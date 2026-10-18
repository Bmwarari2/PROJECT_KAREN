import { featureEnabled, type Tx } from '@thapsus/db';

/**
 * "Ask HR" switches (ADR-0112). Two keys, both off by default:
 *
 *  1. the platform feature flag `aiAssistant` (packages/core/src/features.ts) — staff-managed, the
 *     plan/contract entitlement, checked with `featureEnabled` / `requireFeature`;
 *  2. the customer's own opt-in, `app.tenants.features->'ai'->'enabled'`, set by the account owner in
 *     Settings → Ask HR. As controller, the customer decides when employee questions go to the
 *     sub-processor; staff enabling the entitlement never turns the assistant on by itself.
 *
 * The policy sources live next to the opt-in in `features->'ai'`. All reads run in the caller's tenant
 * transaction (RLS applies).
 */
export const aiAssistantEntitled = (tx: Tx) => featureEnabled(tx, 'aiAssistant');

export interface AiConfig {
  enabled: boolean;
  policyFolderIds: string[];
  policyDocumentIds: string[];
}
export type AiSources = Omit<AiConfig, 'enabled'>;

export async function aiConfig(tx: Tx): Promise<AiConfig> {
  const row = await tx.maybe<{ ai: Partial<AiConfig> | null }>(`SELECT features->'ai' AS ai FROM app.tenants`);
  const ai = row?.ai ?? {};
  return {
    enabled: ai.enabled === true,
    policyFolderIds: Array.isArray(ai.policyFolderIds) ? ai.policyFolderIds.map(String) : [],
    policyDocumentIds: Array.isArray(ai.policyDocumentIds) ? ai.policyDocumentIds.map(String) : [],
  };
}

export const aiSources = async (tx: Tx): Promise<AiSources> => {
  const { policyFolderIds, policyDocumentIds } = await aiConfig(tx);
  return { policyFolderIds, policyDocumentIds };
};

/** Merges the given keys into features->'ai' (other keys are kept). */
export async function updateAiConfig(tx: Tx, patch: Partial<AiConfig>): Promise<void> {
  const clean: Partial<AiConfig> = { ...patch };
  if (clean.policyFolderIds) clean.policyFolderIds = [...new Set(clean.policyFolderIds)];
  if (clean.policyDocumentIds) clean.policyDocumentIds = [...new Set(clean.policyDocumentIds)];
  await tx.exec(`UPDATE app.tenants SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{ai}', coalesce(features->'ai', '{}'::jsonb) || $1::jsonb)`, [JSON.stringify(clean)]);
}

/** Entitled by Thapsus and switched on by the customer (region availability is checked by the caller). */
export async function aiAssistantEnabled(tx: Tx): Promise<boolean> {
  return (await aiAssistantEntitled(tx)) && (await aiConfig(tx)).enabled;
}
