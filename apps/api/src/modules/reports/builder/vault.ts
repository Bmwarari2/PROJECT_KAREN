import { withTenant, type TenantRouter } from '@thapsus/db';
import { open, type Envelope, type KeyProvider } from '../../../lib/kms';
import type { VaultReader } from './engine';

/**
 * Vault values for report columns. Runs on the WRITER (the reporting reader has no vault grants), only
 * for employees the engine already checked against `vault.read:<category>`, and writes one sensitive
 * audit entry per value read (same action as the vault service: `vault.read`).
 */
export function vaultReader(
  router: TenantRouter,
  keys: KeyProvider,
  tenantId: string,
  actor: { userId: string; actorType: 'user' | 'support' | 'system'; requestId?: string; ip?: string },
  via: { kind: 'report_preview' | 'report_run' | 'data_export'; id?: string },
): VaultReader {
  return (category, field, employeeIds) =>
    withTenant(router, tenantId, async (tx) => {
      const rows = await tx.query<{ id: string; subject_id: string; envelope: Envelope }>(
        `SELECT DISTINCT ON (subject_id) id, subject_id, envelope FROM vault.records
          WHERE category = $1 AND field = $2 AND subject_id = ANY($3::uuid[]) ORDER BY subject_id, created_at DESC`,
        [category, field, employeeIds],
      );
      const out = new Map<string, string>();
      for (const r of rows) out.set(r.subject_id, await open(keys, r.envelope, { tenant: tenantId, subject: r.subject_id, category, field }));
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        await tx.exec(
          `INSERT INTO audit.events (tenant_id, actor_type, actor_id, action, target_type, target_id, diff, ip, request_id, sensitive)
           SELECT app.current_tenant(), $1, $2, 'vault.read', $3, t.id, jsonb_build_object('subjectId', t.subject, 'field', $4::text, 'via', $5::text, 'ref', $6::text), $7, $8, true
             FROM unnest($9::text[], $10::uuid[]) AS t(id, subject)`,
          [actor.actorType, actor.userId, `vault:${category}`, field, via.kind, via.id ?? null, actor.ip ?? null, actor.requestId ?? null, chunk.map((r) => r.id), chunk.map((r) => r.subject_id)],
        );
      }
      return out;
    }, { actorId: actor.userId });
}
