import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can, canSome, fieldAccess } from '@thapsus/core/permissions';
import { today } from '@thapsus/core/time';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, decodeCursor, encodeCursor, Nullable, Problem, Uuid } from '../../http/schemas';
import { FIELDS } from './model';
import {
  applySectionChange,
  assertWritable,
  contactsAsOf,
  replaceContacts,
  type ContactInput,
  employeeAsOf,
  employeeListWhere,
  managerChainSql,
  rowTarget,
  type EmployeeListFilter,
  filterFields,
  history,
  loadTarget,
  recordChangeEvent,
  refreshCurrent,
  sectionsOf,
  setCustomFields,
  setManager,
  applyEmployeeChange,
} from './service';

const EmployeeSummary = Type.Object({
  id: Uuid,
  employeeNumber: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
  jobTitle: Type.Optional(Nullable(Type.String())),
  department: Type.Optional(Nullable(Type.String())),
  location: Type.Optional(Nullable(Type.String())),
  country: Type.Optional(Nullable(Type.String())),
  status: Type.Optional(Type.String()),
  managerId: Type.Optional(Nullable(Type.String())),
  workEmail: Type.Optional(Nullable(Type.String())),
  startDate: Type.Optional(Type.String()),
});
const EmployeeView = Type.Object({ id: Uuid }, { additionalProperties: true });

const fieldProps: Record<string, ReturnType<typeof Type.Any>> = {};
for (const k of Object.keys(FIELDS)) fieldProps[k] = Type.Optional(Type.Any());
const valueProps = { ...fieldProps, managerId: Type.Optional(Nullable(Uuid)), custom: Type.Optional(Type.Record(Type.String(), Type.Any())) };

const zoneOf = (req: FastifyRequest) => req.auth?.user.timeZone ?? 'Europe/London';

