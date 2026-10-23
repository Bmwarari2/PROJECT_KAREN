import { createHash } from 'node:crypto';
import type { Tx } from '@thapsus/db';
import { open, seal, type Envelope, type KeyProvider } from '../../lib/kms';

export type CredentialOwner = 'payroll_connector' | 'it_connection';

/**
 * Integration secrets (OAuth tokens, client secrets, SFTP passwords and keys) are stored as one sealed
 * envelope per integration: a fresh data key wrapped by the cell's regional KMS key, AES-256-GCM, with
 * the AAD bound to tenant + owner so an envelope cannot be moved to another integration or tenant.
 * Values are never returned by the API, never written to audit diffs and never logged.
 */
function context(tenantId: string, owner: CredentialOwner, ownerId: string) {
  return { tenant: tenantId, purpose: 'integration-credentials', owner: `${owner}:${ownerId}` };
}

export async function putCredentials(
  tx: Tx,
  keys: KeyProvider,
  tenantId: string,
  owner: CredentialOwner,
  ownerId: string,
  values: Record<string, string>,
  actor: string | null,
) {
  const clean = Object.fromEntries(
    Object.entries(values).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
  const envelope = await seal(keys, JSON.stringify(clean), context(tenantId, owner, ownerId));
  await tx.exec(
    `INSERT INTO app.integration_credentials (tenant_id, owner_type, owner_id, envelope, fields, updated_by)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, owner_type, owner_id) DO UPDATE SET envelope = EXCLUDED.envelope, fields = EXCLUDED.fields, updated_by = EXCLUDED.updated_by`,
    [owner, ownerId, JSON.stringify(envelope), Object.keys(clean).sort(), actor],
  );
  return Object.keys(clean).sort();
}

/** Merges new values into the stored secrets (e.g. a rotated OAuth refresh token). */
export async function mergeCredentials(
  tx: Tx,
  keys: KeyProvider,
  tenantId: string,
  owner: CredentialOwner,
  ownerId: string,
  values: Record<string, string>,
  actor: string | null,
) {
  const current = (await getCredentials(tx, keys, tenantId, owner, ownerId)) ?? {};
  return putCredentials(tx, keys, tenantId, owner, ownerId, { ...current, ...values }, actor);
}

export async function getCredentials(
  tx: Tx,
  keys: KeyProvider,
  tenantId: string,
  owner: CredentialOwner,
  ownerId: string,
): Promise<Record<string, string> | undefined> {
  const row = await tx.maybe<{ envelope: Envelope }>(
    'SELECT envelope FROM app.integration_credentials WHERE owner_type = $1 AND owner_id = $2',
    [owner, ownerId],
  );
  if (!row) return undefined;
  return JSON.parse(await open(keys, row.envelope, context(tenantId, owner, ownerId))) as Record<
    string,
    string
  >;
}

export async function credentialFields(tx: Tx, owner: CredentialOwner, ownerId: string): Promise<string[]> {
  const row = await tx.maybe<{ fields: string[] }>(
    'SELECT fields FROM app.integration_credentials WHERE owner_type = $1 AND owner_id = $2',
    [owner, ownerId],
  );
  return row?.fields ?? [];
}

export async function deleteCredentials(tx: Tx, owner: CredentialOwner, ownerId: string) {
  await tx.exec('DELETE FROM app.integration_credentials WHERE owner_type = $1 AND owner_id = $2', [
    owner,
    ownerId,
  ]);
}

// ---- OAuth state (single use, short-lived, stored hashed) -------------------------------------------------
export const hashState = (state: string) => createHash('sha256').update(state).digest();

export async function createOAuthState(
  tx: Tx,
  owner: CredentialOwner,
  ownerId: string,
  userId: string,
  now: Date,
  state: string,
) {
  await tx.exec(
    `INSERT INTO app.integration_oauth_states (tenant_id, state_hash, owner_type, owner_id, created_by, expires_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5)`,
    [hashState(state), owner, ownerId, userId, new Date(now.getTime() + 15 * 60_000).toISOString()],
  );
}

/** Consumes a state value; returns the owner when it is valid, unused, unexpired and started by this user. */
export async function consumeOAuthState(tx: Tx, state: string, userId: string, now: Date) {
  return tx.maybe<{ owner_type: CredentialOwner; owner_id: string }>(
    `UPDATE app.integration_oauth_states SET used_at = $3 WHERE state_hash = $1 AND created_by = $2 AND used_at IS NULL AND expires_at > $3
     RETURNING owner_type, owner_id`,
    [hashState(state), userId, now.toISOString()],
  );
}
