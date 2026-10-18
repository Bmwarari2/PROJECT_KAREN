import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS, type HomeRegion } from '@thapsus/core/regions';
import { buildApp } from '../lib/app';
import { ENVS, FORBIDDEN_STACK_REGIONS, GLOBAL_REGION, loadConfig, names, type EnvName } from '../lib/config';
import { DIRECTORY_ATTRIBUTES } from '../lib/global-stack';
import { XRAY_ACTIONS } from '../lib/shared';
import { EXPORT_ROLE_ARN_PATTERN } from '../lib/cell-stack';

type Json = Record<string, any>;
type Res = { Type: string; Properties?: Json };

/** Synthesizes every env × stack ONCE (asset staging off: hashes only, no copies, no docker build). */
const flags = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'cdk.json'), 'utf8')).context as Json;
let templates: Map<string, Json>;
let stackRegions: Map<string, string>;

beforeAll(() => {
  const app = buildApp({ context: { ...flags, 'aws:cdk:disable-asset-staging': true }, outdir: mkdtempSync(join(tmpdir(), 'cdk-test-')) });
  const assembly = app.synth();
  templates = new Map();
  stackRegions = new Map();
  for (const s of assembly.stacks) {
    templates.set(s.stackName, s.template as Json);
    stackRegions.set(s.stackName, s.environment.region);
  }
}, 600_000);

const cellName = (env: EnvName, cell: HomeRegion) => names.stack(env, `cell-${cell}`);
const resources = (t: Json, type?: string): Array<[string, Res]> =>
  Object.entries((t.Resources ?? {}) as Record<string, Res>).filter(([, r]) => !type || r.Type === type);
const combos = ENVS.flatMap((env) => HOME_REGIONS.map((cell) => [env, cell] as const));
const allRegions = [...new Set([...HOME_REGIONS.map((c) => REGIONS[c].awsRegion), ...HOME_REGIONS.map((c) => REGIONS[c].backupRegion).filter(Boolean), ...FORBIDDEN_STACK_REGIONS])] as string[];

/** Every string leaf of a JSON value, skipping nodes `skip` says to ignore. */
function strings(node: unknown, skip: (n: unknown) => boolean, out: string[] = []): string[] {
  if (skip(node)) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => strings(n, skip, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => strings(n, skip, out));
  return out;
}
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

describe('app topology', () => {
  it('12. never creates a stack in us-east-1 or us-west-2, and every stack is in its permitted region', () => {
    expect(stackRegions.size).toBe(ENVS.length * (1 + HOME_REGIONS.length + HOME_REGIONS.filter((c) => REGIONS[c].backupRegion).length));
    for (const [name, region] of stackRegions) {
      expect(FORBIDDEN_STACK_REGIONS as readonly string[]).not.toContain(region);
      if (name.endsWith('-global')) expect(region).toBe(GLOBAL_REGION);
    }
  });

  it.each(combos)('5. %s cell %s is deployed in its home region; its copy vault only in the permitted backup region', (env, cell) => {
    expect(stackRegions.get(cellName(env, cell))).toBe(REGIONS[cell].awsRegion);
    const copy = names.stack(env, `backup-copy-${cell}`);
    if (REGIONS[cell].backupRegion) expect(stackRegions.get(copy)).toBe(REGIONS[cell].backupRegion);
    else expect(stackRegions.has(copy)).toBe(false);
  });

  it('4. no template contains a CloudFront distribution', () => {
    for (const [name, t] of templates) {
      expect(resources(t).filter(([, r]) => r.Type.startsWith('AWS::CloudFront::')), name).toEqual([]);
    }
  });
});

