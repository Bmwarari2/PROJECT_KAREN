import { join } from 'node:path';
import { CfnParameter, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

/** Docker build context = repository root. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Keeps asset hashing/staging fast and images free of local build output and secrets. */
export const DOCKER_EXCLUDES = [
  '**/node_modules',
  '**/.next',
  '**/dist',
  '**/cdk.out',
  '**/.turbo',
  '**/coverage',
  '.git',
  '.github',
  '**/.env',
  '**/.env.*',
  '**/*.log',
  '.tmp*',
  '**/playwright-report',
  '**/test-results',
  '**/.lighthouse',
  // Infra sources are not part of any image (package.json stays: it is a workspace importer in the lockfile).
  'infra/bin',
  'infra/lib',
  'infra/test',
  'infra/config',
  'infra/cdk.json',
  'infra/README.md',
  'infra/tsconfig.json',
];

export type AppImage = 'api' | 'worker' | 'web';

/** linux/amd64 throughout (Fargate X86_64) — one consistent platform for every image and task. */
export function appImage(name: AppImage): ecs.ContainerImage {
  return ecs.ContainerImage.fromAsset(REPO_ROOT, {
    file: `apps/${name}/Dockerfile`,
    exclude: DOCKER_EXCLUDES,
    platform: ecrAssets.Platform.LINUX_AMD64,
  });
}

export const RUNTIME_PLATFORM: ecs.RuntimePlatform = {
  cpuArchitecture: ecs.CpuArchitecture.X86_64,
  operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
};

/** CloudWatch log group encrypted with a customer KMS key and a finite retention. */
export function encryptedLogGroup(
  scope: Construct,
  id: string,
  key: kms.IKey,
  cfg: EnvConfig,
  logGroupName?: string,
) {
  return new logs.LogGroup(scope, id, {
    logGroupName,
    encryptionKey: key,
    retention: cfg.logRetentionDays as logs.RetentionDays,
    removalPolicy: cfg.env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  });
}

/** Allows the CloudWatch Logs service of THIS region (only) to use the key for log groups in this account. */
export function allowLogsService(key: kms.Key) {
  const { region, account, partition } = Stack.of(key);
  key.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogsInThisRegion',
      principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:${partition}:logs:${region}:${account}:log-group:*`,
        },
      },
    }),
  );
}

/** Allows CloudWatch alarms and AWS Budgets to publish to an SNS topic encrypted with this key. */
export function allowAlertingServices(key: kms.Key) {
  key.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowAlarmAndBudgetPublishing',
      principals: [
        new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
        new iam.ServicePrincipal('budgets.amazonaws.com'),
      ],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(key).account } },
    }),
  );
}

/**
 * Removal policy for stateful resources: kept when a stack is deleted, except in the temporary
 * load-test environment, which `pnpm loadtest` creates and deletes completely (no leftover cost).
 */
export function keepUnlessEphemeral(cfg: EnvConfig): RemovalPolicy {
  return cfg.env === 'loadtest' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
}

/**
 * Access-log bucket (S3 server access logs + ALB access logs). Both log-delivery services only
 * support SSE-S3 on the target bucket, so this bucket is SSE-S3; it holds request metadata only.
 */
export function logsBucket(scope: Construct, bucketName: string, cfg: EnvConfig) {
  return new s3.Bucket(scope, 'LogsBucket', {
    bucketName,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    lifecycleRules: [
      {
        id: 'expire-logs',
        expiration: Duration.days(cfg.logRetentionDays),
        noncurrentVersionExpiration: Duration.days(7),
      },
    ],
    removalPolicy: keepUnlessEphemeral(cfg),
  });
}

/** HTTPS certificate: from config, else a CloudFormation parameter supplied at deploy time. */
export function certificateArn(scope: Construct, fromConfig: string | null): string {
  if (fromConfig) return fromConfig;
  return new CfnParameter(scope, 'CertificateArn', {
    type: 'String',
    description:
      'ACM certificate ARN (in this region) for the HTTPS listener. Staging: imported self-signed certificate.',
    allowedPattern: '^arn:aws[a-z-]*:acm:[a-z0-9-]+:\\d{12}:certificate/.+$',
  }).valueAsString;
}

/**
 * Internet-facing ALB: HTTPS (TLS 1.2+) only, access logs, invalid headers dropped. Plain HTTP
 * redirects browsers to HTTPS, except API paths (`noRedirectPaths`), which get a 400 instead: an API
 * client that sends a request without TLS must fail visibly, not be silently redirected (ASVS V4.1.2).
 */
export function publicAlb(
  scope: Construct,
  opts: { vpc: ec2.IVpc; logs: s3.IBucket; certificateArn: string; name: string; noRedirectPaths?: string[] },
): { alb: elbv2.ApplicationLoadBalancer; https: elbv2.ApplicationListener; sg: ec2.SecurityGroup } {
  const sg = new ec2.SecurityGroup(scope, 'AlbSg', {
    vpc: opts.vpc,
    description: 'Public ALB',
    allowAllOutbound: false,
  });
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (redirect only)');
  const alb = new elbv2.ApplicationLoadBalancer(scope, 'Alb', {
    vpc: opts.vpc,
    internetFacing: true,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    securityGroup: sg,
    dropInvalidHeaderFields: true,
    loadBalancerName: opts.name,
  });
  alb.logAccessLogs(opts.logs, 'alb');
  // Same construct id as alb.addRedirect() used, so the listener is updated in place, not replaced.
  const http = alb.addListener('Redirect80To443', {
    port: 80,
    protocol: elbv2.ApplicationProtocol.HTTP,
    open: false,
    defaultAction: elbv2.ListenerAction.redirect({
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: '443',
      permanent: true,
    }),
  });
  const noRedirect = opts.noRedirectPaths ?? [];
  // an ALB rule matches at most five path patterns
  for (let i = 0; i < noRedirect.length; i += 5) {
    http.addAction(`HttpsRequired${i / 5}`, {
      priority: 1 + i / 5,
      conditions: [elbv2.ListenerCondition.pathPatterns(noRedirect.slice(i, i + 5))],
      action: elbv2.ListenerAction.fixedResponse(400, {
        contentType: 'application/problem+json',
        messageBody: JSON.stringify({
          type: 'about:blank#httpsRequired',
          title: 'HTTPS is required',
          status: 400,
          code: 'httpsRequired',
        }),
      }),
    });
  }
  const https = alb.addListener('Https', {
    port: 443,
    protocol: elbv2.ApplicationProtocol.HTTPS,
    sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    certificates: [elbv2.ListenerCertificate.fromArn(opts.certificateArn)],
    open: false,
  });
  return { alb, https, sg };
}

/** Regional WAFv2 web ACL (AWS managed rule groups + per-IP rate limit) associated with the ALB. */
export function regionalWaf(
  scope: Construct,
  alb: elbv2.IApplicationLoadBalancer,
  name: string,
  ratePer5Min: number,
) {
  const vis = (metricName: string) => ({
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  });
  const managed = (priority: number, groupName: string) => ({
    name: groupName,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: groupName } },
    visibilityConfig: vis(groupName),
  });
  const acl = new wafv2.CfnWebACL(scope, 'WebAcl', {
    name,
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: vis(name),
    rules: [
      {
        name: 'rate-limit-per-ip',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: { limit: ratePer5Min, aggregateKeyType: 'IP', evaluationWindowSec: 300 },
        },
        visibilityConfig: vis('rate-limit-per-ip'),
      },
      managed(1, 'AWSManagedRulesAmazonIpReputationList'),
      managed(2, 'AWSManagedRulesCommonRuleSet'),
      managed(3, 'AWSManagedRulesKnownBadInputsRuleSet'),
      managed(4, 'AWSManagedRulesSQLiRuleSet'),
    ],
  });
  new wafv2.CfnWebACLAssociation(scope, 'WebAclAssociation', {
    resourceArn: alb.loadBalancerArn,
    webAclArn: acl.attrArn,
  });
  return acl;
}

/** KMS-encrypted SNS topic for alarms and budget notifications. */
export function alertTopic(scope: Construct, key: kms.IKey, cfg: EnvConfig) {
  const topic = new sns.Topic(scope, 'AlertTopic', { masterKey: key, enforceSSL: true });
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowBudgetsPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(scope).account } },
    }),
  );
  if (cfg.alarmEmail) topic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
  return topic;
}

/**
 * Monthly cost budget filtered by the `cell` cost-allocation tag (the tag must be activated in
 * Billing — see HUMAN_TODO), notifying at 80% and 100% of actual spend.
 */
export function cellBudget(
  scope: Construct,
  cfg: EnvConfig,
  cellTag: string,
  amountUsd: number,
  topic: sns.ITopic,
) {
  const subscribers = cfg.alarmEmail
    ? [{ subscriptionType: 'EMAIL', address: cfg.alarmEmail }]
    : [{ subscriptionType: 'SNS', address: topic.topicArn }];
  return new budgets.CfnBudget(scope, 'MonthlyBudget', {
    budget: {
      budgetName: `thapsus-hr-${cfg.env}-${cellTag}`,
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: { amount: amountUsd, unit: 'USD' },
      costFilters: { TagKeyValue: [`user:cell$${cellTag}`] },
    },
    notificationsWithSubscribers: [80, 100].map((threshold) => ({
      notification: {
        notificationType: 'ACTUAL',
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers,
    })),
  });
}

/** X-Ray actions that AWS only supports on Resource "*" (documented exception in the IAM tests). */
export const XRAY_ACTIONS = [
  'xray:PutTraceSegments',
  'xray:PutTelemetryRecords',
  'xray:GetSamplingRules',
  'xray:GetSamplingTargets',
];

/** ADOT collector sidecar: OTLP/HTTP on localhost:4318 → AWS X-Ray in the task's own region. */
export function addOtelSidecar(task: ecs.TaskDefinition, logGroup: logs.ILogGroup) {
  const config = [
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      http:',
    '        endpoint: 0.0.0.0:4318',
    'processors:',
    '  batch: {}',
    'exporters:',
    '  awsxray: {}',
    'service:',
    '  pipelines:',
    '    traces:',
    '      receivers: [otlp]',
    '      processors: [batch]',
    '      exporters: [awsxray]',
  ].join('\n');
  task.addContainer('otel-collector', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3'),
    essential: false,
    memoryReservationMiB: 64,
    environment: { AOT_CONFIG_CONTENT: config },
    logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'otel' }),
  });
  task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: XRAY_ACTIONS, resources: ['*'] }));
}
