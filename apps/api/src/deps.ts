import { promises as dnsPromises } from 'node:dns';
import { HOME_REGIONS, loadCellConfig, type CellConfig, type HomeRegion } from '@thapsus/core';
import { TenantRouter } from '@thapsus/db';
import { directoryFromEnv, type TenantDirectory } from './lib/directory';
import { keyProviderFromEnv, type KeyProvider } from './lib/kms';
import { mailerFromEnv, type Mailer } from './lib/mailer';
import { rateLimiterFromEnv, type RateLimiter } from './lib/rate-limit';
import { objectStoreFromEnv, type ObjectStore } from './lib/object-store';

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export interface Deps {
  config: CellConfig;
  router: TenantRouter;
  directory: TenantDirectory;
  mailer: Mailer;
  keys: KeyProvider;
  limiter: RateLimiter;
  dns: DnsResolver;
  objects: ObjectStore;
  now: () => Date;
  /** Public base URLs of each regional app and API (for redirects and global fan-out). */
  regionalAppUrls: Record<HomeRegion, string>;
  regionalApiUrls: Record<HomeRegion, string>;
  /** Connection URL for the back-office role (support-grant checks only). */
  backofficeDbUrl?: string;
  fetch: typeof fetch;
  /** 'cell' serves tenant APIs; 'global' serves the directory and region-aware sign-in only. */
  serviceRole: 'cell' | 'global';
  /** Enables the built-in mock OIDC/SAML identity provider (dev, test and staging smoke only). */
  mockIdp: boolean;
  webPush?: { publicKey: string; privateKey: string; subject: string };
}

export function regionalUrlsFromEnv(prefix: string, fallback: (r: HomeRegion) => string): Record<HomeRegion, string> {
  const out = {} as Record<HomeRegion, string>;
  for (const r of HOME_REGIONS) out[r] = process.env[`${prefix}_${r.toUpperCase()}`] ?? fallback(r);
  return out;
}

export async function depsFromEnv(): Promise<Deps> {
  const config = loadCellConfig();
  const env = process.env;
  if (config.env === 'prod' && env.MOCK_IDP_ENABLED === 'true') throw new Error('The mock IdP may never run in production');
  return {
    config,
    router: TenantRouter.fromEnv(),
    directory: await directoryFromEnv(),
    mailer: mailerFromEnv(config.cell),
    keys: keyProviderFromEnv(config.cell),
    limiter: rateLimiterFromEnv(),
    dns: dnsPromises,
    objects: objectStoreFromEnv(config.cell),
    now: () => new Date(),
    regionalAppUrls: regionalUrlsFromEnv('APP_URL', () => config.appBaseUrl),
    regionalApiUrls: regionalUrlsFromEnv('API_URL', () => config.apiBaseUrl),
    backofficeDbUrl: env.BACKOFFICE_DATABASE_URL,
    fetch: globalThis.fetch,
    serviceRole: env.SERVICE_ROLE === 'global' ? 'global' : 'cell',
    mockIdp: env.MOCK_IDP_ENABLED === 'true',
    webPush: env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? `mailto:support@${config.domain}` }
      : undefined,
  };
}
