import { isHomeRegion, type HomeRegion } from './regions';

/**
 * Runtime configuration read from the environment. Secrets come from AWS Secrets Manager in
 * deployed environments (injected by ECS) and from git-ignored .env files locally.
 */
export interface CellConfig {
  env: 'dev' | 'test' | 'staging' | 'prod' | 'loadtest';
  cell: HomeRegion;
  /** Product domain — not yet chosen, so always configuration. */
  domain: string;
  appBaseUrl: string;
  apiBaseUrl: string;
  globalBaseUrl: string;
  /**
   * Multiplies every per-IP throttle (sign-in, sign-up, magic links…). Always 1 except in the
   * temporary load-test environment, where one load generator signs in thousands of synthetic users.
   * Refused above 1 in production.
   */
  ipThrottleMultiplier?: number;
  /**
   * Shared secret on global ↔ cell calls (find-workspace fan-out). Injected from Secrets Manager in
   * AWS; the well-known local default exists only for dev and test, so a deployed service without
   * the secret refuses to start instead of accepting it.
   */
  internalToken: string;
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadCellConfig(): CellConfig {
  const cell = env('CELL_REGION', 'uk');
  if (!isHomeRegion(cell)) throw new Error(`CELL_REGION must be one of uk, eu, us (got ${cell})`);
  const domain = env('THAPSUS_HR_DOMAIN', 'thapsus-hr.localhost');
  const e = env('APP_ENV', 'dev');
  if (!['dev', 'test', 'staging', 'prod', 'loadtest'].includes(e)) throw new Error(`Invalid APP_ENV ${e}`);
  const ipThrottleMultiplier = Number(env('IP_THROTTLE_MULTIPLIER', '1'));
  if (!Number.isFinite(ipThrottleMultiplier) || ipThrottleMultiplier < 1)
    throw new Error('IP_THROTTLE_MULTIPLIER must be a number >= 1');
  if (e === 'prod' && ipThrottleMultiplier !== 1)
    throw new Error('IP_THROTTLE_MULTIPLIER must be 1 in production');
  const internalToken =
    process.env.INTERNAL_TOKEN || (e === 'dev' || e === 'test' ? 'dev-internal-token' : undefined);
  if (!internalToken) throw new Error('INTERNAL_TOKEN is required outside dev and test');
  return {
    env: e as CellConfig['env'],
    cell,
    domain,
    appBaseUrl: env('APP_BASE_URL', 'http://localhost:3000'),
    apiBaseUrl: env('API_BASE_URL', 'http://localhost:4000'),
    globalBaseUrl: env('GLOBAL_BASE_URL', 'http://localhost:3000'),
    ipThrottleMultiplier,
    internalToken,
  };
}

/** Regional host names derived from the configured domain, e.g. app.uk.<domain>. */
export function regionalHosts(domain: string, cell: HomeRegion) {
  return { app: `app.${cell}.${domain}`, api: `api.${cell}.${domain}` };
}
