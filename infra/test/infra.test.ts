import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS, type HomeRegion } from '@thapsus/core/regions';
import { TenantRouter } from '../../packages/db/src/router';
import { buildApp } from '../lib/app';
import { ENVS, FORBIDDEN_STACK_REGIONS, GLOBAL_REGION, loadConfig, names, validateConfig, type DedicatedDatabase, type EnvConfig, type EnvName } from '../lib/config';
import { DIRECTORY_ATTRIBUTES } from '../lib/global-stack';
import { XRAY_ACTIONS } from '../lib/shared';
import { AUDIT_STREAM_ROLE_ARN_PATTERN, CellStack, EXPORT_ROLE_ARN_PATTERN } from '../lib/cell-stack';

type Json = Record<string, any>;
type Res = { Type: string; Properties?: Json; DeletionPolicy?: string };

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
    // per environment: global, CI (OIDC deploy roles), three cells and the permitted backup-copy vaults
    expect(stackRegions.size).toBe(ENVS.length * (2 + HOME_REGIONS.length + HOME_REGIONS.filter((c) => REGIONS[c].backupRegion).length));
    for (const [name, region] of stackRegions) {
      expect(FORBIDDEN_STACK_REGIONS as readonly string[]).not.toContain(region);
      if (name.endsWith('-global') || name.endsWith('-ci')) expect(region).toBe(GLOBAL_REGION);
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
    expect(regionLeaks(t, cfg, cell)).toEqual([]);
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

  it('cross-account roles: api and worker may assume only thapsus-hr-export-* (data export), the worker only thapsus-hr-audit-* (S3 audit streams); sts:AssumeRole, no wildcard actions', () => {
    const policies = resources(t, 'AWS::IAM::Policy').map(([, r]) => r.Properties!);
    const sts = policies.flatMap((p) => asArray(p.PolicyDocument.Statement as Json[]).filter((s) => asArray(s.Action as string[]).some((a) => a.startsWith('sts:'))).map((s) => ({ s, roles: asArray(p.Roles as Json[]) })));
    expect(sts.length).toBe(3); // export: api + worker task roles; audit streams: worker task role
    const taskRole = (family: string) => resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith(family))![1].Properties!.TaskRoleArn['Fn::GetAtt'][0];
    const holders = (sid: string) => sts.filter((x) => x.s.Sid === sid).flatMap((x) => x.roles.map((r) => r.Ref)).sort();
    for (const { s } of sts) {
      expect(Object.keys(s).sort()).toEqual(['Action', 'Effect', 'Resource', 'Sid']); // no conditions to widen or narrow it silently
      expect(s.Effect).toBe('Allow');
      expect(s.Action).toBe('sts:AssumeRole');
      expect(s.Resource).toBe(s.Sid === 'AssumeCustomerAuditStreamRoles' ? AUDIT_STREAM_ROLE_ARN_PATTERN : EXPORT_ROLE_ARN_PATTERN);
    }
    expect(sts.map((x) => x.s.Sid).sort()).toEqual(['AssumeCustomerAuditStreamRoles', 'AssumeCustomerExportRoles', 'AssumeCustomerExportRoles']);
    expect(holders('AssumeCustomerExportRoles')).toEqual([taskRole('-api'), taskRole('-worker')].sort());
    expect(holders('AssumeCustomerAuditStreamRoles')).toEqual([taskRole('-worker')]);
    expect(EXPORT_ROLE_ARN_PATTERN).toBe('arn:aws:iam::*:role/thapsus-hr-export-*');
    expect(AUDIT_STREAM_ROLE_ARN_PATTERN).toBe('arn:aws:iam::*:role/thapsus-hr-audit-*');
  });

  it('the rest of the cell: autoscaling, SQS with DLQs, event bus, scheduler group, SES configuration set, budget alarm, 3 AZs, TLS certificate', () => {
    // web, api and worker scale automatically
    const targets = resources(t, 'AWS::ApplicationAutoScaling::ScalableTarget');
    expect(targets.length).toBe(3);
    for (const [, r] of targets) expect(r.Properties!.MaxCapacity).toBeGreaterThan(r.Properties!.MinCapacity);
    expect(resources(t, 'AWS::ApplicationAutoScaling::ScalingPolicy').length).toBeGreaterThanOrEqual(3);
    // every work queue has a dead-letter queue; every queue is KMS-encrypted
    const queues = resources(t, 'AWS::SQS::Queue');
    const work = queues.filter(([, q]) => q.Properties!.RedrivePolicy);
    expect(work.length).toBeGreaterThanOrEqual(2);
    expect(queues.length).toBe(work.length * 2);
    for (const [, q] of work) expect(q.Properties!.RedrivePolicy.maxReceiveCount).toBe(5);
    for (const [, q] of queues) expect(q.Properties!.KmsMasterKeyId).toBeDefined();
    tpl.hasResourceProperties('AWS::Events::EventBus', { Name: `thapsus-hr-${env}` });
    expect(resources(t, 'AWS::Scheduler::ScheduleGroup').length).toBe(1);
    expect(resources(t, 'AWS::SES::ConfigurationSet').length).toBe(1);
    // a cost budget with alert notifications per cell
    const budgets = resources(t, 'AWS::Budgets::Budget');
    expect(budgets.length).toBe(1);
    expect(asArray(budgets[0]![1].Properties!.NotificationsWithSubscribers).length).toBeGreaterThan(0);
    // the VPC spans three availability zones (public, private and isolated subnets)
    const azs = new Set(resources(t, 'AWS::EC2::Subnet').map(([, r]) => JSON.stringify(r.Properties!.AvailabilityZone)));
    expect(azs.size).toBe(3);
    // the HTTPS listener presents a certificate
    const https = resources(t, 'AWS::ElasticLoadBalancingV2::Listener').filter(([, l]) => l.Properties!.Protocol === 'HTTPS');
    expect(https.length).toBeGreaterThan(0);
    for (const [, l] of https) expect(asArray(l.Properties!.Certificates).length).toBe(1);
  });

  it('the web server reaches the api privately over Service Connect (server-rendered app pages)', () => {
    const [, ns] = resources(t, 'AWS::ServiceDiscovery::HttpNamespace')[0]!;
    expect(String(ns.Properties!.Name)).toMatch(/\.internal$/);
    const svc = (suffix: string) => resources(t, 'AWS::ECS::Service').find(([, r]) => String(r.Properties!.ServiceName).endsWith(suffix))![1];
    const apiSc = svc('-api').Properties!.ServiceConnectConfiguration as Json;
    expect(apiSc.Enabled).toBe(true);
    expect((apiSc.Services as Json[]).map((x) => (x.ClientAliases as Json[])[0])).toEqual([{ DnsName: 'api', Port: 4000 }]);
    const webSc = svc('-web').Properties!.ServiceConnectConfiguration as Json;
    expect(webSc.Enabled).toBe(true);
    expect(webSc.Services).toBeUndefined();
    const [, webTask] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith('-web'))!;
    const webApp = (webTask.Properties!.ContainerDefinitions as Json[]).find((c) => c.Name === 'app')!;
    expect((webApp.Environment as Json[]).find((e) => e.Name === 'API_INTERNAL_URL')?.Value).toBe('http://api:4000');
    const ingress = resources(t, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties!);
    expect(ingress.some((r) => r.FromPort === 4000 && r.ToPort === 4000 && r.Description === 'web to api (Service Connect)')).toBe(true);
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
      expect.arrayContaining(['DATABASE_SECRET', 'BACKOFFICE_DATABASE_SECRET', 'REPORTING_DATABASE_SECRET', 'VALKEY_AUTH_TOKEN', 'INTERNAL_TOKEN', 'INTEGRATION_SIGNING_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']),
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

  it("billing: this region's Stripe keys come from the cell's own secret (ADR-0103), never from plain environment values", () => {
    const secrets = resources(t, 'AWS::SecretsManager::Secret').map(([id, r]) => [id, r.Properties!.Name] as const);
    const stripe = secrets.find(([, n]) => n === names.stripeSecret(env, cell));
    expect(stripe, 'cell Stripe secret').toBeDefined();
    // the global stack owns thapsus-hr/<env>/stripe in eu-west-2; a cell never reuses that name
    expect(secrets.map(([, n]) => n)).not.toContain(`thapsus-hr/${env}/stripe`);
    for (const family of ['-api', '-worker']) {
      const [, task] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith(family))!;
      const app = (task.Properties!.ContainerDefinitions as Json[]).find((c) => c.Name === 'app')!;
      const refs = (app.Secrets as Json[]).filter((x) => String(x.Name).startsWith('STRIPE_'));
      expect(refs.map((x) => x.Name).sort()).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
      for (const r of refs) expect(JSON.stringify(r.ValueFrom)).toContain(stripe![0]);
      expect(((app.Environment ?? []) as Json[]).map((e) => e.Name)).not.toContain('STRIPE_SECRET_KEY');
    }
    // the cross-region back-office view may scan the directory table only (no other table)
    const scans = resources(t, 'AWS::IAM::Policy').flatMap(([, p]) => (p.Properties!.PolicyDocument.Statement as Json[]).filter((st) => asArray(st.Action).includes('dynamodb:Scan')));
    expect(scans.length).toBeGreaterThan(0);
    const tableArn = `arn:aws:dynamodb:${GLOBAL_REGION}:${cfg.account}:table/${names.directoryTable(env)}`;
    for (const st of scans) expect(asArray(st.Resource).every((r) => r === tableArn || r === `${tableArn}/index/*`)).toBe(true);
  });
});

