import type { Tx } from '@thapsus/db';

/**
 * Feature flag and settings storage for "Ask HR" (off by default).
 *
 * Kept in this one small file so it can be swapped for the platform flag registry when that lands:
 * until then the flag is `app.tenants.features->'flags'->>'ai_assistant'` and the policy sources are
 * `app.tenants.features->'ai'`. Both reads run inside the caller's tenant transaction (RLS applies).
 */
export async function aiAssistantEnabled(tx: Tx): Promise<boolean> {
  const row = await tx.maybe<{ on: string | null }>(`SELECT features->'flags'->>'ai_assistant' AS on FROM app.tenants`);
  return row?.on === 'true';
}

export async function setAiAssistantEnabled(tx: Tx, on: boolean): Promise<void> {
  await tx.exec(
    `UPDATE app.tenants SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{flags}', coalesce(features->'flags', '{}'::jsonb) || jsonb_build_object('ai_assistant', $1::boolean))`,
    [on],
  );
}

export interface AiSources {
  policyFolderIds: string[];
  policyDocumentIds: string[];
}

export async function aiSources(tx: Tx): Promise<AiSources> {
  const row = await tx.maybe<{ ai: Partial<AiSources> | null }>(`SELECT features->'ai' AS ai FROM app.tenants`);
  return {
    policyFolderIds: Array.isArray(row?.ai?.policyFolderIds) ? row!.ai!.policyFolderIds!.map(String) : [],
    policyDocumentIds: Array.isArray(row?.ai?.policyDocumentIds) ? row!.ai!.policyDocumentIds!.map(String) : [],
  };
}

export async function setAiSources(tx: Tx, sources: AiSources): Promise<void> {
  await tx.exec(`UPDATE app.tenants SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{ai}', $1::jsonb)`, [
    JSON.stringify({ policyFolderIds: [...new Set(sources.policyFolderIds)], policyDocumentIds: [...new Set(sources.policyDocumentIds)] }),
  ]);
}
