import { getPool, withTenant, writeAudit, type TenantRouter, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';

export interface SupportGrant {
  id: string;
  access_level: 'read' | 'read_write';
  expires_at: string;
}

/**
 * The ONLY path from the Thapsus back office to tenant data. Requires an active, customer-granted,
 * unexpired, unrevoked grant for that staff member; the transaction is read-only for 'read' grants;
 * the access and the action are both audit-logged in the customer's audit log and the staff trail.
 */
export async function withSupportAccess<T>(
  opts: { router: TenantRouter; backofficeDbUrl: string },
  staffId: string,
  tenantId: string,
  action: string,
  fn: (tx: Tx, grant: SupportGrant) => Promise<T>,
  meta: { ip?: string; requestId?: string; write?: boolean } = {},
): Promise<T> {
  const bo = getPool(opts.backofficeDbUrl);
  const { rows } = await bo.query<SupportGrant>(
    `SELECT id, access_level, expires_at FROM app.support_grants
      WHERE tenant_id = $1 AND staff_id = $2 AND revoked_at IS NULL AND now() >= starts_at AND now() < expires_at
      ORDER BY expires_at DESC LIMIT 1`,
    [tenantId, staffId],
  );
  const grant = rows[0];
  await bo.query(
    `INSERT INTO backoffice.staff_audit (staff_id, action, subject_tenant_id, target, detail, ip, request_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      staffId,
      grant ? `support.${action}` : 'support.access_denied',
      tenantId,
      action,
      JSON.stringify({ grantId: grant?.id ?? null }),
      meta.ip ?? null,
      meta.requestId ?? null,
    ],
  );
  if (!grant) throw new ApiError('forbidden', 'No active support grant');
  if (meta.write && grant.access_level !== 'read_write')
    throw new ApiError('forbidden', 'Grant is read-only');
  const readOnly = grant.access_level === 'read' || !meta.write;
  // Audit entry first, in its own transaction, so even read-only access is recorded.
  await withTenant(opts.router, tenantId, (tx) =>
    writeAudit(tx, {
      actorType: 'support',
      actorId: staffId,
      action: `support.${action}`,
      targetType: 'support_grant',
      targetId: grant.id,
      ip: meta.ip,
      requestId: meta.requestId,
    }),
  );
  return withTenant(opts.router, tenantId, (tx) => fn(tx, grant), { actorId: staffId, readOnly });
}
