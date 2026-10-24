import { TenantUnavailableError, TenantNotFoundError, withTenant, writeAudit } from '@thapsus/db';
import type { ContainmentKind } from '@thapsus/core/security';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import type { Db } from './engine';
import { isInternalAddress } from './pseudonym';

/**
 * Containment (ADR-0178): audited, reversible, and never deleting customer data.
 *  - block_ip: the API refuses the address (keyed hash) until the block expires or is lifted;
 *  - end_sessions: a person's sessions end (they sign in again; nothing to undo);
 *  - suspend_api_key: the key stops working until it is restored (the customer can also revoke it);
 *  - freeze_staff: the staff account is deactivated and its sessions end; unfreezing needs a second person.
 * Each action is a row in security.containment_actions, an entry on the incident timeline and, when it
 * touches a workspace, an entry in that workspace's own audit log.
 */
export interface ContainmentInput {
  kind: ContainmentKind;
  incidentId: string | null;
  automated: boolean;
  staffId?: string | null;
  reason: string;
  tenantId?: string | null;
  targetId?: string | null;
  ipKey?: string | null;
  ipNet?: string | null;
  minutes?: number;
}

async function timeline(
  db: Db,
  incidentId: string | null,
  kind: 'containment' | 'reversal',
  staffId: string | null,
  detail: object,
) {
  if (!incidentId) return;
  await db.query(
    `INSERT INTO security.incident_events (incident_id, kind, staff_id, detail) VALUES ($1, $2, $3, $4)`,
    [incidentId, kind, staffId, JSON.stringify(detail)],
  );
}

async function tenantAudit(
  deps: Pick<Deps, 'router'>,
  tenantId: string,
  entry: { action: string; targetType: string; targetId: string; staffId?: string | null; diff?: unknown },
) {
  await withTenant(deps.router, tenantId, (tx) =>
    writeAudit(tx, {
      actorType: entry.staffId ? 'support' : 'system',
      actorId: entry.staffId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      diff: entry.diff,
    }),
  );
}

