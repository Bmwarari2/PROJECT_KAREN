import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { FEATURE_FLAGS, isFeatureKey, type FeatureKey } from '@thapsus/core/features';
import { setFeatureFlag, withTenant, writeAudit } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { backofficePool, requireStaff, staffAudit } from '../backoffice/auth';
import { featureFlagList, FeatureFlagOut } from './tenant-settings';

/**
 * Back-office (Thapsus staff) controls for Phase 9: per-tenant feature flags (including staff-managed
 * ones), per-tenant API rate limits, and dedicated-database move requests with status tracking.
 * These touch tenant CONFIGURATION only (app.tenants.features) — never personal data — and every
 * change is recorded in the staff trail and in the customer's own audit log.
 */
const Move = Type.Object({
  id: Uuid,
  tenantId: Uuid,
  targetKey: Type.String(),
  purgeSource: Type.Boolean(),
  status: Type.Union(['requested', 'running', 'succeeded', 'failed', 'cancelled'].map((s) => Type.Literal(s))),
  reason: Type.String(),
  requestedBy: Uuid,
  requestedAt: Type.String(),
  startedAt: Nullable(Type.String()),
  finishedAt: Nullable(Type.String()),
  progress: Type.Array(Type.String()),
  report: Type.Any(),
  error: Nullable(Type.String()),
});
interface MoveRow {
  id: string;
  subject_tenant_id: string;
  target_db_key: string;
  purge_source: boolean;
  status: 'requested';
  reason: string;
  requested_by: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: string[];
  report: unknown;
  error: string | null;
}
const moveOut = (m: MoveRow) => ({
  id: m.id,
  tenantId: m.subject_tenant_id,
  targetKey: m.target_db_key,
  purgeSource: m.purge_source,
  status: m.status,
  reason: m.reason,
  requestedBy: m.requested_by,
  requestedAt: m.requested_at,
  startedAt: m.started_at,
  finishedAt: m.finished_at,
  progress: m.progress,
  report: m.report ?? null,
  error: m.error,
});

