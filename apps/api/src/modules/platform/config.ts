/**
 * Enterprise platform configuration (brief §6.10). Values here are product configuration, not law or
 * prices: per-plan defaults that the back office can override per tenant
 * (app.tenants.features->'api'->'rateLimitPerMinute'). API_PLATFORM_CONFIG (JSON) overrides the defaults
 * per environment without a code change.
 */
export interface PlatformConfig {
  /** Requests per minute per tenant for API clients (fixed 60-second window), by plan key. */
  apiRateLimitPerMinute: Record<string, number> & { default: number };
  /** Idempotency keys are kept (and replayed) for this long. */
  idempotencyTtlHours: number;
  webhooks: { maxAttempts: number; baseDelaySeconds: number; maxDelaySeconds: number; timeoutMs: number; secretGraceHours: number };
  auditStreams: { batchSize: number; timeoutMs: number };
  sandboxes: { maxPerTenant: number; defaultSyntheticPeople: number };
  branding: { maxLogoBytes: number };
}

export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  apiRateLimitPerMinute: { default: 600, trial: 120, sandbox: 120, starter: 300, growth: 600, enterprise: 3000, core: 300, plus: 600 },
  idempotencyTtlHours: 24,
  webhooks: { maxAttempts: 8, baseDelaySeconds: 30, maxDelaySeconds: 6 * 3600, timeoutMs: 10_000, secretGraceHours: 24 },
  auditStreams: { batchSize: 500, timeoutMs: 15_000 },
  sandboxes: { maxPerTenant: 3, defaultSyntheticPeople: 25 },
  branding: { maxLogoBytes: 512 * 1024 },
};

function load(): PlatformConfig {
  const raw = process.env.API_PLATFORM_CONFIG;
  if (!raw) return DEFAULT_PLATFORM_CONFIG;
  const o = JSON.parse(raw) as Partial<PlatformConfig>;
  return {
    ...DEFAULT_PLATFORM_CONFIG,
    ...o,
    apiRateLimitPerMinute: { ...DEFAULT_PLATFORM_CONFIG.apiRateLimitPerMinute, ...(o.apiRateLimitPerMinute ?? {}) },
    webhooks: { ...DEFAULT_PLATFORM_CONFIG.webhooks, ...(o.webhooks ?? {}) },
    auditStreams: { ...DEFAULT_PLATFORM_CONFIG.auditStreams, ...(o.auditStreams ?? {}) },
    sandboxes: { ...DEFAULT_PLATFORM_CONFIG.sandboxes, ...(o.sandboxes ?? {}) },
    branding: { ...DEFAULT_PLATFORM_CONFIG.branding, ...(o.branding ?? {}) },
  };
}

export const platformConfig: PlatformConfig = load();

/** Delay before retry attempt n+1 after attempt n failed: base × 2^(n−1), capped. */
export function webhookRetryDelaySeconds(attempt: number, cfg = platformConfig.webhooks): number {
  return Math.min(cfg.maxDelaySeconds, cfg.baseDelaySeconds * 2 ** Math.max(0, attempt - 1));
}

export function rateLimitFor(api: { rateLimitPerMinute?: unknown; plan?: unknown } | null | undefined, cfg = platformConfig): number {
  const override = Number(api?.rateLimitPerMinute);
  if (Number.isInteger(override) && override > 0) return override;
  const plan = typeof api?.plan === 'string' ? api.plan : 'default';
  return cfg.apiRateLimitPerMinute[plan] ?? cfg.apiRateLimitPerMinute.default;
}
