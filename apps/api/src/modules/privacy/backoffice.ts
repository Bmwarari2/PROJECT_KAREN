import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { addMinutes } from '@thapsus/core/time';
import { LEGAL } from '@thapsus/core/trust';
import { TenantNotFoundError, withTenant, writeAudit } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { notify } from '../../lib/notify';
import { backofficePool, requireStaff, staffAudit } from '../backoffice/auth';
import { privacyAdmins } from './routes';

/**
 * Thapsus-side breach register (Thapsus as processor): records breaches without personal data, tracks
 * the contractual deadline to tell each affected controller (GDPR / UK GDPR Art. 33(2): "without
 * undue delay"; the hour target is a DPA term pending legal review) and notifies each affected tenant
 * by opening an incident in its own log. Staff only.
 */
const Breach = Type.Object({
  id: Uuid,
  cell: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  status: Type.String(),
  awareAt: Type.String(),
  affectedTenantIds: Type.Array(Uuid),
  dataCategories: Type.Array(Type.String()),
  controllersNotifyBy: Type.String(),
  controllersNotifiedAt: Nullable(Type.String()),
  overdue: Type.Boolean(),
  createdAt: Type.String(),
});
type Row = {
  id: string;
  cell: string;
  title: string;
  summary: string;
  status: string;
  aware_at: string;
  affected_tenant_ids: string[];
  data_categories: string[];
  controllers_notify_by: string;
  controllers_notified_at: string | null;
  created_at: string;
};

export async function privacyBackofficeRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const map = (r: Row) => ({
    id: r.id,
    cell: r.cell,
    title: r.title,
    summary: r.summary,
    status: r.status,
    awareAt: r.aware_at,
    affectedTenantIds: r.affected_tenant_ids,
    dataCategories: r.data_categories,
    controllersNotifyBy: r.controllers_notify_by,
    controllersNotifiedAt: r.controllers_notified_at,
    overdue: !r.controllers_notified_at && r.controllers_notify_by < deps.now().toISOString(),
    createdAt: r.created_at,
  });

  app.get(
    '/v1/backoffice/breaches',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support']),
      schema: { tags: ['backoffice'], response: { 200: Type.Array(Breach), 401: Problem, 403: Problem } },
    },
    async () => {
      const { rows } = await backofficePool(app).query<Row>(
        `SELECT * FROM backoffice.breach_register WHERE cell = $1 ORDER BY status = 'closed', aware_at DESC LIMIT 500`,
        [deps.config.cell],
      );
      return rows.map(map);
    },
  );

  app.post(
    '/v1/backoffice/breaches',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support']),
      schema: {
        tags: ['backoffice'],
        summary: 'Record a processor-side breach (no personal data in the register)',
        body: Type.Object({
          title: Type.String({ minLength: 3, maxLength: 200 }),
          summary: Type.String({ minLength: 3, maxLength: 10_000 }),
          awareAt: Type.String({ format: 'date-time' }),
          affectedTenantIds: Type.Array(Uuid, { maxItems: 100_000 }),
          dataCategories: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 30 })),
        }),
        response: { 201: Breach, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        title: string;
        summary: string;
        awareAt: string;
        affectedTenantIds: string[];
        dataCategories?: string[];
      };
      const awareAt = new Date(b.awareAt).toISOString();
      const notifyBy = addMinutes(awareAt, LEGAL.processorBreachNotifyHours * 60);
      const { rows } = await backofficePool(app).query<Row>(
        `INSERT INTO backoffice.breach_register (cell, title, summary, aware_at, affected_tenant_ids, data_categories, controllers_notify_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          deps.config.cell,
          b.title,
          b.summary,
          awareAt,
          b.affectedTenantIds,
          b.dataCategories ?? [],
          notifyBy,
          req.staff!.staffId,
        ],
      );
      await staffAudit(app, req, 'breach.recorded', {
        breachId: rows[0]!.id,
        tenants: b.affectedTenantIds.length,
      });
      return reply.status(201).send(map(rows[0]!));
    },
  );

  app.post(
    '/v1/backoffice/breaches/:id/notify-controllers',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support']),
      schema: {
        tags: ['backoffice'],
        summary: 'Notify every affected controller (opens an incident in each tenant log)',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ notified: Type.Integer(), notInThisCell: Type.Integer(), breach: Breach }),
          401: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const pool = backofficePool(app);
      const r = (
        await pool.query<Row>(`SELECT * FROM backoffice.breach_register WHERE id = $1 AND cell = $2`, [
          id,
          deps.config.cell,
        ])
      ).rows[0];
      if (!r) throw new ApiError('notFound');
      let notified = 0;
      let elsewhere = 0;
      for (const tenantId of r.affected_tenant_ids) {
        try {
          await withTenant(deps.router, tenantId, async (tx) => {
            const inc = await tx.one<{ id: string }>(
              `INSERT INTO app.incidents (tenant_id, source, title, description, severity, personal_data_breach, aware_at, data_categories) VALUES (app.current_tenant(), 'processor', $1, $2, 'high', true, $3, $4) RETURNING id`,
              [r.title, r.summary, deps.now().toISOString(), r.data_categories],
            );
            await notify(tx, {
              userIds: await privacyAdmins(tx),
              kind: 'privacy.incident',
              titleKey: 'notify.processorBreach',
              params: { title: r.title },
              target: { type: 'privacy_incident', id: inc.id },
              dedupeKey: `processor-breach:${r.id}`,
            });
            await writeAudit(tx, {
              actorType: 'support',
              actorId: null,
              action: 'privacy.processor_breach_notified',
              targetType: 'incident',
              targetId: inc.id,
              diff: { breachId: r.id },
            });
          });
          notified++;
        } catch (err) {
          if (err instanceof TenantNotFoundError) elsewhere++;
          else throw err;
        }
      }
      const { rows } = await pool.query<Row>(
        `UPDATE backoffice.breach_register SET controllers_notified_at = coalesce(controllers_notified_at, $2), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, deps.now().toISOString()],
      );
      await staffAudit(app, req, 'breach.controllers_notified', { breachId: id, notified, elsewhere });
      return { notified, notInThisCell: elsewhere, breach: map(rows[0]!) };
    },
  );

  app.get(
    '/v1/backoffice/tenants/:id/deletion-certificate',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support']),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            tenantId: Uuid,
            issuedAt: Type.String(),
            sha256: Type.String(),
            certificate: Type.Any(),
          }),
          401: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { rows } = await backofficePool(app).query<{
        tenant_id: string;
        issued_at: string;
        certificate: unknown;
        certificate_sha256: string;
      }>(`SELECT * FROM registry.deletion_certificates WHERE tenant_id = $1`, [id]);
      if (!rows[0]) throw new ApiError('notFound');
      await staffAudit(app, req, 'tenant.deletion_certificate_viewed', {}, id);
      return {
        tenantId: rows[0].tenant_id,
        issuedAt: rows[0].issued_at,
        sha256: rows[0].certificate_sha256,
        certificate: rows[0].certificate,
      };
    },
  );
}
