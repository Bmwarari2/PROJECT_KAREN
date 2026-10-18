import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_REGIONS, type HomeRegion } from '@thapsus/core/regions';

export const ENVS = ['dev', 'staging', 'prod'] as const;
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
  valkey: { nodeType: string; replicas: number };
  backup: { dailyRetentionDays: number; continuousRetentionDays: number; copyRetentionDays: number };
  services: { api: ServiceSize; worker: ServiceSize; web: ServiceSize };
  wafRateLimitPer5Min: number;
  global: { certificateArn: string | null; monthlyBudgetUsd: number; services: { api: ServiceSize; web: ServiceSize } };
  cells: Record<HomeRegion, CellSettings>;
  billingConfigLocation: string;
  /** GitHub Actions OIDC: the only repository and GitHub environment allowed to assume the deploy roles. */
  ci: { githubRepository: string; githubEnvironment: string; oidcProviderArn: string | null };
}

export function loadConfig(env: EnvName): EnvConfig {
  const file = join(import.meta.dirname, '..', 'config', `${env}.json`);
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as EnvConfig;
  validate(cfg, env);
  return cfg;
}

function validate(cfg: EnvConfig, env: EnvName) {
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
  if (env === 'prod') {
    if (cfg.ci.githubEnvironment !== 'production') fail('prod deploys must come from the "production" GitHub environment (manual approval gate)');
    if (cfg.natGateways < 3) fail('prod needs one NAT gateway per AZ (3)');
    for (const [name, s] of Object.entries(cfg.services)) if (s.desiredCount < 2) fail(`prod services.${name}.desiredCount must be >= 2`);
    if (!cfg.aurora.deletionProtection) fail('prod Aurora must have deletion protection');
  }
}

const prefix = <T>(p: string, o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));

/** Deterministic, region-free names shared between stacks (no cross-stack references needed). */
export const names = {
  directoryTable: (env: EnvName) => `thapsus-hr-${env}-tenant-directory`,
  internalTokenSecret: (env: EnvName) => `thapsus-hr/${env}/internal-token`,
  /** Each cell's copy of the global internal token (distinct name: the UK cell shares eu-west-2 with the global stack). */
  cellInternalTokenSecret: (env: EnvName, cell: HomeRegion) => `thapsus-hr/${env}/${cell}/internal-token`,
  copyVault: (env: EnvName, cell: HomeRegion) => `thapsus-hr-${env}-${cell}-backup-copy`,
  stack: (env: EnvName, kind: string) => `ThapsusHr-${env}-${kind}`,
};

/** AWS regions the organisation SCP denies for workloads (ADR-0001). No stack may target them. */
export const FORBIDDEN_STACK_REGIONS = ['us-east-1', 'us-west-2'] as const;
/** The global layer lives in London (ADR-0001). */
export const GLOBAL_REGION = 'eu-west-2';