describe.each(combos)('%s cell %s', (env, cell) => {
  let t: Json;
  let tpl: Template;
  const spec = REGIONS[cell];
  const cfg = loadConfig(env);
  beforeAll(() => {
    t = templates.get(cellName(env, cell))!;
    tpl = Template.fromJSON(t);
  });

  it('1. Aurora is Multi-AZ and KMS-encrypted; Valkey is Multi-AZ with failover and encryption at rest + in transit', () => {
    const instances = resources(t, 'AWS::RDS::DBInstance');
    expect(instances.length).toBeGreaterThanOrEqual(2);
    expect(new Set(instances.map(([, r]) => r.Properties!.AvailabilityZone)).size).toBeGreaterThanOrEqual(2);
    tpl.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      StorageEncrypted: true,
      KmsKeyId: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
      EnableIAMDatabaseAuthentication: true,
      BackupRetentionPeriod: cfg.aurora.backupRetentionDays,
      DeletionProtection: env === 'prod',
    });
    tpl.hasResourceProperties('AWS::RDS::DBProxy', { RequireTLS: true });
    tpl.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'valkey',
      MultiAZEnabled: true,
      AutomaticFailoverEnabled: true,
      AtRestEncryptionEnabled: true,
      TransitEncryptionEnabled: true,
    });
    const [, rg] = resources(t, 'AWS::ElastiCache::ReplicationGroup')[0]!;
    expect(rg.Properties!.KmsKeyId).toBeDefined();
    expect(rg.Properties!.NumCacheClusters).toBeGreaterThanOrEqual(2);
  });

  it('2. buckets block all public access and are encrypted; the files bucket is versioned SSE-KMS and region-named', () => {
    const buckets = resources(t, 'AWS::S3::Bucket');
    expect(buckets.length).toBe(2);
    for (const [, b] of buckets) {
      expect(b.Properties!.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(b.Properties!.BucketEncryption.ServerSideEncryptionConfiguration.length).toBe(1);
      expect(b.Properties!.BucketName).toContain(spec.awsRegion);
    }
    const files = buckets.find(([, b]) => String(b.Properties!.BucketName).includes('-files-'))![1];
    expect(files.Properties!.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    const sse = files.Properties!.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault;
    expect(sse.SSEAlgorithm).toBe('aws:kms');
    expect(sse.KMSMasterKeyID).toBeDefined();
    expect(files.Properties!.LoggingConfiguration).toBeDefined();
    // Both buckets deny non-TLS access.
    const policies = resources(t, 'AWS::S3::BucketPolicy');
    expect(policies.length).toBe(2);
    for (const [, p] of policies) {
      expect(p.Properties!.PolicyDocument.Statement.some((s: Json) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')).toBe(true);
    }
  });

  it('3. every ALB has a WAF web ACL association; HTTPS is TLS 1.2+ and HTTP only redirects', () => {
    expectWafOnEveryAlb(t);
    expectHttpsOnly(t);
  });

  it('5. no resource names another home region (only the directory in eu-west-2 and the permitted backup copy)', () => {
    const forbidden = allRegions.filter((r) => r !== spec.awsRegion);
    const tableArn = `arn:aws:dynamodb:${GLOBAL_REGION}:${cfg.account}:table/${names.directoryTable(env)}`;
    const allowed = new Set([tableArn, `${tableArn}/index/*`, `arn:aws:kms:${GLOBAL_REGION}:${cfg.account}:key/*`, `dynamodb.${GLOBAL_REGION}.amazonaws.com`]);
    // Copy actions are skipped here and checked precisely in test 6.
    const skip = (n: unknown) =>
      (typeof n === 'string' && allowed.has(n)) ||
      (!!n && typeof n === 'object' && !Array.isArray(n) && ((n as Json).Name === 'DIRECTORY_REGION' || 'DestinationBackupVaultArn' in (n as Json)));
    const leaks = strings(t, skip).filter((s) => forbidden.some((r) => s.includes(r)));
    expect(leaks).toEqual([]);
  });

  it('6. backup copies go only to the permitted region (EU → eu-west-1, US → us-west-1, UK → none)', () => {
    tpl.resourceCountIs('AWS::Backup::BackupPlan', 1);
    const [, plan] = resources(t, 'AWS::Backup::BackupPlan')[0]!;
    const rules = plan.Properties!.BackupPlan.BackupPlanRule as Json[];
    expect(rules.some((r) => r.EnableContinuousBackup === true)).toBe(true);
    const destinations = rules.flatMap((r) => asArray(r.CopyActions).map((c: Json) => c.DestinationBackupVaultArn));
    if (spec.backupRegion === null) expect(destinations).toEqual([]);
    else expect(destinations).toEqual([`arn:aws:backup:${spec.backupRegion}:${cfg.account}:backup-vault:${names.copyVault(env, cell)}`]);
    tpl.hasResourceProperties('AWS::Backup::BackupVault', { EncryptionKeyArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } });
  });

  it('7. IAM: no wildcard actions and no Resource "*" outside the documented allow-list', () => expectLeastPrivilege(t));

  it('8. the mock IdP is enabled in dev/staging only and never in prod', () => {
    const containers = resources(t, 'AWS::ECS::TaskDefinition').flatMap(([, r]) => r.Properties!.ContainerDefinitions as Json[]);
    const mockEnv = containers.flatMap((c) => asArray(c.Environment as Json[]).filter((e) => e.Name === 'MOCK_IDP_ENABLED'));
    const mockSecrets = containers.flatMap((c) => asArray(c.Secrets as Json[]).filter((s) => String(s.Name).startsWith('MOCK_IDP')));
    if (env === 'prod') {
      expect(mockEnv).toEqual([]);
      expect(mockSecrets).toEqual([]);
      expect(JSON.stringify(t)).not.toContain('mock-idp"');
    } else {
      expect(mockEnv.length).toBe(2); // api + worker
      expect(mockEnv.every((e) => e.Value === 'true')).toBe(true);
      expect(mockSecrets.length).toBe(4);
    }
  });

  it('9. every log group is KMS-encrypted with a retention period', () => expectEncryptedLogs(t, cfg.logRetentionDays));

  it('sizes follow the environment config (cost-lean staging, Multi-AZ prod)', () => {
    tpl.resourceCountIs('AWS::EC2::NatGateway', cfg.natGateways);
    tpl.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: cfg.aurora.minAcu, MaxCapacity: cfg.aurora.maxAcu },
    });
    tpl.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', { CacheNodeType: cfg.valkey.nodeType });
    const services = resources(t, 'AWS::ECS::Service');
    expect(services.length).toBe(3);
    for (const [, s] of services) {
      if (env === 'prod') expect(s.Properties!.DesiredCount).toBeGreaterThanOrEqual(2);
      if (env === 'staging') expect(s.Properties!.DesiredCount).toBe(1);
    }
    if (env === 'staging') {
      expect(cfg.aurora.minAcu).toBe(0.5);
      expect(cfg.natGateways).toBe(1);
      expect(cfg.valkey).toEqual({ nodeType: 'cache.t4g.micro', replicas: 1 });
    }
    if (env === 'prod') expect(cfg.natGateways).toBe(3);
  });

  it('data export: api and worker may assume only customer roles named thapsus-hr-export-* (sts:AssumeRole, no wildcard actions)', () => {
    const statements = resources(t, 'AWS::IAM::Policy').flatMap(([, r]) => asArray(r.Properties!.PolicyDocument.Statement as Json[]));
    const assume = statements.filter((s) => asArray(s.Action as string[]).some((a) => a.startsWith('sts:')));
    expect(assume.length).toBe(2); // api and worker task roles
    for (const s of assume) {
      expect(s).toMatchObject({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: EXPORT_ROLE_ARN_PATTERN, Sid: 'AssumeCustomerExportRoles' });
    }
    expect(EXPORT_ROLE_ARN_PATTERN).toBe('arn:aws:iam::*:role/thapsus-hr-export-*');
  });

  it('services receive the documented configuration', () => {
    const [, apiTask] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith('-api'))!;
    const app = (apiTask.Properties!.ContainerDefinitions as Json[]).find((c) => c.Name === 'app')!;
    const envNames = (app.Environment as Json[]).map((e) => e.Name);
    for (const n of [
      'APP_ENV', 'CELL_REGION', 'SERVICE_ROLE', 'THAPSUS_HR_DOMAIN', 'APP_BASE_URL', 'API_BASE_URL', 'GLOBAL_BASE_URL',
      'DATABASE_HOST', 'REPORTING_DATABASE_HOST', 'VALKEY_URL', 'FILES_BUCKET', 'FILES_KMS_KEY_ARN', 'KMS_KEY_ARN',
      'EVENT_BUS_NAME', 'QUEUE_URL_JOBS', 'QUEUE_URL_WEBHOOKS', 'MAIL_TRANSPORT', 'SES_CONFIGURATION_SET', 'LOG_LEVEL',
      'OTEL_EXPORTER_OTLP_ENDPOINT', 'BACKUP_VAULT_ARN', 'DIRECTORY_TABLE', 'DIRECTORY_REGION',
    ]) expect(envNames, n).toContain(n);
    expect((app.Secrets as Json[]).map((s) => s.Name)).toEqual(
      expect.arrayContaining(['DATABASE_SECRET', 'BACKOFFICE_DATABASE_SECRET', 'REPORTING_DATABASE_SECRET', 'VALKEY_AUTH_TOKEN', 'INTERNAL_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']),
    );
    expect((apiTask.Properties!.ContainerDefinitions as Json[]).map((c) => c.Name)).toContain('otel-collector');
    // Phase 7: reports and data exports read through the Aurora reader endpoint (reporting role), on api AND worker.
    const [readerId] = resources(t, 'AWS::RDS::DBCluster')[0]!;
    for (const family of ['-api', '-worker']) {
      const [, task] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith(family))!;
      const c = (task.Properties!.ContainerDefinitions as Json[]).find((x) => x.Name === 'app')!;
      const reader = (c.Environment as Json[]).find((e) => e.Name === 'REPORTING_DATABASE_HOST')!;
      expect(reader.Value, family).toEqual({ 'Fn::GetAtt': [readerId, 'ReadEndpoint.Address'] });
      const writer = (c.Environment as Json[]).find((e) => e.Name === 'DATABASE_HOST')!;
      expect(JSON.stringify(writer.Value)).toContain('Endpoint'); // the RDS Proxy (writer)
      expect((c.Secrets as Json[]).map((s) => s.Name)).toContain('REPORTING_DATABASE_SECRET');
    }
    const [, migrator] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith('-migrator'))!;
    const m = (migrator.Properties!.ContainerDefinitions as Json[])[0]!;
    expect(m.Command).toEqual(['node', 'dist/migrate.mjs']);
    expect((m.Secrets as Json[]).map((s) => s.Name).sort()).toEqual(
      ['APP_DATABASE_SECRET', 'BACKOFFICE_DATABASE_SECRET', 'OWNER_DATABASE_SECRET', 'REPORTING_DATABASE_SECRET'],
    );
  });
});

