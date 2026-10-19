import type { Tx } from '@thapsus/db';
import { writeAudit } from '@thapsus/db';
import { can, type Principal, type Target } from '@thapsus/core/permissions';
import { open, seal, type Envelope, type KeyProvider } from '../../lib/kms';
import { ApiError } from '../../http/errors';

export const VAULT_CATEGORIES = ['health', 'sickness', 'disability', 'diversity', 'eeo', 'immigration'] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export interface VaultActor {
  principal: Principal;
  actorType: 'user' | 'support' | 'system';
  requestId?: string;
  ip?: string;
}

/**
 * Sensitive data vault. Values are sealed with a per-value data key wrapped by the regional KMS key;
 * the AAD binds ciphertext to tenant, subject, category and field, so rows cannot be swapped.
 * Every read (decrypt) and write is audit-logged with sensitive = true.
 */
export class Vault {
  constructor(private readonly keys: KeyProvider) {}

  private ctx(tenantId: string, subjectId: string, category: string, field: string) {
    return { tenant: tenantId, subject: subjectId, category, field };
  }

  async put(tx: Tx, actor: VaultActor, tenantId: string, target: Target & { employeeId: string }, category: VaultCategory, field: string, value: string, fileKey?: string) {
    if (!can(actor.principal, `vault.write:${category}`, target)) throw new ApiError('forbidden');
    const envelope = await seal(this.keys, value, this.ctx(tenantId, target.employeeId, category, field));
    const row = await tx.one<{ id: string }>(
      `INSERT INTO vault.records (tenant_id, subject_id, category, field, envelope, file_key, created_by)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [target.employeeId, category, field, JSON.stringify(envelope), fileKey ?? null, actor.principal.userId],
    );
    await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.write', targetType: `vault:${category}`, targetId: row.id, diff: { subjectId: target.employeeId, field }, sensitive: true, requestId: actor.requestId, ip: actor.ip });
    return row.id;
  }

  /** Latest value per field for a subject and category (optionally only `fields`). Throws 403 without the category permission. */
  async read(tx: Tx, actor: VaultActor, tenantId: string, target: Target & { employeeId: string }, category: VaultCategory, fields?: string[]) {
    if (!can(actor.principal, `vault.read:${category}`, target)) {
      await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.read_denied', targetType: `vault:${category}`, targetId: target.employeeId, sensitive: true, requestId: actor.requestId, ip: actor.ip });
      throw new ApiError('forbidden');
    }
    const rows = await tx.query<{ id: string; field: string; envelope: Envelope; file_key: string | null; created_at: string }>(
      `SELECT DISTINCT ON (field) id, field, envelope, file_key, created_at FROM vault.records
        WHERE subject_id = $1 AND category = $2 AND ($3::text[] IS NULL OR field = ANY($3::text[])) ORDER BY field, created_at DESC`,
      [target.employeeId, category, fields ?? null],
    );
    const out: Array<{ id: string; field: string; value: string; fileKey: string | null; recordedAt: string }> = [];
    for (const r of rows) {
      const value = await open(this.keys, r.envelope, this.ctx(tenantId, target.employeeId, category, r.field));
      await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.read', targetType: `vault:${category}`, targetId: r.id, diff: { subjectId: target.employeeId, field: r.field }, sensitive: true, requestId: actor.requestId, ip: actor.ip });
      out.push({ id: r.id, field: r.field, value, fileKey: r.file_key, recordedAt: r.created_at });
    }
    return out;
  }

  /**
   * Every stored value for a subject (all categories and versions) for a data subject access export.
   * Each decrypt is audited with the purpose; categories the actor may not read are withheld and the
   * refusal is audited too.
   */
  async exportSubject(tx: Tx, actor: VaultActor, tenantId: string, target: Target & { employeeId: string }, purpose: Record<string, unknown>) {
    const rows = await tx.query<{ id: string; category: VaultCategory; field: string; envelope: Envelope; file_key: string | null; created_at: string }>(
      `SELECT id, category, field, envelope, file_key, created_at FROM vault.records WHERE subject_id = $1 ORDER BY category, field, created_at`,
      [target.employeeId],
    );
    const values: Array<{ category: string; field: string; value: string; hasFile: boolean; recordedAt: string }> = [];
    const withheld = new Set<string>();
    for (const r of rows) {
      if (!can(actor.principal, `vault.read:${r.category}`, target)) {
        if (!withheld.has(r.category)) await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.read_denied', targetType: `vault:${r.category}`, targetId: target.employeeId, diff: purpose, sensitive: true, requestId: actor.requestId, ip: actor.ip });
        withheld.add(r.category);
        continue;
      }
      const value = await open(this.keys, r.envelope, this.ctx(tenantId, target.employeeId, r.category, r.field));
      await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.read', targetType: `vault:${r.category}`, targetId: r.id, diff: { subjectId: target.employeeId, field: r.field, ...purpose }, sensitive: true, requestId: actor.requestId, ip: actor.ip });
      values.push({ category: r.category, field: r.field, value, hasFile: !!r.file_key, recordedAt: r.created_at });
    }
    return { values, withheld: [...withheld].sort() };
  }

  /** Erases a subject's vault values except the categories that must be kept; returns file keys to delete. */
  async eraseSubject(tx: Tx, actor: VaultActor, employeeId: string, keepCategories: string[], purpose: Record<string, unknown>) {
    const rows = await tx.query<{ category: string; file_key: string | null }>(
      `DELETE FROM vault.records WHERE subject_id = $1 AND NOT (category = ANY($2::text[])) RETURNING category, file_key`,
      [employeeId, keepCategories],
    );
    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    await writeAudit(tx, { actorType: actor.actorType, actorId: actor.principal.userId, action: 'vault.erased', targetType: 'employee', targetId: employeeId, diff: { byCategory, kept: keepCategories, ...purpose }, sensitive: true, requestId: actor.requestId, ip: actor.ip });
    return { deleted: rows.length, byCategory, fileKeys: rows.flatMap((r) => (r.file_key ? [r.file_key] : [])) };
  }
}
