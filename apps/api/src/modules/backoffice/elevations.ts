import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { emitSecurityEvent } from '../../lib/security-events';
import {
  backofficePool,
  requireStaff,
  STAFF_ROLES,
  staffAudit,
  type ElevationScope,
  type StaffRole,
} from './auth';

/**
 * Just-in-time elevation for Thapsus staff (plan 2.2.3, 2.2.6; ADR-0173). Nobody holds standing access to
 * super-admin actions, rule publishing or the use of a customer's support grant. A staff member asks for a
 * scope with a reason and a duration; a DIFFERENT staff member who could hold that scope approves it after
 * re-authenticating with their key; it then lasts until it expires (at most 4 hours) or is revoked.
 * Every step is in the staff audit trail and emitted as a `staff.elevation_*` security event.
 */
export const ELEVATION_MAX_MINUTES = 240;
/** A request nobody approved within this time can no longer be approved (ask again). */
export const ELEVATION_PENDING_MINUTES = 60;

/** Who may request (and approve) each scope. */
export const ELEVATION_ROLES: Record<ElevationScope, StaffRole[]> = {
  super_admin: ['super_admin'],
  rules_publish: ['rules_editor', 'super_admin'],
  support_grant: ['support', 'super_admin'],
};

const ElevationOut = Type.Object({
  id: Uuid,
  staffId: Uuid,
  staffEmail: Type.String(),
  scope: Type.String(),
  subjectTenantId: Nullable(Type.String()),
  reason: Type.String(),
  minutes: Type.Integer(),
  requestedAt: Type.String(),
  approvedBy: Nullable(Type.String()),
  approvedAt: Nullable(Type.String()),
  expiresAt: Nullable(Type.String()),
  deniedAt: Nullable(Type.String()),
  revokedAt: Nullable(Type.String()),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('active'),
    Type.Literal('expired'),
    Type.Literal('denied'),
    Type.Literal('revoked'),
  ]),
});

