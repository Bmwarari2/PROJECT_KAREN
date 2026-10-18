import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { HOME_REGIONS, REGIONS, type HomeRegion } from '@thapsus/core/regions';
import { GLOBAL_REGION, names, type EnvConfig, type ServiceSize } from './config';
import {
  addOtelSidecar,
  alertTopic,
  allowAlertingServices,
  allowLogsService,
  appImage,
  cellBudget,
  certificateArn,
  encryptedLogGroup,
  logsBucket,
  publicAlb,
  regionalWaf,
  RUNTIME_PLATFORM,
} from './shared';

export interface CellStackProps extends StackProps {
  config: EnvConfig;
  cell: HomeRegion;
}

/** Characters excluded from generated database passwords (URL- and shell-hostile). */
const DB_PASSWORD_EXCLUDE = '"@/\\\'';

/** Paths served by the API service; everything else goes to the web app. ALB rules take ≤5 values each. */
export const API_PATHS = ['/v1/*', '/scim/*', '/__mock-idp/*', '/openapi.json', '/global/*', '/health/api'];

/**
 * One regional cell: every tenant whose home region is `cell` is served, stored, cached, queued,
 * logged, emailed and backed up here (backup copies only to REGIONS[cell].backupRegion).
 */
export class CellStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: CellStackProps) {
    super(scope, id, props);
    const { config: cfg, cell } = props;
    const spec = REGIONS[cell];
    const env = cfg.env;
    const prod = env === 'prod';
    const prefix = `thapsus-hr-${env}-${cell}`;
    if (this.region !== spec.awsRegion) throw new Error(`Cell ${cell} must be deployed to ${spec.awsRegion}, not ${this.region}`);

    // ---------------------------------------------------------------- KMS (per region, rotation on)
    const dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${prefix}-data`,
      description: `Thapsus-HR ${env} ${cell}: Aurora, S3, Valkey, SQS, logs, backups`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    allowLogsService(dataKey);
    allowAlertingServices(dataKey);
    const vaultKey = new kms.Key(this, 'VaultKey', {
      alias: `alias/${prefix}-vault`,
      description: `Thapsus-HR ${env} ${cell}: field-level envelope encryption of sensitive data`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- Network
    const azs = ['a', 'b', 'c'].map((s) => `${spec.awsRegion}${s}`);
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: azs,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const flowLogGroup = encryptedLogGroup(this, 'FlowLogs', dataKey, cfg);
    vpc.addFlowLog('FlowLog', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup), trafficType: ec2.FlowLogTrafficType.ALL });
    // Keep S3 and DynamoDB traffic on the AWS network.
    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // ---------------------------------------------------------------- Storage: logs + files buckets
    const logs_ = logsBucket(this, `thapsus-hr-${env}-${spec.awsRegion}-logs-${this.account}`, cfg);

    // ---------------------------------------------------------------- Load balancer + WAF
    const { alb, https } = publicAlb(this, {
      vpc,
      logs: logs_,
      certificateArn: certificateArn(this, cfg.cells[cell].certificateArn),
      name: prefix,
    });
    this.alb = alb;
    regionalWaf(this, alb, `${prefix}-web-acl`, cfg.wafRateLimitPer5Min);

    // Public URLs. With no product domain yet, the cell is reached on its ALB DNS name.
    const host = (kind: 'app' | 'api', r: HomeRegion) => (cfg.domain ? `${kind}.${r}.${cfg.domain}` : undefined);
    const appHost = host('app', cell) ?? alb.loadBalancerDnsName;
    const apiHost = host('api', cell) ?? alb.loadBalancerDnsName;
    const appBaseUrl = `https://${appHost}`;
    const apiBaseUrl = `https://${apiHost}`;
    const globalBaseUrl =
      cfg.globalBaseUrl ??
      (cfg.domain
        ? `https://${cfg.domain}`
        : new CfnParameter(this, 'GlobalBaseUrl', {
            type: 'String',
            default: '',
            description: 'Public URL of the global sign-in service (the global ALB) while no domain is configured.',
          }).valueAsString);

