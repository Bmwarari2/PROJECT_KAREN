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
  return (category, pairs) =>
    withTenant(
      router,
      tenantId,
      async (tx) => {
        const rows = await tx.query<{ id: string; subject_id: string; field: string; envelope: Envelope }>(
          `SELECT DISTINCT ON (r.subject_id, r.field) r.id, r.subject_id, r.field, r.envelope FROM vault.records r
           JOIN unnest($2::uuid[], $3::text[]) AS w(subject, field) ON w.subject = r.subject_id AND w.field = r.field
          WHERE r.category = $1 ORDER BY r.subject_id, r.field, r.created_at DESC`,
          [category, pairs.map((x) => x.subject), pairs.map((x) => x.field)],
        );
        const out = new Map<string, string>();
        for (const r of rows)
          out.set(
            `${r.subject_id}|${r.field}`,
            await open(keys, r.envelope, {
              tenant: tenantId,
              subject: r.subject_id,
              category,
              field: r.field,
            }),
          );
        for (let i = 0; i < rows.length; i += 1000) {
          const chunk = rows.slice(i, i + 1000);
          await tx.exec(
            `INSERT INTO audit.events (tenant_id, actor_type, actor_id, action, target_type, target_id, diff, ip, request_id, sensitive)
           SELECT app.current_tenant(), $1, $2, 'vault.read', $3, t.id, jsonb_build_object('subjectId', t.subject, 'field', t.field, 'via', $4::text, 'ref', $5::text), $6, $7, true
             FROM unnest($8::text[], $9::uuid[], $10::text[]) AS t(id, subject, field)`,
            [
              actor.actorType,
              actor.userId,
              `vault:${category}`,
              via.kind,
              via.id ?? null,
              actor.ip ?? null,
              actor.requestId ?? null,
              chunk.map((r) => r.id),
              chunk.map((r) => r.subject_id),
              chunk.map((r) => r.field),
            ],
          );
        }
        return out;
      },
      { actorId: actor.userId },
    );
}