interface Row {
  id: string;
  staff_id: string;
  staff_email: string;
  scope: ElevationScope;
  subject_tenant_id: string | null;
  reason: string;
  minutes: number;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  denied_at: string | null;
  revoked_at: string | null;
}
const COLS = `e.id, e.staff_id, u.email AS staff_email, e.scope, e.subject_tenant_id, e.reason, e.minutes, e.requested_at,
  e.approved_by, e.approved_at, e.expires_at, e.denied_at, e.revoked_at`;

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export async function elevationRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const pool = () => backofficePool(app);
  const now = () => deps.now();
  const status = (r: Row) =>
    r.revoked_at
      ? 'revoked'
      : r.denied_at
        ? 'denied'
        : r.approved_at
          ? new Date(r.expires_at!) > now()
            ? 'active'
            : 'expired'
          : new Date(r.requested_at).getTime() + ELEVATION_PENDING_MINUTES * 60_000 > now().getTime()
            ? 'pending'
            : 'expired';
  const out = (r: Row) => ({
    id: r.id,
    staffId: r.staff_id,
    staffEmail: r.staff_email,
    scope: r.scope,
    subjectTenantId: r.subject_tenant_id,
    reason: r.reason,
    minutes: r.minutes,
    requestedAt: new Date(r.requested_at).toISOString(),
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    expiresAt: iso(r.expires_at),
    deniedAt: iso(r.denied_at),
    revokedAt: iso(r.revoked_at),
    status: status(r) as 'pending' | 'active' | 'expired' | 'denied' | 'revoked',
  });
  const any = { config: { auth: 'public' as const, selfAudited: true } };

  app.get(
    '/v1/backoffice/elevations',
    {
      ...any,
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        summary: 'Your elevations, and requests from other staff that you may approve',
        response: {
          200: Type.Object({ mine: Type.Array(ElevationOut), toApprove: Type.Array(ElevationOut) }),
          401: Problem,
        },
      },
    },
    async (req) => {
      const me = req.staff!;
      const mine = (
        await pool().query<Row>(
          `SELECT ${COLS} FROM backoffice.staff_elevations e JOIN backoffice.staff_users u ON u.id = e.staff_id
            WHERE e.staff_id = $1 ORDER BY e.requested_at DESC LIMIT 50`,
          [me.staffId],
        )
      ).rows;
      const scopes = (Object.keys(ELEVATION_ROLES) as ElevationScope[]).filter((s) =>
        ELEVATION_ROLES[s].includes(me.role),
      );
      const toApprove = (
        await pool().query<Row>(
          `SELECT ${COLS} FROM backoffice.staff_elevations e JOIN backoffice.staff_users u ON u.id = e.staff_id
            WHERE e.staff_id <> $1 AND e.approved_at IS NULL AND e.denied_at IS NULL AND e.revoked_at IS NULL
              AND e.requested_at > $2 AND e.scope = ANY($3) ORDER BY e.requested_at`,
          [me.staffId, new Date(now().getTime() - ELEVATION_PENDING_MINUTES * 60_000), scopes],
        )
      ).rows;
      return { mine: mine.map(out), toApprove: toApprove.map(out) };
    },
  );

  app.post(
    '/v1/backoffice/elevations',
    {
      ...any,
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        summary: 'Ask for a time-boxed elevation; another staff member must approve it',
        body: Type.Object(
          {
            scope: Type.Union([
              Type.Literal('super_admin'),
              Type.Literal('rules_publish'),
              Type.Literal('support_grant'),
            ]),
            reason: Type.String({ minLength: 10, maxLength: 500 }),
            minutes: Type.Integer({ minimum: 5, maximum: ELEVATION_MAX_MINUTES }),
            tenantId: Type.Optional(Uuid),
          },
          { additionalProperties: false },
        ),
        response: { 201: ElevationOut, 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const me = req.staff!;
      const b = req.body as { scope: ElevationScope; reason: string; minutes: number; tenantId?: string };
      if (!ELEVATION_ROLES[b.scope].includes(me.role))
        throw new ApiError('forbidden', 'scopeNotForYourRole', { reason: 'scopeNotForYourRole' });
      const { rows } = await pool().query<{ id: string }>(
        `INSERT INTO backoffice.staff_elevations (staff_id, scope, subject_tenant_id, reason, minutes, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [me.staffId, b.scope, b.tenantId ?? null, b.reason.trim(), b.minutes, now()],
      );
      const id = rows[0]!.id;
      await staffAudit(
        app,
        req,
        'staff.elevation_requested',
        { id, scope: b.scope, minutes: b.minutes },
        b.tenantId,
      );
      emitSecurityEvent(deps, req, {
        type: 'staff.elevation_requested',
        severity: b.scope === 'super_admin' ? 'medium' : 'low',
        staffId: me.staffId,
        detail: { scope: b.scope, minutes: b.minutes },
      });
      const row = (
        await pool().query<Row>(
          `SELECT ${COLS} FROM backoffice.staff_elevations e JOIN backoffice.staff_users u ON u.id = e.staff_id WHERE e.id = $1`,
          [id],
        )
      ).rows[0]!;
      return reply.status(201).send(out(row));
    },
  );

  async function decide(id: string, staffId: string, role: StaffRole) {
    const r = (
      await pool().query<Row>(
        `SELECT ${COLS} FROM backoffice.staff_elevations e JOIN backoffice.staff_users u ON u.id = e.staff_id WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!r) throw new ApiError('notFound');
    // separation of duties: nobody approves (or denies) their own request
    if (r.staff_id === staffId) throw new ApiError('forbidden', 'ownRequest', { reason: 'ownRequest' });
    if (!ELEVATION_ROLES[r.scope].includes(role))
      throw new ApiError('forbidden', 'scopeNotForYourRole', { reason: 'scopeNotForYourRole' });
    if (status(r) !== 'pending') throw new ApiError('conflict', 'notPending');
    return r;
  }

  app.post(
    '/v1/backoffice/elevations/:id/approve',
    {
      ...any,
      // approving gives someone else access: a fresh key assertion is required
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true, reauth: true }),
      schema: {
        tags: ['backoffice'],
        summary: 'Approve another staff member’s elevation (re-authenticate first); it starts now',
        params: Type.Object({ id: Uuid }),
        response: { 200: ElevationOut, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const me = req.staff!;
      const { id } = req.params as { id: string };
      const r = await decide(id, me.staffId, me.role);
      const at = now();
      const { rows } = await pool().query<{ id: string }>(
        `UPDATE backoffice.staff_elevations SET approved_by = $2, approved_at = $3, expires_at = $4
          WHERE id = $1 AND approved_at IS NULL AND denied_at IS NULL AND revoked_at IS NULL RETURNING id`,
        [id, me.staffId, at, new Date(at.getTime() + r.minutes * 60_000)],
      );
      if (!rows[0]) throw new ApiError('conflict', 'notPending');
      await staffAudit(
        app,
        req,
        'staff.elevation_approved',
        { id, scope: r.scope, requester: r.staff_id, minutes: r.minutes },
        r.subject_tenant_id,
      );
      emitSecurityEvent(deps, req, {
        type: 'staff.elevation_approved',
        severity: r.scope === 'super_admin' ? 'high' : 'medium',
        staffId: r.staff_id,
        detail: { scope: r.scope, approvedBy: me.staffId, minutes: r.minutes },
      });
      const row = (
        await pool().query<Row>(
          `SELECT ${COLS} FROM backoffice.staff_elevations e JOIN backoffice.staff_users u ON u.id = e.staff_id WHERE e.id = $1`,
          [id],
        )
      ).rows[0]!;
      return out(row);
    },
  );

  app.post(
    '/v1/backoffice/elevations/:id/deny',
    {
      ...any,
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const me = req.staff!;
      const { id } = req.params as { id: string };
      const r = await decide(id, me.staffId, me.role);
      await pool().query(
        'UPDATE backoffice.staff_elevations SET denied_by = $2, denied_at = $3 WHERE id = $1 AND approved_at IS NULL',
        [id, me.staffId, now()],
      );
      await staffAudit(app, req, 'staff.elevation_denied', { id, scope: r.scope, requester: r.staff_id });
      emitSecurityEvent(deps, req, {
        type: 'staff.elevation_denied',
        severity: 'low',
        staffId: r.staff_id,
        detail: { scope: r.scope, deniedBy: me.staffId },
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/backoffice/elevations/:id/revoke',
    {
      ...any,
      preHandler: requireStaff(app, STAFF_ROLES, { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        summary: 'End an elevation early (your own, or anyone’s if you are a super admin)',
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const me = req.staff!;
      const { id } = req.params as { id: string };
      const { rows } = await pool().query<{ staff_id: string; scope: string }>(
        'SELECT staff_id, scope FROM backoffice.staff_elevations WHERE id = $1',
        [id],
      );
      const r = rows[0];
      if (!r) throw new ApiError('notFound');
      if (r.staff_id !== me.staffId && me.role !== 'super_admin') throw new ApiError('forbidden');
      await pool().query(
        'UPDATE backoffice.staff_elevations SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
        [id, now()],
      );
      await staffAudit(app, req, 'staff.elevation_revoked', { id, scope: r.scope, of: r.staff_id });
      emitSecurityEvent(deps, req, {
        type: 'staff.elevation_revoked',
        severity: 'low',
        staffId: r.staff_id,
        detail: { scope: r.scope, revokedBy: me.staffId },
      });
      return reply.status(204).send(null);
    },
  );
}