export async function applyContainment(
  deps: Pick<Deps, 'router' | 'now'>,
  db: Db,
  c: ContainmentInput,
): Promise<{ id: string } | { skipped: string }> {
  const now = deps.now();
  if (c.kind === 'block_ip') {
    if (!c.ipKey) return { skipped: 'noAddress' };
    // the cell's own infrastructure (proxies, health checks) is never blocked
    if (isInternalAddress(c.ipNet)) return { skipped: 'internalAddress' };
    const active = (
      await db.query<{ id: string }>(
        `SELECT id FROM security.containment_actions WHERE kind = 'block_ip' AND ip_key = $1 AND reversed_at IS NULL AND (expires_at IS NULL OR expires_at > $2) LIMIT 1`,
        [c.ipKey, now],
      )
    ).rows[0];
    if (active) return { skipped: 'alreadyBlocked' };
  }
  if (c.kind === 'end_sessions' || c.kind === 'suspend_api_key') {
    if (!c.tenantId || !c.targetId) return { skipped: 'noTarget' };
    try {
      const changed = await withTenant(deps.router, c.tenantId, async (tx) => {
        const n =
          c.kind === 'end_sessions'
            ? await tx.exec(
                'UPDATE app.sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
                [c.targetId, now],
              )
            : await tx.exec(
                'UPDATE app.api_keys SET suspended_at = $2 WHERE id = $1 AND revoked_at IS NULL AND suspended_at IS NULL',
                [c.targetId, now],
              );
        if (c.kind === 'suspend_api_key' && !n) return false;
        await writeAudit(tx, {
          actorType: c.staffId ? 'support' : 'system',
          actorId: c.staffId ?? null,
          action: c.kind === 'end_sessions' ? 'security.sessions_ended' : 'security.api_key_suspended',
          targetType: c.kind === 'end_sessions' ? 'user' : 'api_key',
          targetId: c.targetId!,
          diff: { incidentId: c.incidentId, automated: c.automated, sessions: n },
        });
        return true;
      });
      if (!changed) return { skipped: 'noTarget' };
    } catch (err) {
      if (err instanceof TenantNotFoundError || err instanceof TenantUnavailableError)
        return { skipped: 'noTarget' };
      throw err;
    }
  }
  if (c.kind === 'freeze_staff') {
    if (!c.targetId) return { skipped: 'noTarget' };
    const s = (
      await db.query<{ role: string; active: boolean }>(
        'SELECT role, active FROM backoffice.staff_users WHERE id = $1',
        [c.targetId],
      )
    ).rows[0];
    if (!s?.active) return { skipped: s ? 'alreadyFrozen' : 'noTarget' };
    if (s.role === 'super_admin') {
      const others = (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM backoffice.staff_users WHERE role = 'super_admin' AND active AND id <> $1`,
          [c.targetId],
        )
      ).rows[0]!.n;
      // never lock the platform out: the last active super admin is not frozen automatically or by anyone
      if (!others) return { skipped: 'lastSuperAdmin' };
    }
    await db.query('UPDATE backoffice.staff_users SET active = false WHERE id = $1', [c.targetId]);
    await db.query(
      'UPDATE backoffice.staff_sessions SET revoked_at = $2 WHERE staff_id = $1 AND revoked_at IS NULL',
      [c.targetId, now],
    );
  }
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO security.containment_actions (kind, incident_id, automated, subject_tenant_id, target_id, ip_key, ip_net, reason, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::cidr, $8, $9, $10, $11) RETURNING id`,
      [
        c.kind,
        c.incidentId,
        c.automated,
        c.tenantId ?? null,
        c.targetId ?? null,
        c.ipKey ?? null,
        c.ipNet ?? null,
        c.reason,
        c.staffId ?? null,
        now,
        c.kind === 'block_ip' ? new Date(now.getTime() + (c.minutes ?? 60) * 60_000) : null,
      ],
    )
  ).rows[0]!;
  await timeline(db, c.incidentId, 'containment', c.staffId ?? null, {
    actionId: row.id,
    kind: c.kind,
    automated: c.automated,
    minutes: c.kind === 'block_ip' ? (c.minutes ?? 60) : undefined,
  });
  if (c.incidentId)
    await db.query(
      `UPDATE security.incidents SET status = CASE WHEN status IN ('open', 'acknowledged') THEN 'contained' ELSE status END, updated_at = $2 WHERE id = $1`,
      [c.incidentId, now],
    );
  return row;
}

/**
 * Reverses a containment action. A block is lifted and a key restored by one staff member; a frozen staff
 * account needs two: the first call records the request, a second staff member's call unfreezes it.
 */
export async function reverseContainment(
  deps: Pick<Deps, 'router' | 'now'>,
  db: Db,
  actionId: string,
  staffId: string,
): Promise<{ state: 'reversed' | 'awaitingSecondApproval' }> {
  const now = deps.now();
  const a = (
    await db.query<{
      id: string;
      kind: ContainmentKind;
      incident_id: string | null;
      subject_tenant_id: string | null;
      target_id: string | null;
      reversed_at: string | null;
      reversal_requested_by: string | null;
    }>('SELECT * FROM security.containment_actions WHERE id = $1 FOR UPDATE', [actionId])
  ).rows[0];
  if (!a) throw new ApiError('notFound');
  if (a.reversed_at) throw new ApiError('conflict', 'alreadyReversed');
  if (a.kind === 'end_sessions') throw new ApiError('conflict', 'nothingToReverse');
  if (a.kind === 'freeze_staff') {
    if (a.target_id === staffId) throw new ApiError('forbidden', 'notOwnFreeze');
    if (!a.reversal_requested_by) {
      await db.query(
        'UPDATE security.containment_actions SET reversal_requested_by = $2, reversal_requested_at = $3 WHERE id = $1',
        [actionId, staffId, now],
      );
      await timeline(db, a.incident_id, 'reversal', staffId, { actionId, kind: a.kind, step: 'requested' });
      return { state: 'awaitingSecondApproval' };
    }
    if (a.reversal_requested_by === staffId) throw new ApiError('forbidden', 'secondPersonRequired');
    await db.query('UPDATE backoffice.staff_users SET active = true WHERE id = $1', [a.target_id]);
  }
  if (a.kind === 'suspend_api_key' && a.subject_tenant_id && a.target_id) {
    await withTenant(deps.router, a.subject_tenant_id, (tx) =>
      tx.exec('UPDATE app.api_keys SET suspended_at = NULL WHERE id = $1', [a.target_id]),
    );
    await tenantAudit(deps, a.subject_tenant_id, {
      action: 'security.api_key_restored',
      targetType: 'api_key',
      targetId: a.target_id,
      staffId,
      diff: { incidentId: a.incident_id },
    });
  }
  await db.query('UPDATE security.containment_actions SET reversed_by = $2, reversed_at = $3 WHERE id = $1', [
    actionId,
    staffId,
    now,
  ]);
  await timeline(db, a.incident_id, 'reversal', staffId, { actionId, kind: a.kind, step: 'done' });
  return { state: 'reversed' };
}
