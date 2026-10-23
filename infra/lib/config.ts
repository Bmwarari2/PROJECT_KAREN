import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_REGIONS, type HomeRegion } from '@thapsus/core/regions';

/** `loadtest` is a temporary environment created and torn down by `pnpm loadtest` (brief §8). */
export const ENVS = ['dev', 'staging', 'prod', 'loadtest'] as const;
export type EnvName = (typeof ENVS)[number];

export interface ServiceSize {
  cpu: number;
  memoryMiB: number;
  desiredCount: number;
  minCapacity: number;
  maxCapacity: number;
}

export interface CellSettings {
  /** ACM certificate for the cell ALB. null → the stack takes a `CertificateArn` CloudFormation parameter. */
  certificateArn: string | null;
  monthlyBudgetUsd: number;
}

/**
 * A dedicated Aurora PostgreSQL cluster for one or more very large tenants (ADR-0068, runbook
 * docs/runbooks/move-tenant-to-dedicated-db.md). Each entry is recurring cost: add one only with the
 * product owner's approval (docs/COSTS.md). The committed env configs declare none.
 */
export interface DedicatedDatabase {
  /** Routing key (registry.tenants.db_key and DEDICATED_DATABASE_HOSTS): lower-case letters, digits and single hyphens. */
  key: string;
  /** Home cell of the tenants it serves. The cluster is created in that cell's region only. */
  cell: HomeRegion;
  /** Aurora Serverless v2 capacity; defaults to the environment's `aurora` settings. */
  minAcu?: number;
  maxAcu?: number;
}

/** Router keys the cell stack can turn into AWS names (cluster, proxy, secrets, task family). */
export const DEDICATED_DATABASE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const DEDICATED_DATABASE_KEY_MAX = 24;
const DEDICATED_DATABASE_FIELDS = new Set(['key', 'cell', 'minAcu', 'maxAcu']);

/** Shape of infra/config/<env>.json. Nothing environment-specific is hardcoded in the stacks. */
export interface EnvConfig {
  env: EnvName;
  account: string;
  /** Product domain — not yet chosen (null). No hosted zone or DNS records are created while null. */
  domain: string | null;
  /** Route 53 hosted zone id for `domain` (filled after the global stack first creates the zone). */
  hostedZoneId: string | null;
  alarmEmail: string | null;
  /** Public URL of the global sign-in/marketing service. null → derived from domain, else a CFN parameter. */
  globalBaseUrl: string | null;
  /** Optional overrides: { api: { uk: 'https://…' }, app: { … } }. */
  regionalUrls: { api?: Partial<Record<HomeRegion, string>>; app?: Partial<Record<HomeRegion, string>> };
  logRetentionDays: number;
  natGateways: number;
  aurora: { minAcu: number; maxAcu: number; backupRetentionDays: number; deletionProtection: boolean };
  /** Optional dedicated databases (none by default). Same backups and deletion protection as `aurora`. */
  dedicatedDatabases?: DedicatedDatabase[];
  valkey: { nodeType: string; replicas: number };
  backup: { dailyRetentionDays: number; continuousRetentionDays: number; copyRetentionDays: number };
  services: { api: ServiceSize; worker: ServiceSize; web: ServiceSize };
  wafRateLimitPer5Min: number;
  global: { certificateArn: string | null; monthlyBudgetUsd: number; services: { api: ServiceSize; web: ServiceSize } };
  cells: Record<HomeRegion, CellSettings>;
  billingConfigLocation: string;
  /** Only in the temporary load-test environment: relaxes per-IP throttles for a single load generator. */
  loadTest?: { ipThrottleMultiplier: number };
  /** GitHub Actions OIDC: the only repository and GitHub environment allowed to assume the deploy roles. */
  ci: { githubRepository: string; githubEnvironment: string; oidcProviderArn: string | null };
}

export function loadConfig(env: EnvName): EnvConfig {
  const file = join(import.meta.dirname, '..', 'config', `${env}.json`);
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as EnvConfig;
  validateConfig(cfg, env);
  return cfg;
}

export function validateConfig(cfg: EnvConfig, env: EnvName) {
  const fail = (m: string) => {
    throw new Error(`infra/config/${env}.json: ${m}`);
  };
  if (cfg.env !== env) fail(`env must be "${env}"`);
  if (!/^\d{12}$/.test(cfg.account)) fail('account must be a 12-digit AWS account id');
  for (const r of HOME_REGIONS) if (!cfg.cells[r]) fail(`cells.${r} is missing`);
  for (const [name, s] of Object.entries({ ...cfg.services, ...prefix('global.', cfg.global.services) })) {
    if (s.minCapacity > s.maxCapacity || s.desiredCount < s.minCapacity || s.desiredCount > s.maxCapacity) fail(`services.${name} capacity is inconsistent`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.ci?.githubRepository ?? '')) fail('ci.githubRepository must be owner/repo');
  if (!cfg.ci.githubEnvironment) fail('ci.githubEnvironment is required');
  if (cfg.loadTest && env !== 'loadtest') fail('loadTest settings are only allowed in the loadtest environment');
  validateDedicatedDatabases(cfg.dedicatedDatabases, fail);
  if (env === 'prod') {
    if (cfg.ci.githubEnvironment !== 'production') fail('prod deploys must come from the "production" GitHub environment (manual approval gate)');
    if (cfg.natGateways < 3) fail('prod needs one NAT gateway per AZ (3)');
    for (const [name, s] of Object.entries(cfg.services)) if (s.desiredCount < 2) fail(`prod services.${name}.desiredCount must be >= 2`);
    if (!cfg.aurora.deletionProtection) fail('prod Aurora must have deletion protection');
  }
}

