import { promises as dnsPromises } from 'node:dns';
import { assertCellResidency, HOME_REGIONS, loadCellConfig, type CellConfig, type HomeRegion } from '@thapsus/core';
import { secretToUrl, TenantRouter } from '@thapsus/db';
import { directoryFromEnv, type TenantDirectory } from './lib/directory';
import { randomBytes } from 'node:crypto';
import { keyProviderFromEnv, LocalKeyProvider, type KeyProvider } from './lib/kms';
import { mailerFromEnv, type Mailer } from './lib/mailer';
import { rateLimiterFromEnv, type RateLimiter } from './lib/rate-limit';
import { objectStoreFromEnv, type ObjectStore } from './lib/object-store';
import type { BillingProvider } from './modules/billing/provider';
import { StripeBillingProvider } from './modules/billing/stripe-provider';
import { withDeliveryHealth } from './modules/status/service';
import { STRICT_OUTBOUND, type OutboundPolicy } from './lib/outbound';
import { crossAccountS3FromEnv, type CrossAccountS3 } from './modules/platform/siem-s3';

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
  /** Billing provider (Stripe test mode in AWS; a recording fake in tests and local dev). ADR-0103. */
  billing?: BillingProvider;
  /** Signing secret of this region's Stripe webhook endpoint (Secrets Manager thapsus-hr/<env>/stripe). */
  stripeWebhookSecret?: string;
  /** SSRF policy for customer-configured destinations (webhooks, SIEM). Strict when omitted. */
  outbound?: OutboundPolicy;
  /** Writes audit batches to customer S3 buckets through a cross-account role (home region only). */
  siemS3?: CrossAccountS3;
}

/** Dev/test-only relaxations (a local webhook receiver); refused in production. */
export function outboundPolicyFromEnv(appEnv: string, env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const policy = { allowHttp: env.OUTBOUND_ALLOW_HTTP === 'true', allowPrivateNetworks: env.OUTBOUND_ALLOW_PRIVATE_NETWORKS === 'true' };
  if (appEnv === 'prod' && (policy.allowHttp || policy.allowPrivateNetworks)) throw new Error('Outbound SSRF relaxations may never be enabled in production');
  return policy.allowHttp || policy.allowPrivateNetworks ? policy : STRICT_OUTBOUND;
}

export function regionalUrlsFromEnv(prefix: string, fallback: (r: HomeRegion) => string): Record<HomeRegion, string> {
  const out = {} as Record<HomeRegion, string>;
  for (const r of HOME_REGIONS) out[r] = process.env[`${prefix}_${r.toUpperCase()}`] ?? fallback(r);
  return out;
}

export async function depsFromEnv(): Promise<Deps> {
  const config = loadCellConfig();
  const env = process.env;
  if (env.SERVICE_ROLE !== 'global') assertCellResidency(config.cell, env);
  if (config.env === 'prod' && env.MOCK_IDP_ENABLED === 'true') throw new Error('The mock IdP may never run in production');
  // The global service never touches tenant databases; its router is never used to connect.
  const router = env.SERVICE_ROLE === 'global' && !env.DATABASE_URL && !env.DATABASE_SECRET ? new TenantRouter({ databases: { shared: 'postgres://unused@127.0.0.1:1/none' } }) : TenantRouter.fromEnv();
  const mailer = mailerFromEnv(config.cell);
  return {
    config,
    router,
    directory: await directoryFromEnv(),
    // Cells record email delivery outcomes (timestamps and counts only) for the public status page.
    mailer: env.SERVICE_ROLE === 'global' ? mailer : withDeliveryHealth(mailer, () => router.registryPool()),
    keys: env.SERVICE_ROLE === 'global' ? new LocalKeyProvider(randomBytes(32).toString('hex'), 'global-unused') : keyProviderFromEnv(config.cell),
    limiter: rateLimiterFromEnv(),
    dns: dnsPromises,
    objects: objectStoreFromEnv(config.cell),
    now: () => new Date(),
    regionalAppUrls: regionalUrlsFromEnv('APP_URL', () => config.appBaseUrl),
    regionalApiUrls: regionalUrlsFromEnv('API_URL', () => config.apiBaseUrl),
    backofficeDbUrl: env.BACKOFFICE_DATABASE_URL ?? (env.BACKOFFICE_DATABASE_SECRET ? secretToUrl(env.BACKOFFICE_DATABASE_SECRET, env.DATABASE_HOST) : undefined),
    fetch: globalThis.fetch,
    serviceRole: env.SERVICE_ROLE === 'global' ? 'global' : 'cell',
    mockIdp: env.MOCK_IDP_ENABLED === 'true',
    // Stripe keys come only from Secrets Manager (ECS secrets) or a git-ignored local .env; test mode only.
    billing: env.STRIPE_SECRET_KEY ? StripeBillingProvider.fromKey(env.STRIPE_SECRET_KEY) : undefined,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    webPush: env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? `mailto:support@${config.domain}` }
      : undefined,
    outbound: outboundPolicyFromEnv(config.env, env),
    siemS3: crossAccountS3FromEnv(config.cell, env),
  };
}
