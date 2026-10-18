import { CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { HOME_REGIONS } from '@thapsus/core/regions';
import { GLOBAL_REGION, names, type EnvConfig, type ServiceSize } from './config';
import {
  alertTopic,
  allowAlertingServices,
  allowLogsService,
  appImage,
  cellBudget,
  certificateArn,
  encryptedLogGroup,
  keepUnlessEphemeral,
  logsBucket,
  publicAlb,
  regionalWaf,
  RUNTIME_PLATFORM,
} from './shared';

export interface GlobalStackProps extends StackProps {
  config: EnvConfig;
}

/**
 * The complete set of attribute names the tenant directory may ever hold. It maps tenant id, slug and
 * verified domains to a home region and holds NO personal data (see apps/api/src/lib/directory.ts).
 */
export const DIRECTORY_ATTRIBUTES = [
  'pk',
  'tenantId',
  'slug',
  'homeRegion',
  'status',
  'planRef',
  'verifiedDomains',
  'domainKey',
  'createdAt',
  'updatedAt',
] as const;

/** Global layer (London): tenant directory, region-aware sign-in routing, marketing site, billing placeholders. */
export class GlobalStack extends Stack {
  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const env = cfg.env;
    const prod = env === 'prod';
    const prefix = `thapsus-hr-${env}-global`;
    if (this.region !== GLOBAL_REGION) throw new Error(`The global stack must be deployed to ${GLOBAL_REGION}`);

    const key = new kms.Key(this, 'GlobalKey', {
      alias: `alias/${prefix}`,
      description: `Thapsus-HR ${env} global layer: directory table, logs, secrets`,
      enableKeyRotation: true,
      removalPolicy: keepUnlessEphemeral(cfg),
    });
    allowLogsService(key);
    allowAlertingServices(key);

    // ---------------------------------------------------------------- Tenant directory (no personal data)
    const table = new dynamodb.Table(this, 'TenantDirectory', {
      tableName: names.directoryTable(env),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: prod,
      removalPolicy: keepUnlessEphemeral(cfg),
    });
    table.addGlobalSecondaryIndex({
      indexName: 'byDomain',
      partitionKey: { name: 'domainKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['tenantId'],
    });

    // ---------------------------------------------------------------- Network (public subnets only, no NAT)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [`${GLOBAL_REGION}a`, `${GLOBAL_REGION}b`],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true,
    });
    const flowLogs = encryptedLogGroup(this, 'FlowLogs', key, cfg);
    vpc.addFlowLog('FlowLog', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs) });

    const logs_ = logsBucket(this, `thapsus-hr-${env}-${GLOBAL_REGION}-global-logs-${this.account}`, cfg);
    const { alb, https } = publicAlb(this, { vpc, logs: logs_, certificateArn: certificateArn(this, cfg.global.certificateArn), name: prefix });
    regionalWaf(this, alb, `${prefix}-web-acl`, cfg.wafRateLimitPer5Min);

    // ---------------------------------------------------------------- Secrets + billing placeholders
    const internalToken = new secretsmanager.Secret(this, 'InternalToken', {
      // Source of truth for INTERNAL_TOKEN in this env. Each cell stack creates its own copy
      // (names.cellInternalTokenSecret, no cross-region references); scripts/deploy.mjs copies this value there.
      secretName: names.internalTokenSecret(env),
      encryptionKey: key,
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });
    new secretsmanager.Secret(this, 'StripeSecret', {
      secretName: `thapsus-hr/${env}/stripe`,
      description: 'Stripe API keys + webhook secret, to be filled by a human (HUMAN_TODO). No Stripe resources are created here.',
      encryptionKey: key,
    });
    new ssm.StringParameter(this, 'BillingConfigLocation', {
      parameterName: `/thapsus-hr/${env}/billing/config-location`,
      stringValue: cfg.billingConfigLocation,
      description: 'Where the billing config (prices, bands, discounts) is loaded from.',
    });

    // ---------------------------------------------------------------- URLs
    const baseUrl = cfg.globalBaseUrl ?? (cfg.domain ? `https://${cfg.domain}` : `https://${alb.loadBalancerDnsName}`);
    const regional: Record<string, string> = {};
    for (const kind of ['api', 'app'] as const) {
      for (const r of HOME_REGIONS) {
        const k = `${kind.toUpperCase()}_URL_${r.toUpperCase()}`;
        regional[k] =
          cfg.regionalUrls[kind]?.[r] ??
          (cfg.domain
            ? `https://${kind}.${r}.${cfg.domain}`
            : new CfnParameter(this, `${kind === 'api' ? 'Api' : 'App'}Url${r.toUpperCase()}`, {
                type: 'String',
                default: '',
                description: `Public ${kind} URL of the ${r} cell (its ALB) while no domain is configured.`,
              }).valueAsString);
      }
    }

    const topic = alertTopic(this, key, cfg);
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: prefix, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    encryptedLogGroup(this, 'ContainerInsightsLogs', key, cfg, `/aws/ecs/containerinsights/${prefix}/performance`);

    const service = (name: 'api' | 'web', size: ServiceSize, port: number, environment: Record<string, string>, secrets: Record<string, ecs.Secret>) => {
      const logGroup = encryptedLogGroup(this, `${name}Logs`, key, cfg, `/thapsus-hr/${env}/global/${name}`);
      const sg = new ec2.SecurityGroup(this, `${name}Sg`, { vpc, description: `global ${name} tasks` });
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `${prefix}-${name}`,
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        runtimePlatform: RUNTIME_PLATFORM,
      });
      task.addContainer('app', {
        image: appImage(name),
        environment: { ...environment, PORT: String(port), SERVICE_NAME: `thapsus-global-${name}` },
        secrets,
        portMappings: [{ containerPort: port }],
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
      });
      // Public subnets without NAT: tasks get a public IP for image pulls; inbound is ALB-only (SG).
      const svc = new ecs.FargateService(this, `${name}Service`, {
        serviceName: `${prefix}-${name}`,
        cluster,
        taskDefinition: task,
        desiredCount: size.desiredCount,
        securityGroups: [sg],
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        propagateTags: ecs.PropagatedTagSource.SERVICE,
      });
      const scaling = svc.autoScaleTaskCount({ minCapacity: size.minCapacity, maxCapacity: size.maxCapacity });
      scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });
      return { svc, task, scaling };
    };

    const common = {
      APP_ENV: env,
      CELL_REGION: 'uk',
      THAPSUS_HR_DOMAIN: cfg.domain ?? alb.loadBalancerDnsName,
      GLOBAL_BASE_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      API_BASE_URL: baseUrl,
      LOG_LEVEL: prod ? 'info' : 'debug',
      ...regional,
    };
    const api = service(
      'api',
      cfg.global.services.api,
      4000,
      {
        ...common,
        SERVICE_ROLE: 'global',
        DIRECTORY_TABLE: table.tableName,
        DIRECTORY_REGION: GLOBAL_REGION,
        // The global service never encrypts tenant data; this key only satisfies startup config.
        KMS_KEY_ARN: key.keyArn,
        OTEL_SDK_DISABLED: 'true',
      },
      { INTERNAL_TOKEN: ecs.Secret.fromSecretsManager(internalToken) },
    );
    table.grantReadWriteData(api.task.taskRole);
    const web = service('web', cfg.global.services.web, 3000, { ...common, SERVICE_ROLE: 'global', SITE_MODE: 'marketing' }, {});

    const apiTg = https.addTargets('Api', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/global/*', '/health/api'])],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api.svc.loadBalancerTarget({ containerName: 'app', containerPort: 4000 })],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(30),
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

    // ---------------------------------------------------------------- DNS (only when a domain is configured)
    if (cfg.domain) {
      const zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: cfg.domain });
      const target = route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb));
      new route53.ARecord(this, 'ApexRecord', { zone, target });
      new route53.ARecord(this, 'WwwRecord', { zone, recordName: 'www', target });
      new CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId, description: 'Copy into config.hostedZoneId for the cell stacks.' });
    }

    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmDescription: `${prefix} ALB 5xx responses`,
      metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(topic));
    cellBudget(this, cfg, 'global', cfg.global.monthlyBudgetUsd, topic);

    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'DirectoryTableName', { value: table.tableName });
    new CfnOutput(this, 'InternalTokenSecretArn', { value: internalToken.secretArn });
  }
}