export async function employeeRoutes(app: FastifyInstance) {
  // ---- list ------------------------------------------------------------------------------
  app.get(
    '/v1/employees',
    {
      schema: {
        tags: ['employees'],
        summary: 'List employees the caller may see (cursor-paginated, permission-filtered)',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 100 })),
          status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('pre_start'), Type.Literal('leaver'), Type.Literal('all')])),
          entityId: Type.Optional(Uuid),
          departmentId: Type.Optional(Uuid),
          locationId: Type.Optional(Uuid),
          managerId: Type.Optional(Uuid),
          country: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Type.Object({ data: Type.Array(EmployeeSummary), nextCursor: Nullable(Type.String()) }), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'employees.read');
      const q = req.query as EmployeeListFilter & { cursor?: string; limit?: number };
      const params: unknown[] = [];
      const where = employeeListWhere(auth.principal, 'employees.read', q, params);
      const add = (v: unknown) => (params.push(v), `$${params.length}`);
      const after = decodeCursor<[string, string]>(q.cursor);
      if (after) where.push(`(e.display_name, e.id) > (${add(after[0])}, ${add(after[1])}::uuid)`);
      const limit = q.limit ?? 50;
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<Record<string, string | null> & { chain: Array<string | null> | null }>(
            `SELECT e.id, e.employee_number, e.display_name, e.job_title, e.status, e.manager_id, e.work_email, e.start_date, e.country,
                    e.entity_id, e.department_id, e.location_id, d.name AS department, l.name AS location, ${managerChainSql(auth.principal)} AS chain
               FROM app.employees e
               LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
               LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = e.location_id
              WHERE ${where.join(' AND ')}
              ORDER BY e.display_name, e.id LIMIT ${limit + 1}`,
            params,
          ),
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      const data = page.map((r) => {
        const full = { id: r.id!, employeeNumber: r.employee_number, displayName: r.display_name, jobTitle: r.job_title, department: r.department, location: r.location, country: r.country, status: r.status, managerId: r.manager_id, workEmail: r.work_email, startDate: r.start_date };
        return filterFields(auth.principal, full, rowTarget(r as Parameters<typeof rowTarget>[0]), ['displayName']);
      });
      return { data, nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.display_name, page.at(-1)!.id]) : null };
    },
  );

  // ---- directory (every signed-in person: names and work contact details only) ------------
  app.get(
    '/v1/directory',
    {
      schema: {
        tags: ['employees'],
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })) }),
        response: { 200: Type.Object({ data: Type.Array(Type.Object({ id: Uuid, displayName: Type.String(), jobTitle: Nullable(Type.String()), department: Nullable(Type.String()), workEmail: Nullable(Type.String()), managerId: Nullable(Type.String()) })), nextCursor: Nullable(Type.String()) }) },
      },
    },
    async (req) => {
      requireAuth(req);
      const q = req.query as { q?: string; cursor?: string; limit?: number };
      const params: unknown[] = [];
      const where = [`e.status = 'active'`];
      if (q.q) {
        params.push(q.q.trim());
        where.push(`(e.search @@ plainto_tsquery('simple', $${params.length}) OR e.display_name ILIKE '%' || $${params.length} || '%')`);
      }
      const after = decodeCursor<[string, string]>(q.cursor);
      if (after) {
        params.push(after[0], after[1]);
        where.push(`(e.display_name, e.id) > ($${params.length - 1}, $${params.length}::uuid)`);
      }
      const limit = q.limit ?? 50;
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{ id: string; display_name: string; job_title: string | null; department: string | null; work_email: string | null; manager_id: string | null }>(
            `SELECT e.id, e.display_name, e.job_title, d.name AS department, e.work_email, e.manager_id FROM app.employees e
               LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
              WHERE ${where.join(' AND ')} ORDER BY e.display_name, e.id LIMIT ${limit + 1}`,
            params,
          ),
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      return {
        data: page.map((r) => ({ id: r.id, displayName: r.display_name, jobTitle: r.job_title, department: r.department, workEmail: r.work_email, managerId: r.manager_id })),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.display_name, page.at(-1)!.id]) : null,
      };
    },
  );

  // ---- one employee as of a date -------------------------------------------------------------
  app.get(
    '/v1/employees/:id',
    {
      schema: {
        tags: ['employees'],
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: { 200: Type.Object({ employee: EmployeeView, asOf: Type.String(), access: Type.Record(Type.String(), Type.String()) }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today(zoneOf(req));
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, id);
          const isSelf = auth.principal.employeeId === id;
          if (!can(auth.principal, 'employees.read', target) && !(isSelf && can(auth.principal, 'self.read', target))) throw new ApiError('forbidden');
          const view = await employeeAsOf(tx, id, asOf);
          const filtered = filterFields(auth.principal, view, target);
          // Field access map so the UI shows exactly what the API allows (identical enforcement).
          const access: Record<string, string> = {};
          for (const k of Object.keys(FIELDS)) access[k] = fieldAccess(auth.principal, 'employee', FIELDS[k]!.perm, target);
          for (const k of ['emergencyContacts', 'manager']) access[k] = fieldAccess(auth.principal, 'employee', k, target);
          const customKeys = await tx.query<{ key: string }>(`SELECT key FROM app.custom_field_definitions WHERE entity_type = 'employee' AND NOT archived`);
          for (const { key } of customKeys) access[`custom.${key}`] = fieldAccess(auth.principal, 'employee', `custom.${key}`, target);
          return { employee: filtered, asOf, access };
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/employees/:id/history',
    { schema: { tags: ['employees'], params: Type.Object({ id: Uuid }), response: { 200: Type.Record(Type.String(), Type.Array(Type.Any())), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, id);
          if (!can(auth.principal, 'employees.history', target) && !can(auth.principal, 'employees.update', target)) throw new ApiError('forbidden');
          const h = await history(tx, id);
          // strip sections the caller cannot read
          if (fieldAccess(auth.principal, 'employee', 'pay.amount', target) === 'none') delete h.pay;
          if (fieldAccess(auth.principal, 'employee', 'dateOfBirth', target) === 'none') delete h.personal;
          if (fieldAccess(auth.principal, 'employee', 'emergencyContacts', target) === 'none') delete h.emergencyContacts;
          return h;
        },
        { readOnly: true },
      );
    },
  );

  // ---- hire -----------------------------------------------------------------------------------
  app.post(
    '/v1/employees',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        summary: 'Hire (create) an employee with effective-dated personal, job, pay and contract records',
        body: Type.Object({ ...valueProps, startDate: CivilDate, employeeNumber: Type.Optional(Type.String({ maxLength: 40 })) }, { additionalProperties: false }),
        response: { 201: Type.Object({ id: Uuid }), 400: Problem, 403: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as Record<string, unknown> & { startDate: string; managerId?: string | null; custom?: Record<string, unknown> };
      if (!canSome(auth.principal, 'employees.create')) throw new ApiError('forbidden');
      const id = await app.tenantTx(req, async (tx) => {
        const entity = b.entityId ? await tx.maybe<{ country: string }>('SELECT country FROM app.legal_entities WHERE id = $1', [b.entityId]) : undefined;
        if (!entity) throw new ApiError('validation', 'entityId is required');
        if (!can(auth.principal, 'employees.create', { entityId: b.entityId as string, country: entity.country, departmentId: (b.departmentId as string) ?? null, locationId: (b.locationId as string) ?? null })) throw new ApiError('forbidden');
        const number =
          (b.employeeNumber as string | undefined) ??
          (await tx.one<{ n: string }>(`SELECT 'E' || lpad((count(*) + 1)::text, 6, '0') AS n FROM app.employees`)).n;
        const e = await tx.one<{ id: string }>(
          `INSERT INTO app.employees (tenant_id, employee_number, start_date, status, work_email, work_phone, display_name)
           VALUES (app.current_tenant(), $1, $2, CASE WHEN $2::date > current_date THEN 'pre_start' ELSE 'active' END, $3, $4, $5) RETURNING id`,
          [number, b.startDate, b.workEmail ?? null, b.workPhone ?? null, `${b.preferredName ?? b.legalFirstName ?? ''} ${b.legalLastName ?? ''}`.trim()],
        );
        const sections = sectionsOf(b);
        for (const s of ['personal', 'job', 'pay', 'contract'] as const) {
          if (sections[s]) await applySectionChange(tx, e.id, s, b.startDate, sections[s]!, auth.userId);
        }
        if (b.managerId) await setManager(tx, e.id, b.managerId, b.startDate, 'solid', auth.userId);
        if (b.custom) await setCustomFields(tx, e.id, b.custom, b.startDate, auth.userId);
        await refreshCurrent(tx, e.id);
        await recordChangeEvent(tx, e.id, 'employee.created', { startDate: b.startDate });
        await app.audit(tx, req, { action: 'employee.created', targetType: 'employee', targetId: e.id, diff: { startDate: b.startDate, fields: Object.keys(b) } });
        return e.id;
      });
      return reply.status(201).send({ id });
    },
  );

  // ---- effective-dated change -------------------------------------------------------------------
  app.post(
    '/v1/employees/:id/changes',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        summary: 'Apply an effective-dated change (past, today or future-dated)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ ...valueProps, effectiveDate: CivilDate, reason: Type.Optional(Type.String({ maxLength: 200 })), reassignReportsTo: Type.Optional(Uuid) }, { additionalProperties: false }),
        response: { 200: Type.Object({ id: Uuid, effectiveDate: Type.String() }), 202: Type.Object({ id: Uuid, effectiveDate: Type.String(), approvalRequestId: Uuid }), 400: Problem, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as Record<string, unknown> & { effectiveDate: string; managerId?: string | null; custom?: Record<string, unknown>; reason?: string; reassignReportsTo?: string };
      const result = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        const isSelf = auth.principal.employeeId === id;
        const allowed = can(auth.principal, 'employees.update', target) || (isSelf && can(auth.principal, 'self.update_contact', target));
        if (!allowed) throw new ApiError('forbidden');
        const fields = Object.keys(b).filter((k) => k in FIELDS);
        const customFields = Object.keys(b.custom ?? {}).map((k) => `custom.${k}`);
        assertWritable(auth.principal, [...fields, ...(b.managerId !== undefined ? ['manager'] : []), ...customFields], target);
        // Changes covered by an approval policy wait for approval and are applied when approved.
        const { requestApproval } = await import('../approvals/service');
        const approvalId = await requestApproval(tx, 'employee.change', id, auth.userId, b);
        if (approvalId) {
          await app.audit(tx, req, { action: 'employee.change_requested', targetType: 'employee', targetId: id, diff: { approvalRequestId: approvalId, effectiveDate: b.effectiveDate, fields } });
          return { pending: approvalId };
        }
        const diff = await applyEmployeeChange(tx, id, b, auth.userId);
        await app.audit(tx, req, { action: 'employee.changed', targetType: 'employee', targetId: id, diff: { effectiveDate: b.effectiveDate, reason: b.reason, changes: diff } });
        return { pending: null };
      });
      if (result.pending) return reply.status(202).send({ id, effectiveDate: b.effectiveDate, approvalRequestId: result.pending });
      return { id, effectiveDate: b.effectiveDate };
    },
  );

  // ---- termination ---------------------------------------------------------------------------
  app.post(
    '/v1/employees/:id/terminate',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ endDate: CivilDate, reason: Type.String({ minLength: 2, maxLength: 200 }), reassignReportsTo: Type.Optional(Uuid) }),
        response: { 200: Type.Object({ id: Uuid, endDate: Type.String() }), 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { endDate: string; reason: string; reassignReportsTo?: string };
      await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (!can(auth.principal, 'employees.terminate', target)) throw new ApiError('forbidden');
        const reports = await tx.query<{ id: string }>('SELECT id FROM app.employees WHERE manager_id = $1 AND status <> $2', [id, 'leaver']);
        if (reports.length && !b.reassignReportsTo) {
          throw new ApiError('unprocessable', 'This person manages other employees; choose who their reports move to', { reports: reports.length });
        }
        for (const r of reports) await setManager(tx, r.id, b.reassignReportsTo!, b.endDate, 'solid', auth.userId);
        await tx.exec('UPDATE app.employees SET end_date = $2 WHERE id = $1', [id, b.endDate]);
        // close any open-ended effective-dated records the day after the last working day
        const closeOn = (await tx.one<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [b.endDate])).d;
        for (const t of ['app.employee_jobs', 'app.employee_pay', 'app.employee_contracts', 'app.reporting_lines'])
          await tx.exec(`UPDATE ${t} SET valid_to = $2 WHERE employee_id = $1 AND (valid_to IS NULL OR valid_to > $2) AND valid_from < $2`, [id, closeOn]);
        await refreshCurrent(tx, id);
        await recordChangeEvent(tx, id, 'employee.terminated', { endDate: b.endDate });
        await app.audit(tx, req, { action: 'employee.terminated', targetType: 'employee', targetId: id, diff: { endDate: b.endDate, reason: b.reason, reportsMoved: reports.length } });
      });
      return { id, endDate: b.endDate };
    },
  );

  // ---- reporting lines (dotted / matrix) ------------------------------------------------------------
  app.post(
    '/v1/employees/:id/reporting-lines',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ managerId: Uuid, kind: Type.Union([Type.Literal('solid'), Type.Literal('dotted'), Type.Literal('matrix')]), effectiveDate: CivilDate }),
        response: { 201: Type.Object({ ok: Type.Boolean() }), 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { managerId: string; kind: 'solid' | 'dotted' | 'matrix'; effectiveDate: string };
      await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (!can(auth.principal, 'org.reporting', target) && !can(auth.principal, 'employees.update', target)) throw new ApiError('forbidden');
        await setManager(tx, id, b.managerId, b.effectiveDate, b.kind, auth.userId);
        await refreshCurrent(tx, id);
        await app.audit(tx, req, { action: 'employee.reporting_line_added', targetType: 'employee', targetId: id, diff: b });
      });
      return reply.status(201).send({ ok: true });
    },
  );

  // ---- emergency contacts -------------------------------------------------------------------------
  const Contact = Type.Object({ id: Type.Optional(Uuid), name: Type.String({ minLength: 1, maxLength: 120 }), relationship: Type.Optional(Nullable(Type.String({ maxLength: 60 }))), phone: Type.Optional(Nullable(Type.String({ maxLength: 40 }))), email: Type.Optional(Nullable(Type.String({ maxLength: 254 }))), priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })) });
  const ContactOut = Type.Object({ ...Contact.properties, validFrom: Type.Optional(Nullable(Type.String())), validTo: Type.Optional(Nullable(Type.String())) });
  app.put(
    '/v1/employees/:id/emergency-contacts',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        summary: 'Replace the emergency contact list in force from a date (default today); later future-dated lists are kept',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ effectiveDate: Type.Optional(CivilDate) }),
        body: Type.Array(Contact, { maxItems: 9 }),
        response: { 200: Type.Array(ContactOut), 400: Problem, 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const date = (req.query as { effectiveDate?: string }).effectiveDate ?? today(zoneOf(req));
      const body = req.body as ContactInput[];
      return app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (fieldAccess(auth.principal, 'employee', 'emergencyContacts', target) !== 'write') throw new ApiError('forbidden');
        await replaceContacts(tx, id, date, body, auth.userId);
        await app.audit(tx, req, { action: 'employee.emergency_contacts_updated', targetType: 'employee', targetId: id, diff: { effectiveDate: date, count: body.length } });
        return contactsAsOf(tx, id, date);
      });
    },
  );
  app.get(
    '/v1/employees/:id/emergency-contacts',
    { schema: { tags: ['employees'], params: Type.Object({ id: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Array(ContactOut), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today(zoneOf(req));
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, id);
          if (fieldAccess(auth.principal, 'employee', 'emergencyContacts', target) === 'none') throw new ApiError('forbidden');
          return contactsAsOf(tx, id, asOf);
        },
        { readOnly: true },
      );
    },
  );

  // ---- custom field definitions ----------------------------------------------------------------
  const FieldDef = Type.Object({
    key: Type.String({ pattern: '^[a-z][a-zA-Z0-9_]{1,40}$' }),
    label: Type.Record(Type.String(), Type.String()),
    fieldType: Type.Union(['text', 'number', 'date', 'select', 'multi_select', 'boolean', 'currency', 'file'].map((t) => Type.Literal(t))),
    options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.Record(Type.String(), Type.String()) }))),
    required: Type.Optional(Type.Boolean()),
    validation: Type.Optional(Type.Object({ min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), pattern: Type.Optional(Type.String({ maxLength: 200 })) })),
    effectiveDated: Type.Optional(Type.Boolean()),
  });
  app.get('/v1/settings/custom-fields', { schema: { tags: ['settings'], response: { 200: Type.Array(Type.Any()) } } }, async (req) => {
    requireAuth(req);
    return app.tenantTx(req, (tx) => tx.query(`SELECT id, key, label, field_type AS "fieldType", options, required, validation, effective_dated AS "effectiveDated", archived FROM app.custom_field_definitions WHERE entity_type = 'employee' ORDER BY key`), { readOnly: true });
  });
  app.post(
    '/v1/settings/custom-fields',
    { config: { selfAudited: true }, schema: { tags: ['settings'], body: FieldDef, response: { 201: Type.Object({ id: Uuid }), 403: Problem, 409: Problem } } },
    async (req, reply) => {
      authorize(req, 'settings.manage');
      const b = req.body as { key: string; label: Record<string, string>; fieldType: string; options?: unknown[]; required?: boolean; validation?: object; effectiveDated?: boolean };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.custom_field_definitions (tenant_id, key, label, field_type, options, required, validation, effective_dated) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.key, JSON.stringify(b.label), b.fieldType, JSON.stringify(b.options ?? []), b.required ?? false, JSON.stringify(b.validation ?? {}), b.effectiveDated ?? false],
        );
        await app.audit(tx, req, { action: 'custom_field.created', targetType: 'custom_field', targetId: r.id, diff: { key: b.key, type: b.fieldType } });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  // ---- custom objects ---------------------------------------------------------------------------
  app.post(
    '/v1/settings/custom-objects',
    { config: { selfAudited: true }, schema: { tags: ['settings'], body: Type.Object({ key: Type.String({ pattern: '^[a-z][a-zA-Z0-9_]{1,40}$' }), label: Type.Record(Type.String(), Type.String()), fields: Type.Array(FieldDef, { maxItems: 50 }) }), response: { 201: Type.Object({ id: Uuid }), 403: Problem } } },
    async (req, reply) => {
      authorize(req, 'settings.manage');
      const b = req.body as { key: string; label: object; fields: unknown[] };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.custom_object_types (tenant_id, key, label, fields) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`, [b.key, JSON.stringify(b.label), JSON.stringify(b.fields)]);
        await app.audit(tx, req, { action: 'custom_object.type_created', targetType: 'custom_object_type', targetId: r.id, diff: { key: b.key } });
        return r;
      });
      return reply.status(201).send(row);
    },
  );
  app.post(
    '/v1/employees/:id/custom-objects/:typeKey',
    { config: { selfAudited: true }, schema: { tags: ['employees'], params: Type.Object({ id: Uuid, typeKey: Type.String() }), body: Type.Object({ data: Type.Record(Type.String(), Type.Any()), validFrom: Type.Optional(CivilDate) }), response: { 201: Type.Object({ id: Uuid }), 400: Problem, 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id, typeKey } = req.params as { id: string; typeKey: string };
      const b = req.body as { data: Record<string, unknown>; validFrom?: string };
      const row = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (fieldAccess(auth.principal, 'employee', `custom.${typeKey}`, target) !== 'write') throw new ApiError('forbidden');
        const type = await tx.maybe<{ id: string; fields: Array<{ key: string; fieldType: string; options?: Array<{ value: string }>; required?: boolean; validation?: object }> }>('SELECT id, fields FROM app.custom_object_types WHERE key = $1', [typeKey]);
        if (!type) throw new ApiError('notFound');
        const { validateCustomValue } = await import('./service');
        for (const f of type.fields) validateCustomValue({ field_type: f.fieldType, options: f.options ?? [], required: !!f.required, validation: (f.validation ?? {}) as never }, b.data[f.key], f.key);
        const unknown = Object.keys(b.data).filter((k) => !type.fields.some((f) => f.key === k));
        if (unknown.length) throw new ApiError('validation', `Unknown fields: ${unknown.join(', ')}`);
        const r = await tx.one<{ id: string }>(`INSERT INTO app.custom_object_records (tenant_id, type_id, employee_id, data, valid_from, created_by) VALUES (app.current_tenant(), $1, $2, $3, coalesce($4::date, '-infinity'), $5) RETURNING id`, [type.id, id, JSON.stringify(b.data), b.validFrom ?? null, auth.userId]);
        await app.audit(tx, req, { action: 'custom_object.record_created', targetType: 'employee', targetId: id, diff: { type: typeKey } });
        return r;
      });
      return reply.status(201).send(row);
    },
  );
}
