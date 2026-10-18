import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';

const Grant = Type.Object({
  id: Type.String(),
  staffId: Type.String(),
  accessLevel: Type.String(),
  reason: Type.String(),
  startsAt: Type.String(),
  expiresAt: Type.String(),
  revokedAt: Type.Union([Type.String(), Type.Null()]),
});

/** Customer-side management of time-limited Thapsus support access. */
export async function supportGrantRoutes(app: FastifyInstance) {
  const map = (r: Record<string, string | null>) => ({
    id: r.id!,
    staffId: r.staff_id!,
    accessLevel: r.access_level!,
    reason: r.reason!,
    startsAt: r.starts_at!,
    expiresAt: r.expires_at!,
    revokedAt: r.revoked_at,
  });

  app.get('/v1/settings/support-grants', { schema: { tags: ['settings'], response: { 200: Type.Array(Grant), 403: Problem } } }, async (req) => {
    authorize(req, 'settings.read');
    const rows = await app.tenantTx(req, (tx) => tx.query<Record<string, string | null>>('SELECT * FROM app.support_grants ORDER BY created_at DESC'), { readOnly: true });
    return rows.map(map);
  });

  app.post(
    '/v1/settings/support-grants',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        body: Type.Object({
          staffId: Type.String({ format: 'uuid' }),
          accessLevel: Type.Union([Type.Literal('read'), Type.Literal('read_write')]),
          hours: Type.Integer({ minimum: 1, maximum: 720 }),
          reason: Type.String({ minLength: 3, maxLength: 500 }),
        }),
        response: { 201: Grant, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const b = req.body as { staffId: string; accessLevel: string; hours: number; reason: string };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<Record<string, string | null>>(
          `INSERT INTO app.support_grants (tenant_id, staff_id, granted_by_user_id, access_level, reason, expires_at)
           VALUES (app.current_tenant(), $1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING *`,
          [b.staffId, auth.userId, b.accessLevel, b.reason, b.hours],
        );
        await app.audit(tx, req, { action: 'support.grant_created', targetType: 'support_grant', targetId: r.id!, diff: { staffId: b.staffId, accessLevel: b.accessLevel, hours: b.hours } });
        return r;
      });
      return reply.status(201).send(map(row));
    },
  );

  app.delete(
    '/v1/settings/support-grants/:id',
    { config: { selfAudited: true }, schema: { tags: ['settings'], params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: Type.Null(), 404: Problem } } },
    async (req, reply) => {
      authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const n = await tx.exec('UPDATE app.support_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'support.grant_revoked', targetType: 'support_grant', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );
}
