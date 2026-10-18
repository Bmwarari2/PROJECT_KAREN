import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { instantToDate } from '@thapsus/core/time';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { scopePredicate } from '../employees/service';
import { recordExpiry, type MatrixStatus } from './engine';
import { matrixCells, type ReqRow } from './status';
import { complianceSettings, EMPLOYEE_COLUMNS, EMPLOYEE_FROM, targetOf, type EmployeeRow } from './service';

const KINDS = ['licence', 'certification', 'background_check', 'training', 'other'] as const;
const Scope = Type.Object(
  {
    jobTitles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 })),
    locationIds: Type.Optional(Type.Array(Uuid, { maxItems: 500 })),
    entityIds: Type.Optional(Type.Array(Uuid, { maxItems: 500 })),
    departmentIds: Type.Optional(Type.Array(Uuid, { maxItems: 500 })),
    countries: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z]{2}$' }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);
const Requirement = Type.Object({ id: Uuid, kind: Type.String(), name: Type.String(), description: Nullable(Type.String()), appliesTo: Scope, validityMonths: Nullable(Type.Integer()), reminderDays: Type.Array(Type.Integer()), evidenceRequired: Type.Boolean(), active: Type.Boolean() });
const RequirementBody = Type.Object({
  kind: Type.Union(KINDS.map((k) => Type.Literal(k))),
  name: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  appliesTo: Type.Optional(Scope),
  validityMonths: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 600 }))),
  reminderDays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 730 }), { maxItems: 10 })),
  evidenceRequired: Type.Optional(Type.Boolean()),
  active: Type.Optional(Type.Boolean()),
});
const mapReq = (r: ReqRow) => ({ id: r.id, kind: r.kind, name: r.name, description: r.description, appliesTo: r.applies_to, validityMonths: r.validity_months, reminderDays: r.reminder_days, evidenceRequired: r.evidence_required, active: r.active });
const MatrixRow = Type.Object({ employeeId: Uuid, employeeName: Type.String(), jobTitle: Nullable(Type.String()), requirementId: Uuid, requirementName: Type.String(), kind: Type.String(), status: Type.String(), recordId: Nullable(Uuid), issuedOn: Nullable(Type.String()), expiresOn: Nullable(Type.String()), daysLeft: Nullable(Type.Integer()), evidenceRequired: Type.Boolean(), hasEvidence: Type.Boolean() });