describe('dedicated databases (ADR-0068, runbook move-tenant-to-dedicated-db.md)', () => {
  it('the committed env configs declare none: every cell has exactly one Aurora cluster and proxy, one migrator and no DEDICATED_* variables', () => {
    for (const [env, cell] of combos) {
      expect(loadConfig(env).dedicatedDatabases, env).toBeUndefined();
      const t = templates.get(cellName(env, cell))!;
      expect(resources(t, 'AWS::RDS::DBCluster').length).toBe(1);
      expect(resources(t, 'AWS::RDS::DBProxy').length).toBe(1);
      expect(resources(t, 'AWS::ECS::TaskDefinition').length).toBe(4); // api, worker, web, migrator
      expect(JSON.stringify(t)).not.toMatch(/DEDICATED_|Dedicated/);
    }
  });

  it('env config validation refuses unusable entries', () => {
    const base = loadConfig('staging');
    const check = (dedicatedDatabases: unknown) => () => validateConfig({ ...base, dedicatedDatabases } as EnvConfig, 'staging');
    expect(check([{ key: 'big-uk', cell: 'uk' }, { key: 'big-eu', cell: 'eu', minAcu: 1, maxAcu: 32 }])).not.toThrow();
    expect(check([])).not.toThrow();
    for (const bad of [
      { key: 'big', cell: 'fr' },
      { key: 'shared', cell: 'uk' },
      { key: 'Big', cell: 'uk' },
      { key: 'big_co', cell: 'uk' },
      { key: 'big--co', cell: 'uk' },
      { key: '1big', cell: 'uk' },
      { key: 'b'.repeat(25), cell: 'uk' },
      { key: 'big', cell: 'uk', minAcu: 8, maxAcu: 4 },
      { key: 'big', cell: 'uk', maxAcu: 300 },
      { key: 'big', cell: 'uk', minAcu: 0.25 },
      { key: 'big', cell: 'uk', Key: 'typo' },
      { cell: 'uk' },
    ]) {
      expect(check([bad]), JSON.stringify(bad)).toThrow(/dedicatedDatabases\[0\]/);
    }
    expect(check([{ key: 'big-co', cell: 'uk' }, { key: 'bigco', cell: 'eu' }])).toThrow(/used twice/);
    expect(check({ key: 'big', cell: 'uk' })).toThrow(/must be a list/);
  });

  // One dedicated database per cell (fictional keys), synthesized for a cost-lean and a production environment.
  const DEDICATED: DedicatedDatabase[] = [{ key: 'big-uk', cell: 'uk' }, { key: 'big-eu', cell: 'eu', minAcu: 1, maxAcu: 32 }, { key: 'big-us', cell: 'us' }];
  const dedicatedCombos = (['staging', 'prod'] as const).flatMap((env) => HOME_REGIONS.map((cell) => [env, cell] as const));
  const synthesized = new Map<string, { t: Json; region: string; cfg: EnvConfig }>();
  beforeAll(() => {
    const app = new App({ context: { ...flags, 'aws:cdk:disable-asset-staging': true }, outdir: mkdtempSync(join(tmpdir(), 'cdk-dedicated-')) });
    const configs = new Map<EnvName, EnvConfig>();
    for (const [env, cell] of dedicatedCombos) {
      if (!configs.has(env)) {
        const c = { ...loadConfig(env), dedicatedDatabases: DEDICATED };
        validateConfig(c, env);
        configs.set(env, c);
      }
      const config = configs.get(env)!;
      new CellStack(app, `Dedicated-${env}-${cell}`, { env: { account: config.account, region: REGIONS[cell].awsRegion }, config, cell, crossRegionReferences: false });
    }
    for (const s of app.synth().stacks) {
      const [, env, cell] = s.stackName.split('-') as [string, EnvName, HomeRegion];
      synthesized.set(`${env}:${cell}`, { t: s.template as Json, region: s.environment.region, cfg: configs.get(env)! });
    }
  }, 600_000);

  describe.each(dedicatedCombos)('%s cell %s with a dedicated database', (env, cell) => {
    const entry = DEDICATED.find((d) => d.cell === cell)!;
    const identifier = `thapsus-hr-${env}-${cell}-${entry.key}`;
    let t: Json;
    let cfg: EnvConfig;
    let shared: [string, Res];
    let mine: [string, Res];
    beforeAll(() => {
      ({ t, cfg } = synthesized.get(`${env}:${cell}`)!);
      const clusters = resources(t, 'AWS::RDS::DBCluster');
      expect(clusters.length).toBe(2);
      shared = clusters.find(([, r]) => r.Properties!.DBClusterIdentifier === `thapsus-hr-${env}-${cell}`)!;
      mine = clusters.find(([, r]) => r.Properties!.DBClusterIdentifier === identifier)!;
    });

    it('creates its Aurora cluster only in this cell\'s region: cell data key, Multi-AZ, backups, deletion protection per env, same network, behind a TLS RDS Proxy', () => {
      expect(synthesized.get(`${env}:${cell}`)!.region).toBe(REGIONS[cell].awsRegion);
      expect(mine, identifier).toBeDefined();
      const p = mine[1].Properties!;
      expect(p).toMatchObject({
        Engine: 'aurora-postgresql',
        StorageEncrypted: true,
        KmsKeyId: shared[1].Properties!.KmsKeyId, // the cell's data key
        EnableIAMDatabaseAuthentication: true,
        BackupRetentionPeriod: cfg.aurora.backupRetentionDays,
        DeletionProtection: env === 'prod',
        VpcSecurityGroupIds: shared[1].Properties!.VpcSecurityGroupIds,
        ServerlessV2ScalingConfiguration: { MinCapacity: entry.minAcu ?? cfg.aurora.minAcu, MaxCapacity: entry.maxAcu ?? cfg.aurora.maxAcu },
      });
      expect(mine[1].DeletionPolicy ?? 'Delete').toBe(shared[1].DeletionPolicy ?? 'Delete');
      // writer + reporting reader in two AZs of this region
      const instances = resources(t, 'AWS::RDS::DBInstance').filter(([, r]) => r.Properties!.DBClusterIdentifier?.Ref === mine[0]);
      expect(instances.length).toBe(2);
      expect(new Set(instances.map(([, r]) => r.Properties!.AvailabilityZone)).size).toBe(2);
      for (const [, r] of instances) expect(String(r.Properties!.AvailabilityZone).startsWith(REGIONS[cell].awsRegion)).toBe(true);
      // isolated subnets of the cell VPC, like the shared cluster
      const subnets = (id: string) => resources(t, 'AWS::RDS::DBSubnetGroup').find(([sid]) => sid === id)![1].Properties!.SubnetIds;
      expect(subnets(p.DBSubnetGroupName.Ref)).toEqual(subnets(shared[1].Properties!.DBSubnetGroupName.Ref));
      // its own owner secret, encrypted with the cell key
      const secretNames = resources(t, 'AWS::SecretsManager::Secret').map(([, r]) => r.Properties!.Name);
      expect(secretNames).toContain(`thapsus-hr/${env}/db/${entry.key}/thapsus_owner`);
      const proxies = resources(t, 'AWS::RDS::DBProxy').map(([, r]) => r.Properties!);
      expect(proxies.find((x) => x.DBProxyName === `${identifier}-proxy`)).toMatchObject({ RequireTLS: true, EngineFamily: 'POSTGRESQL' });
      // in the cell's backup plan (continuous + daily, copies only to the permitted region)
      const [, selection] = resources(t, 'AWS::Backup::BackupSelection')[0]!;
      expect(JSON.stringify(selection.Properties!.BackupSelection.Resources)).toContain(`{"Ref":"${mine[0]}"}`);
      // only this cell's entry
      for (const other of DEDICATED.filter((d) => d.cell !== cell)) expect(JSON.stringify(t)).not.toContain(other.key);
    });

    it('wires DEDICATED_DATABASE_HOSTS (its proxy) and DEDICATED_READER_HOSTS (its reader) into the api and worker, in the format TenantRouter.fromEnv reads', () => {
      const [proxyId] = resources(t, 'AWS::RDS::DBProxy').find(([, r]) => r.Properties!.DBProxyName === `${identifier}-proxy`)!;
      for (const family of ['-api', '-worker']) {
        const [, task] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith(family))!;
        const c = (task.Properties!.ContainerDefinitions as Json[]).find((x) => x.Name === 'app')!;
        const value = (n: string) => resolve((c.Environment as Json[]).find((e) => e.Name === n)?.Value ?? '');
        expect(JSON.parse(value('DEDICATED_DATABASE_HOSTS')), family).toEqual({ [entry.key]: `<${proxyId}.Endpoint>` });
        expect(JSON.parse(value('DEDICATED_READER_HOSTS')), family).toEqual({ [entry.key]: `<${mine[0]}.ReadEndpoint.Address>` });
        expect((c.Secrets as Json[]).map((s) => s.Name)).toEqual(expect.arrayContaining(['DATABASE_SECRET', 'REPORTING_DATABASE_SECRET']));
        const fictional = (u: string) => JSON.stringify({ username: u, password: 'fictional-pw', port: 5432, dbname: 'thapsus' });
        const router = TenantRouter.fromEnv({
          CELL_REGION: cell,
          DATABASE_SECRET: fictional('thapsus_app'),
          DATABASE_HOST: 'shared-proxy.internal',
          REPORTING_DATABASE_SECRET: fictional('thapsus_reporting'),
          DEDICATED_DATABASE_HOSTS: value('DEDICATED_DATABASE_HOSTS'),
          DEDICATED_READER_HOSTS: value('DEDICATED_READER_HOSTS'),
        });
        expect(router.config.databases[entry.key]).toBe(`postgres://thapsus_app:fictional-pw@<${proxyId}.Endpoint>:5432/thapsus`);
        expect(router.config.readers?.[entry.key]).toBe(`postgres://thapsus_reporting:fictional-pw@<${mine[0]}.ReadEndpoint.Address>:5432/thapsus`);
      }
      // the web tier never gets database configuration
      const [, web] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith('-web'))!;
      expect(JSON.stringify(web.Properties!.ContainerDefinitions)).not.toContain('DEDICATED_');
    });

    it('has a tools task that migrates it (default command) and runs the move runner with both owner secrets; outputs for the deploy script', () => {
      const [, task] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => r.Properties!.Family === `thapsus-hr-${env}-${cell}-db-${entry.key}`)!;
      const c = (task.Properties!.ContainerDefinitions as Json[])[0]!;
      expect(c.Name).toBe('tools');
      expect(c.Command).toEqual(['node', 'dist/migrate.mjs']);
      const envOf = Object.fromEntries((c.Environment as Json[]).map((e) => [e.Name, e.Value]));
      expect(envOf).toMatchObject({ CELL_REGION: cell, DEDICATED_DB_KEY: entry.key, DATABASE_HOST: { 'Fn::GetAtt': [mine[0], 'Endpoint.Address'] }, SHARED_DATABASE_HOST: { 'Fn::GetAtt': [shared[0], 'Endpoint.Address'] } });
      const secrets = Object.fromEntries((c.Secrets as Json[]).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]));
      expect(Object.keys(secrets).sort()).toEqual(['APP_DATABASE_SECRET', 'BACKOFFICE_DATABASE_SECRET', 'OWNER_DATABASE_SECRET', 'REPORTING_DATABASE_SECRET', 'SHARED_OWNER_DATABASE_SECRET']);
      expect(secrets.OWNER_DATABASE_SECRET).not.toBe(secrets.SHARED_OWNER_DATABASE_SECRET);
      // the role secrets are the ones the api, worker and shared migrator use (same passwords on every database)
      const [, migrator] = resources(t, 'AWS::ECS::TaskDefinition').find(([, r]) => String(r.Properties!.Family).endsWith('-migrator'))!;
      const m = Object.fromEntries(((migrator.Properties!.ContainerDefinitions as Json[])[0]!.Secrets as Json[]).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]));
      for (const n of ['APP_DATABASE_SECRET', 'BACKOFFICE_DATABASE_SECRET', 'REPORTING_DATABASE_SECRET']) expect(secrets[n], n).toBe(m[n]);
      expect(secrets.SHARED_OWNER_DATABASE_SECRET).toBe(m.OWNER_DATABASE_SECRET);
      const o = names.dedicatedOutputs(entry.key);
      expect(Object.keys(t.Outputs)).toEqual(expect.arrayContaining([o.proxyEndpoint, o.writerEndpoint, o.toolsTaskDefinitionArn, 'MigratorSubnetIds', 'MigratorSecurityGroupId']));
    });

    it('still names no other region, keeps IAM least-privilege and encrypts every log group', () => {
      expect(regionLeaks(t, cfg, cell)).toEqual([]);
      expectLeastPrivilege(t);
      expectEncryptedLogs(t, cfg.logRetentionDays);
    });
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

