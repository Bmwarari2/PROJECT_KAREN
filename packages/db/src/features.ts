import { FEATURE_FLAGS, resolveFeatureFlags, type FeatureKey } from '@thapsus/core/features';
import type { Tx } from './client';

/**
 * Per-tenant feature flags, stored in app.tenants.features->'flags' and resolved against the registry
 * in @thapsus/core/features. Always called inside the tenant context (withTenant / app.tenantTx).
 */
export async function loadFeatureFlags(tx: Tx): Promise<Record<FeatureKey, boolean>> {
  const row = await tx.maybe<{ flags: unknown }>(`SELECT features->'flags' AS flags FROM app.tenants`);
  return resolveFeatureFlags(row?.flags);
}

/** True when the flag is on for the current tenant (registry default when the tenant has no override). */
export async function featureEnabled(tx: Tx, key: FeatureKey): Promise<boolean> {
  if (!(key in FEATURE_FLAGS)) throw new Error(`Unknown feature flag ${key}`);
  return (await loadFeatureFlags(tx))[key];
}

/** Sets (or, with null, clears back to the default) one flag for the current tenant. Returns the previous value. */
export async function setFeatureFlag(tx: Tx, key: FeatureKey, enabled: boolean | null): Promise<boolean> {
  if (!(key in FEATURE_FLAGS)) throw new Error(`Unknown feature flag ${key}`);
  const before = await featureEnabled(tx, key);
  await tx.exec(
    enabled === null
      ? `UPDATE app.tenants SET features = jsonb_set(features, '{flags}', coalesce(features->'flags', '{}'::jsonb) - $1::text)`
      : `UPDATE app.tenants SET features = jsonb_set(features, '{flags}', coalesce(features->'flags', '{}'::jsonb) || jsonb_build_object($1::text, $2::boolean))`,
    enabled === null ? [key] : [key, enabled],
  );
  return before;
}