function validateDedicatedDatabases(list: unknown, fail: (m: string) => never) {
  if (list === undefined) return;
  if (!Array.isArray(list)) fail('dedicatedDatabases must be a list');
  const seen = new Set<string>();
  for (const [i, d] of (list as DedicatedDatabase[]).entries()) {
    const at = `dedicatedDatabases[${i}]`;
    if (!d || typeof d !== 'object') fail(`${at} must be an object`);
    for (const k of Object.keys(d)) if (!DEDICATED_DATABASE_FIELDS.has(k)) fail(`${at}.${k} is not a known setting`);
    if (typeof d.key !== 'string' || !DEDICATED_DATABASE_KEY.test(d.key) || d.key.length > DEDICATED_DATABASE_KEY_MAX) {
      fail(`${at}.key must be lower-case letters, digits and single hyphens, start with a letter, at most ${DEDICATED_DATABASE_KEY_MAX} characters`);
    }
    if (d.key === 'shared') fail(`${at}.key "shared" is the cell's shared database`);
    // Construct ids and stack outputs drop the hyphens, so "big-co" and "bigco" would collide.
    const id = d.key.replace(/-/g, '');
    if (seen.has(id)) fail(`${at}.key "${d.key}" is used twice (keys must differ ignoring hyphens)`);
    seen.add(id);
    if (!(HOME_REGIONS as readonly string[]).includes(d.cell)) fail(`${at}.cell must be one of ${HOME_REGIONS.join(', ')}`);
    for (const k of ['minAcu', 'maxAcu'] as const) {
      const v = d[k];
      if (v !== undefined && (typeof v !== 'number' || v < 0.5 || v > 256 || (v * 2) % 1 !== 0)) fail(`${at}.${k} must be 0.5 to 256 in steps of 0.5`);
    }
    if ((d.minAcu ?? 0) > (d.maxAcu ?? Infinity)) fail(`${at}.minAcu must not exceed maxAcu`);
  }
}

/** PascalCase id of a dedicated database key, for construct ids and stack outputs ("big-co" → "BigCo"). */
export const dedicatedDatabaseId = (key: string) => key.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

/** The dedicated databases of one cell. */
export const dedicatedDatabasesFor = (cfg: EnvConfig, cell: HomeRegion) => (cfg.dedicatedDatabases ?? []).filter((d) => d.cell === cell);

const prefix = <T>(p: string, o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));

/** Deterministic, region-free names shared between stacks (no cross-stack references needed). */
export const names = {
  directoryTable: (env: EnvName) => `thapsus-hr-${env}-tenant-directory`,
  internalTokenSecret: (env: EnvName) => `thapsus-hr/${env}/internal-token`,
  /** Each cell's copy of the global internal token (distinct name: the UK cell shares eu-west-2 with the global stack). */
  cellInternalTokenSecret: (env: EnvName, cell: HomeRegion) => `thapsus-hr/${env}/${cell}/internal-token`,
  /** Per-cell Stripe keys (one Stripe account per home region, ADR-0103); distinct from the global stack's name. */
  stripeSecret: (env: EnvName, cell: HomeRegion) => `thapsus-hr/${env}/stripe/${cell}`,
  copyVault: (env: EnvName, cell: HomeRegion) => `thapsus-hr-${env}-${cell}-backup-copy`,
  stack: (env: EnvName, kind: string) => `ThapsusHr-${env}-${kind}`,
  /** Cell stack outputs for a dedicated database (read by scripts/deploy.mjs and the runbook). */
  dedicatedOutputs: (key: string) => {
    const id = dedicatedDatabaseId(key);
    return { proxyEndpoint: `Dedicated${id}ProxyEndpoint`, writerEndpoint: `Dedicated${id}WriterEndpoint`, toolsTaskDefinitionArn: `Dedicated${id}ToolsTaskDefinitionArn` };
  },
};

/** AWS regions the organisation SCP denies for workloads (ADR-0001). No stack may target them. */
export const FORBIDDEN_STACK_REGIONS = ['us-east-1', 'us-west-2'] as const;
/** The global layer lives in London (ADR-0001). */
export const GLOBAL_REGION = 'eu-west-2';
