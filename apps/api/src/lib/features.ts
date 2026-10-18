import type { FeatureKey } from '@thapsus/core/features';
import { featureEnabled, type Tx } from '@thapsus/db';
import { ApiError } from '../http/errors';

export { featureEnabled, loadFeatureFlags, setFeatureFlag } from '@thapsus/db';

/** Throws 403 (detail "featureDisabled", extra { feature }) when the flag is off for the current tenant. */
export async function requireFeature(tx: Tx, key: FeatureKey): Promise<void> {
  if (!(await featureEnabled(tx, key))) throw new ApiError('forbidden', 'featureDisabled', { feature: key });
}
