import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { addDays, compareDates, dateParts, daysBetween, today } from '@thapsus/core/time';
import { enqueueJob, withTenant, writeAudit, type Tx } from '@thapsus/db';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { objectKey } from '../../lib/object-store';
import { periodic, registerJob } from '../../jobs/registry';
import { composeToken, hashToken, newToken, parseToken } from '../auth/tokens';
import { loadTarget, scopePredicate } from '../employees/service';
import { approvalHandlers, rejectionHandlers, requestApproval } from '../approvals/service';
import { ruleBook } from '../rules/routes';
import { Vault } from '../vault/service';
import { bradfordFactor, employerContinuedPay, fmlaEligibility, milesBetween, requestAmount, ukSsp, usSickAccrual, type LeavePolicy, type UkSspRule } from './engine';
import { amountFor, balanceFor, coverProblems, ensureLeaveDefaults, holidaysFor, leaveContext } from './service';

const ICS_PREFIX = 'ics_';
const Balance = Type.Object({ leaveType: Type.String(), policy: Type.String(), year: Type.Array(Type.String()), entitlement: Type.Number(), accrued: Type.Number(), carriedOver: Type.Number(), carryOverExpired: Type.Number(), adjustments: Type.Number(), publicHolidays: Type.Number(), taken: Type.Number(), booked: Type.Number(), pending: Type.Number(), available: Type.Number(), inWaitingPeriod: Type.Boolean() });
const LeaveRequest = Type.Object({ id: Uuid, employeeId: Uuid, employeeName: Nullable(Type.String()), leaveType: Type.String(), startDate: Type.String(), endDate: Type.String(), amountDays: Type.Number(), status: Type.String(), note: Nullable(Type.String()) });

/** Leave types whose detail must not be shown to colleagues or in calendar feeds. */
const SENSITIVE_CATEGORIES = new Set(['sickness', 'family', 'fmla']);