export async function platformBackofficeRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const staffOnly = { config: { auth: 'public' as const, selfAudited: true }, preHandler: requireStaff(app, []) };
  const TenantParams = Type.Object({ tenantId: Uuid });

  async function registryEntry(tenantId: string) {
    const { rows } = await backofficePool(app).query<{ tenant_id: string; db_key: string; status: string; home_region: string }>('SELECT tenant_id, db_key, status, home_region FROM registry.tenants WHERE tenant_id = $1', [tenantId]);
    if (!rows[0] || rows[0].home_region !== deps.config.cell) throw new ApiError('notFound');
    return rows[0];
  }
  const tenantAudit = (req: FastifyRequest, tenantId: string, action: string, diff: Record<string, unknown>) =>
    withTenant(deps.router, tenantId, (tx) => writeAudit(tx, { actorType: 'support', actorId: req.staff!.staffId, action, diff: { ...diff, by: 'thapsus-staff' }, ip: req.ctx.ip, requestId: req.id }));

  // ---- Feature flags ------------------------------------------------------------------------------
  app.get('/v1/backoffice/tenants/:tenantId/features', { ...staffOnly, schema: { tags: ['backoffice'], params: TenantParams, response: { 200: Type.Array(FeatureFlagOut), 401: Problem, 403: Problem, 404: Problem } } }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    await registryEntry(tenantId);
    return withTenant(deps.router, tenantId, featureFlagList, { readOnly: true });
  });

  app.put(
    '/v1/backoffice/tenants/:tenantId/features/:key',
    { ...staffOnly, schema: { tags: ['backoffice'], summary: 'Set any feature flag for a tenant (including staff-managed ones)', params: Type.Object({ tenantId: Uuid, key: Type.String({ maxLength: 60 }) }), body: Type.Object({ enabled: Nullable(Type.Boolean()) }), response: { 200: Type.Array(FeatureFlagOut), 401: Problem, 403: Problem, 404: Problem } } },
    async (req) => {
      const { tenantId, key } = req.params as { tenantId: string; key: string };
      const { enabled } = req.body as { enabled: boolean | null };
      if (!isFeatureKey(key)) throw new ApiError('notFound');
      await registryEntry(tenantId);
      const list = await withTenant(deps.router, tenantId, async (tx) => {
        const before = await setFeatureFlag(tx, key as FeatureKey, enabled);
        await writeAudit(tx, { actorType: 'support', actorId: req.staff!.staffId, action: 'feature.flag_changed', targetType: 'feature_flag', targetId: key, diff: { from: before, to: enabled, managedBy: FEATURE_FLAGS[key].managedBy, by: 'thapsus-staff' }, ip: req.ctx.ip, requestId: req.id });
        return featureFlagList(tx);
      });
      await staffAudit(app, req, 'tenant.feature_flag_changed', { key, enabled }, tenantId);
      return list;
    },
  );

  // ---- API rate limit override --------------------------------------------------------------------
  app.put(
    '/v1/backoffice/tenants/:tenantId/api-settings',
    { ...staffOnly, schema: { tags: ['backoffice'], summary: 'Override the tenant’s public API rate limit (null restores the plan default)', params: TenantParams, body: Type.Object({ rateLimitPerMinute: Nullable(Type.Integer({ minimum: 1, maximum: 100_000 })) }), response: { 200: Type.Object({ rateLimitPerMinute: Nullable(Type.Integer()) }), 401: Problem, 403: Problem, 404: Problem } } },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const { rateLimitPerMinute } = req.body as { rateLimitPerMinute: number | null };
      await registryEntry(tenantId);
      await withTenant(deps.router, tenantId, (tx) =>
        tx.exec(
          `UPDATE app.tenants SET features = jsonb_set(features, '{api}', CASE WHEN $1::int IS NULL THEN coalesce(features->'api', '{}'::jsonb) - 'rateLimitPerMinute'
             ELSE coalesce(features->'api', '{}'::jsonb) || jsonb_build_object('rateLimitPerMinute', $1::int) END)`,
          [rateLimitPerMinute],
        ),
      );
      await tenantAudit(req, tenantId, 'api.rate_limit_changed', { rateLimitPerMinute });
      await staffAudit(app, req, 'tenant.api_rate_limit_changed', { rateLimitPerMinute }, tenantId);
      return { rateLimitPerMinute };
    },
  );

  // ---- Dedicated database moves (runbook: docs/runbooks/move-tenant-to-dedicated-db.md) ---------
  app.post(
    '/v1/backoffice/tenants/:tenantId/database-moves',
    {
      ...staffOnly,
      schema: {
        tags: ['backoffice'],
        summary: 'Request a move of the tenant to another configured database (run by the move runner, status-tracked)',
        params: TenantParams,
        body: Type.Object({ targetKey: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' }), purgeSource: Type.Optional(Type.Boolean()), reason: Type.String({ minLength: 3, maxLength: 500 }) }, { additionalProperties: false }),
        response: { 202: Move, 401: Problem, 403: Problem, 404: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const b = req.body as { targetKey: string; purgeSource?: boolean; reason: string };
      const entry = await registryEntry(tenantId);
      // Step 3 of the runbook must be done first: the target must already be in the routing configuration.
      if (!(b.targetKey in deps.router.config.databases)) throw new ApiError('unprocessable', 'targetNotConfigured');
      if (entry.db_key === b.targetKey) throw new ApiError('unprocessable', 'alreadyOnTarget');
      if (entry.status !== 'active') throw new ApiError('conflict', 'tenantNotActive');
      const { rows } = await backofficePool(app)
        .query<MoveRow>(`INSERT INTO backoffice.tenant_moves (subject_tenant_id, target_db_key, purge_source, requested_by, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [tenantId, b.targetKey, b.purgeSource ?? false, req.staff!.staffId, b.reason])
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw new ApiError('conflict', 'moveAlreadyOpen');
          throw err;
        });
      await staffAudit(app, req, 'tenant.database_move_requested', { moveId: rows[0]!.id, targetKey: b.targetKey, purgeSource: b.purgeSource ?? false, reason: b.reason }, tenantId);
      await tenantAudit(req, tenantId, 'tenant.database_move_requested', { moveId: rows[0]!.id, targetKey: b.targetKey });
      return reply.status(202).send(moveOut(rows[0]!));
    },
  );

  app.get('/v1/backoffice/tenants/:tenantId/database-moves', { ...staffOnly, schema: { tags: ['backoffice'], params: TenantParams, response: { 200: Type.Array(Move), 401: Problem, 403: Problem } } }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const { rows } = await backofficePool(app).query<MoveRow>('SELECT * FROM backoffice.tenant_moves WHERE subject_tenant_id = $1 ORDER BY requested_at DESC', [tenantId]);
    return rows.map(moveOut);
  });

  app.get('/v1/backoffice/database-moves/:id', { ...staffOnly, schema: { tags: ['backoffice'], summary: 'Status and progress of a move request', params: Type.Object({ id: Uuid }), response: { 200: Move, 401: Problem, 403: Problem, 404: Problem } } }, async (req) => {
    const { rows } = await backofficePool(app).query<MoveRow>('SELECT * FROM backoffice.tenant_moves WHERE id = $1', [(req.params as { id: string }).id]);
    if (!rows[0]) throw new ApiError('notFound');
    return moveOut(rows[0]);
  });

  app.post('/v1/backoffice/database-moves/:id/cancel', { ...staffOnly, schema: { tags: ['backoffice'], summary: 'Cancel a move that has not started', params: Type.Object({ id: Uuid }), response: { 200: Move, 401: Problem, 403: Problem, 409: Problem } } }, async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await backofficePool(app).query<MoveRow>(`UPDATE backoffice.tenant_moves SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'requested' RETURNING *`, [id]);
    if (!rows[0]) throw new ApiError('conflict', 'moveNotCancellable');
    await staffAudit(app, req, 'tenant.database_move_cancelled', { moveId: id }, rows[0].subject_tenant_id);
    return moveOut(rows[0]);
  });
}
