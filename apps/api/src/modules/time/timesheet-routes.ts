import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { addDays, addMonths, compareDates, daysBetween, instantToDate, maxDate } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, decodeCursor, encodeCursor, Nullable, Problem, Uuid } from '../../http/schemas';
import { loadTarget, scopePredicate } from '../employees/service';
import { approvalHandlers, rejectionHandlers, requestApproval } from '../approvals/service';
import { ruleBook } from '../rules/routes';
import { timesheetCsv } from './engine';
import { ensureApprovalPolicy, notifyEmployees } from './rota-routes';
import { buildTimesheet, employeeTimeContext, timeSettings, weekStartFor, type Finding, type Timesheet, type TimesheetDay } from './service';
import { TimesheetOut } from './schemas';

interface TimesheetRow {
  id: string;
  employee_id: string;
  week_start: string;
  status: string;
  regular_minutes: number;
  overtime_minutes: number;
  double_minutes: number;
  scheduled_minutes: number;
  worked_minutes: number;
  violations: Finding[];
  days: TimesheetDay[];
  sources: string[];
  time_recording_required: boolean;
  approval_request_id: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  exported_at: string | null;
}

/** Submitted and approved timesheets show the snapshot that was approved; open ones are computed live. */
function present(live: Timesheet, stored: TimesheetRow | undefined) {
  const frozen = stored && ['submitted', 'approved'].includes(stored.status);
  return {
    ...live,
    ...(frozen
      ? { days: stored.days, workedMinutes: stored.worked_minutes, scheduledMinutes: stored.scheduled_minutes, regularMinutes: stored.regular_minutes, overtimeMinutes: stored.overtime_minutes, doubleMinutes: stored.double_minutes, violations: stored.violations, sources: stored.sources, timeRecordingRequired: stored.time_recording_required }
      : {}),
    id: stored?.id ?? null,
    status: stored?.status ?? 'open',
    approvalRequestId: stored?.approval_request_id ?? null,
    submittedAt: stored?.submitted_at ?? null,
    decidedAt: stored?.decided_at ?? null,
    exportedAt: stored?.exported_at ?? null,
  };
}

const OptOut = Type.Object({ id: Uuid, employeeId: Uuid, validFrom: Type.String(), validTo: Nullable(Type.String()), noticeDays: Type.Integer(), noticeGivenOn: Nullable(Type.String()), signedDocumentId: Nullable(Uuid), source: Nullable(Type.String()) });
interface OptOutRow {
  id: string;
  employee_id: string;
  valid_from: string;
  valid_to: string | null;
  notice_days: number;
  notice_given_on: string | null;
  signed_document_id: string | null;
}
interface OptOutRule {
  permitted: boolean;
  workerMayTerminate?: boolean;
  defaultTerminationNoticeDays?: number;
  maxAgreedTerminationNoticeMonths?: number;
}

