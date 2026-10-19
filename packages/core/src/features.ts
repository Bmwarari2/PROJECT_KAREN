/**
 * Per-tenant feature flags (brief §6.10). The registry holds every flag with its default; a tenant's
 * overrides live in app.tenants.features->'flags' as { "<key>": true | false }. Unknown stored keys are
 * ignored, so removing a flag from the registry never breaks a tenant.
 *
 *  - managedBy 'tenant': company admins toggle it in Settings → Features (and staff in the back office).
 *  - managedBy 'staff': only Thapsus staff toggle it in the back office (plan- or contract-gated).
 *
 * API code checks a flag with `featureEnabled(tx, key)` / `requireFeature(tx, key)` from @thapsus/db;
 * the web app reads the resolved map from GET /v1/tenant/experience and hides disabled features.
 */
export interface FeatureFlagDefinition {
  key: FeatureKey;
  default: boolean;
  managedBy: 'tenant' | 'staff';
  /** Message catalogue keys for the settings and back-office screens. */
  labelKey: string;
  descriptionKey: string;
}

export const FEATURE_KEYS = ['publicApi', 'webhooks', 'auditStreaming', 'sandboxes', 'customBranding', 'aiAssistant'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_FLAGS: Record<FeatureKey, FeatureFlagDefinition> = {
  publicApi: { key: 'publicApi', default: true, managedBy: 'tenant', labelKey: 'platform.flags.publicApi.label', descriptionKey: 'platform.flags.publicApi.description' },
  webhooks: { key: 'webhooks', default: true, managedBy: 'tenant', labelKey: 'platform.flags.webhooks.label', descriptionKey: 'platform.flags.webhooks.description' },
  auditStreaming: { key: 'auditStreaming', default: true, managedBy: 'tenant', labelKey: 'platform.flags.auditStreaming.label', descriptionKey: 'platform.flags.auditStreaming.description' },
  sandboxes: { key: 'sandboxes', default: true, managedBy: 'staff', labelKey: 'platform.flags.sandboxes.label', descriptionKey: 'platform.flags.sandboxes.description' },
  customBranding: { key: 'customBranding', default: true, managedBy: 'tenant', labelKey: 'platform.flags.customBranding.label', descriptionKey: 'platform.flags.customBranding.description' },
  // Brief §6.13: the optional AI assistant is off by default and enabled per tenant by staff.
  aiAssistant: { key: 'aiAssistant', default: false, managedBy: 'staff', labelKey: 'platform.flags.aiAssistant.label', descriptionKey: 'platform.flags.aiAssistant.description' },
};

export function isFeatureKey(v: unknown): v is FeatureKey {
  return typeof v === 'string' && (FEATURE_KEYS as readonly string[]).includes(v);
}

/** Resolves stored overrides against the registry defaults (unknown keys and non-booleans are ignored). */
export function resolveFeatureFlags(stored: unknown): Record<FeatureKey, boolean> {
  const overrides = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    const v = overrides[key];
    out[key] = typeof v === 'boolean' ? v : FEATURE_FLAGS[key].default;
  }
  return out;
}
