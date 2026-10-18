import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { addDays, compareDates, compareInstants, daysBetween, dayOfWeek, isValidTimeZone, minutesBetween } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import type { RuleBook } from '@thapsus/rules';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, decodeCursor, encodeCursor, Nullable, Problem, Uuid } from '../../http/schemas';
import { notify } from '../../lib/notify';
import { loadTarget, scopePredicate } from '../employees/service';
import { approvalHandlers, rejectionHandlers, requestApproval } from '../approvals/service';
import { ruleBook } from '../rules/routes';
import { shiftTimes } from './engine';
import { assignmentCheck, employeeTimeContext, timeSettings, weekStartFor, type Finding, type TimeSettings } from './service';
import { Finding as FindingSchema, HHMM, Shift, shiftOut, SHIFT_COLUMNS, Slot, Swap, Template, Zone, type ShiftDbRow } from './schemas';

type Auth = ReturnType<typeof requireAuth>;
const RETURNING = `RETURNING ${SHIFT_COLUMNS}`;

/** Users linked to employees (one notification per employee). */
async function usersFor(tx: Tx, employeeIds: string[]): Promise<Map<string, string>> {
  if (!employeeIds.length) return new Map();
  const rows = await tx.query<{ id: string; employee_id: string }>(`SELECT DISTINCT ON (employee_id) id, employee_id FROM app.users WHERE employee_id = ANY($1::uuid[]) AND status = 'active' ORDER BY employee_id, created_at`, [employeeIds]);
  return new Map(rows.map((r) => [r.employee_id, r.id]));
}

type Params = Record<string, string | number>;
export async function notifyEmployees(tx: Tx, employeeIds: string[], n: { kind: string; titleKey: string; params?: Params | ((employeeId: string) => Params); link: string; dedupe: (employeeId: string) => string }) {
  const users = await usersFor(tx, [...new Set(employeeIds)]);
  let sent = 0;
  for (const [employeeId, userId] of users) {
    const params = typeof n.params === 'function' ? n.params(employeeId) : n.params;
    sent += (await notify(tx, { userIds: [userId], kind: n.kind, titleKey: n.titleKey, params, link: n.link, dedupeKey: n.dedupe(employeeId) })).length;
  }
  return sent;
}

/** A manager-approval policy is created on first use (customers can change or extend it). */
export async function ensureApprovalPolicy(tx: Tx, subject: string, name: string) {
  const has = await tx.maybe(`SELECT 1 FROM app.approval_policies WHERE subject = $1 LIMIT 1`, [subject]);
  if (!has) await tx.exec(`INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), $1, $2, '[{"approver":{"type":"manager"}}]')`, [subject, name]);
}

async function mayManage(tx: Tx, auth: Auth, employeeId: string | null | undefined): Promise<boolean> {
  if (!employeeId) return canSome(auth.principal, 'rota.manage');
  return can(auth.principal, 'rota.manage', await loadTarget(tx, employeeId));
}

async function zoneFor(tx: Tx, zone: string | undefined, locationId: string | null | undefined, employeeId: string | null | undefined): Promise<string> {
  if (zone) {
    if (!isValidTimeZone(zone)) throw new ApiError('validation', 'Unknown time zone');
    return zone;
  }
  if (locationId) {
    const l = await tx.maybe<{ time_zone: string }>('SELECT time_zone FROM app.locations WHERE id = $1', [locationId]);
    if (!l) throw new ApiError('validation', 'Unknown location');
    return l.time_zone;
  }
  if (employeeId) return (await employeeTimeContext(tx, employeeId)).zone;
  throw new ApiError('validation', 'zone is required for an open shift without a location');
}

function times(date: string, start: string, end: string, zone: string, breakMinutes: number) {
  let t: ReturnType<typeof shiftTimes>;
  try {
    t = shiftTimes(date, start, end, zone);
  } catch {
    throw new ApiError('validation', 'Invalid shift date or time');
  }
  if (breakMinutes >= minutesBetween(t.startsAt, t.endsAt)) throw new ApiError('validation', 'Break is longer than the shift');
  return t;
}

/** Statutory findings block the change when the tenant enforces working-time rules; otherwise everything is a warning. */
export async function enforceAssignment(tx: Tx, book: RuleBook, settings: TimeSettings, employeeId: string, s: { start_local: string; end_local: string; break_minutes: number; zone: string }, exclude: string[]): Promise<Finding[]> {
  const r = await assignmentCheck(tx, book, settings, employeeId, { start: s.start_local, end: s.end_local, breakMinutes: s.break_minutes, zone: s.zone }, { excludeShiftIds: exclude });
  if (r.violations.length && settings.enforcement === 'block') throw new ApiError('unprocessable', 'Working-time rules would be broken', { violations: r.violations, warnings: r.warnings });
  return [...r.violations, ...r.warnings];
}

const ShiftIn = Type.Object({
  employeeId: Type.Optional(Nullable(Uuid)),
  date: CivilDate,
  start: HHMM,
  end: HHMM,
  breakMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 480 })),
  zone: Type.Optional(Zone),
  locationId: Type.Optional(Nullable(Uuid)),
  departmentId: Type.Optional(Nullable(Uuid)),
  role: Type.Optional(Nullable(Type.String({ maxLength: 80 }))),
  notes: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
});
interface ShiftInput {
  employeeId?: string | null;
  date: string;
  start: string;
  end: string;
  breakMinutes?: number;
  zone?: string;
  locationId?: string | null;
  departmentId?: string | null;
  role?: string | null;
  notes?: string | null;
}
const ShiftWithWarnings = Type.Object({ shift: Shift, warnings: Type.Array(FindingSchema) });
const RangeQuery = { from: CivilDate, to: CivilDate };

function checkRange(from: string, to: string, maxDays: number) {
  if (compareDates(to, from) < 0) throw new ApiError('validation', 'to is before from');
  if (daysBetween(from, to) > maxDays) throw new ApiError('validation', `At most ${maxDays} days`);
}

interface SwapRow {
  id: string;
  kind: 'swap' | 'claim_open';
  status: string;
  shift_id: string;
  to_shift_id: string | null;
  from_employee_id: string;
  to_employee_id: string | null;
  accepted_at: string | null;
  approval_request_id: string | null;
  requested_by: string | null;
  note: string | null;
  created_at: string;
}