export async function timesheetRoutes(app: FastifyInstance) {
  const now = () => app.deps.now().toISOString();

  async function mayRead(tx: Tx, auth: ReturnType<typeof requireAuth>, employeeId: string) {
    if (employeeId === auth.principal.employeeId) return can(auth.principal, 'time.clock', { employeeId });
    return can(auth.principal, 'time.read', await loadTarget(tx, employeeId));
  }

  app.get(
    '/v1/timesheets/employees/:employeeId/weeks/:weekStart',
    { schema: { tags: ['time'], summary: 'Weekly timesheet: recorded vs rota per day (variances flagged), overtime and working-time findings from the jurisdiction packs', params: Type.Object({ employeeId: Uuid, weekStart: CivilDate }), response: { 200: TimesheetOut, 403: Problem, 404: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const p = req.params as { employeeId: string; weekStart: string };
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          if (!(await mayRead(tx, auth, p.employeeId))) throw new ApiError('forbidden');
          const settings = await timeSettings(tx);
          const weekStart = weekStartFor(p.weekStart, settings.workweekStartsOn);
          const stored = await tx.maybe<TimesheetRow>('SELECT * FROM app.timesheets WHERE employee_id = $1 AND week_start = $2', [p.employeeId, weekStart]);
          return present(await buildTimesheet(tx, book, p.employeeId, weekStart, settings), stored);
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/timesheets/employees/:employeeId/weeks/:weekStart/submit',
    { config: { selfAudited: true }, schema: { tags: ['time'], summary: 'Submits a week for approval (snapshot frozen until decided)', params: Type.Object({ employeeId: Uuid, weekStart: CivilDate }), response: { 200: TimesheetOut, 403: Problem, 409: Problem, 422: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const p = req.params as { employeeId: string; weekStart: string };
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const own = p.employeeId === auth.principal.employeeId;
        if (!(own ? can(auth.principal, 'time.clock', { employeeId: p.employeeId }) : can(auth.principal, 'time.correct', await loadTarget(tx, p.employeeId)))) throw new ApiError('forbidden');
        const settings = await timeSettings(tx);
        const weekStart = weekStartFor(p.weekStart, settings.workweekStartsOn);
        const ctx = await employeeTimeContext(tx, p.employeeId);
        if (compareDates(instantToDate(now(), ctx.zone), addDays(weekStart, 6)) < 0) throw new ApiError('conflict', 'The week has not finished yet');
        const cur = await tx.maybe<TimesheetRow>('SELECT * FROM app.timesheets WHERE employee_id = $1 AND week_start = $2 FOR UPDATE', [p.employeeId, weekStart]);
        if (cur && !['open', 'rejected'].includes(cur.status)) throw new ApiError('conflict', 'Already submitted');
        const ts = await buildTimesheet(tx, book, p.employeeId, weekStart, settings);
        if (ts.openClock) throw new ApiError('unprocessable', 'Clock out before submitting the week');
        const row = await tx.one<TimesheetRow>(
          `INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, overtime_minutes, double_minutes, scheduled_minutes, worked_minutes, violations, days, sources, time_recording_required, submitted_at, submitted_by, decided_at, approval_request_id)
           VALUES (app.current_tenant(), $1, $2, 'submitted', $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, NULL, NULL)
           ON CONFLICT (tenant_id, employee_id, week_start) DO UPDATE SET status = 'submitted', regular_minutes = EXCLUDED.regular_minutes, overtime_minutes = EXCLUDED.overtime_minutes,
             double_minutes = EXCLUDED.double_minutes, scheduled_minutes = EXCLUDED.scheduled_minutes, worked_minutes = EXCLUDED.worked_minutes, violations = EXCLUDED.violations, days = EXCLUDED.days,
             sources = EXCLUDED.sources, time_recording_required = EXCLUDED.time_recording_required, submitted_at = now(), submitted_by = EXCLUDED.submitted_by, decided_at = NULL, approval_request_id = NULL
           RETURNING *`,
          [p.employeeId, weekStart, ts.regularMinutes, ts.overtimeMinutes, ts.doubleMinutes, ts.scheduledMinutes, ts.workedMinutes, JSON.stringify(ts.violations), JSON.stringify(ts.days), JSON.stringify(ts.sources), ts.timeRecordingRequired, auth.userId],
        );
        await ensureApprovalPolicy(tx, 'timesheet', 'Timesheet approval');
        const approvalId = await requestApproval(tx, 'timesheet', p.employeeId, auth.userId, { timesheetId: row.id, weekStart, workedMinutes: ts.workedMinutes, overtimeMinutes: ts.overtimeMinutes + ts.doubleMinutes, violations: ts.violations.length });
        let final: TimesheetRow;
        if (approvalId) final = await tx.one<TimesheetRow>('UPDATE app.timesheets SET approval_request_id = $2 WHERE id = $1 RETURNING *', [row.id, approvalId]);
        else final = await tx.one<TimesheetRow>(`UPDATE app.timesheets SET status = 'approved', decided_at = now() WHERE id = $1 RETURNING *`, [row.id]);
        await app.audit(tx, req, { action: 'timesheet.submitted', targetType: 'timesheet', targetId: row.id, diff: { employeeId: p.employeeId, weekStart, workedMinutes: ts.workedMinutes, overtimeMinutes: ts.overtimeMinutes, doubleMinutes: ts.doubleMinutes, violations: ts.violations.map((v) => v.rule) } });
        return present(ts, final);
      });
    },
  );

  app.post(
    '/v1/timesheets/:id/reopen',
    { config: { selfAudited: true }, schema: { tags: ['time'], params: Type.Object({ id: Uuid }), body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      return app.tenantTx(req, async (tx) => {
        const ts = await tx.maybe<TimesheetRow>('SELECT * FROM app.timesheets WHERE id = $1 FOR UPDATE', [id]);
        if (!ts) throw new ApiError('notFound');
        const target = await loadTarget(tx, ts.employee_id);
        if (!can(auth.principal, 'time.approve', target) && !can(auth.principal, 'time.correct', target)) throw new ApiError('forbidden');
        if (!['submitted', 'approved'].includes(ts.status)) throw new ApiError('conflict');
        if (ts.exported_at) throw new ApiError('conflict', 'Already sent to payroll — correct it in the next pay period');
        await tx.exec(`UPDATE app.timesheets SET status = 'open', reopened_at = now(), decided_at = NULL WHERE id = $1`, [id]);
        if (ts.approval_request_id) {
          await tx.exec(`UPDATE app.approval_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`, [ts.approval_request_id]);
          await tx.exec(`UPDATE app.tasks SET status = 'cancelled' WHERE source = 'approval' AND source_id = $1 AND status = 'open'`, [ts.approval_request_id]);
        }
        await app.audit(tx, req, { action: 'timesheet.reopened', targetType: 'timesheet', targetId: id, diff: { from: ts.status, reason } });
        return { id, status: 'open' };
      });
    },
  );

  const ListRow = Type.Object({ id: Uuid, employeeId: Uuid, employeeName: Type.String(), employeeNumber: Type.String(), weekStart: Type.String(), status: Type.String(), workedMinutes: Type.Integer(), scheduledMinutes: Type.Integer(), regularMinutes: Type.Integer(), overtimeMinutes: Type.Integer(), doubleMinutes: Type.Integer(), violations: Type.Integer(), approvalRequestId: Nullable(Uuid), exportedAt: Nullable(Type.String()) });
  app.get(
    '/v1/timesheets',
    { schema: { tags: ['time'], summary: 'Timesheets for a week in the caller’s scope (keyset by name, id)', querystring: Type.Object({ weekStart: CivilDate, status: Type.Optional(Type.Union(['open', 'submitted', 'approved', 'rejected'].map((s) => Type.Literal(s)))), cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })) }), response: { 200: Type.Object({ data: Type.Array(ListRow), nextCursor: Nullable(Type.String()) }), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'time.read')) throw new ApiError('forbidden');
      const q = req.query as { weekStart: string; status?: string; cursor?: string; limit?: number };
      const limit = q.limit ?? 100;
      return app.tenantTx(
        req,
        async (tx) => {
          const settings = await timeSettings(tx);
          const params: unknown[] = [weekStartFor(q.weekStart, settings.workweekStartsOn)];
          const add = (v: unknown) => (params.push(v), `$${params.length}`);
          const where = ['t.week_start = $1', scopePredicate(auth.principal, 'time.read', params)];
          if (q.status) where.push(`t.status = ${add(q.status)}`);
          const c = decodeCursor<[string, string]>(q.cursor);
          if (c) where.push(`(e.display_name, t.id) > (${add(c[0])}, ${add(c[1])}::uuid)`);
          const rows = await tx.query<TimesheetRow & { display_name: string; employee_number: string }>(
            `SELECT t.*, e.display_name, e.employee_number FROM app.timesheets t JOIN app.employees e ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
              WHERE ${where.join(' AND ')} ORDER BY e.display_name, t.id LIMIT ${add(limit + 1)}`,
            params,
          );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          return {
            data: page.map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: r.display_name, employeeNumber: r.employee_number, weekStart: r.week_start, status: r.status, workedMinutes: r.worked_minutes, scheduledMinutes: r.scheduled_minutes, regularMinutes: r.regular_minutes, overtimeMinutes: r.overtime_minutes, doubleMinutes: r.double_minutes, violations: r.violations.length, approvalRequestId: r.approval_request_id, exportedAt: r.exported_at })),
            nextCursor: rows.length > limit && last ? encodeCursor([last.display_name, last.id]) : null,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/timesheets/export',
    {
      config: { selfAudited: true },
      schema: { tags: ['time'], summary: 'Payroll export feed: CSV of approved timesheets for a week (reproducible; every export is audited)', produces: ['text/csv'], querystring: Type.Object({ weekStart: CivilDate }), response: { 200: Type.String(), 403: Problem } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'time.export')) throw new ApiError('forbidden');
      const q = req.query as { weekStart: string };
      const out = await app.tenantTx(req, async (tx) => {
        const settings = await timeSettings(tx);
        const weekStart = weekStartFor(q.weekStart, settings.workweekStartsOn);
        const params: unknown[] = [weekStart];
        const rows = await tx.query<TimesheetRow & { display_name: string; employee_number: string }>(
          `SELECT t.*, e.display_name, e.employee_number FROM app.timesheets t JOIN app.employees e ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
            WHERE t.week_start = $1 AND t.status = 'approved' AND ${scopePredicate(auth.principal, 'time.export', params)} ORDER BY e.employee_number`,
          params,
        );
        const csv = timesheetCsv(rows.map((r) => ({ employeeNumber: r.employee_number, name: r.display_name, weekStart: r.week_start, worked: r.worked_minutes, scheduled: r.scheduled_minutes, regular: r.regular_minutes, overtime: r.overtime_minutes, double: r.double_minutes, violations: r.violations.length, approvedAt: r.decided_at })));
        const checksum = createHash('sha256').update(csv).digest('hex');
        const exp = await tx.one<{ id: string }>(`INSERT INTO app.timesheet_exports (tenant_id, week_start, row_count, checksum, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`, [weekStart, rows.length, checksum, auth.userId]);
        if (rows.length) await tx.exec(`UPDATE app.timesheets SET exported_at = now() WHERE id = ANY($1::uuid[]) AND exported_at IS NULL`, [rows.map((r) => r.id)]);
        await app.audit(tx, req, { action: 'timesheets.exported', targetType: 'timesheet_export', targetId: exp.id, diff: { weekStart, rows: rows.length, checksum } });
        return { csv, weekStart, checksum };
      });
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="timesheets-${out.weekStart}.csv"`)
        .header('X-Content-SHA256', out.checksum)
        .send(out.csv);
    },
  );

  // ---- 48-hour week opt-out records (where the pack permits an individual opt-out) --------------------------
  const optOutOut = (r: OptOutRow, source: string | null) => ({ id: r.id, employeeId: r.employee_id, validFrom: r.valid_from, validTo: r.valid_to, noticeDays: r.notice_days, noticeGivenOn: r.notice_given_on, signedDocumentId: r.signed_document_id, source });
  async function optOutRule(tx: Tx, employeeId: string, date: string) {
    const ctx = await employeeTimeContext(tx, employeeId);
    const r = ctx.country ? (await ruleBook(app)).tryResolve<OptOutRule>(ctx.country, 'working_time.opt_out', date) : undefined;
    return r;
  }

  app.post(
    '/v1/working-time/opt-outs',
    { config: { selfAudited: true }, schema: { tags: ['time'], summary: 'Records a written opt-out from the 48-hour average week (only where the jurisdiction pack permits one, e.g. GB)', body: Type.Object({ employeeId: Uuid, validFrom: CivilDate, noticeDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 366 })), signedDocumentId: Type.Optional(Uuid) }), response: { 201: OptOut, 403: Problem, 409: Problem, 422: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId: string; validFrom: string; noticeDays?: number; signedDocumentId?: string };
      const out = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'time.manage', await loadTarget(tx, b.employeeId))) throw new ApiError('forbidden');
        const rule = await optOutRule(tx, b.employeeId, b.validFrom);
        if (!rule?.value.permitted) throw new ApiError('unprocessable', 'An individual opt-out is not available in this jurisdiction');
        const noticeDays = b.noticeDays ?? rule.value.defaultTerminationNoticeDays;
        if (noticeDays === undefined) throw new ApiError('validation', 'noticeDays is required');
        const maxMonths = rule.value.maxAgreedTerminationNoticeMonths;
        if (maxMonths !== undefined && noticeDays > daysBetween(b.validFrom, addMonths(b.validFrom, maxMonths))) throw new ApiError('unprocessable', 'Notice period is longer than the law allows', { maxMonths, source: rule.source.url });
        if (b.signedDocumentId && !(await tx.maybe('SELECT 1 FROM app.documents WHERE id = $1', [b.signedDocumentId]))) throw new ApiError('validation', 'Unknown document');
        const r = await tx.one<OptOutRow>(`INSERT INTO app.working_time_opt_outs (tenant_id, employee_id, valid_from, notice_days, signed_document_id, recorded_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING *`, [b.employeeId, b.validFrom, noticeDays, b.signedDocumentId ?? null, auth.userId]);
        await app.audit(tx, req, { action: 'working_time.opt_out_recorded', targetType: 'employee', targetId: b.employeeId, diff: { optOutId: r.id, validFrom: b.validFrom, noticeDays, signedDocument: !!b.signedDocumentId, source: rule.source.url } });
        return optOutOut(r, rule.source.url);
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/working-time/opt-outs/:id/end',
    { config: { selfAudited: true }, schema: { tags: ['time'], summary: 'Ends an opt-out: the worker (or HR) gives notice; it ends when the notice period expires', params: Type.Object({ id: Uuid }), body: Type.Object({ noticeGivenOn: CivilDate }), response: { 200: OptOut, 403: Problem, 404: Problem, 409: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const { noticeGivenOn } = req.body as { noticeGivenOn: string };
      return app.tenantTx(req, async (tx) => {
        const cur = await tx.maybe<OptOutRow>('SELECT * FROM app.working_time_opt_outs WHERE id = $1 FOR UPDATE', [id]);
        if (!cur) throw new ApiError('notFound');
        if (cur.valid_to) throw new ApiError('conflict', 'Already ended');
        const rule = await optOutRule(tx, cur.employee_id, noticeGivenOn);
        const own = cur.employee_id === auth.principal.employeeId;
        if (!(own ? !!rule?.value.workerMayTerminate && can(auth.principal, 'time.clock', { employeeId: cur.employee_id }) : can(auth.principal, 'time.manage', await loadTarget(tx, cur.employee_id)))) throw new ApiError('forbidden');
        const validTo = maxDate(addDays(noticeGivenOn, cur.notice_days), addDays(cur.valid_from, 1));
        const r = await tx.one<OptOutRow>('UPDATE app.working_time_opt_outs SET valid_to = $2, notice_given_on = $3, ended_by = $4 WHERE id = $1 RETURNING *', [id, validTo, noticeGivenOn, auth.userId]);
        await app.audit(tx, req, { action: 'working_time.opt_out_ended', targetType: 'employee', targetId: cur.employee_id, diff: { optOutId: id, noticeGivenOn, validTo } });
        return optOutOut(r, rule?.source.url ?? null);
      });
    },
  );

  app.get('/v1/working-time/opt-outs', { schema: { tags: ['time'], querystring: Type.Object({ employeeId: Uuid }), response: { 200: Type.Array(OptOut), 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { employeeId } = req.query as { employeeId: string };
    return app.tenantTx(
      req,
      async (tx) => {
        if (!(await mayRead(tx, auth, employeeId))) throw new ApiError('forbidden');
        const rows = await tx.query<OptOutRow>('SELECT * FROM app.working_time_opt_outs WHERE employee_id = $1 ORDER BY valid_from DESC', [employeeId]);
        const rule = rows.length ? await optOutRule(tx, employeeId, rows[0]!.valid_from) : undefined;
        return rows.map((r) => optOutOut(r, rule?.source.url ?? null));
      },
      { readOnly: true },
    );
  });

  // ---- approval effects ------------------------------------------------------------------------------------
  approvalHandlers['timesheet'] = async (tx, r) => {
    const ts = await tx.maybe<{ employee_id: string; week_start: string }>(`UPDATE app.timesheets SET status = 'approved', decided_at = now() WHERE id = $1 AND status = 'submitted' RETURNING employee_id, week_start`, [r.payload.timesheetId]);
    if (ts) await notifyEmployees(tx, [ts.employee_id], { kind: 'time.timesheet_approved', titleKey: 'notify.timesheetApproved', params: { week: ts.week_start }, link: '/app/timesheets', dedupe: () => `ts-ok:${r.id}` });
  };
  rejectionHandlers['timesheet'] = async (tx, r) => {
    const ts = await tx.maybe<{ employee_id: string; week_start: string }>(`UPDATE app.timesheets SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'submitted' RETURNING employee_id, week_start`, [r.payload.timesheetId]);
    if (ts) await notifyEmployees(tx, [ts.employee_id], { kind: 'time.timesheet_rejected', titleKey: 'notify.timesheetRejected', params: { week: ts.week_start }, link: '/app/timesheets', dedupe: () => `ts-no:${r.id}` });
  };
}