describe.each(ENVS)('%s global stack', (env) => {
  let t: Json;
  const cfg = loadConfig(env);
  beforeAll(() => {
    t = templates.get(names.stack(env, 'global'))!;
  });

  it('10. the tenant directory only ever names allow-listed, non-personal attributes', () => {
    const tables = resources(t, 'AWS::DynamoDB::Table');
    expect(tables.length).toBe(1);
    const p = tables[0]![1].Properties!;
    expect(p.TableName).toBe(names.directoryTable(env));
    const attrNames = [
      ...(p.AttributeDefinitions as Json[]).map((a) => a.AttributeName),
      ...(p.KeySchema as Json[]).map((k) => k.AttributeName),
      ...(p.GlobalSecondaryIndexes as Json[]).flatMap((g) => [
        ...(g.KeySchema as Json[]).map((k) => k.AttributeName),
        ...asArray(g.Projection.NonKeyAttributes as string[]),
      ]),
    ];
    for (const a of attrNames) expect(DIRECTORY_ATTRIBUTES as readonly string[]).toContain(a);
    expect(p.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect((p.GlobalSecondaryIndexes as Json[]).map((g) => g.IndexName)).toEqual(['byDomain']);
    expect(p.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(p.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: 'KMS' });
    expect(p.DeletionProtectionEnabled).toBe(env === 'prod');
    for (const a of DIRECTORY_ATTRIBUTES) expect(a).not.toMatch(/email|name$|phone|address|birth|ssn|nino|national|salary/i);
  });

  it('11. contains no cell-region resource and no regional data stores', () => {
    const others = allRegions.filter((r) => r !== GLOBAL_REGION);
    expect(strings(t, () => false).filter((s) => others.some((r) => s.includes(r)))).toEqual([]);
    expect(resources(t).filter(([, r]) => /^AWS::(RDS|ElastiCache|SQS|CloudFront)::/.test(r.Type))).toEqual([]);
    expect(stackRegions.get(names.stack(env, 'global'))).toBe(GLOBAL_REGION);
  });

  it('3/7/9. WAF on the ALB, HTTPS only, least-privilege IAM, encrypted logs', () => {
    expectWafOnEveryAlb(t);
    expectHttpsOnly(t);
    expectLeastPrivilege(t);
    expectEncryptedLogs(t, cfg.logRetentionDays);
  });

  it('runs the api in global mode and the web app in marketing mode; Route 53 only with a domain', () => {
    const tasks = resources(t, 'AWS::ECS::TaskDefinition').map(([, r]) => (r.Properties!.ContainerDefinitions as Json[])[0]!);
    const env_ = (c: Json, n: string) => (c.Environment as Json[]).find((e) => e.Name === n)?.Value;
    expect(tasks.map((c) => env_(c, 'SERVICE_ROLE'))).toEqual(['global', 'global']);
    expect(tasks.some((c) => env_(c, 'SITE_MODE') === 'marketing')).toBe(true);
    expect(tasks.flatMap((c) => asArray(c.Environment as Json[])).some((e) => e.Name === 'MOCK_IDP_ENABLED')).toBe(false);
    expect(resources(t, 'AWS::Route53::HostedZone').length).toBe(cfg.domain ? 1 : 0);
    expect(resources(t, 'AWS::SecretsManager::Secret').map(([, r]) => r.Properties!.Name)).toEqual(
      expect.arrayContaining([names.internalTokenSecret(env), `thapsus-hr/${env}/stripe`]),
    );
  });
});

describe.each(ENVS)('%s backup copy vaults', (env) => {
  it('exist only for cells with a permitted backup region, KMS-encrypted', () => {
    for (const cell of HOME_REGIONS) {
      const name = names.stack(env, `backup-copy-${cell}`);
      if (!REGIONS[cell].backupRegion) {
        expect(templates.has(name)).toBe(false);
        continue;
      }
      const tpl = Template.fromJSON(templates.get(name)!);
      tpl.hasResourceProperties('AWS::Backup::BackupVault', { BackupVaultName: names.copyVault(env, cell) });
      tpl.resourceCountIs('AWS::KMS::Key', 1);
      expectLeastPrivilege(templates.get(name)!);
    }
  });
});

// ------------------------------------------------------------------------------------------ helpers

function expectWafOnEveryAlb(t: Json) {
  const albs = resources(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer').map(([id]) => id);
  expect(albs.length).toBeGreaterThan(0);
  const associated = resources(t, 'AWS::WAFv2::WebACLAssociation').map(([, r]) => r.Properties!.ResourceArn?.Ref);
  for (const id of albs) expect(associated).toContain(id);
  for (const [, acl] of resources(t, 'AWS::WAFv2::WebACL')) {
    expect(acl.Properties!.Scope).toBe('REGIONAL');
    const groups = (acl.Properties!.Rules as Json[]).map((r) => r.Statement.ManagedRuleGroupStatement?.Name).filter(Boolean);
    expect(groups.sort()).toEqual(
      ['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesSQLiRuleSet'],
    );
    expect((acl.Properties!.Rules as Json[]).some((r) => r.Statement.RateBasedStatement)).toBe(true);
  }
}

function expectHttpsOnly(t: Json) {
  const listeners = resources(t, 'AWS::ElasticLoadBalancingV2::Listener').map(([, r]) => r.Properties!);
  for (const l of listeners) {
    if (l.Protocol === 'HTTPS') expect(l.SslPolicy).toMatch(/TLS13-1-2|TLS-1-2/);
    else expect(l.DefaultActions[0].Type).toBe('redirect');
  }
  expect(listeners.some((l) => l.Protocol === 'HTTPS')).toBe(true);
}

/** Actions AWS only supports on Resource "*", plus what CDK's ECS execution role needs. */
const STAR_RESOURCE_ALLOWED = new Set([...XRAY_ACTIONS, 'ecr:GetAuthorizationToken', 'logs:CreateLogStream', 'logs:PutLogEvents']);

function expectLeastPrivilege(t: Json) {
  const docs: Array<[string, Json]> = [];
  for (const [id, r] of resources(t, 'AWS::IAM::Policy')) docs.push([id, r.Properties!.PolicyDocument]);
  for (const [id, r] of resources(t, 'AWS::IAM::Role')) for (const p of asArray(r.Properties!.Policies as Json[])) docs.push([id, p.PolicyDocument]);
  const problems: string[] = [];
  for (const [id, doc] of docs) {
    for (const s of asArray(doc.Statement as Json[])) {
      if (s.Effect !== 'Allow') continue;
      const actions = asArray(s.Action as string[]);
      const resources_ = asArray(s.Resource as unknown[]);
      if (actions.some((a) => a === '*' || /^[a-z0-9-]+:\*$/i.test(a))) problems.push(`${id}: wildcard action ${actions.join(',')}`);
      if (s.NotAction || s.NotResource) problems.push(`${id}: NotAction/NotResource`);
      if (resources_.includes('*')) {
        const bad = actions.filter((a) => !STAR_RESOURCE_ALLOWED.has(a));
        if (bad.length) problems.push(`${id}: Resource "*" for ${bad.join(',')}`);
      }
    }
  }
  expect(problems).toEqual([]);
}

function expectEncryptedLogs(t: Json, retention: number) {
  const groups = resources(t, 'AWS::Logs::LogGroup');
  expect(groups.length).toBeGreaterThan(0);
  for (const [id, g] of groups) {
    expect(g.Properties?.KmsKeyId, id).toBeDefined();
    expect(g.Properties?.RetentionInDays, id).toBe(retention);
  }
}