export async function leaveRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);

  async function canActOn(tx: Tx, auth: ReturnType<typeof requireAuth>, employeeId: string, action: string) {
    if (auth.principal.employeeId === employeeId) return can(auth.principal, action === 'leave.read' ? 'self.read' : 'leave.request', { employeeId });
    return can(auth.principal, action, await loadTarget(tx, employeeId));
  }

  // ---- types and policies ----------------------------------------------------------------------------
  app.get('/v1/leave/types', { schema: { tags: ['leave'], response: { 200: Type.Array(Type.Object({ id: Uuid, key: Type.String(), name: Type.Record(Type.String(), Type.String()), category: Type.String(), paid: Type.Boolean(), requiresApproval: Type.Boolean() })) } } }, async (req) => {
    requireAuth(req);
    const book = await ruleBook(app);
    return app.tenantTx(req, async (tx) => {
      await ensureLeaveDefaults(tx, book);
      return (await tx.query<{ id: string; key: string; name: Record<string, string>; category: string; paid: boolean; requires_approval: boolean }>('SELECT * FROM app.leave_types WHERE active ORDER BY key')).map((t) => ({ id: t.id, key: t.key, name: t.name, category: t.category, paid: t.paid, requiresApproval: t.requires_approval }));
    });
  });

  const PolicyConfig = Type.Object({
    accrual: Type.Union([Type.Object({ method: Type.Union([Type.Literal('annual_upfront'), Type.Literal('monthly')]), days: Type.Number({ minimum: 0, maximum: 366 }) }), Type.Object({ method: Type.Literal('per_hour_worked'), percent: Type.Number({ minimum: 0, maximum: 100 }) })]),
    unit: Type.Union([Type.Literal('days'), Type.Literal('hours')]),
    yearStart: Type.String({ pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' }),
    proRata: Type.Boolean(),
    includesPublicHolidays: Type.Boolean(),
    waitingDays: Type.Integer({ minimum: 0, maximum: 365 }),
    carryOver: Type.Optional(Type.Object({ maxDays: Type.Number({ minimum: 0 }), expiresAfterMonths: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })) })),
    capDays: Type.Optional(Type.Number({ minimum: 0 })),
    allowNegativeDays: Type.Number({ minimum: 0, maximum: 30 }),
    rounding: Type.Union(['none', 'up_half_day', 'nearest_half_day', 'up_whole_day'].map((r) => Type.Literal(r))),
  });

  app.post(
    '/v1/leave/policies',
    { config: { selfAudited: true }, schema: { tags: ['leave'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), leaveTypeId: Uuid, entityId: Type.Optional(Nullable(Uuid)), country: Type.Optional(Nullable(Type.String({ pattern: '^[A-Z]{2}$' }))), config: PolicyConfig, effectiveFrom: Type.Optional(CivilDate) }), response: { 201: Type.Object({ id: Uuid, warnings: Type.Array(Type.String()) }), 403: Problem } } },
    async (req, reply) => {
      authorize(req, 'leave.manage');
      const b = req.body as { name: string; leaveTypeId: string; entityId?: string | null; country?: string | null; config: LeavePolicy; effectiveFrom?: string };
      // Compliance check against the jurisdiction pack's statutory minimum (warn; customers may offer more).
      const warnings: string[] = [];
      const book = await ruleBook(app);
      const country = b.country ?? null;
      if (country && b.config.accrual.method !== 'per_hour_worked') {
        const r = book.tryResolve<{ capDays?: number; weeks?: number; days?: number; fiveDayWeekEquivalentDays?: number }>(country === 'GB' ? 'GB' : country, 'leave.statutory_annual_minimum', b.effectiveFrom ?? today('UTC'));
        const minDays = r?.value.capDays ?? r?.value.fiveDayWeekEquivalentDays ?? (r?.value.weeks ? r.value.weeks * 5 : undefined);
        if (minDays !== undefined && b.config.accrual.days < minDays) warnings.push(`belowStatutoryMinimum:${minDays}`);
      }
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, entity_id, country, config, effective_from) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, coalesce($6::date, '2000-01-01')) RETURNING id`, [b.name, b.leaveTypeId, b.entityId ?? null, country, JSON.stringify(b.config), b.effectiveFrom ?? null]);
        await app.audit(tx, req, { action: 'leave_policy.created', targetType: 'leave_policy', targetId: r.id, diff: { name: b.name, warnings } });
        return r;
      });
      return reply.status(201).send({ id: row.id, warnings });
    },
  );

  app.post(
    '/v1/leave/policies/:id/assign',
    { config: { selfAudited: true }, schema: { tags: ['leave'], params: Type.Object({ id: Uuid }), body: Type.Object({ employeeIds: Type.Array(Uuid, { minItems: 1, maxItems: 10_000 }), validFrom: CivilDate }), response: { 200: Type.Object({ assigned: Type.Integer() }), 403: Problem } } },
    async (req) => {
      authorize(req, 'leave.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { employeeIds: string[]; validFrom: string };
      return app.tenantTx(req, async (tx) => {
        const p = await tx.one<{ leave_type_id: string }>('SELECT leave_type_id FROM app.leave_policies WHERE id = $1', [id]);
        for (const e of b.employeeIds) {
          await tx.exec(`UPDATE app.leave_policy_assignments SET valid_to = $3 WHERE employee_id = $1 AND leave_type_id = $2 AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $3)`, [e, p.leave_type_id, b.validFrom]);
          await tx.exec(`INSERT INTO app.leave_policy_assignments (tenant_id, employee_id, policy_id, leave_type_id, valid_from) VALUES (app.current_tenant(), $1, $2, $3, $4)`, [e, id, p.leave_type_id, b.validFrom]);
        }
        await app.audit(tx, req, { action: 'leave_policy.assigned', targetType: 'leave_policy', targetId: id, diff: { employees: b.employeeIds.length, validFrom: b.validFrom } });
        return { assigned: b.employeeIds.length };
      });
    },
  );

  // ---- balances -------------------------------------------------------------------------------------
  app.get(
    '/v1/leave/balances/:employeeId',
    { schema: { tags: ['leave'], params: Type.Object({ employeeId: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Array(Balance), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today(auth.user.timeZone ?? 'Europe/London');
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        if (!(await canActOn(tx, auth, employeeId, 'leave.read'))) throw new ApiError('forbidden');
        await ensureLeaveDefaults(tx, book);
        const types = await tx.query<{ id: string; key: string }>(`SELECT id, key FROM app.leave_types WHERE active AND deducts_balance ORDER BY key`);
        const out = [];
        for (const t of types) {
          const b = await balanceFor(tx, book, employeeId, t.id, asOf);
          if (b) {
            const { canBook: _c, waitingEnds: _w, ...rest } = b;
            void _c;
            void _w;
            out.push({ leaveType: t.key, ...rest, year: [...b.year] });
          }
        }
        return out;
      });
    },
  );

  app.post(
    '/v1/leave/adjustments',
    { config: { selfAudited: true }, schema: { tags: ['leave'], body: Type.Object({ employeeId: Uuid, leaveTypeId: Uuid, amount: Type.Number({ minimum: -365, maximum: 365 }), effectiveDate: CivilDate, kind: Type.Optional(Type.Union(['manual', 'toil', 'carry_over', 'correction'].map((k) => Type.Literal(k)))), reason: Type.String({ minLength: 3, maxLength: 300 }) }), response: { 201: Type.Object({ id: Uuid }), 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId: string; leaveTypeId: string; amount: number; effectiveDate: string; kind?: string; reason: string };
      const row = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'leave.adjust', await loadTarget(tx, b.employeeId))) throw new ApiError('forbidden');
        const r = await tx.one<{ id: string }>(`INSERT INTO app.leave_adjustments (tenant_id, employee_id, leave_type_id, amount, kind, effective_date, reason, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`, [b.employeeId, b.leaveTypeId, b.amount, b.kind ?? 'manual', b.effectiveDate, b.reason, auth.userId]);
        await app.audit(tx, req, { action: 'leave.adjusted', targetType: 'employee', targetId: b.employeeId, diff: { amount: b.amount, kind: b.kind ?? 'manual', reason: b.reason } });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  // ---- requests -----------------------------------------------------------------------------------------
  app.post(
    '/v1/leave/requests',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({ employeeId: Type.Optional(Uuid), leaveTypeId: Uuid, startDate: CivilDate, endDate: CivilDate, startHalf: Type.Optional(Type.Union([Type.Literal('am'), Type.Literal('pm')])), endHalf: Type.Optional(Type.Union([Type.Literal('am'), Type.Literal('pm')])), note: Type.Optional(Type.String({ maxLength: 500 })), fmlaCaseId: Type.Optional(Uuid) }),
        response: { 201: Type.Object({ id: Uuid, status: Type.String(), amountDays: Type.Number(), warnings: Type.Array(Type.Any()) }), 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId?: string; leaveTypeId: string; startDate: string; endDate: string; startHalf?: 'am' | 'pm'; endHalf?: 'am' | 'pm'; note?: string; fmlaCaseId?: string };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation', 'employeeId is required');
      if (compareDates(b.endDate, b.startDate) < 0) throw new ApiError('validation', 'endDate before startDate');
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const own = auth.principal.employeeId === employeeId;
        if (!(own ? can(auth.principal, 'leave.request', { employeeId }) : can(auth.principal, 'leave.record', await loadTarget(tx, employeeId)))) throw new ApiError('forbidden');
        const type = await tx.maybe<{ id: string; key: string; category: string; requires_approval: boolean; deducts_balance: boolean; name: Record<string, string> }>('SELECT * FROM app.leave_types WHERE id = $1 AND active', [b.leaveTypeId]);
        if (!type) throw new ApiError('notFound');
        const overlap = await tx.maybe(`SELECT 1 FROM app.leave_requests WHERE employee_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3 AND end_date >= $2`, [employeeId, b.startDate, b.endDate]);
        if (overlap) throw new ApiError('conflict', 'Overlaps an existing request');
        const amount = await amountFor(tx, book, employeeId, b.startDate, b.endDate, b.startHalf, b.endHalf);
        if (amount.days === 0) throw new ApiError('unprocessable', 'No working days in this period');
        if (type.deducts_balance) {
          const bal = await balanceFor(tx, book, employeeId, type.id, b.startDate);
          if (!bal) throw new ApiError('unprocessable', 'No leave policy applies');
          if (!bal.canBook(amount.days)) throw new ApiError('unprocessable', bal.inWaitingPeriod ? 'Still in the waiting period' : 'Not enough balance', { available: bal.available, requested: amount.days });
        }
        const ctx = await leaveContext(tx, employeeId, b.startDate);
        const cover = await coverProblems(tx, ctx, b.startDate, b.endDate);
        if (cover.some((c) => c.enforcement === 'block')) throw new ApiError('unprocessable', 'Minimum cover would not be met', { cover });
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, start_half, end_half, amount_days, amount_hours, note, requested_by, fmla_case_id, status)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [employeeId, type.id, b.startDate, b.endDate, b.startHalf ?? null, b.endHalf ?? null, amount.days, amount.hours, b.note ?? null, auth.userId, b.fmlaCaseId ?? null, type.requires_approval ? 'pending' : 'approved'],
        );
        let status = type.requires_approval ? 'pending' : 'approved';
        if (type.requires_approval) {
          // A manager-approval policy is created on first use; customers can change or extend it.
          const has = await tx.maybe(`SELECT 1 FROM app.approval_policies WHERE subject = 'leave.request' LIMIT 1`);
          if (!has) await tx.exec(`INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), 'leave.request', 'Leave approval', '[{"approver":{"type":"manager"}}]')`);
          const approvalId = await requestApproval(tx, 'leave.request', employeeId, auth.userId, { leaveRequestId: r.id, leaveType: type.key, startDate: b.startDate, endDate: b.endDate, amountDays: amount.days, ...(cover.length ? { coverWarnings: cover.length } : {}) });
          if (approvalId) await tx.exec('UPDATE app.leave_requests SET approval_request_id = $2 WHERE id = $1', [r.id, approvalId]);
          else {
            await tx.exec(`UPDATE app.leave_requests SET status = 'approved', decided_at = now() WHERE id = $1`, [r.id]);
            status = 'approved';
          }
        }
        await app.audit(tx, req, { action: 'leave.requested', targetType: 'leave_request', targetId: r.id, diff: { employeeId, type: type.key, start: b.startDate, end: b.endDate, days: amount.days }, sensitive: SENSITIVE_CATEGORIES.has(type.category) });
        return { id: r.id, status, amountDays: amount.days, warnings: cover };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/leave/requests',
    { schema: { tags: ['leave'], querystring: Type.Object({ employeeId: Type.Optional(Uuid), status: Type.Optional(Type.String()) }), response: { 200: Type.Array(LeaveRequest), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { employeeId?: string; status?: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          let where: string;
          if (q.employeeId) {
            if (!(await canActOn(tx, auth, q.employeeId, 'leave.read'))) throw new ApiError('forbidden');
            params.push(q.employeeId);
            where = `l.employee_id = $1`;
          } else {
            const scope = scopePredicate(auth.principal, 'leave.read', params);
            params.push(auth.principal.employeeId);
            where = `(${scope} OR l.employee_id = $${params.length})`;
          }
          if (q.status) {
            params.push(q.status);
            where += ` AND l.status = $${params.length}`;
          }
          const rows = await tx.query<{ id: string; employee_id: string; display_name: string | null; key: string; category: string; start_date: string; end_date: string; amount_days: string; status: string; note: string | null }>(
            `SELECT l.*, e.display_name, t.key, t.category FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
               JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id WHERE ${where} ORDER BY l.start_date DESC LIMIT 500`,
            params,
          );
          return rows.map((r) => {
            const hide = SENSITIVE_CATEGORIES.has(r.category) && r.employee_id !== auth.principal.employeeId && !canSome(auth.principal, 'absence.read');
            return { id: r.id, employeeId: r.employee_id, employeeName: r.display_name, leaveType: hide ? 'away' : r.key, startDate: r.start_date, endDate: r.end_date, amountDays: Number(r.amount_days), status: r.status, note: hide ? null : r.note };
          });
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/leave/requests/:id/cancel',
    { config: { selfAudited: true }, schema: { tags: ['leave'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 409: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<{ employee_id: string; status: string; start_date: string; approval_request_id: string | null }>('SELECT * FROM app.leave_requests WHERE id = $1 FOR UPDATE', [id]);
        if (!r) throw new ApiError('notFound');
        const own = r.employee_id === auth.principal.employeeId;
        if (!own && !can(auth.principal, 'leave.record', await loadTarget(tx, r.employee_id))) throw new ApiError('forbidden');
        if (!['pending', 'approved'].includes(r.status)) throw new ApiError('conflict');
        if (own && r.status === 'approved' && compareDates(r.start_date, today('UTC')) <= 0) throw new ApiError('conflict', 'Leave already started — ask HR to change it');
        await tx.exec(`UPDATE app.leave_requests SET status = 'cancelled', decided_at = now() WHERE id = $1`, [id]);
        if (r.approval_request_id) {
          await tx.exec(`UPDATE app.approval_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`, [r.approval_request_id]);
          await tx.exec(`UPDATE app.tasks SET status = 'cancelled' WHERE source = 'approval' AND source_id = $1 AND status = 'open'`, [r.approval_request_id]);
        }
        await app.audit(tx, req, { action: 'leave.cancelled', targetType: 'leave_request', targetId: id });
        return { id, status: 'cancelled' };
      });
    },
  );

  // ---- calendar and ICS feeds ---------------------------------------------------------------------------
  app.get(
    '/v1/leave/calendar',
    { schema: { tags: ['leave'], querystring: Type.Object({ from: CivilDate, to: CivilDate }), response: { 200: Type.Object({ entries: Type.Array(Type.Object({ employeeId: Uuid, name: Type.String(), start: Type.String(), end: Type.String(), kind: Type.String(), status: Type.String() })), holidays: Type.Array(Type.Object({ date: Type.String(), name: Type.String() })) }) } } },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { from: string; to: string };
      if (compareDates(q.to, addDays(q.from, 92)) > 0) throw new ApiError('validation', 'At most 3 months');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          const scope = scopePredicate(auth.principal, 'leave.read', params);
          params.push(auth.principal.employeeId, q.from, q.to);
          const n = params.length;
          const rows = await tx.query<{ employee_id: string; display_name: string; start_date: string; end_date: string; key: string; category: string; status: string }>(
            `SELECT l.employee_id, e.display_name, l.start_date, l.end_date, t.key, t.category, l.status FROM app.leave_requests l
               JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id
              WHERE l.status IN ('approved', 'pending') AND l.start_date <= $${n} AND l.end_date >= $${n - 1}
                AND (${scope} OR l.employee_id = $${n - 2} OR e.manager_id = $${n - 2}) ORDER BY l.start_date LIMIT 5000`,
            params,
          );
          const absence = canSome(auth.principal, 'absence.read');
          const holidays = auth.principal.employeeId ? await holidaysFor(tx, book, await leaveContext(tx, auth.principal.employeeId, q.from), q.from, q.to) : [];
          const names = new Map<string, string>();
          if (auth.principal.employeeId) {
            const ctx = await leaveContext(tx, auth.principal.employeeId, q.from);
            for (let y = dateParts(q.from).year; y <= dateParts(q.to).year; y++) for (const h of book.holidays(ctx.country ?? 'GB', y, ctx.region ?? undefined)) names.set(h.observed ?? h.date, h.name);
          }
          return {
            entries: rows.map((r) => ({ employeeId: r.employee_id, name: r.display_name, start: r.start_date, end: r.end_date, kind: SENSITIVE_CATEGORIES.has(r.category) && !absence && r.employee_id !== auth.principal.employeeId ? 'away' : r.key, status: r.status })),
            holidays: holidays.map((d) => ({ date: d, name: names.get(d) ?? '' })),
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/leave/ics-tokens',
    { config: { selfAudited: true }, schema: { tags: ['leave'], body: Type.Object({ scope: Type.Union([Type.Literal('me'), Type.Literal('team')]) }), response: { 201: Type.Object({ id: Uuid, url: Type.String() }) } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const scope = (req.body as { scope: 'me' | 'team' }).scope;
      const secret = newToken();
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.ics_tokens (tenant_id, user_id, scope, token_hash) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`, [auth.userId, scope, hashToken(secret)]);
        await app.audit(tx, req, { action: 'ics.token_created', targetType: 'ics_token', targetId: r.id, diff: { scope } });
        return r;
      });
      return reply.status(201).send({ id: row.id, url: `${deps.config.apiBaseUrl}/v1/ics/${composeToken(ICS_PREFIX, auth.tenantId, secret)}.ics` });
    },
  );

  app.delete('/v1/leave/ics-tokens/:id', { config: { selfAudited: true }, schema: { tags: ['leave'], params: Type.Object({ id: Uuid }), response: { 204: Type.Null() } } }, async (req, reply) => {
    const auth = requireAuth(req);
    await app.tenantTx(req, async (tx) => {
      await tx.exec('UPDATE app.ics_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2', [(req.params as { id: string }).id, auth.userId]);
      await app.audit(tx, req, { action: 'ics.token_revoked', targetType: 'ics_token', targetId: (req.params as { id: string }).id });
    });
    return reply.status(204).send(null);
  });

  /** Public, token-authenticated calendar feed. Never contains leave types, notes or sensitive detail. */
  app.get('/v1/ics/:token', { config: { auth: 'public' }, schema: { hide: true, params: Type.Object({ token: Type.String({ maxLength: 200 }) }) } }, async (req, reply) => {
    const parsed = parseToken(ICS_PREFIX, (req.params as { token: string }).token.replace(/\.ics$/, ''));
    if (!parsed) throw new ApiError('notFound');
    const events = await withTenant(deps.router, parsed.tenantId, async (tx) => {
      const tok = await tx.maybe<{ user_id: string; scope: string }>('SELECT user_id, scope FROM app.ics_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(parsed.secret)]);
      if (!tok) throw new ApiError('notFound');
      const user = await tx.one<{ employee_id: string | null }>('SELECT employee_id FROM app.users WHERE id = $1', [tok.user_id]);
      if (!user.employee_id) return [];
      return tx.query<{ id: string; display_name: string; start_date: string; end_date: string }>(
        `SELECT l.id, e.display_name, l.start_date, l.end_date FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
          WHERE l.status = 'approved' AND l.end_date >= current_date - 90 AND (l.employee_id = $1 OR ($2 = 'team' AND e.manager_id = $1)) ORDER BY l.start_date LIMIT 1000`,
        [user.employee_id, tok.scope],
      );
    });
    const fmt = (d: string) => d.replace(/-/g, '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Thapsus//Thapsus-HR//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Time off'];
    for (const e of events) lines.push('BEGIN:VEVENT', `UID:${e.id}@thapsus-hr`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${fmt(e.start_date)}`, `DTEND;VALUE=DATE:${fmt(addDays(e.end_date, 1))}`, `SUMMARY:${e.display_name.replace(/[,;\\]/g, ' ')} – out of office`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    lines.push('END:VCALENDAR');
    return reply.type('text/calendar; charset=utf-8').send(lines.join('\r\n'));
  });

  // ---- sickness ----------------------------------------------------------------------------------------
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.post(
    '/v1/sickness',
    { config: { selfAudited: true }, schema: { tags: ['absence'], body: Type.Object({ employeeId: Type.Optional(Uuid), startDate: CivilDate, endDate: Type.Optional(Nullable(CivilDate)), reason: Type.Optional(Type.String({ maxLength: 500 })) }), response: { 201: Type.Object({ id: Uuid, rtwStatus: Type.String(), fitNoteRequired: Type.Boolean() }), 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId?: string; startDate: string; endDate?: string | null; reason?: string };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation');
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, employeeId);
        const own = auth.principal.employeeId === employeeId;
        if (!own && !can(auth.principal, 'absence.record', target)) throw new ApiError('forbidden');
        await ensureLeaveDefaults(tx, book);
        const type = await tx.one<{ id: string }>(`SELECT id FROM app.leave_types WHERE key = 'sickness'`);
        const end = b.endDate ?? b.startDate;
        const amount = await amountFor(tx, book, employeeId, b.startDate, end);
        const lr = await tx.one<{ id: string }>(
          `INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, amount_days, amount_hours, status, requested_by, decided_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 'approved', $7, now()) RETURNING id`,
          [employeeId, type.id, b.startDate, end, amount.days, amount.hours, auth.userId],
        );
        // Fit-note threshold is a tenant absence setting (company policy), not hard-coded law.
        const settings = await tx.one<{ absence: { fitNoteAfterCalendarDays?: number } | null }>("SELECT features->'absence' AS absence FROM app.tenants");
        const fitNoteAfter = settings.absence?.fitNoteAfterCalendarDays;
        const fitNoteRequired = !!(b.endDate && fitNoteAfter !== undefined && daysBetween(b.startDate, b.endDate) + 1 > fitNoteAfter);
        const rec = await tx.one<{ id: string }>(
          `INSERT INTO app.sickness_records (tenant_id, employee_id, start_date, end_date, leave_request_id, fit_note_required, rtw_status, recorded_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [employeeId, b.startDate, b.endDate ?? null, lr.id, fitNoteRequired, b.endDate ? 'due' : 'not_required', auth.userId],
        );
        if (b.reason) {
          const vid = await vault.put(tx, { principal: own ? { ...auth.principal, grants: [...auth.principal.grants, { roleKey: 'self-disclosure', isAdmin: false, permissions: ['vault.write:sickness'], fieldAccess: {}, scope: { type: 'self' } }] } : auth.principal, actorType: 'user', requestId: req.id, ip: req.ctx.ip }, auth.tenantId, target, 'sickness', `reason:${rec.id}`, b.reason);
          await tx.exec('UPDATE app.sickness_records SET reason_vault_id = $2 WHERE id = $1', [rec.id, vid]);
        }
        const manager = await userForEmployee(tx, (await tx.maybe<{ manager_id: string | null }>('SELECT manager_id FROM app.employees WHERE id = $1', [employeeId]))?.manager_id);
        if (manager && b.endDate) await createTask(tx, { source: 'manual', title: 'Return-to-work conversation', subjectEmployeeId: employeeId, assigneeUserId: manager, dueOn: addDays(b.endDate, 2), link: '/app/absence', dedupeKey: `rtw:${rec.id}` });
        await app.audit(tx, req, { action: 'sickness.recorded', targetType: 'sickness_record', targetId: rec.id, diff: { employeeId, start: b.startDate, end: b.endDate ?? null }, sensitive: true });
        return { id: rec.id, rtwStatus: b.endDate ? 'due' : 'not_required', fitNoteRequired };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/sickness/:id/fit-note',
    { config: { selfAudited: true }, schema: { tags: ['absence'], consumes: ['multipart/form-data'], params: Type.Object({ id: Uuid }), response: { 201: Type.Object({ vaultId: Uuid }), 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const file = await req.file();
      if (!file || !['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) throw new ApiError('validation', 'Upload a PDF or image');
      const buf = await file.toBuffer();
      const out = await app.tenantTx(req, async (tx) => {
        const rec = await tx.maybe<{ employee_id: string }>('SELECT employee_id FROM app.sickness_records WHERE id = $1', [id]);
        if (!rec) throw new ApiError('notFound');
        const target = await loadTarget(tx, rec.employee_id);
        const own = rec.employee_id === auth.principal.employeeId;
        const principal = own ? { ...auth.principal, grants: [...auth.principal.grants, { roleKey: 'self-disclosure', isAdmin: false, permissions: ['vault.write:sickness'], fieldAccess: {}, scope: { type: 'self' as const } }] } : auth.principal;
        // The file is stored in the home-region bucket under a vault key; access only via the vault (audited).
        const key = objectKey(auth.tenantId, `vault/sickness/${rec.employee_id}`, file.mimetype === 'application/pdf' ? '.pdf' : '.img');
        await deps.objects.put(key, buf, file.mimetype);
        const vid = await vault.put(tx, { principal, actorType: 'user', requestId: req.id, ip: req.ctx.ip }, auth.tenantId, target, 'sickness', `fit_note:${id}`, file.filename, key);
        await tx.exec('UPDATE app.sickness_records SET fit_note_vault_id = $2 WHERE id = $1', [id, vid]);
        req.auditWritten = true;
        return { vaultId: vid };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/sickness/:id/return-to-work',
    { config: { selfAudited: true }, schema: { tags: ['absence'], params: Type.Object({ id: Uuid }), body: Type.Object({ answers: Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 2000 })), fitForWork: Type.Boolean(), adjustments: Type.Optional(Type.String({ maxLength: 2000 })) }), response: { 200: Type.Object({ id: Uuid, rtwStatus: Type.String() }), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { answers: Record<string, string>; fitForWork: boolean; adjustments?: string };
      return app.tenantTx(req, async (tx) => {
        const rec = await tx.maybe<{ employee_id: string }>('SELECT employee_id FROM app.sickness_records WHERE id = $1', [id]);
        if (!rec) throw new ApiError('notFound');
        const target = await loadTarget(tx, rec.employee_id);
        if (!can(auth.principal, 'absence.record', target)) throw new ApiError('forbidden');
        // Managers record the conversation without being able to read medical detail afterwards.
        const writer = { ...auth.principal, grants: [...auth.principal.grants, { roleKey: 'rtw-writer', isAdmin: false, permissions: ['vault.write:sickness'], fieldAccess: {}, scope: { type: 'all' as const } }] };
        const vid = await vault.put(tx, { principal: writer, actorType: 'user', requestId: req.id, ip: req.ctx.ip }, auth.tenantId, target, 'sickness', `rtw:${id}`, JSON.stringify(b));
        await tx.exec(`UPDATE app.sickness_records SET rtw_status = 'completed', rtw_vault_id = $2 WHERE id = $1`, [id, vid]);
        await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE dedupe_key = $1`, [`rtw:${id}`, auth.userId]);
        req.auditWritten = true;
        return { id, rtwStatus: 'completed' };
      });
    },
  );

  app.get(
    '/v1/sickness/:employeeId/statutory-pay',
    { schema: { tags: ['absence'], params: Type.Object({ employeeId: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate), normalWeeklyEarningsMinor: Type.Optional(Type.Integer({ minimum: 0 })) }), response: { 200: Type.Object({ jurisdiction: Nullable(Type.String()), scheme: Type.String(), result: Type.Any(), source: Nullable(Type.Object({ url: Type.String(), title: Type.String() })) }), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const q = req.query as { asOf?: string; normalWeeklyEarningsMinor?: number };
      const asOf = q.asOf ?? today('UTC');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, employeeId);
          if (!can(auth.principal, 'absence.read', target) && !can(auth.principal, 'payroll.read', target)) throw new ApiError('forbidden');
          const ctx = await leaveContext(tx, employeeId, asOf);
          const spells = await tx.query<{ start_date: string; end_date: string | null }>(`SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1 AND start_date >= ($2::date - 365) ORDER BY start_date`, [employeeId, asOf]);
          const pay = await tx.maybe<{ amount_minor: string; frequency: string }>(`SELECT amount_minor, frequency FROM app.employee_pay WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`, [employeeId, asOf]);
          const weeklyHours = Object.values(ctx.pattern).reduce((s, h) => s + h, 0);
          const weekly = q.normalWeeklyEarningsMinor ?? (pay ? Math.round(pay.frequency === 'annual' ? Number(pay.amount_minor) / 52 : pay.frequency === 'monthly' ? (Number(pay.amount_minor) * 12) / 52 : pay.frequency === 'hourly' ? Number(pay.amount_minor) * weeklyHours : Number(pay.amount_minor)) : 0);
          const country = ctx.country;
          if (country === 'GB') {
            const r = book.resolve<UkSspRule>('GB', 'sick_pay.statutory', asOf);
            return { jurisdiction: 'GB', scheme: 'uk_ssp', result: ukSsp({ rule: r.value, normalWeeklyEarningsMinor: weekly, pattern: ctx.pattern, spells: spells.map((s) => ({ start: s.start_date, end: s.end_date ?? asOf })) }), source: r.source };
          }
          if (country && ctx.country !== 'US') {
            const r = book.tryResolve<Record<string, unknown>>(country, 'sick_pay.statutory', asOf);
            if (!r) return { jurisdiction: country, scheme: 'not_modelled', result: null, source: null };
            const last = spells.at(-1);
            const result = last ? employerContinuedPay(r.value as never, { startDate: ctx.startDate, sickStart: last.start_date, sickEnd: last.end_date ?? asOf, dailyPayMinor: Math.round(weekly / 5), workingDays: requestAmount({ start: last.start_date, end: last.end_date ?? asOf, pattern: ctx.pattern, holidays: [] }).days }) : null;
            return { jurisdiction: r.jurisdiction, scheme: 'employer_continued_pay', result, source: r.source };
          }
          const region = ctx.region ?? 'US';
          const r = book.tryResolve<Record<string, unknown>>(region, 'sick_pay.paid_sick_leave_accrual', asOf);
          if (!r) return { jurisdiction: region, scheme: 'not_modelled', result: null, source: null };
          const weeksEmployed = Math.max(0, Math.min(52, Math.floor((Number(new Date(asOf)) - Number(new Date(ctx.startDate))) / (7 * 86_400_000))));
          const headcount = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees WHERE status = 'active'`)).n;
          return { jurisdiction: r.jurisdiction, scheme: 'us_paid_sick_leave', result: usSickAccrual(r.value as never, { hoursWorked: weeksEmployed * weeklyHours, hoursPerDay: weeklyHours / 5, employerSize: headcount }), source: r.source };
        },
        { readOnly: true },
      );
    },
  );

  // ---- FMLA ------------------------------------------------------------------------------------------
  app.post(
    '/v1/fmla/cases',
    { config: { selfAudited: true }, schema: { tags: ['absence'], body: Type.Object({ employeeId: Uuid, reason: Type.Union(['own_health', 'family_care', 'birth_bonding', 'placement', 'military_exigency', 'military_caregiver'].map((r) => Type.Literal(r))), leaveYearMethod: Type.Union(['calendar_year', 'fixed_12_month_period', 'forward_from_first_leave_date', 'rolling_backward'].map((m) => Type.Literal(m))), startDate: CivilDate, intermittent: Type.Optional(Type.Boolean()), hoursPrior12Months: Type.Optional(Type.Number({ minimum: 0 })) }), response: { 201: Type.Object({ id: Uuid, eligible: Type.Boolean(), failed: Type.Array(Type.String()), entitlementHours: Type.Number() }), 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId: string; reason: string; leaveYearMethod: string; startDate: string; intermittent?: boolean; hoursPrior12Months?: number };
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, b.employeeId);
        if (!can(auth.principal, 'absence.record', target)) throw new ApiError('forbidden');
        const rule = book.resolve<Parameters<typeof fmlaEligibility>[0] & { entitlementWorkweeks: number; militaryCaregiverWorkweeks: number }>('US', 'family_leave.fmla', b.startDate);
        const ctx = await leaveContext(tx, b.employeeId, b.startDate);
        const weeklyHours = Object.values(ctx.pattern).reduce((s, h) => s + h, 0);
        const serviceMonths = Math.floor((Number(new Date(b.startDate)) - Number(new Date(ctx.startDate))) / (30.4375 * 86_400_000));
        const employerEmployees = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees WHERE status = 'active' AND country = 'US'`)).n;
        // worksite count: employees at locations within 75 miles of the employee's location (geofence coordinates), else same location
        const here = ctx.locationId ? await tx.maybe<{ geofence: { lat: number; lng: number } | null }>('SELECT geofence FROM app.locations WHERE id = $1', [ctx.locationId]) : undefined;
        let within = 0;
        const locs = await tx.query<{ id: string; geofence: { lat: number; lng: number } | null; n: number }>(`SELECT l.id, l.geofence, (SELECT count(*)::int FROM app.employees e WHERE e.location_id = l.id AND e.status = 'active') AS n FROM app.locations l`);
        for (const l of locs) if (l.id === ctx.locationId || (here?.geofence && l.geofence && milesBetween(here.geofence, l.geofence) <= ((rule.value.eligibility as { radiusMiles?: number }).radiusMiles ?? 0))) within += l.n;
        const hours = b.hoursPrior12Months ?? weeklyHours * 52;
        const elig = fmlaEligibility(rule.value, { serviceMonths, hoursPrior12Months: hours, employeesWithin75Miles: within, employerEmployees });
        const weeks = b.reason === 'military_caregiver' ? rule.value.militaryCaregiverWorkweeks : rule.value.entitlementWorkweeks;
        const entitlementHours = weeks * weeklyHours;
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.fmla_cases (tenant_id, employee_id, reason, leave_year_method, start_date, intermittent, entitlement_hours, eligibility, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [b.employeeId, b.reason, b.leaveYearMethod, b.startDate, b.intermittent ?? false, entitlementHours, JSON.stringify({ ...elig, serviceMonths, hours, within, employerEmployees, source: rule.source }), auth.userId],
        );
        await app.audit(tx, req, { action: 'fmla.case_opened', targetType: 'fmla_case', targetId: r.id, diff: { eligible: elig.eligible }, sensitive: true });
        return { id: r.id, eligible: elig.eligible, failed: elig.failed, entitlementHours };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/fmla/cases/:id',
    { schema: { tags: ['absence'], params: Type.Object({ id: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Object({ id: Uuid, eligible: Type.Boolean(), entitlementHours: Type.Number(), usedHours: Type.Number(), remainingHours: Type.Number(), leaveYear: Type.Array(Type.String()) }), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today('UTC');
      return app.tenantTx(
        req,
        async (tx) => {
          const c = await tx.maybe<{ employee_id: string; leave_year_method: string; start_date: string; entitlement_hours: string; eligibility: { eligible: boolean } }>('SELECT * FROM app.fmla_cases WHERE id = $1', [id]);
          if (!c) throw new ApiError('notFound');
          if (!can(auth.principal, 'absence.read', await loadTarget(tx, c.employee_id))) throw new ApiError('forbidden');
          const first = (await tx.maybe<{ d: string }>(`SELECT min(start_date)::text AS d FROM app.leave_requests WHERE fmla_case_id = $1 AND status = 'approved'`, [id]))?.d ?? c.start_date;
          // leave-year methods (29 CFR 825.200)
          const { year } = dateParts(asOf);
          const window: [string, string] =
            c.leave_year_method === 'calendar_year'
              ? [`${year}-01-01`, `${year + 1}-01-01`]
              : c.leave_year_method === 'fixed_12_month_period'
                ? [c.start_date, addDays(c.start_date, 365)]
                : c.leave_year_method === 'forward_from_first_leave_date'
                  ? [first, addDays(first, 365)]
                  : [addDays(asOf, -365), addDays(asOf, 1)];
          const used = (await tx.one<{ h: string | null }>(`SELECT sum(amount_hours) AS h FROM app.leave_requests WHERE fmla_case_id = $1 AND status = 'approved' AND start_date >= $2 AND start_date < $3`, [id, window[0], window[1]])).h;
          const usedHours = Number(used ?? 0);
          return { id, eligible: c.eligibility.eligible, entitlementHours: Number(c.entitlement_hours), usedHours, remainingHours: Math.max(0, Number(c.entitlement_hours) - usedHours), leaveYear: window };
        },
        { readOnly: true },
      );
    },
  );

  // ---- analytics, triggers, cover ---------------------------------------------------------------------
  app.get(
    '/v1/absence/bradford/:employeeId',
    { schema: { tags: ['absence'], params: Type.Object({ employeeId: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Object({ spells: Type.Integer(), days: Type.Number(), score: Type.Number() }), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today('UTC');
      return app.tenantTx(
        req,
        async (tx) => {
          if (!can(auth.principal, 'absence.read', await loadTarget(tx, employeeId))) throw new ApiError('forbidden');
          const ctx = await leaveContext(tx, employeeId, asOf);
          const spells = await tx.query<{ start_date: string; end_date: string | null }>(`SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1`, [employeeId]);
          return bradfordFactor(spells.map((s) => ({ start: s.start_date, end: s.end_date ?? asOf })), asOf, ctx.pattern);
        },
        { readOnly: true },
      );
    },
  );

  app.post('/v1/absence/triggers', { config: { selfAudited: true }, schema: { tags: ['absence'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), bradfordThreshold: Type.Optional(Type.Integer({ minimum: 1 })), spellsThreshold: Type.Optional(Type.Integer({ minimum: 1 })), windowDays: Type.Optional(Type.Integer({ minimum: 7, maximum: 730 })) }), response: { 201: Type.Object({ id: Uuid }) } } }, async (req, reply) => {
    authorize(req, 'absence.manage');
    const b = req.body as { name: string; bradfordThreshold?: number; spellsThreshold?: number; windowDays?: number };
    const r = await app.tenantTx(req, async (tx) => {
      const row = await tx.one<{ id: string }>(`INSERT INTO app.absence_triggers (tenant_id, name, bradford_threshold, spells_threshold, window_days) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`, [b.name, b.bradfordThreshold ?? null, b.spellsThreshold ?? null, b.windowDays ?? 365]);
      await app.audit(tx, req, { action: 'absence_trigger.created', targetType: 'absence_trigger', targetId: row.id, diff: b });
      return row;
    });
    return reply.status(201).send(r);
  });

  app.post('/v1/leave/cover-rules', { config: { selfAudited: true }, schema: { tags: ['leave'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), departmentId: Type.Optional(Nullable(Uuid)), locationId: Type.Optional(Nullable(Uuid)), minPresent: Type.Integer({ minimum: 0 }), enforcement: Type.Union([Type.Literal('warn'), Type.Literal('block')]) }), response: { 201: Type.Object({ id: Uuid }) } } }, async (req, reply) => {
    authorize(req, 'leave.manage');
    const b = req.body as { name: string; departmentId?: string | null; locationId?: string | null; minPresent: number; enforcement: string };
    const r = await app.tenantTx(req, async (tx) => {
      const row = await tx.one<{ id: string }>(`INSERT INTO app.cover_rules (tenant_id, name, department_id, location_id, min_present, enforcement) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [b.name, b.departmentId ?? null, b.locationId ?? null, b.minPresent, b.enforcement]);
      await app.audit(tx, req, { action: 'cover_rule.created', targetType: 'cover_rule', targetId: row.id, diff: b });
      return row;
    });
    return reply.status(201).send(r);
  });

  app.post('/v1/settings/company-calendars', { config: { selfAudited: true }, schema: { tags: ['leave'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), entityId: Type.Optional(Nullable(Uuid)), locationId: Type.Optional(Nullable(Uuid)), days: Type.Array(Type.Object({ date: CivilDate, name: Type.String({ maxLength: 120 }) }), { maxItems: 366 }) }), response: { 201: Type.Object({ id: Uuid }) } } }, async (req, reply) => {
    authorize(req, 'leave.manage');
    const b = req.body as { name: string; entityId?: string | null; locationId?: string | null; days: unknown[] };
    const r = await app.tenantTx(req, async (tx) => {
      const row = await tx.one<{ id: string }>(`INSERT INTO app.company_calendars (tenant_id, name, entity_id, location_id, days) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`, [b.name, b.entityId ?? null, b.locationId ?? null, JSON.stringify(b.days)]);
      await app.audit(tx, req, { action: 'company_calendar.created', targetType: 'company_calendar', targetId: row.id });
      return row;
    });
    return reply.status(201).send(r);
  });
}