    // Browser uploads via presigned URLs. Without a domain the app is on its ALB name; a token here would
    // create a cycle (bucket → ALB → logs-bucket policy → bucket), so match this region's ELB names instead.
    const corsOrigin = cfg.domain ? `https://app.${cell}.${cfg.domain}` : `https://*.${spec.awsRegion}.elb.amazonaws.com`;
    const filesBucket = new s3.Bucket(this, 'FilesBucket', {
      bucketName: `thapsus-hr-${env}-${spec.awsRegion}-files-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: logs_,
      serverAccessLogsPrefix: 's3/files/',
      lifecycleRules: [
        { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(prod ? 90 : 30), noncurrentVersionsToRetain: 3 },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
      cors: [{ allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT], allowedOrigins: [corsOrigin], allowedHeaders: ['*'], maxAge: 3000 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- Security groups
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', { vpc, description: 'api tasks' });
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', { vpc, description: 'worker tasks' });
    const webSg = new ec2.SecurityGroup(this, 'WebSg', { vpc, description: 'web tasks' });
    const migratorSg = new ec2.SecurityGroup(this, 'MigratorSg', { vpc, description: 'one-off migrator task' });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Aurora + RDS Proxy' });
    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'Valkey', allowAllOutbound: false });
    for (const [sg, label] of [[apiSg, 'api'], [workerSg, 'worker'], [migratorSg, 'migrator']] as const) {
      dbSg.addIngressRule(sg, ec2.Port.tcp(5432), `${label} to Postgres`);
    }
    dbSg.addIngressRule(dbSg, ec2.Port.tcp(5432), 'RDS Proxy to Aurora');
    for (const [sg, label] of [[apiSg, 'api'], [workerSg, 'worker']] as const) cacheSg.addIngressRule(sg, ec2.Port.tcp(6379), `${label} to Valkey`);

    // ---------------------------------------------------------------- Aurora PostgreSQL 17 (Serverless v2)
    const clusterIdentifier = prefix;
    const auroraLogs = encryptedLogGroup(this, 'AuroraLogs', dataKey, cfg, `/aws/rds/cluster/${clusterIdentifier}/postgresql`);
    const roleSecret = (id: string, username: string) =>
      new rds.DatabaseSecret(this, id, {
        username,
        secretName: `thapsus-hr/${env}/db/${username}`,
        encryptionKey: dataKey,
        excludeCharacters: DB_PASSWORD_EXCLUDE,
      });
    const cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_17_7 }),
      clusterIdentifier,
      defaultDatabaseName: 'thapsus',
      credentials: rds.Credentials.fromGeneratedSecret('thapsus_owner', {
        secretName: `thapsus-hr/${env}/db/thapsus_owner`,
        encryptionKey: dataKey,
        excludeCharacters: DB_PASSWORD_EXCLUDE,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer', {
        availabilityZone: azs[0],
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: dataKey,
        autoMinorVersionUpgrade: true,
      }),
      // Reporting replica in a different AZ: also the failover target (Multi-AZ).
      readers: [
        rds.ClusterInstance.serverlessV2('reporting', {
          availabilityZone: azs[1],
          scaleWithWriter: true,
          enablePerformanceInsights: true,
          performanceInsightEncryptionKey: dataKey,
          autoMinorVersionUpgrade: true,
        }),
      ],
      serverlessV2MinCapacity: cfg.aurora.minAcu,
      serverlessV2MaxCapacity: cfg.aurora.maxAcu,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      backup: { retention: Duration.days(cfg.aurora.backupRetentionDays), preferredWindow: '01:00-02:00' },
      preferredMaintenanceWindow: 'Sun:03:00-Sun:04:00',
      deletionProtection: cfg.aurora.deletionProtection,
      iamAuthentication: true,
      cloudwatchLogsExports: ['postgresql'],
      copyTagsToSnapshot: true,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
    });
    // Only the DB cluster resource waits for its log group (a construct-level dependency would cycle via the proxy role).
    cluster.node.defaultChild!.node.addDependency(auroraLogs.node.defaultChild!);
    const ownerSecret = cluster.secret!;
    const appDbSecret = roleSecret('AppDbSecret', 'thapsus_app');
    const backofficeDbSecret = roleSecret('BackofficeDbSecret', 'thapsus_backoffice');
    const reportingDbSecret = roleSecret('ReportingDbSecret', 'thapsus_reporting');

    const proxyName = `${prefix}-proxy`;
    encryptedLogGroup(this, 'ProxyLogs', dataKey, cfg, `/aws/rds/proxy/${proxyName}`);
    const proxy = cluster.addProxy('Proxy', {
      dbProxyName: proxyName,
      secrets: [ownerSecret, appDbSecret, backofficeDbSecret, reportingDbSecret],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      requireTLS: true,
      iamAuth: false,
      debugLogging: false,
    });

    // ---------------------------------------------------------------- Valkey (Multi-AZ, TLS, KMS)
    const valkeyAuth = new secretsmanager.Secret(this, 'ValkeyAuthToken', {
      secretName: `thapsus-hr/${env}/valkey-auth-token`,
      encryptionKey: dataKey,
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });
    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'ValkeySubnets', {
      description: `${prefix} Valkey`,
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const valkey = new elasticache.CfnReplicationGroup(this, 'Valkey', {
      replicationGroupDescription: `${prefix} cache, rate limits and sessions`,
      engine: 'valkey',
      engineVersion: '8.0',
      cacheNodeType: cfg.valkey.nodeType,
      numCacheClusters: 1 + Math.max(1, cfg.valkey.replicas),
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      atRestEncryptionEnabled: true,
      kmsKeyId: dataKey.keyArn,
      transitEncryptionEnabled: true,
      authToken: valkeyAuth.secretValue.unsafeUnwrap(), // CloudFormation dynamic reference, never plaintext
      cacheSubnetGroupName: cacheSubnets.ref,
      securityGroupIds: [cacheSg.securityGroupId],
      port: 6379,
      snapshotRetentionLimit: prod ? 7 : 1,
      autoMinorVersionUpgrade: true,
    });
    const valkeyUrl = `rediss://${valkey.attrPrimaryEndPointAddress}:6379`;

    // ---------------------------------------------------------------- Messaging
    const queue = (id: string, name: string) => {
      const dlq = new sqs.Queue(this, `${id}Dlq`, {
        queueName: `${prefix}-${name}-dlq`,
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        enforceSSL: true,
        retentionPeriod: Duration.days(14),
      });
      return new sqs.Queue(this, id, {
        queueName: `${prefix}-${name}`,
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        enforceSSL: true,
        visibilityTimeout: Duration.minutes(5),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      });
    };
    const jobsQueue = queue('JobsQueue', 'jobs');
    const webhooksQueue = queue('WebhooksQueue', 'webhooks');
    const bus = new events.EventBus(this, 'EventBus', { eventBusName: `thapsus-hr-${env}` });

    // EventBridge Scheduler: the worker creates per-tenant schedules in this group at runtime; each
    // schedule drops a message on the jobs queue (no compute is invoked by the scheduler itself).
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: prefix });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
      description: 'EventBridge Scheduler to jobs queue',
    });
    jobsQueue.grantSendMessages(schedulerRole);

    // ---------------------------------------------------------------- Email (no identities until the domain exists)
    const sesConfigSet = new ses.ConfigurationSet(this, 'SesConfigurationSet', {
      configurationSetName: prefix,
      reputationMetrics: true,
      sendingEnabled: true,
    });

    // ---------------------------------------------------------------- Backup (vault in-region; copy only to the permitted region)
    const backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: prefix,
      encryptionKey: dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const plan = new backup.BackupPlan(this, 'BackupPlan', { backupPlanName: prefix, backupVault });
    // Continuous backup (point-in-time restore, RPO ≤ 15 minutes) for Aurora and S3.
    plan.addRule(
      new backup.BackupPlanRule({
        ruleName: 'continuous',
        enableContinuousBackup: true,
        deleteAfter: Duration.days(Math.min(35, cfg.backup.continuousRetentionDays)),
        scheduleExpression: events.Schedule.cron({ minute: '0', hour: '1' }),
      }),
    );
    const copyActions: backup.BackupPlanCopyActionProps[] = spec.backupRegion
      ? [
          {
            destinationBackupVault: backup.BackupVault.fromBackupVaultArn(
              this,
              'CopyVault',
              // Name-based ARN of the vault created by BackupCopyVaultStack (no cross-region reference).
              `arn:aws:backup:${spec.backupRegion}:${this.account}:backup-vault:${names.copyVault(env, cell)}`,
            ),
            deleteAfter: Duration.days(cfg.backup.copyRetentionDays),
          },
        ]
      : [];
    plan.addRule(
      new backup.BackupPlanRule({
        ruleName: 'daily',
        scheduleExpression: events.Schedule.cron({ minute: '0', hour: '3' }),
        deleteAfter: Duration.days(cfg.backup.dailyRetentionDays),
        copyActions,
      }),
    );
    const backupRole = new iam.Role(this, 'BackupRole', {
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        'service-role/AWSBackupServiceRolePolicyForBackup',
        'service-role/AWSBackupServiceRolePolicyForRestores',
        'AWSBackupServiceRolePolicyForS3Backup',
        'AWSBackupServiceRolePolicyForS3Restore',
      ].map((n) => iam.ManagedPolicy.fromAwsManagedPolicyName(n)),
    });
    plan.addSelection('Selection', {
      role: backupRole,
      resources: [backup.BackupResource.fromArn(cluster.clusterArn), backup.BackupResource.fromArn(filesBucket.bucketArn)],
    });

    // ---------------------------------------------------------------- Secrets for the services
    const internalToken = new secretsmanager.Secret(this, 'InternalToken', {
      // The cell's own copy of the global internal token (no cross-region references); scripts/deploy.mjs
      // copies the global value into it after each cell deploy. A distinct name per cell, because the UK
      // cell shares eu-west-2 with the global stack's source secret.
      secretName: names.cellInternalTokenSecret(env, cell),
      encryptionKey: dataKey,
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });
    const vapid = new secretsmanager.Secret(this, 'VapidKeys', {
      secretName: `thapsus-hr/${env}/vapid`,
      description: 'Web push VAPID key pair, filled by a script (empty values disable web push).',
      encryptionKey: dataKey,
      secretObjectValue: { VAPID_PUBLIC_KEY: SecretValue.unsafePlainText(''), VAPID_PRIVATE_KEY: SecretValue.unsafePlainText('') },
    });
    const mockIdpAllowed = env === 'dev' || env === 'staging';
    const mockIdp = mockIdpAllowed
      ? new secretsmanager.Secret(this, 'MockIdpKeys', {
          secretName: `thapsus-hr/${env}/mock-idp`,
          description: 'Mock IdP signing key/cert for staging smoke tests, filled by a script. Never exists in prod.',
          encryptionKey: dataKey,
          secretObjectValue: { MOCK_IDP_KEY_PEM: SecretValue.unsafePlainText(''), MOCK_IDP_CERT_PEM: SecretValue.unsafePlainText('') },
        })
      : undefined;

    // ---------------------------------------------------------------- ECS cluster
    const clusterName = prefix;
    encryptedLogGroup(this, 'ContainerInsightsLogs', dataKey, cfg, `/aws/ecs/containerinsights/${clusterName}/performance`);
    const ecsCluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    const directoryTableArn = `arn:aws:dynamodb:${GLOBAL_REGION}:${this.account}:table/${names.directoryTable(env)}`;
    const regionalUrls = (kind: 'api' | 'app') => {
      const out: Record<string, string> = {};
      for (const r of HOME_REGIONS) {
        const url =
          cfg.regionalUrls[kind]?.[r] ?? (host(kind, r) ? `https://${host(kind, r)}` : r === cell ? (kind === 'api' ? apiBaseUrl : appBaseUrl) : undefined);
        if (url) out[`${kind.toUpperCase()}_URL_${r.toUpperCase()}`] = url;
      }
      return out;
    };
    const commonEnv: Record<string, string> = {
      APP_ENV: env,
      CELL_REGION: cell,
      SERVICE_ROLE: 'cell',
      THAPSUS_HR_DOMAIN: cfg.domain ?? alb.loadBalancerDnsName,
      APP_BASE_URL: appBaseUrl,
      API_BASE_URL: apiBaseUrl,
      GLOBAL_BASE_URL: globalBaseUrl,
      LOG_LEVEL: prod ? 'info' : 'debug',
      ...regionalUrls('api'),
      ...regionalUrls('app'),
    };
    const backendEnv: Record<string, string> = {
      ...commonEnv,
      DATABASE_HOST: proxy.endpoint,
      REPORTING_DATABASE_HOST: cluster.clusterReadEndpoint.hostname,
      VALKEY_URL: valkeyUrl,
      FILES_BUCKET: filesBucket.bucketName,
      FILES_KMS_KEY_ARN: dataKey.keyArn,
      KMS_KEY_ARN: vaultKey.keyArn,
      EVENT_BUS_NAME: bus.eventBusName,
      QUEUE_URL_JOBS: jobsQueue.queueUrl,
      QUEUE_URL_WEBHOOKS: webhooksQueue.queueUrl,
      MAIL_TRANSPORT: 'ses',
      SES_CONFIGURATION_SET: sesConfigSet.configurationSetName,
      ...(cfg.domain ? { MAIL_FROM: `no-reply@${cfg.domain}` } : {}),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      BACKUP_VAULT_ARN: backupVault.backupVaultArn,
      DIRECTORY_TABLE: names.directoryTable(env),
      DIRECTORY_REGION: GLOBAL_REGION,
      SCHEDULE_GROUP_NAME: scheduleGroup.name!,
      SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      ...(mockIdpAllowed ? { MOCK_IDP_ENABLED: 'true' } : {}),
    };
    const backendSecrets: Record<string, ecs.Secret> = {
      DATABASE_SECRET: ecs.Secret.fromSecretsManager(appDbSecret),
      BACKOFFICE_DATABASE_SECRET: ecs.Secret.fromSecretsManager(backofficeDbSecret),
      REPORTING_DATABASE_SECRET: ecs.Secret.fromSecretsManager(reportingDbSecret),
      VALKEY_AUTH_TOKEN: ecs.Secret.fromSecretsManager(valkeyAuth),
      INTERNAL_TOKEN: ecs.Secret.fromSecretsManager(internalToken),
      VAPID_PUBLIC_KEY: ecs.Secret.fromSecretsManager(vapid, 'VAPID_PUBLIC_KEY'),
      VAPID_PRIVATE_KEY: ecs.Secret.fromSecretsManager(vapid, 'VAPID_PRIVATE_KEY'),
      ...(mockIdp
        ? {
            MOCK_IDP_KEY_PEM: ecs.Secret.fromSecretsManager(mockIdp, 'MOCK_IDP_KEY_PEM'),
            MOCK_IDP_CERT_PEM: ecs.Secret.fromSecretsManager(mockIdp, 'MOCK_IDP_CERT_PEM'),
          }
        : {}),
    };

    const service = (
      name: 'api' | 'worker' | 'web',
      opts: { size: ServiceSize; sg: ec2.SecurityGroup; port?: number; environment: Record<string, string>; secrets: Record<string, ecs.Secret>; otel: boolean },
    ) => {
      const logGroup = encryptedLogGroup(this, `${name}Logs`, dataKey, cfg, `/thapsus-hr/${env}/${cell}/${name}`);
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `${prefix}-${name}`,
        cpu: opts.size.cpu,
        memoryLimitMiB: opts.size.memoryMiB,
        runtimePlatform: RUNTIME_PLATFORM,
      });
      task.addContainer('app', {
        image: appImage(name),
        essential: true,
        environment: { ...opts.environment, SERVICE_NAME: `thapsus-${name}`, ...(opts.port ? { PORT: String(opts.port) } : {}) },
        secrets: opts.secrets,
        portMappings: opts.port ? [{ containerPort: opts.port }] : [],
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
        stopTimeout: Duration.seconds(30),
      });
      if (opts.otel) addOtelSidecar(task, logGroup);
      const svc = new ecs.FargateService(this, `${name}Service`, {
        serviceName: `${prefix}-${name}`,
        cluster: ecsCluster,
        taskDefinition: task,
        desiredCount: opts.size.desiredCount,
        securityGroups: [opts.sg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        assignPublicIp: false,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        propagateTags: ecs.PropagatedTagSource.SERVICE,
      });
      const scaling = svc.autoScaleTaskCount({ minCapacity: opts.size.minCapacity, maxCapacity: opts.size.maxCapacity });
      scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60, scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.seconds(180) });
      new cloudwatch.Alarm(this, `${name}CpuAlarm`, {
        alarmDescription: `${prefix} ${name} CPU high`,
        metric: svc.metricCpuUtilization({ period: Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwActions.SnsAction(topic));
      return { svc, task, scaling };
    };

    const topic = alertTopic(this, dataKey, cfg);

    const api = service('api', { size: cfg.services.api, sg: apiSg, port: 4000, environment: backendEnv, secrets: backendSecrets, otel: true });
    const worker = service('worker', { size: cfg.services.worker, sg: workerSg, environment: backendEnv, secrets: backendSecrets, otel: true });
    const web = service('web', {
      size: cfg.services.web,
      sg: webSg,
      port: 3000,
      environment: { ...commonEnv, SITE_MODE: 'app' },
      secrets: { VAPID_PUBLIC_KEY: ecs.Secret.fromSecretsManager(vapid, 'VAPID_PUBLIC_KEY') },
      otel: false,
    });

    // ---------------------------------------------------------------- Least-privilege task roles
    for (const { task } of [api, worker]) {
      const role = task.taskRole;
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'VaultEnvelopeKeys',
          actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
          resources: [vaultKey.keyArn],
          // Every wrapped data key is bound to an encryption context (tenant + purpose).
          conditions: { Null: { 'kms:EncryptionContextKeys': 'false' } },
        }),
      );
      filesBucket.grantReadWrite(role);
      bus.grantPutEventsTo(role);
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'SendEmailWithConfigurationSet',
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            `arn:aws:ses:${this.region}:${this.account}:identity/*`,
            `arn:aws:ses:${this.region}:${this.account}:configuration-set/${sesConfigSet.configurationSetName}`,
          ],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'TenantDirectory',
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
          resources: [directoryTableArn, `${directoryTableArn}/index/*`],
        }),
      );
      // The directory table is encrypted with the global stack's key (alias-scoped, DynamoDB only).
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'TenantDirectoryKey',
          actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [`arn:aws:kms:${GLOBAL_REGION}:${this.account}:key/*`],
          conditions: {
            'ForAnyValue:StringEquals': { 'kms:ResourceAliases': `alias/thapsus-hr-${env}-global` },
            StringEquals: { 'kms:ViaService': `dynamodb.${GLOBAL_REGION}.amazonaws.com` },
          },
        }),
      );
    }
    jobsQueue.grantSendMessages(api.task.taskRole);
    webhooksQueue.grantSendMessages(api.task.taskRole);
    for (const q of [jobsQueue, webhooksQueue]) {
      q.grantSendMessages(worker.task.taskRole);
      q.grantConsumeMessages(worker.task.taskRole);
    }
    worker.task.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ManageTenantSchedules',
        actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`],
      }),
    );
    schedulerRole.grantPassRole(worker.task.taskRole);

    // ---------------------------------------------------------------- Routing
    const apiTg = https.addTargets('Api', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(API_PATHS.slice(0, 5))],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api.svc.loadBalancerTarget({ containerName: 'app', containerPort: 4000 })],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(30),
    });
    https.addAction('ApiHealth', {
      priority: 11,
      conditions: [elbv2.ListenerCondition.pathPatterns(API_PATHS.slice(5))],
      action: elbv2.ListenerAction.forward([apiTg]),
    });
    const webTg = https.addTargets('Web', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [web.svc.loadBalancerTarget({ containerName: 'app', containerPort: 3000 })],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(30),
    });
    api.scaling.scaleOnRequestCount('Requests', { requestsPerTarget: 1000, targetGroup: apiTg });
    web.scaling.scaleOnRequestCount('Requests', { requestsPerTarget: 1000, targetGroup: webTg });

    // ---------------------------------------------------------------- Migrator (one-off task)
    const migratorLogs = encryptedLogGroup(this, 'migratorLogs', dataKey, cfg, `/thapsus-hr/${env}/${cell}/migrator`);
    const migrator = new ecs.FargateTaskDefinition(this, 'MigratorTask', {
      family: `${prefix}-migrator`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: RUNTIME_PLATFORM,
    });
    migrator.addContainer('migrator', {
      image: appImage('api'),
      command: ['node', 'dist/migrate.mjs'],
      environment: { APP_ENV: env, CELL_REGION: cell, DATABASE_HOST: cluster.clusterEndpoint.hostname, LOG_LEVEL: 'info' },
      secrets: {
        OWNER_DATABASE_SECRET: ecs.Secret.fromSecretsManager(ownerSecret),
        APP_DATABASE_SECRET: ecs.Secret.fromSecretsManager(appDbSecret),
        BACKOFFICE_DATABASE_SECRET: ecs.Secret.fromSecretsManager(backofficeDbSecret),
        REPORTING_DATABASE_SECRET: ecs.Secret.fromSecretsManager(reportingDbSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: migratorLogs, streamPrefix: 'migrator' }),
    });

    // ---------------------------------------------------------------- DNS (only once a domain + zone exist)
    if (cfg.domain && cfg.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: cfg.hostedZoneId, zoneName: cfg.domain });
      for (const kind of ['app', 'api'] as const) {
        new route53.ARecord(this, `${kind}Record`, {
          zone,
          recordName: `${kind}.${cell}`,
          target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
        });
      }
    }

    // ---------------------------------------------------------------- Alarms + budget
    const alarm = (id: string, props: cloudwatch.AlarmProps) =>
      new cloudwatch.Alarm(this, id, { treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, ...props }).addAlarmAction(
        new cwActions.SnsAction(topic),
      );
    alarm('Alb5xxAlarm', {
      alarmDescription: `${prefix} ALB 5xx responses`,
      metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 1,
    });
    alarm('Target5xxAlarm', {
      alarmDescription: `${prefix} target 5xx responses`,
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 25,
      evaluationPeriods: 1,
    });
    alarm('LatencyP95Alarm', {
      alarmDescription: `${prefix} target response time p95 above 1s`,
      metric: alb.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: 'p95' }),
      threshold: 1,
      evaluationPeriods: 3,
    });
    alarm('AuroraCpuAlarm', {
      alarmDescription: `${prefix} Aurora CPU high`,
      metric: cluster.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
    });
    cellBudget(this, cfg, cell, cfg.cells[cell].monthlyBudgetUsd, topic);

    // ---------------------------------------------------------------- Outputs for deploy scripts
    const out = (id: string, value: string, description?: string) => new CfnOutput(this, id, { value, description });
    out('AlbDnsName', alb.loadBalancerDnsName);
    out('AppBaseUrl', appBaseUrl);
    out('EcsClusterName', ecsCluster.clusterName);
    out('MigratorTaskDefinitionArn', migrator.taskDefinitionArn, 'aws ecs run-task --task-definition <this> --launch-type FARGATE');
    out('MigratorSubnetIds', Fn.join(',', vpc.privateSubnets.map((s) => s.subnetId)));
    out('MigratorSecurityGroupId', migratorSg.securityGroupId);
    out('DatabaseProxyEndpoint', proxy.endpoint);
    out('VaultKeyArn', vaultKey.keyArn);
    out('FilesBucketName', filesBucket.bucketName);
    out('InternalTokenSecretArn', internalToken.secretArn);
    out('VapidSecretArn', vapid.secretArn);
    if (mockIdp) out('MockIdpSecretArn', mockIdp.secretArn);
  }
}