export async function rotaRoutes(app: FastifyInstance) {
  const now = () => app.deps.now().toISOString();

  // ---- templates ---------------------------------------------------------------------------------------
  const TemplateIn = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), locationId: Type.Optional(Nullable(Uuid)), departmentId: Type.Optional(Nullable(Uuid)), slots: Type.Array(Slot, { minItems: 1, maxItems: 500 }) });
  type TemplateBody = { name: string; locationId?: string | null; departmentId?: string | null; slots: Array<{ weekday: number; start: string; end: string; breakMinutes?: number; role?: string; headcount?: number; employeeId?: string | null }> };
  const templateOut = (t: { id: string; name: string; location_id: string | null; department_id: string | null; slots: TemplateBody['slots'] }) => ({ id: t.id, name: t.name, locationId: t.location_id, departmentId: t.department_id, slots: t.slots });

  app.get('/v1/rota/templates', { schema: { tags: ['rota'], response: { 200: Type.Array(Template), 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    if (!canSome(auth.principal, 'rota.view')) throw new ApiError('forbidden');
    return app.tenantTx(req, async (tx) => (await tx.query<Parameters<typeof templateOut>[0]>('SELECT * FROM app.rota_templates ORDER BY name, id LIMIT 500')).map(templateOut), { readOnly: true });
  });

  app.post('/v1/rota/templates', { config: { selfAudited: true }, schema: { tags: ['rota'], body: TemplateIn, response: { 201: Template, 403: Problem } } }, async (req, reply) => {
    const auth = requireAuth(req);
    if (!canSome(auth.principal, 'rota.manage')) throw new ApiError('forbidden');
    const b = req.body as TemplateBody;
    const out = await app.tenantTx(req, async (tx) => {
      const t = await tx.one<Parameters<typeof templateOut>[0]>(`INSERT INTO app.rota_templates (tenant_id, name, location_id, department_id, slots) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING *`, [b.name, b.locationId ?? null, b.departmentId ?? null, JSON.stringify(b.slots)]);
      await app.audit(tx, req, { action: 'rota_template.created', targetType: 'rota_template', targetId: t.id, diff: { name: b.name, slots: b.slots.length } });
      return templateOut(t);
    });
    return reply.status(201).send(out);
  });

  app.put('/v1/rota/templates/:id', { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), body: TemplateIn, response: { 200: Template, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    if (!canSome(auth.principal, 'rota.manage')) throw new ApiError('forbidden');
    const b = req.body as TemplateBody;
    const { id } = req.params as { id: string };
    return app.tenantTx(req, async (tx) => {
      const t = await tx.maybe<Parameters<typeof templateOut>[0]>(`UPDATE app.rota_templates SET name = $2, location_id = $3, department_id = $4, slots = $5 WHERE id = $1 RETURNING *`, [id, b.name, b.locationId ?? null, b.departmentId ?? null, JSON.stringify(b.slots)]);
      if (!t) throw new ApiError('notFound');
      await app.audit(tx, req, { action: 'rota_template.updated', targetType: 'rota_template', targetId: id, diff: { name: b.name, slots: b.slots.length } });
      return templateOut(t);
    });
  });

  app.delete('/v1/rota/templates/:id', { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 403: Problem, 404: Problem } } }, async (req, reply) => {
    const auth = requireAuth(req);
    if (!canSome(auth.principal, 'rota.manage')) throw new ApiError('forbidden');
    const { id } = req.params as { id: string };
    await app.tenantTx(req, async (tx) => {
      if (!(await tx.exec('DELETE FROM app.rota_templates WHERE id = $1', [id]))) throw new ApiError('notFound');
      await app.audit(tx, req, { action: 'rota_template.deleted', targetType: 'rota_template', targetId: id });
    });
    return reply.status(204).send(null);
  });

  app.post(
    '/v1/rota/templates/:id/apply',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['rota'],
        summary: 'Creates draft shifts for a week from a template (open, or assigned where the slot names an employee)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ weekStart: CivilDate, zone: Type.Optional(Zone) }),
        response: { 201: Type.Object({ created: Type.Integer(), shiftIds: Type.Array(Uuid), warnings: Type.Array(Type.Object({ employeeId: Uuid, findings: Type.Array(FindingSchema) })), openedInstead: Type.Array(Type.Object({ employeeId: Uuid, date: Type.String(), violations: Type.Array(FindingSchema) })) }), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'rota.manage')) throw new ApiError('forbidden');
      const { id } = req.params as { id: string };
      const b = req.body as { weekStart: string; zone?: string };
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const t = await tx.maybe<Parameters<typeof templateOut>[0]>('SELECT * FROM app.rota_templates WHERE id = $1', [id]);
        if (!t) throw new ApiError('notFound');
        const settings = await timeSettings(tx);
        const zone = await zoneFor(tx, b.zone, t.location_id, null);
        const shiftIds: string[] = [];
        const warnings: Array<{ employeeId: string; findings: Finding[] }> = [];
        const openedInstead: Array<{ employeeId: string; date: string; violations: Finding[] }> = [];
        for (const slot of t.slots) {
          const date = addDays(b.weekStart, (slot.weekday - dayOfWeek(b.weekStart) + 7) % 7);
          const tm = times(date, slot.start, slot.end, zone, slot.breakMinutes ?? 0);
          for (let n = 0; n < (slot.headcount ?? 1); n++) {
            let employeeId = n === 0 ? (slot.employeeId ?? null) : null;
            if (employeeId) {
              if (!(await mayManage(tx, auth, employeeId))) throw new ApiError('forbidden');
              try {
                const f = await enforceAssignment(tx, book, settings, employeeId, { start_local: tm.startLocal, end_local: tm.endLocal, break_minutes: slot.breakMinutes ?? 0, zone }, []);
                if (f.length) warnings.push({ employeeId, findings: f });
              } catch (err) {
                if (!(err instanceof ApiError) || err.status !== 422) throw err;
                openedInstead.push({ employeeId, date, violations: err.extra.violations as Finding[] });
                employeeId = null;
              }
            }
            const row = await tx.one<{ id: string }>(
              `INSERT INTO app.shifts (tenant_id, employee_id, location_id, department_id, role, shift_date, start_local, end_local, zone, starts_at, ends_at, break_minutes, template_id)
               VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
              [employeeId, t.location_id, t.department_id, slot.role ?? null, date, tm.startLocal, tm.endLocal, zone, tm.startsAt, tm.endsAt, slot.breakMinutes ?? 0, id],
            );
            shiftIds.push(row.id);
          }
        }
        await app.audit(tx, req, { action: 'rota_template.applied', targetType: 'rota_template', targetId: id, diff: { weekStart: b.weekStart, created: shiftIds.length, openedInstead: openedInstead.length } });
        return { created: shiftIds.length, shiftIds, warnings, openedInstead };
      });
      return reply.status(201).send(out);
    },
  );

  // ---- shifts ----------------------------------------------------------------------------------------------
  app.post(
    '/v1/shifts',
    { config: { selfAudited: true }, schema: { tags: ['rota'], summary: 'Creates a draft shift from local wall-clock times in an IANA zone (end ≤ start = overnight). Working-time findings are returned as warnings, or refused with 422 when the tenant blocks.', body: ShiftIn, response: { 201: ShiftWithWarnings, 400: Problem, 403: Problem, 409: Problem, 422: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as ShiftInput;
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        if (!(await mayManage(tx, auth, b.employeeId))) throw new ApiError('forbidden');
        const settings = await timeSettings(tx);
        const zone = await zoneFor(tx, b.zone, b.locationId, b.employeeId);
        const brk = b.breakMinutes ?? 0;
        const t = times(b.date, b.start, b.end, zone, brk);
        const ctx = b.employeeId ? await employeeTimeContext(tx, b.employeeId) : undefined;
        const warnings = b.employeeId ? await enforceAssignment(tx, book, settings, b.employeeId, { start_local: t.startLocal, end_local: t.endLocal, break_minutes: brk, zone }, []) : [];
        const row = await tx.one<ShiftDbRow>(
          `INSERT INTO app.shifts AS s (tenant_id, employee_id, location_id, department_id, role, notes, shift_date, start_local, end_local, zone, starts_at, ends_at, break_minutes)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ${RETURNING}`,
          [b.employeeId ?? null, b.locationId !== undefined ? b.locationId : (ctx?.locationId ?? null), b.departmentId !== undefined ? b.departmentId : (ctx?.departmentId ?? null), b.role ?? null, b.notes ?? null, b.date, t.startLocal, t.endLocal, zone, t.startsAt, t.endsAt, brk],
        );
        await app.audit(tx, req, { action: 'shift.created', targetType: 'shift', targetId: row.id, diff: { employeeId: b.employeeId ?? null, date: b.date, start: b.start, end: b.end, zone, findings: warnings.map((w) => w.rule) } });
        return { shift: shiftOut({ ...row, display_name: ctx?.displayName ?? null }), warnings };
      });
      return reply.status(201).send(out);
    },
  );

  app.patch(
    '/v1/shifts/:id',
    { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), body: Type.Partial(ShiftIn), response: { 200: ShiftWithWarnings, 403: Problem, 404: Problem, 409: Problem, 422: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as Partial<ShiftInput>;
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const cur = await tx.maybe<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1 FOR UPDATE`, [id]);
        if (!cur) throw new ApiError('notFound');
        if (cur.status === 'cancelled') throw new ApiError('conflict', 'Shift is cancelled');
        if (!(await mayManage(tx, auth, cur.employee_id))) throw new ApiError('forbidden');
        const employeeId = b.employeeId !== undefined ? b.employeeId : cur.employee_id;
        if (employeeId !== cur.employee_id && !(await mayManage(tx, auth, employeeId))) throw new ApiError('forbidden');
        const settings = await timeSettings(tx);
        const zone = b.zone ? await zoneFor(tx, b.zone, null, null) : cur.zone;
        const brk = b.breakMinutes ?? cur.break_minutes;
        const date = b.date ?? cur.shift_date;
        const t = times(date, b.start ?? cur.start_local.slice(11), b.end ?? cur.end_local.slice(11), zone, brk);
        const warnings = employeeId ? await enforceAssignment(tx, book, settings, employeeId, { start_local: t.startLocal, end_local: t.endLocal, break_minutes: brk, zone }, [id]) : [];
        const row = await tx.one<ShiftDbRow & { updated_at: string }>(
          `UPDATE app.shifts AS s SET employee_id = $2, shift_date = $3, start_local = $4, end_local = $5, zone = $6, starts_at = $7, ends_at = $8, break_minutes = $9,
                  location_id = $10, department_id = $11, role = $12, notes = $13 WHERE s.id = $1 ${RETURNING}, s.updated_at`,
          [id, employeeId, date, t.startLocal, t.endLocal, zone, t.startsAt, t.endsAt, brk, b.locationId !== undefined ? b.locationId : cur.location_id, b.departmentId !== undefined ? b.departmentId : cur.department_id, b.role !== undefined ? b.role : cur.role, b.notes !== undefined ? b.notes : cur.notes],
        );
        if (cur.status === 'published') {
          const affected = [cur.employee_id, employeeId].filter((e): e is string => !!e);
          await notifyEmployees(tx, affected, { kind: 'rota.changed', titleKey: 'notify.shiftChanged', params: { date }, link: '/app/rota', dedupe: (e) => `shift-changed:${id}:${row.updated_at}:${e}` });
        }
        await app.audit(tx, req, { action: 'shift.updated', targetType: 'shift', targetId: id, diff: { from: { employeeId: cur.employee_id, start: cur.start_local, end: cur.end_local }, to: { employeeId, start: t.startLocal, end: t.endLocal }, findings: warnings.map((w) => w.rule) } });
        const name = employeeId ? (await employeeTimeContext(tx, employeeId)).displayName : null;
        return { shift: shiftOut({ ...row, display_name: name }), warnings };
      });
    },
  );

  app.post('/v1/shifts/:id/cancel', { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    return app.tenantTx(req, async (tx) => {
      const cur = await tx.maybe<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1 FOR UPDATE`, [id]);
      if (!cur) throw new ApiError('notFound');
      if (!(await mayManage(tx, auth, cur.employee_id))) throw new ApiError('forbidden');
      if (cur.status === 'cancelled') throw new ApiError('conflict');
      await tx.exec(`UPDATE app.shifts SET status = 'cancelled' WHERE id = $1`, [id]);
      await cancelSwapsFor(tx, [id]);
      if (cur.status === 'published' && cur.employee_id) await notifyEmployees(tx, [cur.employee_id], { kind: 'rota.cancelled', titleKey: 'notify.shiftCancelled', params: { date: cur.shift_date }, link: '/app/rota', dedupe: (e) => `shift-cancelled:${id}:${e}` });
      await app.audit(tx, req, { action: 'shift.cancelled', targetType: 'shift', targetId: id, diff: { employeeId: cur.employee_id, date: cur.shift_date } });
      return { id, status: 'cancelled' };
    });
  });

  app.get(
    '/v1/shifts',
    {
      schema: {
        tags: ['rota'],
        summary: 'Shifts in a date range (keyset-paginated by date, start, id), permission-filtered',
        querystring: Type.Object({ ...RangeQuery, employeeId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), departmentId: Type.Optional(Uuid), status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('cancelled')])), open: Type.Optional(Type.Boolean()), cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })) }),
        response: { 200: Type.Object({ data: Type.Array(Shift), nextCursor: Nullable(Type.String()) }), 400: Problem, 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'rota.view')) throw new ApiError('forbidden');
      const q = req.query as { from: string; to: string; employeeId?: string; locationId?: string; departmentId?: string; status?: string; open?: boolean; cursor?: string; limit?: number };
      checkRange(q.from, q.to, 62);
      const limit = q.limit ?? 200;
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          const add = (v: unknown) => (params.push(v), `$${params.length}`);
          const scope = scopePredicate(auth.principal, 'rota.view', params);
          const where = [`s.shift_date >= ${add(q.from)}`, `s.shift_date <= ${add(q.to)}`, `((s.employee_id IS NULL) OR (e.id IS NOT NULL AND ${scope}))`];
          if (q.employeeId) where.push(`s.employee_id = ${add(q.employeeId)}`);
          if (q.locationId) where.push(`s.location_id = ${add(q.locationId)}`);
          if (q.departmentId) where.push(`s.department_id = ${add(q.departmentId)}`);
          if (q.status) where.push(`s.status = ${add(q.status)}`);
          else where.push(`s.status <> 'cancelled'`);
          if (q.open === true) where.push('s.employee_id IS NULL');
          if (q.open === false) where.push('s.employee_id IS NOT NULL');
          const c = decodeCursor<[string, string, string]>(q.cursor);
          if (c) where.push(`(s.shift_date, s.starts_at, s.id) > (${add(c[0])}::date, ${add(c[1])}::timestamptz, ${add(c[2])}::uuid)`);
          const rows = await tx.query<ShiftDbRow>(
            `SELECT ${SHIFT_COLUMNS}, e.display_name FROM app.shifts s LEFT JOIN app.employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
              WHERE ${where.join(' AND ')} ORDER BY s.shift_date, s.starts_at, s.id LIMIT ${add(limit + 1)}`,
            params,
          );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          return { data: page.map(shiftOut), nextCursor: rows.length > limit && last ? encodeCursor([last.shift_date, last.starts_at, last.id]) : null };
        },
        { readOnly: true },
      );
    },
  );

  const GridRow = Type.Object({ employeeId: Uuid, name: Type.String(), employeeNumber: Type.String(), jobTitle: Nullable(Type.String()), shifts: Type.Array(Shift) });
  app.get(
    '/v1/rota',
    {
      schema: {
        tags: ['rota'],
        summary: 'Rota grid for one week: employees (keyset by name, id) with their shifts, plus open shifts on the first page',
        querystring: Type.Object({ weekStart: CivilDate, locationId: Type.Optional(Uuid), departmentId: Type.Optional(Uuid), q: Type.Optional(Type.String({ maxLength: 100 })), cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })) }),
        response: { 200: Type.Object({ weekStart: Type.String(), days: Type.Array(Type.String()), total: Nullable(Type.Integer()), rows: Type.Array(GridRow), openShifts: Type.Array(Shift), nextCursor: Nullable(Type.String()) }), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'rota.view')) throw new ApiError('forbidden');
      const q = req.query as { weekStart: string; locationId?: string; departmentId?: string; q?: string; cursor?: string; limit?: number };
      const limit = q.limit ?? 100;
      return app.tenantTx(
        req,
        async (tx) => {
          const settings = await timeSettings(tx);
          const weekStart = weekStartFor(q.weekStart, settings.workweekStartsOn);
          const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const params: unknown[] = [];
          const add = (v: unknown) => (params.push(v), `$${params.length}`);
          const filters = [`e.status = 'active'`, scopePredicate(auth.principal, 'rota.view', params)];
          if (q.locationId) filters.push(`e.location_id = ${add(q.locationId)}`);
          if (q.departmentId) filters.push(`e.department_id = ${add(q.departmentId)}`);
          if (q.q) filters.push(`e.display_name ILIKE ${add(`%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)}`);
          const base = filters.join(' AND ');
          const total = q.cursor ? null : (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees e WHERE ${base}`, params)).n;
          const pageParams = [...params];
          const addP = (v: unknown) => (pageParams.push(v), `$${pageParams.length}`);
          const c = decodeCursor<[string, string]>(q.cursor);
          const keyset = c ? ` AND (e.display_name, e.id) > (${addP(c[0])}, ${addP(c[1])}::uuid)` : '';
          const emps = await tx.query<{ id: string; display_name: string; employee_number: string; job_title: string | null }>(
            `SELECT e.id, e.display_name, e.employee_number, e.job_title FROM app.employees e WHERE ${base}${keyset} ORDER BY e.display_name, e.id LIMIT ${addP(limit + 1)}`,
            pageParams,
          );
          const page = emps.slice(0, limit);
          const shifts = page.length
            ? await tx.query<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.employee_id = ANY($1::uuid[]) AND s.shift_date >= $2 AND s.shift_date <= $3 AND s.status <> 'cancelled' ORDER BY s.starts_at`, [page.map((e) => e.id), weekStart, days[6]])
            : [];
          const byEmp = new Map<string, ReturnType<typeof shiftOut>[]>();
          for (const s of shifts) (byEmp.get(s.employee_id!) ?? byEmp.set(s.employee_id!, []).get(s.employee_id!)!).push(shiftOut(s));
          const openParams: unknown[] = [weekStart, days[6]];
          const openWhere = [`s.employee_id IS NULL`, `s.shift_date >= $1`, `s.shift_date <= $2`, `s.status <> 'cancelled'`];
          if (q.locationId) openWhere.push(`(s.location_id = $${openParams.push(q.locationId)})`);
          if (q.departmentId) openWhere.push(`(s.department_id = $${openParams.push(q.departmentId)})`);
          const openShifts = q.cursor ? [] : await tx.query<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE ${openWhere.join(' AND ')} ORDER BY s.starts_at, s.id LIMIT 1000`, openParams);
          const last = page.at(-1);
          return {
            weekStart,
            days,
            total,
            rows: page.map((e) => ({ employeeId: e.id, name: e.display_name, employeeNumber: e.employee_number, jobTitle: e.job_title, shifts: byEmp.get(e.id) ?? [] })),
            openShifts: openShifts.map(shiftOut),
            nextCursor: emps.length > limit && last ? encodeCursor([last.display_name, last.id]) : null,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/rota/publish',
    {
      config: { selfAudited: true },
      schema: { tags: ['rota'], summary: 'Publishes draft shifts in a range and notifies each affected employee once (in-app, email and web push)', body: Type.Object({ ...RangeQuery, locationId: Type.Optional(Uuid), departmentId: Type.Optional(Uuid) }), response: { 200: Type.Object({ published: Type.Integer(), notified: Type.Integer() }), 403: Problem } },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'rota.manage')) throw new ApiError('forbidden');
      const b = req.body as { from: string; to: string; locationId?: string; departmentId?: string };
      checkRange(b.from, b.to, 62);
      return app.tenantTx(req, async (tx) => {
        const params: unknown[] = [b.from, b.to];
        const scope = scopePredicate(auth.principal, 'rota.manage', params);
        const where = [`s.status = 'draft'`, `s.shift_date >= $1`, `s.shift_date <= $2`, `(s.employee_id IS NULL OR s.employee_id IN (SELECT e.id FROM app.employees e WHERE ${scope}))`];
        if (b.locationId) where.push(`s.location_id = $${params.push(b.locationId)}`);
        if (b.departmentId) where.push(`s.department_id = $${params.push(b.departmentId)}`);
        const rows = await tx.query<{ id: string; employee_id: string | null }>(`UPDATE app.shifts s SET status = 'published', published_at = now() WHERE ${where.join(' AND ')} RETURNING s.id, s.employee_id`, params);
        const byEmp = new Map<string, string[]>();
        for (const r of rows) if (r.employee_id) (byEmp.get(r.employee_id) ?? byEmp.set(r.employee_id, []).get(r.employee_id)!).push(r.id);
        // One notification per employee per publish; the key covers exactly the shifts published, so a retry never duplicates.
        const digest = (e: string) => createHash('sha256').update(byEmp.get(e)!.sort().join(',')).digest('hex').slice(0, 24);
        const notified = await notifyEmployees(tx, [...byEmp.keys()], { kind: 'rota.published', titleKey: 'notify.rotaPublished', params: (e) => ({ from: b.from, to: b.to, shifts: byEmp.get(e)!.length }), link: '/app/rota', dedupe: (e) => `rota-published:${e}:${digest(e)}` });
        await app.audit(tx, req, { action: 'rota.published', targetType: 'rota', diff: { from: b.from, to: b.to, published: rows.length, employees: byEmp.size, locationId: b.locationId ?? null, departmentId: b.departmentId ?? null } });
        return { published: rows.length, notified };
      });
    },
  );

  app.get('/v1/me/shifts', { schema: { tags: ['rota'], querystring: Type.Object(RangeQuery), response: { 200: Type.Array(Shift), 400: Problem, 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const q = req.query as { from: string; to: string };
    checkRange(q.from, q.to, 92);
    const me = auth.principal.employeeId;
    if (!me || !can(auth.principal, 'rota.view_own', { employeeId: me })) throw new ApiError('forbidden');
    return app.tenantTx(req, async (tx) => (await tx.query<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.employee_id = $1 AND s.status = 'published' AND s.shift_date >= $2 AND s.shift_date <= $3 ORDER BY s.starts_at`, [me, q.from, q.to])).map(shiftOut), { readOnly: true });
  });

  app.get(
    '/v1/shifts/open',
    { schema: { tags: ['rota'], summary: 'Published open shifts the caller may claim (same location/department where the shift names one)', querystring: Type.Object(RangeQuery), response: { 200: Type.Array(Type.Intersect([Shift, Type.Object({ claimedByMe: Type.Boolean() })])), 400: Problem, 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { from: string; to: string };
      checkRange(q.from, q.to, 92);
      const me = auth.principal.employeeId;
      if (!me || !can(auth.principal, 'rota.view_own', { employeeId: me })) throw new ApiError('forbidden');
      return app.tenantTx(
        req,
        async (tx) => {
          const ctx = await employeeTimeContext(tx, me);
          const rows = await tx.query<ShiftDbRow & { claimed: boolean }>(
            `SELECT ${SHIFT_COLUMNS}, EXISTS (SELECT 1 FROM app.shift_swaps w WHERE w.tenant_id = s.tenant_id AND w.shift_id = s.id AND w.from_employee_id = $4 AND w.status = 'pending') AS claimed
               FROM app.shifts s WHERE s.employee_id IS NULL AND s.status = 'published' AND s.shift_date >= $1 AND s.shift_date <= $2 AND s.starts_at > $3
                AND (s.location_id IS NULL OR s.location_id = $5) AND (s.department_id IS NULL OR s.department_id = $6)
              ORDER BY s.starts_at, s.id LIMIT 500`,
            [q.from, q.to, now(), me, ctx.locationId, ctx.departmentId],
          );
          return rows.map((r) => ({ ...shiftOut(r), claimedByMe: r.claimed }));
        },
        { readOnly: true },
      );
    },
  );

  // ---- open-shift claims and swaps (through approvals) -----------------------------------------------------
  async function swapOut(tx: Tx, rows: SwapRow[]) {
    if (!rows.length) return [];
    const shifts = await tx.query<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS}, e.display_name FROM app.shifts s LEFT JOIN app.employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id WHERE s.id = ANY($1::uuid[])`, [rows.map((r) => r.shift_id)]);
    const names = await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM app.employees WHERE id = ANY($1::uuid[])`, [rows.flatMap((r) => [r.from_employee_id, r.to_employee_id]).filter(Boolean)]);
    const shiftMap = new Map(shifts.map((s) => [s.id, s]));
    const nameMap = new Map(names.map((n) => [n.id, n.display_name]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      shiftId: r.shift_id,
      toShiftId: r.to_shift_id,
      fromEmployeeId: r.from_employee_id,
      fromEmployeeName: nameMap.get(r.from_employee_id) ?? null,
      toEmployeeId: r.to_employee_id,
      toEmployeeName: r.to_employee_id ? (nameMap.get(r.to_employee_id) ?? null) : null,
      acceptedAt: r.accepted_at,
      approvalRequestId: r.approval_request_id,
      shift: shiftOut(shiftMap.get(r.shift_id)!),
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  app.post(
    '/v1/shifts/:id/claim',
    { config: { selfAudited: true }, schema: { tags: ['rota'], summary: 'Asks to take a published open shift; the manager approves (working time re-checked on approval)', params: Type.Object({ id: Uuid }), body: Type.Optional(Type.Object({ note: Type.Optional(Type.String({ maxLength: 500 })) })), response: { 201: Type.Object({ id: Uuid, status: Type.String(), warnings: Type.Array(FindingSchema) }), 403: Problem, 404: Problem, 409: Problem, 422: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const note = (req.body as { note?: string } | undefined)?.note ?? null;
      const me = auth.principal.employeeId;
      if (!me || !can(auth.principal, 'rota.swap_request', { employeeId: me })) throw new ApiError('forbidden');
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const s = await tx.maybe<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1`, [id]);
        if (!s || s.status !== 'published' || s.employee_id) throw new ApiError('notFound');
        if (compareInstants(s.starts_at, now()) <= 0) throw new ApiError('conflict', 'Shift has started');
        const ctx = await employeeTimeContext(tx, me);
        if ((s.location_id && s.location_id !== ctx.locationId) || (s.department_id && s.department_id !== ctx.departmentId)) throw new ApiError('forbidden', 'Not eligible for this shift');
        const settings = await timeSettings(tx);
        const warnings = await enforceAssignment(tx, book, settings, me, s, []);
        const sw = await tx.one<{ id: string }>(`INSERT INTO app.shift_swaps (tenant_id, shift_id, from_employee_id, kind, requested_by, note) VALUES (app.current_tenant(), $1, $2, 'claim_open', $3, $4) RETURNING id`, [id, me, auth.userId, note]);
        await ensureApprovalPolicy(tx, 'shift.claim', 'Open shift claim');
        const approvalId = await requestApproval(tx, 'shift.claim', me, auth.userId, { swapId: sw.id, shiftId: id, date: s.shift_date, start: s.start_local.slice(11), end: s.end_local.slice(11), ...(warnings.length ? { warnings: warnings.length } : {}) });
        let status = 'pending';
        if (approvalId) await tx.exec('UPDATE app.shift_swaps SET approval_request_id = $2 WHERE id = $1', [sw.id, approvalId]);
        else {
          await applyClaim(tx, book, sw.id);
          status = 'approved';
        }
        await app.audit(tx, req, { action: 'shift.claim_requested', targetType: 'shift', targetId: id, diff: { swapId: sw.id, employeeId: me, findings: warnings.map((w) => w.rule) } });
        return { id: sw.id, status, warnings };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/shifts/:id/swap',
    { config: { selfAudited: true }, schema: { tags: ['rota'], summary: 'Offers my published shift to a colleague (optionally in exchange for theirs); the colleague accepts, then the manager approves', params: Type.Object({ id: Uuid }), body: Type.Object({ toEmployeeId: Uuid, toShiftId: Type.Optional(Uuid), note: Type.Optional(Type.String({ maxLength: 500 })) }), response: { 201: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { toEmployeeId: string; toShiftId?: string; note?: string };
      const me = auth.principal.employeeId;
      if (!me || !can(auth.principal, 'rota.swap_request', { employeeId: me })) throw new ApiError('forbidden');
      if (b.toEmployeeId === me) throw new ApiError('validation', 'Choose a colleague');
      const out = await app.tenantTx(req, async (tx) => {
        const s = await tx.maybe<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1`, [id]);
        if (!s || s.employee_id !== me || s.status !== 'published') throw new ApiError('notFound');
        if (compareInstants(s.starts_at, now()) <= 0) throw new ApiError('conflict', 'Shift has started');
        const colleague = await tx.maybe<{ status: string }>(`SELECT status FROM app.employees WHERE id = $1`, [b.toEmployeeId]);
        if (!colleague || colleague.status !== 'active') throw new ApiError('notFound');
        if (b.toShiftId) {
          const other = await tx.maybe<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1`, [b.toShiftId]);
          if (!other || other.employee_id !== b.toEmployeeId || other.status !== 'published' || compareInstants(other.starts_at, now()) <= 0) throw new ApiError('notFound');
        }
        const sw = await tx.one<{ id: string }>(`INSERT INTO app.shift_swaps (tenant_id, shift_id, to_shift_id, from_employee_id, to_employee_id, kind, requested_by, note) VALUES (app.current_tenant(), $1, $2, $3, $4, 'swap', $5, $6) RETURNING id`, [id, b.toShiftId ?? null, me, b.toEmployeeId, auth.userId, b.note ?? null]);
        await notifyEmployees(tx, [b.toEmployeeId], { kind: 'rota.swap_offered', titleKey: 'notify.swapOffered', params: { date: s.shift_date }, link: '/app/rota', dedupe: () => `swap-offered:${sw.id}` });
        await app.audit(tx, req, { action: 'shift.swap_requested', targetType: 'shift', targetId: id, diff: { swapId: sw.id, from: me, to: b.toEmployeeId, toShiftId: b.toShiftId ?? null } });
        return { id: sw.id, status: 'pending' };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/shift-swaps/:id/respond',
    { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), body: Type.Object({ accept: Type.Boolean() }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem, 422: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const { accept } = req.body as { accept: boolean };
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const sw = await tx.maybe<SwapRow>('SELECT * FROM app.shift_swaps WHERE id = $1 FOR UPDATE', [id]);
        if (!sw || sw.kind !== 'swap') throw new ApiError('notFound');
        if (sw.to_employee_id !== auth.principal.employeeId) throw new ApiError('forbidden');
        if (sw.status !== 'pending' || sw.accepted_at) throw new ApiError('conflict');
        let status = 'pending';
        if (!accept) {
          await tx.exec(`UPDATE app.shift_swaps SET status = 'rejected', decided_at = now() WHERE id = $1`, [id]);
          await notifyEmployees(tx, [sw.from_employee_id], { kind: 'rota.swap_declined', titleKey: 'notify.swapDeclined', link: '/app/rota', dedupe: () => `swap-declined:${id}` });
          status = 'rejected';
        } else {
          const settings = await timeSettings(tx);
          const s = await tx.one<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1`, [sw.shift_id]);
          // early warning for the colleague (re-checked on approval)
          await enforceAssignment(tx, book, settings, sw.to_employee_id!, s, sw.to_shift_id ? [sw.to_shift_id] : []);
          await tx.exec('UPDATE app.shift_swaps SET accepted_at = now() WHERE id = $1', [id]);
          await ensureApprovalPolicy(tx, 'shift.swap', 'Shift swap');
          const approvalId = await requestApproval(tx, 'shift.swap', sw.from_employee_id, sw.requested_by, { swapId: id, shiftId: sw.shift_id, toShiftId: sw.to_shift_id, toEmployeeId: sw.to_employee_id, date: s.shift_date });
          if (approvalId) await tx.exec('UPDATE app.shift_swaps SET approval_request_id = $2 WHERE id = $1', [id, approvalId]);
          else {
            await applySwap(tx, book, id);
            status = 'approved';
          }
        }
        await app.audit(tx, req, { action: accept ? 'shift.swap_accepted' : 'shift.swap_declined', targetType: 'shift_swap', targetId: id });
        return { id, status };
      });
    },
  );

  app.post('/v1/shift-swaps/:id/cancel', { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    return app.tenantTx(req, async (tx) => {
      const sw = await tx.maybe<SwapRow>('SELECT * FROM app.shift_swaps WHERE id = $1 FOR UPDATE', [id]);
      if (!sw) throw new ApiError('notFound');
      if (sw.from_employee_id !== auth.principal.employeeId && !(await mayManage(tx, auth, sw.from_employee_id))) throw new ApiError('forbidden');
      if (sw.status !== 'pending') throw new ApiError('conflict');
      await cancelSwaps(tx, [sw]);
      await app.audit(tx, req, { action: 'shift.swap_cancelled', targetType: 'shift_swap', targetId: id });
      return { id, status: 'cancelled' };
    });
  });

  app.get('/v1/shift-swaps', { schema: { tags: ['rota'], querystring: Type.Object({ status: Type.Optional(Type.Union(['pending', 'approved', 'rejected', 'cancelled'].map((s) => Type.Literal(s)))) }), response: { 200: Type.Array(Swap) } } }, async (req) => {
    const auth = requireAuth(req);
    const status = (req.query as { status?: string }).status;
    return app.tenantTx(
      req,
      async (tx) => {
        const params: unknown[] = [auth.principal.employeeId ?? null];
        const scope = canSome(auth.principal, 'rota.manage') ? `OR w.from_employee_id IN (SELECT e.id FROM app.employees e WHERE ${scopePredicate(auth.principal, 'rota.manage', params)})` : '';
        const st = status ? ` AND w.status = $${params.push(status)}` : '';
        const rows = await tx.query<SwapRow>(`SELECT w.* FROM app.shift_swaps w WHERE (w.from_employee_id = $1 OR w.to_employee_id = $1 ${scope})${st} ORDER BY w.created_at DESC LIMIT 200`, params);
        return swapOut(tx, rows);
      },
      { readOnly: true },
    );
  });

  // ---- availability -----------------------------------------------------------------------------------------
  const Availability = Type.Object({ id: Uuid, employeeId: Uuid, weekday: Nullable(Type.Integer()), date: Nullable(Type.String()), available: Type.Boolean(), from: Nullable(Type.String()), to: Nullable(Type.String()), note: Nullable(Type.String()) });
  const availabilityOut = (r: { id: string; employee_id: string; weekday: number | null; on_date: string | null; available: boolean; from_time: string | null; to_time: string | null; note: string | null }) => ({ id: r.id, employeeId: r.employee_id, weekday: r.weekday, date: r.on_date, available: r.available, from: r.from_time, to: r.to_time, note: r.note });
  const mayAvailability = async (tx: Tx, auth: Auth, employeeId: string) => can(auth.principal, 'rota.availability', employeeId === auth.principal.employeeId ? { employeeId } : await loadTarget(tx, employeeId));

  app.get('/v1/availability/:employeeId', { schema: { tags: ['rota'], params: Type.Object({ employeeId: Uuid }), response: { 200: Type.Array(Availability), 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { employeeId } = req.params as { employeeId: string };
    return app.tenantTx(
      req,
      async (tx) => {
        if (!(await mayAvailability(tx, auth, employeeId)) && !can(auth.principal, 'rota.view', await loadTarget(tx, employeeId))) throw new ApiError('forbidden');
        return (await tx.query<Parameters<typeof availabilityOut>[0]>('SELECT * FROM app.availability WHERE employee_id = $1 ORDER BY weekday NULLS LAST, on_date', [employeeId])).map(availabilityOut);
      },
      { readOnly: true },
    );
  });

  app.post(
    '/v1/availability',
    { config: { selfAudited: true }, schema: { tags: ['rota'], body: Type.Object({ employeeId: Type.Optional(Uuid), weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })), date: Type.Optional(CivilDate), available: Type.Boolean(), from: Type.Optional(HHMM), to: Type.Optional(HHMM), note: Type.Optional(Type.String({ maxLength: 300 })) }), response: { 201: Availability, 400: Problem, 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId?: string; weekday?: number; date?: string; available: boolean; from?: string; to?: string; note?: string };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation', 'employeeId is required');
      if ((b.weekday === undefined) === (b.date === undefined)) throw new ApiError('validation', 'Give a weekday or a date');
      if (b.from && b.to && b.to <= b.from) throw new ApiError('validation', 'to must be after from');
      const out = await app.tenantTx(req, async (tx) => {
        if (!(await mayAvailability(tx, auth, employeeId))) throw new ApiError('forbidden');
        const r = await tx.one<Parameters<typeof availabilityOut>[0]>(`INSERT INTO app.availability (tenant_id, employee_id, weekday, on_date, available, from_time, to_time, note) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`, [employeeId, b.weekday ?? null, b.date ?? null, b.available, b.from ?? null, b.to ?? null, b.note ?? null]);
        await app.audit(tx, req, { action: 'availability.set', targetType: 'employee', targetId: employeeId, diff: { weekday: b.weekday ?? null, date: b.date ?? null, available: b.available } });
        return availabilityOut(r);
      });
      return reply.status(201).send(out);
    },
  );

  app.delete('/v1/availability/:id', { config: { selfAudited: true }, schema: { tags: ['rota'], params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 403: Problem, 404: Problem } } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = req.params as { id: string };
    await app.tenantTx(req, async (tx) => {
      const r = await tx.maybe<{ employee_id: string }>('SELECT employee_id FROM app.availability WHERE id = $1', [id]);
      if (!r) throw new ApiError('notFound');
      if (!(await mayAvailability(tx, auth, r.employee_id))) throw new ApiError('forbidden');
      await tx.exec('DELETE FROM app.availability WHERE id = $1', [id]);
      await app.audit(tx, req, { action: 'availability.removed', targetType: 'employee', targetId: r.employee_id });
    });
    return reply.status(204).send(null);
  });

  // ---- approval effects (working time is re-checked when the manager approves) ----------------------------
  async function applyClaim(tx: Tx, book: RuleBook, swapId: string) {
    const sw = await tx.one<SwapRow>('SELECT * FROM app.shift_swaps WHERE id = $1 FOR UPDATE', [swapId]);
    if (sw.status !== 'pending') return;
    const s = await tx.one<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1 FOR UPDATE`, [sw.shift_id]);
    if (s.employee_id || s.status !== 'published') throw new ApiError('conflict', 'Shift is no longer open');
    await enforceAssignment(tx, book, await timeSettings(tx), sw.from_employee_id, s, []);
    await tx.exec('UPDATE app.shifts SET employee_id = $2 WHERE id = $1', [s.id, sw.from_employee_id]);
    await tx.exec(`UPDATE app.shift_swaps SET status = 'approved', decided_at = now() WHERE id = $1`, [swapId]);
    // the shift is taken: other pending claims for it lapse
    const others = await tx.query<SwapRow>(`SELECT * FROM app.shift_swaps WHERE shift_id = $1 AND status = 'pending' AND id <> $2`, [s.id, swapId]);
    await cancelSwaps(tx, others);
    await notifyEmployees(tx, [sw.from_employee_id], { kind: 'rota.claim_approved', titleKey: 'notify.shiftClaimApproved', params: { date: s.shift_date }, link: '/app/rota', dedupe: () => `claim-ok:${swapId}` });
  }

  async function applySwap(tx: Tx, book: RuleBook, swapId: string) {
    const sw = await tx.one<SwapRow>('SELECT * FROM app.shift_swaps WHERE id = $1 FOR UPDATE', [swapId]);
    if (sw.status !== 'pending' || !sw.to_employee_id) return;
    const settings = await timeSettings(tx);
    const a = await tx.one<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1 FOR UPDATE`, [sw.shift_id]);
    const bShift = sw.to_shift_id ? await tx.one<ShiftDbRow>(`SELECT ${SHIFT_COLUMNS} FROM app.shifts s WHERE s.id = $1 FOR UPDATE`, [sw.to_shift_id]) : undefined;
    if (a.employee_id !== sw.from_employee_id || a.status !== 'published' || (bShift && (bShift.employee_id !== sw.to_employee_id || bShift.status !== 'published'))) throw new ApiError('conflict', 'The rota changed since the swap was requested');
    await enforceAssignment(tx, book, settings, sw.to_employee_id, a, bShift ? [bShift.id] : []);
    if (bShift) await enforceAssignment(tx, book, settings, sw.from_employee_id, bShift, [a.id]);
    // free the colleague's shift first so the no-overlap constraint holds at every step
    if (bShift) await tx.exec('UPDATE app.shifts SET employee_id = NULL WHERE id = $1', [bShift.id]);
    await tx.exec('UPDATE app.shifts SET employee_id = $2 WHERE id = $1', [a.id, sw.to_employee_id]);
    if (bShift) await tx.exec('UPDATE app.shifts SET employee_id = $2 WHERE id = $1', [bShift.id, sw.from_employee_id]);
    await tx.exec(`UPDATE app.shift_swaps SET status = 'approved', decided_at = now() WHERE id = $1`, [swapId]);
    await notifyEmployees(tx, [sw.from_employee_id, sw.to_employee_id], { kind: 'rota.swap_approved', titleKey: 'notify.swapApproved', params: { date: a.shift_date }, link: '/app/rota', dedupe: (e) => `swap-ok:${swapId}:${e}` });
  }

  approvalHandlers['shift.claim'] = async (tx, r) => applyClaim(tx, await ruleBook(app), String(r.payload.swapId));
  approvalHandlers['shift.swap'] = async (tx, r) => applySwap(tx, await ruleBook(app), String(r.payload.swapId));
  const rejected = (kind: string, titleKey: string) => async (tx: Tx, r: { payload: Record<string, unknown> }) => {
    const sw = await tx.maybe<SwapRow>(`UPDATE app.shift_swaps SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [r.payload.swapId]);
    if (sw) await notifyEmployees(tx, [sw.from_employee_id, ...(sw.to_employee_id ? [sw.to_employee_id] : [])], { kind, titleKey, link: '/app/rota', dedupe: (e) => `swap-no:${sw.id}:${e}` });
  };
  rejectionHandlers['shift.claim'] = rejected('rota.claim_rejected', 'notify.shiftClaimRejected');
  rejectionHandlers['shift.swap'] = rejected('rota.swap_rejected', 'notify.swapRejected');
}

/** Cancels pending swaps/claims and their approval requests and tasks. */
async function cancelSwaps(tx: Tx, swaps: Array<Pick<SwapRow, 'id' | 'approval_request_id'>>) {
  for (const sw of swaps) {
    await tx.exec(`UPDATE app.shift_swaps SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`, [sw.id]);
    if (sw.approval_request_id) {
      await tx.exec(`UPDATE app.approval_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`, [sw.approval_request_id]);
      await tx.exec(`UPDATE app.tasks SET status = 'cancelled' WHERE source = 'approval' AND source_id = $1 AND status = 'open'`, [sw.approval_request_id]);
    }
  }
}
async function cancelSwapsFor(tx: Tx, shiftIds: string[]) {
  const rows = await tx.query<SwapRow>(`SELECT id, approval_request_id FROM app.shift_swaps WHERE (shift_id = ANY($1::uuid[]) OR to_shift_id = ANY($1::uuid[])) AND status = 'pending'`, [shiftIds]);
  await cancelSwaps(tx, rows);
}