/** Compliance matrix: licences, certifications, background checks and training per role, location and entity. */
export async function matrixRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.get('/v1/compliance/requirements', { schema: { tags: ['compliance'], response: { 200: Type.Array(Requirement), 403: Problem } } }, async (req) => {
    authorizeSome(req, 'compliance.read');
    return app.tenantTx(req, async (tx) => (await tx.query<ReqRow>('SELECT * FROM app.compliance_requirements ORDER BY active DESC, name')).map(mapReq), { readOnly: true });
  });

  app.post('/v1/compliance/requirements', { config: { selfAudited: true }, schema: { tags: ['compliance'], body: RequirementBody, response: { 201: Requirement, 403: Problem } } }, async (req, reply) => {
    authorize(req, 'compliance.manage');
    const b = req.body as Static<typeof RequirementBody>;
    const row = await app.tenantTx(req, async (tx) => {
      const r = await tx.one<ReqRow>(
        `INSERT INTO app.compliance_requirements (tenant_id, kind, name, description, applies_to, validity_months, reminder_days, evidence_required, active, created_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [b.kind, b.name, b.description ?? null, JSON.stringify(b.appliesTo ?? {}), b.validityMonths ?? null, b.reminderDays ?? [], b.evidenceRequired ?? false, b.active ?? true, requireAuth(req).userId],
      );
      await app.audit(tx, req, { action: 'compliance.requirement_created', targetType: 'compliance_requirement', targetId: r.id, diff: b });
      return r;
    });
    return reply.status(201).send(mapReq(row));
  });

  app.patch('/v1/compliance/requirements/:id', { config: { selfAudited: true }, schema: { tags: ['compliance'], params: Type.Object({ id: Uuid }), body: Type.Partial(RequirementBody), response: { 200: Requirement, 403: Problem, 404: Problem } } }, async (req) => {
    authorize(req, 'compliance.manage');
    const { id } = req.params as { id: string };
    const b = req.body as Partial<Static<typeof RequirementBody>>;
    return app.tenantTx(req, async (tx) => {
      const before = await tx.maybe<ReqRow>('SELECT * FROM app.compliance_requirements WHERE id = $1', [id]);
      if (!before) throw new ApiError('notFound');
      const r = await tx.one<ReqRow>(
        `UPDATE app.compliance_requirements SET kind = $2, name = $3, description = $4, applies_to = $5, validity_months = $6, reminder_days = $7, evidence_required = $8, active = $9 WHERE id = $1 RETURNING *`,
        [id, b.kind ?? before.kind, b.name ?? before.name, b.description !== undefined ? b.description : before.description, JSON.stringify(b.appliesTo ?? before.applies_to), b.validityMonths !== undefined ? b.validityMonths : before.validity_months, b.reminderDays ?? before.reminder_days, b.evidenceRequired ?? before.evidence_required, b.active ?? before.active],
      );
      await app.audit(tx, req, { action: 'compliance.requirement_updated', targetType: 'compliance_requirement', targetId: id, diff: { before: mapReq(before), after: mapReq(r) } });
      return mapReq(r);
    });
  });

  app.post(
    '/v1/compliance/records',
    { config: { selfAudited: true }, schema: { tags: ['compliance'], summary: 'Record a licence, certificate, background check or training completion for an employee', body: Type.Object({ requirementId: Uuid, employeeId: Uuid, issuedOn: CivilDate, expiresOn: Type.Optional(Nullable(CivilDate)), reference: Type.Optional(Type.String({ maxLength: 120 })), evidenceDocumentId: Type.Optional(Uuid), notes: Type.Optional(Type.String({ maxLength: 1000 })) }), response: { 201: Type.Object({ id: Uuid, expiresOn: Nullable(Type.String()) }), 400: Problem, 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { requirementId: string; employeeId: string; issuedOn: string; expiresOn?: string | null; reference?: string; evidenceDocumentId?: string; notes?: string };
      if (b.expiresOn && b.expiresOn < b.issuedOn) throw new ApiError('validation', 'expiresOn is before issuedOn');
      const out = await app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [b.employeeId]);
        if (!e) throw new ApiError('notFound');
        if (!can(auth.principal, 'compliance.record', targetOf(e))) throw new ApiError('forbidden');
        const r = await tx.maybe<ReqRow>('SELECT * FROM app.compliance_requirements WHERE id = $1 AND active', [b.requirementId]);
        if (!r) throw new ApiError('notFound');
        if (b.evidenceDocumentId) {
          const doc = await tx.maybe<{ employee_id: string | null }>(`SELECT employee_id FROM app.documents WHERE id = $1 AND status = 'ready'`, [b.evidenceDocumentId]);
          if (!doc || doc.employee_id !== e.id) throw new ApiError('validation', 'Evidence must be a ready document of this employee');
        }
        const expiresOn = recordExpiry({ validityMonths: r.validity_months }, { issuedOn: b.issuedOn, expiresOn: b.expiresOn ?? null });
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.compliance_records (tenant_id, requirement_id, employee_id, issued_on, expires_on, reference, evidence_document_id, notes, recorded_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [r.id, e.id, b.issuedOn, expiresOn, b.reference ?? null, b.evidenceDocumentId ?? null, b.notes ?? null, auth.userId],
        );
        // a newer record replaces the older ones for the same requirement; their reminder tasks are closed
        const older = await tx.query<{ id: string }>(`UPDATE app.compliance_records SET status = 'revoked' WHERE employee_id = $1 AND requirement_id = $2 AND status = 'active' AND id <> $3 AND issued_on <= $4 RETURNING id`, [e.id, r.id, row.id, b.issuedOn]);
        for (const o of older) await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE dedupe_key LIKE $1 AND status = 'open'`, [`matrix:${o.id}:%`, auth.userId]);
        await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE dedupe_key = $1 AND status = 'open'`, [`matrix-missing:${r.id}:${e.id}`, auth.userId]);
        await app.audit(tx, req, { action: 'compliance.record_added', targetType: 'employee', targetId: e.id, diff: { recordId: row.id, requirementId: r.id, kind: r.kind, issuedOn: b.issuedOn, expiresOn, replaced: older.length } });
        return { id: row.id, expiresOn };
      });
      return reply.status(201).send(out);
    },
  );

  app.post('/v1/compliance/records/:id/revoke', { config: { selfAudited: true }, schema: { tags: ['compliance'], params: Type.Object({ id: Uuid }), body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 300 }) }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    return app.tenantTx(req, async (tx) => {
      const rec = await tx.maybe<{ employee_id: string }>('SELECT employee_id FROM app.compliance_records WHERE id = $1', [id]);
      if (!rec) throw new ApiError('notFound');
      const e = await tx.one<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [rec.employee_id]);
      if (!can(auth.principal, 'compliance.record', targetOf(e))) throw new ApiError('forbidden');
      await tx.exec(`UPDATE app.compliance_records SET status = 'revoked' WHERE id = $1`, [id]);
      await app.audit(tx, req, { action: 'compliance.record_revoked', targetType: 'employee', targetId: e.id, diff: { recordId: id, reason: (req.body as { reason: string }).reason } });
      return { id, status: 'revoked' };
    });
  });

  app.get(
    '/v1/compliance/matrix',
    {
      schema: {
        tags: ['compliance'],
        summary: 'Status per employee and applicable requirement (compliant / expiring / expired / missing), permission-scoped, with filters',
        querystring: Type.Object({
          asOf: Type.Optional(CivilDate),
          status: Type.Optional(Type.Union(['compliant', 'expiring', 'expired', 'missing'].map((s) => Type.Literal(s)))),
          requirementId: Type.Optional(Uuid),
          kind: Type.Optional(Type.Union(KINDS.map((k) => Type.Literal(k)))),
          entityId: Type.Optional(Uuid),
          locationId: Type.Optional(Uuid),
          departmentId: Type.Optional(Uuid),
          jobTitle: Type.Optional(Type.String({ maxLength: 200 })),
          employeeId: Type.Optional(Uuid),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        }),
        response: { 200: Type.Object({ asOf: Type.String(), summary: Type.Object({ compliant: Type.Integer(), expiring: Type.Integer(), expired: Type.Integer(), missing: Type.Integer() }), total: Type.Integer(), rows: Type.Array(MatrixRow) }), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.read');
      const q = req.query as { asOf?: string; status?: MatrixStatus; requirementId?: string; kind?: string; entityId?: string; locationId?: string; departmentId?: string; jobTitle?: string; employeeId?: string; limit?: number; offset?: number };
      const asOf = q.asOf ?? instantToDate(deps.now().toISOString(), auth.user.timeZone ?? 'UTC');
      return app.tenantTx(
        req,
        async (tx) => {
          const settings = await complianceSettings(tx);
          const reqs = await tx.query<ReqRow>(`SELECT * FROM app.compliance_requirements WHERE active ${q.requirementId ? 'AND id = $1' : ''} ${q.kind ? `AND kind = $${q.requirementId ? 2 : 1}` : ''} ORDER BY name`, [q.requirementId, q.kind].filter(Boolean));
          const params: unknown[] = [];
          const where = [scopePredicate(auth.principal, 'compliance.read', params), `e.status <> 'leaver'`];
          const add = (v: unknown) => (params.push(v), `$${params.length}`);
          if (q.entityId) where.push(`coalesce(e.entity_id, fj.entity_id) = ${add(q.entityId)}`);
          if (q.locationId) where.push(`coalesce(e.location_id, fj.location_id) = ${add(q.locationId)}`);
          if (q.departmentId) where.push(`coalesce(e.department_id, fj.department_id) = ${add(q.departmentId)}`);
          if (q.jobTitle) where.push(`coalesce(e.job_title, fj.job_title) = ${add(q.jobTitle)}`);
          if (q.employeeId) where.push(`e.id = ${add(q.employeeId)}`);
          const emps = reqs.length ? await tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${where.join(' AND ')} ORDER BY e.display_name, e.id`, params) : [];
          const summary = { compliant: 0, expiring: 0, expired: 0, missing: 0 };
          const rows: Array<Static<typeof MatrixRow>> = [];
          for (const c of await matrixCells(tx, emps, reqs, asOf, settings)) {
            summary[c.status]++;
            if (q.status && c.status !== q.status) continue;
            rows.push({ employeeId: c.employee.id, employeeName: c.employee.display_name, jobTitle: c.employee.job_title, requirementId: c.requirement.id, requirementName: c.requirement.name, kind: c.requirement.kind, status: c.status, recordId: c.record?.id ?? null, issuedOn: c.record?.issued_on ?? null, expiresOn: c.expiresOn, daysLeft: c.daysLeft, evidenceRequired: c.requirement.evidence_required, hasEvidence: !!c.record?.evidence_document_id });
          }
          const offset = q.offset ?? 0;
          return { asOf, summary, total: rows.length, rows: rows.slice(offset, offset + (q.limit ?? 200)) };
        },
        { readOnly: true },
      );
    },
  );
}