// ---- approval effects ------------------------------------------------------------------------------------
approvalHandlers['leave.request'] = async (tx, r) => {
  await tx.exec(`UPDATE app.leave_requests SET status = 'approved', decided_at = now() WHERE id = $1 AND status = 'pending'`, [r.payload.leaveRequestId]);
  const user = await userForEmployee(tx, r.subject_employee_id);
  if (user) await notify(tx, { userIds: [user], kind: 'leave.approved', titleKey: 'notify.leaveApproved', link: '/app/time-off', dedupeKey: `leave-ok:${r.payload.leaveRequestId}` });
};
rejectionHandlers['leave.request'] = async (tx, r) => {
  await tx.exec(`UPDATE app.leave_requests SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'`, [r.payload.leaveRequestId]);
  const user = await userForEmployee(tx, r.subject_employee_id);
  if (user) await notify(tx, { userIds: [user], kind: 'leave.rejected', titleKey: 'notify.leaveRejected', link: '/app/time-off', dedupeKey: `leave-no:${r.payload.leaveRequestId}` });
};

// ---- absence trigger alerts (daily, deduplicated per employee per window) ---------------------------------
registerJob('absence.triggers', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    const triggers = await tx.query<{ id: string; name: string; bradford_threshold: number | null; spells_threshold: number | null; window_days: number; notify_role: string; notify_manager: boolean }>('SELECT * FROM app.absence_triggers');
    if (!triggers.length) return { alerts: 0 };
    let alerts = 0;
    const emps = await tx.query<{ employee_id: string }>(`SELECT DISTINCT employee_id FROM app.sickness_records WHERE start_date >= ($1::date - 730)`, [date]);
    for (const { employee_id } of emps) {
      const spells = await tx.query<{ start_date: string; end_date: string | null }>('SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1', [employee_id]);
      const lc = await leaveContext(tx, employee_id, date);
      for (const t of triggers) {
        const bf = bradfordFactor(spells.map((s) => ({ start: s.start_date, end: s.end_date ?? date })).filter((s) => s.end >= addDays(date, -t.window_days)), date, lc.pattern);
        const hit = (t.bradford_threshold !== null && bf.score >= t.bradford_threshold) || (t.spells_threshold !== null && bf.spells >= t.spells_threshold);
        if (!hit) continue;
        const recipients = [...(await usersWithRole(tx, t.notify_role))];
        // Small companies often have no HR admin: the owner handles HR, so the alert goes to them.
        if (!recipients.length) recipients.push(...(await usersWithRole(tx, 'owner')));
        if (t.notify_manager) {
          const m = await userForEmployee(tx, (await tx.maybe<{ manager_id: string | null }>('SELECT manager_id FROM app.employees WHERE id = $1', [employee_id]))?.manager_id);
          if (m) recipients.push(m);
        }
        alerts += (await notify(tx, { userIds: [...new Set(recipients)], kind: 'absence.trigger', titleKey: 'notify.absenceTrigger', params: { trigger: t.name, score: bf.score }, link: `/app/people/${employee_id}`, dedupeKey: `trigger:${t.id}:${employee_id}:${bf.spells}` })).length;
        await writeAudit(tx, { actorType: 'system', action: 'absence.trigger_fired', targetType: 'employee', targetId: employee_id, diff: { trigger: t.id, score: bf.score, spells: bf.spells }, sensitive: true });
      }
    }
    return { alerts };
  });
});
periodic.push(async (tx, now) => {
  const date = now.toISOString().slice(0, 10);
  await enqueueJob(tx, 'absence.triggers', date, { date });
});