describe.each(ENVS)('%s CI stack (GitHub OIDC, no long-lived keys)', (env) => {
  let t: Json;
  const cfg = loadConfig(env);
  beforeAll(() => {
    t = templates.get(names.stack(env, 'ci'))!;
  });

  it('creates one deploy role per region this environment deploys to, assumable only from this repo and GitHub environment', () => {
    const envRegions = [...stackRegions].filter(([n]) => n.startsWith(`ThapsusHr-${env}-`)).map(([, r]) => r);
    const roles = resources(t, 'AWS::IAM::Role');
    expect(roles.map(([, r]) => r.Properties!.RoleName).sort()).toEqual([...new Set(envRegions)].map((r) => `thapsus-hr-${env}-deploy-${r}`).sort());
    for (const [, r] of roles) {
      const stmt = asArray(r.Properties!.AssumeRolePolicyDocument.Statement as Json[]);
      expect(stmt).toHaveLength(1);
      expect(stmt[0]!.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(stmt[0]!.Condition.StringEquals).toEqual({
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${cfg.ci.githubRepository}:environment:${cfg.ci.githubEnvironment}`,
      });
    }
    if (env === 'prod') expect(cfg.ci.githubEnvironment).toBe('production');
  });

  it('each role can only reach its own region, through the CDK bootstrap roles', () => {
    expectLeastPrivilege(t);
    const policies = resources(t, 'AWS::IAM::Policy');
    expect(policies.length).toBe(resources(t, 'AWS::IAM::Role').length);
    for (const [id, p] of policies) {
      const own = allRegions.find((r) => id.startsWith(`Deploy${r.replace(/-/g, '')}`));
      expect(own, id).toBeDefined();
      const statements = asArray(p.Properties!.PolicyDocument.Statement as Json[]);
      // the one documented exception: cells read the env's internal service token from the global layer
      const crossRegion = statements.filter((st) => /^ReadGlobalInternalToken/.test(st.Sid));
      for (const st of crossRegion) {
        expect(JSON.stringify(st.Resource)).toMatch(new RegExp(`:${GLOBAL_REGION}:`));
        expect(asArray(st.Action as string[]).every((a) => a === 'secretsmanager:GetSecretValue' || a === 'kms:Decrypt'), st.Sid).toBe(true);
      }
      const text = JSON.stringify(statements.filter((st) => !crossRegion.includes(st)));
      expect(text).toMatch(new RegExp(`[:-]${own}(?![0-9])`));
      for (const r of allRegions.filter((x) => x !== own)) expect(new RegExp(`[:-]${r}(?![0-9])`).test(text), `${id} must not reach ${r}`).toBe(false);
      for (const stmt of statements) {
        if (asArray(stmt.Action as string[]).includes('sts:AssumeRole')) for (const res of asArray(stmt.Resource as string[])) expect(JSON.stringify(res)).toMatch(/:role\/cdk-hnb659fds-(deploy|file-publishing|image-publishing|lookup)-role-/);
      }
    }
  });

  it('only cell regions get post-deploy permissions (migrator, restart, own secrets)', () => {
    for (const [id, p] of resources(t, 'AWS::IAM::Policy')) {
      const sids = asArray(p.Properties!.PolicyDocument.Statement as Json[]).map((st) => st.Sid);
      const cellRegion = HOME_REGIONS.some((c) => id.startsWith(`Deploy${REGIONS[c].awsRegion.replace(/-/g, '')}`));
      expect(sids.includes('RunMigrator'), id).toBe(cellRegion);
    }
  });

  it('no two stacks create a secret with the same name in the same region', () => {
    const seen = new Map<string, string>();
    for (const [name, tpl] of templates) {
      if (!name.startsWith(`ThapsusHr-${env}-`)) continue;
      for (const [, r] of resources(tpl, 'AWS::SecretsManager::Secret')) {
        const key = `${stackRegions.get(name)}:${JSON.stringify(r.Properties!.Name)}`;
        expect(seen.get(key), `${key} in ${name}`).toBeUndefined();
        seen.set(key, name);
      }
    }
  });

  it('no stack in any environment creates IAM users or access keys', () => {
    for (const [name, tpl] of templates) expect(resources(tpl).filter(([, r]) => r.Type === 'AWS::IAM::User' || r.Type === 'AWS::IAM::AccessKey'), name).toEqual([]);
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

/** Strings in a cell template that name another region (only the directory in eu-west-2 is allowed; backup copy actions are checked in test 6). */
function regionLeaks(t: Json, cfg: EnvConfig, cell: HomeRegion): string[] {
  const forbidden = allRegions.filter((r) => r !== REGIONS[cell].awsRegion);
  const tableArn = `arn:aws:dynamodb:${GLOBAL_REGION}:${cfg.account}:table/${names.directoryTable(cfg.env)}`;
  const allowed = new Set([tableArn, `${tableArn}/index/*`, `arn:aws:kms:${GLOBAL_REGION}:${cfg.account}:key/*`, `dynamodb.${GLOBAL_REGION}.amazonaws.com`]);
  const skip = (n: unknown) =>
    (typeof n === 'string' && allowed.has(n)) ||
    (!!n && typeof n === 'object' && !Array.isArray(n) && ((n as Json).Name === 'DIRECTORY_REGION' || 'DestinationBackupVaultArn' in (n as Json)));
  return strings(t, skip).filter((s) => forbidden.some((r) => s.includes(r)));
}

/** Resolves CloudFormation intrinsics in an environment value to readable placeholders (`<LogicalId.Attr>`). */
function resolve(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Json;
  if (o['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(resolve).join(o['Fn::Join'][0]);
  if (o['Fn::GetAtt']) return `<${o['Fn::GetAtt'].join('.')}>`;
  if (o.Ref) return `<${o.Ref}>`;
  throw new Error(`unresolvable ${JSON.stringify(v)}`);
}

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
