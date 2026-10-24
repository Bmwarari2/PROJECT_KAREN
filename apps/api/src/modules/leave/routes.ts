import type { FastifyInstance } from 'fastify';
import { matchesMagic } from '../../lib/file-types';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { personHref } from '@thapsus/core/links';
import {
  addDays,
  addMonths,
  compareDates,
  dateParts,
  daysBetween,
  maxDate,
  minDate,
  monthsBetween,
  today,
} from '@thapsus/core/time';
import { enqueueJob, withTenant, writeAudit, type Tx } from '@thapsus/db';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { completeTasksFor } from '../tasks/completion';
import { createReturnToWorkTask } from './rtw-task';
import { objectKey } from '../../lib/object-store';
import { periodic, registerJob } from '../../jobs/registry';
import { composeToken, hashToken, newToken, parseToken } from '../auth/tokens';
import { loadTarget, scopePredicate } from '../employees/service';
import { approvalHandlers, rejectionHandlers, requestApproval } from '../approvals/service';
import { ruleBook } from '../rules/routes';
import { Vault } from '../vault/service';
import {
  averageDayHours,
  bradfordFactor,
  employerContinuedPay,
  familyLeaveInfo,
  fmlaEligibility,
  fmlaEmployerCoverage,
  milesBetween,
  requestAmount,
  ukSsp,
  usSickAccrual,
  weeklyHoursOf,
  type FamilyLeaveRule,
  type FmlaRule,
  type LeavePolicy,
  type UkSspRule,
  type UsSickRule,
} from './engine';
import {
  absenceSettings,
  amountFor,
  balanceFor,
  coverProblems,
  ensureLeaveDefaults,
  ensureLeaveType,
  fmlaMethod,
  fmlaStatus,
  holidaysFor,
  hoursWorked,
  leaveContext,
  usWeeklyHeadcounts,
  type AbsenceSettings,
  type FmlaCaseRow,
} from './service';

const ICS_PREFIX = 'ics_';
const Balance = Type.Object({
  leaveType: Type.String(),
  policy: Type.String(),
  unit: Type.Union([Type.Literal('days'), Type.Literal('hours')]),
  year: Type.Array(Type.String()),
  entitlement: Type.Number(),
  accrued: Type.Number(),
  carriedOver: Type.Number(),
  carryOverExpired: Type.Number(),
  adjustments: Type.Number(),
  publicHolidays: Type.Number(),
  taken: Type.Number(),
  booked: Type.Number(),
  pending: Type.Number(),
  available: Type.Number(),
  inWaitingPeriod: Type.Boolean(),
});
const LeaveRequest = Type.Object({
  id: Uuid,
  employeeId: Uuid,
  employeeName: Nullable(Type.String()),
  leaveType: Type.String(),
  startDate: Type.String(),
  endDate: Type.String(),
  amountDays: Type.Number(),
  amountHours: Type.Number(),
  status: Type.String(),
  note: Nullable(Type.String()),
});
const MonthDay = Type.String({ pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' });

/** Leave types whose detail must not be shown to colleagues or in calendar feeds. */
const SENSITIVE_CATEGORIES = new Set(['sickness', 'family', 'fmla']);

export async function leaveRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);

  async function canActOn(tx: Tx, auth: ReturnType<typeof requireAuth>, employeeId: string, action: string) {
    if (auth.principal.employeeId === employeeId)
      return can(auth.principal, action === 'leave.read' ? 'self.read' : 'leave.request', { employeeId });
    return can(auth.principal, action, await loadTarget(tx, employeeId));
  }

  // ---- types and policies ----------------------------------------------------------------------------
  app.get(
    '/v1/leave/types',
    {
      schema: {
        tags: ['leave'],
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              key: Type.String(),
              name: Type.Record(Type.String(), Type.String()),
              category: Type.String(),
              paid: Type.Boolean(),
              requiresApproval: Type.Boolean(),
              deductsBalance: Type.Boolean(),
            }),
          ),
        },
      },
    },
    async (req) => {
      requireAuth(req);
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        await ensureLeaveDefaults(tx, book);
        return (
          await tx.query<{
            id: string;
            key: string;
            name: Record<string, string>;
            category: string;
            paid: boolean;
            requires_approval: boolean;
            deducts_balance: boolean;
          }>('SELECT * FROM app.leave_types WHERE active ORDER BY key')
        ).map((t) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          category: t.category,
          paid: t.paid,
          requiresApproval: t.requires_approval,
          deductsBalance: t.deducts_balance,
        }));
      });
    },
  );

  const PolicyConfig = Type.Object({
    accrual: Type.Union([
      Type.Object({
        method: Type.Union([Type.Literal('annual_upfront'), Type.Literal('monthly')]),
        days: Type.Number({ minimum: 0, maximum: 366 }),
      }),
      Type.Object({
        method: Type.Literal('per_hour_worked'),
        percent: Type.Number({ minimum: 0, maximum: 100 }),
      }),
    ]),
    unit: Type.Union([Type.Literal('days'), Type.Literal('hours')]),
    yearStart: MonthDay,
    proRata: Type.Boolean(),
    includesPublicHolidays: Type.Boolean(),
    waitingDays: Type.Integer({ minimum: 0, maximum: 365 }),
    carryOver: Type.Optional(
      Type.Object({
        maxDays: Type.Number({ minimum: 0 }),
        expiresAfterMonths: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
      }),
    ),
    capDays: Type.Optional(Type.Number({ minimum: 0 })),
    allowNegativeDays: Type.Number({ minimum: 0, maximum: 30 }),
    rounding: Type.Union(
      ['none', 'up_half_day', 'nearest_half_day', 'up_whole_day'].map((r) => Type.Literal(r)),
    ),
  });

  app.post(
    '/v1/leave/policies',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          leaveTypeId: Uuid,
          entityId: Type.Optional(Nullable(Uuid)),
          country: Type.Optional(Nullable(Type.String({ pattern: '^[A-Z]{2}$' }))),
          config: PolicyConfig,
          effectiveFrom: Type.Optional(CivilDate),
        }),
        response: { 201: Type.Object({ id: Uuid, warnings: Type.Array(Type.String()) }), 403: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'leave.manage');
      const b = req.body as {
        name: string;
        leaveTypeId: string;
        entityId?: string | null;
        country?: string | null;
        config: LeavePolicy;
        effectiveFrom?: string;
      };
      // Compliance check against the jurisdiction pack's statutory minimum (warn; customers may offer more).
      const warnings: string[] = [];
      const book = await ruleBook(app);
      const country = b.country ?? null;
      if (country && b.config.accrual.method !== 'per_hour_worked') {
        const r = book.tryResolve<{
          capDays?: number;
          weeks?: number;
          days?: number;
          fiveDayWeekEquivalentDays?: number;
        }>(
          country === 'GB' ? 'GB' : country,
          'leave.statutory_annual_minimum',
          b.effectiveFrom ?? today('UTC'),
        );
        const minDays =
          r?.value.capDays ??
          r?.value.fiveDayWeekEquivalentDays ??
          (r?.value.weeks ? r.value.weeks * 5 : undefined);
        if (minDays !== undefined && b.config.accrual.days < minDays)
          warnings.push(`belowStatutoryMinimum:${minDays}`);
      }
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, entity_id, country, config, effective_from) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, coalesce($6::date, '2000-01-01')) RETURNING id`,
          [
            b.name,
            b.leaveTypeId,
            b.entityId ?? null,
            country,
            JSON.stringify(b.config),
            b.effectiveFrom ?? null,
          ],
        );
        await app.audit(tx, req, {
          action: 'leave_policy.created',
          targetType: 'leave_policy',
          targetId: r.id,
          diff: { name: b.name, warnings },
        });
        return r;
      });
      return reply.status(201).send({ id: row.id, warnings });
    },
  );

  const PolicyOut = Type.Object({
    id: Uuid,
    name: Type.String(),
    leaveTypeId: Uuid,
    leaveTypeKey: Type.String(),
    entityId: Nullable(Uuid),
    entityName: Nullable(Type.String()),
    country: Nullable(Type.String()),
    config: PolicyConfig,
    effectiveFrom: Type.String(),
    effectiveTo: Nullable(Type.String()),
    assignedEmployees: Type.Integer(),
  });
  app.get(
    '/v1/leave/policies',
    {
      schema: {
        tags: ['leave'],
        summary: 'Leave policies with the number of employees currently assigned to each',
        response: { 200: Type.Array(PolicyOut), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'leave.manage');
      const asOf = today(auth.user.timeZone ?? 'Europe/London');
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        await ensureLeaveDefaults(tx, book);
        const rows = await tx.query<{
          id: string;
          name: string;
          leave_type_id: string;
          key: string;
          entity_id: string | null;
          entity_name: string | null;
          country: string | null;
          config: LeavePolicy;
          effective_from: string;
          effective_to: string | null;
          assigned: number;
        }>(
          `SELECT p.id, p.name, p.leave_type_id, t.key, p.entity_id, le.name AS entity_name, p.country, p.config, p.effective_from::text, p.effective_to::text,
                (SELECT count(DISTINCT a.employee_id)::int FROM app.leave_policy_assignments a WHERE a.policy_id = p.id AND a.valid_from <= $1::date AND (a.valid_to IS NULL OR a.valid_to > $1::date)) AS assigned
           FROM app.leave_policies p JOIN app.leave_types t ON t.tenant_id = p.tenant_id AND t.id = p.leave_type_id
           LEFT JOIN app.legal_entities le ON le.tenant_id = p.tenant_id AND le.id = p.entity_id
          ORDER BY t.key, p.effective_from DESC, p.name`,
          [asOf],
        );
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          leaveTypeId: r.leave_type_id,
          leaveTypeKey: r.key,
          entityId: r.entity_id,
          entityName: r.entity_name,
          country: r.country,
          config: r.config,
          effectiveFrom: r.effective_from,
          effectiveTo: r.effective_to,
          assignedEmployees: r.assigned,
        }));
      });
    },
  );

  app.post(
    '/v1/leave/policies/:id/assign',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          employeeIds: Type.Array(Uuid, { minItems: 1, maxItems: 10_000 }),
          validFrom: CivilDate,
        }),
        response: { 200: Type.Object({ assigned: Type.Integer() }), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'leave.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { employeeIds: string[]; validFrom: string };
      const employeeIds = [...new Set(b.employeeIds)];
      return app.tenantTx(req, async (tx) => {
        const p = await tx.maybe<{ leave_type_id: string }>(
          'SELECT leave_type_id FROM app.leave_policies WHERE id = $1',
          [id],
        );
        if (!p) throw new ApiError('notFound');
        // every person must exist in this workspace and be within the caller's leave.manage scope
        const params: unknown[] = [employeeIds];
        const scope = scopePredicate(auth.principal, 'leave.manage', params);
        const reachable = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.employees e WHERE e.id = ANY($1::uuid[]) AND ${scope}`,
          params,
        );
        if (reachable.n !== employeeIds.length) throw new ApiError('notFound');
        for (const e of employeeIds) {
          await tx.exec(
            `UPDATE app.leave_policy_assignments SET valid_to = $3 WHERE employee_id = $1 AND leave_type_id = $2 AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $3)`,
            [e, p.leave_type_id, b.validFrom],
          );
          await tx.exec(
            `INSERT INTO app.leave_policy_assignments (tenant_id, employee_id, policy_id, leave_type_id, valid_from) VALUES (app.current_tenant(), $1, $2, $3, $4)`,
            [e, id, p.leave_type_id, b.validFrom],
          );
        }
        await app.audit(tx, req, {
          action: 'leave_policy.assigned',
          targetType: 'leave_policy',
          targetId: id,
          diff: { employees: employeeIds.length, validFrom: b.validFrom },
        });
        return { assigned: employeeIds.length };
      });
    },
  );

  // ---- balances -------------------------------------------------------------------------------------
  app.get(
    '/v1/leave/balances/:employeeId',
    {
      schema: {
        tags: ['leave'],
        params: Type.Object({ employeeId: Uuid }),
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: { 200: Type.Array(Balance), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today(auth.user.timeZone ?? 'Europe/London');
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        if (!(await canActOn(tx, auth, employeeId, 'leave.read'))) throw new ApiError('forbidden');
        await ensureLeaveDefaults(tx, book);
        const types = await tx.query<{ id: string; key: string }>(
          `SELECT id, key FROM app.leave_types WHERE active AND deducts_balance ORDER BY key`,
        );
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
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        description:
          'Adds to (or subtracts from) a balance, in the unit of the policy that applies (days or hours).',
        body: Type.Object({
          employeeId: Uuid,
          leaveTypeId: Uuid,
          amount: Type.Number({ minimum: -3000, maximum: 3000 }),
          effectiveDate: CivilDate,
          kind: Type.Optional(
            Type.Union(['manual', 'toil', 'carry_over', 'correction'].map((k) => Type.Literal(k))),
          ),
          reason: Type.String({ minLength: 3, maxLength: 300 }),
        }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId: string;
        leaveTypeId: string;
        amount: number;
        effectiveDate: string;
        kind?: string;
        reason: string;
      };
      const row = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'leave.adjust', await loadTarget(tx, b.employeeId)))
          throw new ApiError('forbidden');
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.leave_adjustments (tenant_id, employee_id, leave_type_id, amount, kind, effective_date, reason, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.employeeId, b.leaveTypeId, b.amount, b.kind ?? 'manual', b.effectiveDate, b.reason, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'leave.adjusted',
          targetType: 'employee',
          targetId: b.employeeId,
          diff: { amount: b.amount, kind: b.kind ?? 'manual', reason: b.reason },
        });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  // ---- hours worked (per-hour-worked accrual, FMLA hours, US paid sick leave) ------------------------------
  app.post(
    '/v1/leave/worked-hours',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        description:
          'Records hours actually worked in a period (inclusive dates) where timesheets are not used. Approved timesheets take precedence when present.',
        body: Type.Object({
          employeeId: Uuid,
          startDate: CivilDate,
          endDate: CivilDate,
          hours: Type.Number({ minimum: 0, maximum: 9600 }),
          source: Type.Optional(
            Type.Union([Type.Literal('manual'), Type.Literal('import'), Type.Literal('payroll')]),
          ),
        }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId: string;
        startDate: string;
        endDate: string;
        hours: number;
        source?: string;
      };
      if (compareDates(b.endDate, b.startDate) < 0)
        throw new ApiError('validation', 'endDate before startDate');
      const row = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'leave.adjust', await loadTarget(tx, b.employeeId)))
          throw new ApiError('forbidden');
        const clash = await tx.maybe(
          `SELECT 1 FROM app.worked_hours WHERE employee_id = $1 AND period_start < $3 AND period_end > $2`,
          [b.employeeId, b.startDate, addDays(b.endDate, 1)],
        );
        if (clash) throw new ApiError('conflict', 'Hours are already recorded for part of this period');
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.worked_hours (tenant_id, employee_id, period_start, period_end, minutes, source, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            b.employeeId,
            b.startDate,
            addDays(b.endDate, 1),
            Math.round(b.hours * 60),
            b.source ?? 'manual',
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'worked_hours.recorded',
          targetType: 'employee',
          targetId: b.employeeId,
          diff: { start: b.startDate, end: b.endDate, hours: b.hours, source: b.source ?? 'manual' },
        });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  app.get(
    '/v1/leave/worked-hours/:employeeId',
    {
      schema: {
        tags: ['leave'],
        params: Type.Object({ employeeId: Uuid }),
        querystring: Type.Object({ from: CivilDate, to: CivilDate }),
        response: { 200: Type.Object({ hours: Type.Number(), source: Type.String() }), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const q = req.query as { from: string; to: string };
      return app.tenantTx(
        req,
        async (tx) => {
          if (!(await canActOn(tx, auth, employeeId, 'leave.read'))) throw new ApiError('forbidden');
          return hoursWorked(tx, employeeId, q.from, addDays(q.to, 1));
        },
        { readOnly: true },
      );
    },
  );

  // ---- statutory family leave (from the packs) -----------------------------------------------------------
  app.get(
    '/v1/leave/family-entitlements/:employeeId',
    {
      schema: {
        tags: ['leave'],
        description:
          'Statutory family leave that applies to the employee, from the jurisdiction packs (indicative; HR confirms when leave is notified).',
        params: Type.Object({ employeeId: Uuid }),
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({
            jurisdiction: Nullable(Type.String()),
            entitlements: Type.Array(
              Type.Object({
                kind: Type.String(),
                leaveWeeks: Type.Number(),
                detail: Type.Any(),
                source: Type.Object({ url: Type.String(), title: Type.String() }),
              }),
            ),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today('UTC');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          if (!(await canActOn(tx, auth, employeeId, 'leave.read'))) throw new ApiError('forbidden');
          const ctx = await leaveContext(tx, employeeId, asOf);
          const jurisdiction = ctx.country === 'US' ? (ctx.region ?? 'US') : ctx.country;
          const entitlements: Array<{
            kind: string;
            leaveWeeks: number;
            detail: unknown;
            source: { url: string; title: string };
          }> = [];
          if (!jurisdiction) return { jurisdiction: null, entitlements };
          for (const kind of ['maternity', 'paternity'] as const) {
            const r = book.tryResolve<FamilyLeaveRule>(jurisdiction, `family_leave.${kind}`, asOf);
            if (!r) continue;
            const info = familyLeaveInfo(r.value, { startDate: ctx.startDate, asOf });
            entitlements.push({ kind, leaveWeeks: info.leaveWeeks, detail: info, source: r.source });
          }
          const fmla =
            ctx.country === 'US'
              ? book.tryResolve<FmlaRule>(jurisdiction, 'family_leave.fmla', asOf)
              : undefined;
          if (fmla)
            entitlements.push({
              kind: 'fmla',
              leaveWeeks: fmla.value.entitlementWorkweeks ?? 0,
              detail: {
                militaryCaregiverWorkweeks: fmla.value.militaryCaregiverWorkweeks ?? null,
                unpaid: true,
              },
              source: fmla.source,
            });
          return { jurisdiction, entitlements };
        },
        { readOnly: true },
      );
    },
  );

  // ---- requests -----------------------------------------------------------------------------------------
  app.post(
    '/v1/leave/requests',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({
          employeeId: Type.Optional(Uuid),
          leaveTypeId: Uuid,
          startDate: CivilDate,
          endDate: CivilDate,
          startHalf: Type.Optional(Type.Union([Type.Literal('am'), Type.Literal('pm')])),
          endHalf: Type.Optional(Type.Union([Type.Literal('am'), Type.Literal('pm')])),
          hours: Type.Optional(
            Type.Number({
              exclusiveMinimum: 0,
              maximum: 24,
              description: 'Part of a single day, in hours (hourly leave, intermittent FMLA).',
            }),
          ),
          note: Type.Optional(Type.String({ maxLength: 500 })),
          fmlaCaseId: Type.Optional(Uuid),
        }),
        response: {
          201: Type.Object({
            id: Uuid,
            status: Type.String(),
            amountDays: Type.Number(),
            amountHours: Type.Number(),
            warnings: Type.Array(Type.Any()),
          }),
          403: Problem,
          409: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId?: string;
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        startHalf?: 'am' | 'pm';
        endHalf?: 'am' | 'pm';
        hours?: number;
        note?: string;
        fmlaCaseId?: string;
      };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation', 'employeeId is required');
      if (compareDates(b.endDate, b.startDate) < 0)
        throw new ApiError('validation', 'endDate before startDate');
      if (b.hours !== undefined && b.startDate !== b.endDate)
        throw new ApiError('validation', 'hours is only allowed for a single day');
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const own = auth.principal.employeeId === employeeId;
        if (
          !(own
            ? can(auth.principal, 'leave.request', { employeeId })
            : can(auth.principal, 'leave.record', await loadTarget(tx, employeeId)))
        )
          throw new ApiError('forbidden');
        const type = await tx.maybe<{
          id: string;
          key: string;
          category: string;
          requires_approval: boolean;
          deducts_balance: boolean;
          name: Record<string, string>;
        }>('SELECT * FROM app.leave_types WHERE id = $1 AND active', [b.leaveTypeId]);
        if (!type) throw new ApiError('notFound');
        const overlap = await tx.maybe(
          `SELECT 1 FROM app.leave_requests WHERE employee_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3 AND end_date >= $2`,
          [employeeId, b.startDate, b.endDate],
        );
        if (overlap) throw new ApiError('conflict', 'Overlaps an existing request');
        const amount = await amountFor(
          tx,
          book,
          employeeId,
          b.startDate,
          b.endDate,
          b.startHalf,
          b.endHalf,
          b.hours,
        );
        if (amount.days === 0) throw new ApiError('unprocessable', 'No working days in this period');
        if (type.deducts_balance) {
          const bal = await balanceFor(tx, book, employeeId, type.id, b.startDate);
          if (!bal) throw new ApiError('unprocessable', 'No leave policy applies');
          const requested = bal.unit === 'hours' ? amount.hours : amount.days;
          if (!bal.canBook(requested))
            throw new ApiError(
              'unprocessable',
              bal.inWaitingPeriod ? 'Still in the waiting period' : 'Not enough balance',
              { available: bal.available, requested, unit: bal.unit },
            );
        }
        if (b.fmlaCaseId) {
          // FMLA runs alongside the leave type (paid leave may be substituted); usage is tracked in hours.
          const c = await tx.maybe<FmlaCaseRow>('SELECT * FROM app.fmla_cases WHERE id = $1', [b.fmlaCaseId]);
          if (!c || c.employee_id !== employeeId)
            throw new ApiError('unprocessable', 'The FMLA case is not this employee’s');
          if (c.status !== 'open' || !c.eligibility.eligible)
            throw new ApiError('unprocessable', 'The FMLA case is not open for leave');
          const partial = b.hours !== undefined || !!b.startHalf || !!b.endHalf;
          if (partial && !c.intermittent)
            throw new ApiError(
              'unprocessable',
              'Part-day FMLA leave needs an intermittent or reduced-schedule case',
            );
          const st = await fmlaStatus(tx, book, c, b.startDate, { statuses: ['approved', 'pending'] });
          if (amount.hours > st.remainingHours)
            throw new ApiError('unprocessable', 'FMLA entitlement exhausted for this 12-month period', {
              remainingHours: st.remainingHours,
              requestedHours: amount.hours,
            });
        }
        const ctx = await leaveContext(tx, employeeId, b.startDate);
        const cover = await coverProblems(tx, ctx, b.startDate, b.endDate);
        if (cover.some((c) => c.enforcement === 'block'))
          throw new ApiError('unprocessable', 'Minimum cover would not be met', { cover });
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, start_half, end_half, amount_days, amount_hours, explicit_hours, note, requested_by, fmla_case_id, status)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [
            employeeId,
            type.id,
            b.startDate,
            b.endDate,
            b.startHalf ?? null,
            b.endHalf ?? null,
            amount.days,
            amount.hours,
            b.hours !== undefined,
            b.note ?? null,
            auth.userId,
            b.fmlaCaseId ?? null,
            type.requires_approval ? 'pending' : 'approved',
          ],
        );
        let status = type.requires_approval ? 'pending' : 'approved';
        if (type.requires_approval) {
          // A manager-approval policy is created on first use; customers can change or extend it.
          const has = await tx.maybe(
            `SELECT 1 FROM app.approval_policies WHERE subject = 'leave.request' LIMIT 1`,
          );
          if (!has)
            await tx.exec(
              `INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), 'leave.request', 'Leave approval', '[{"approver":{"type":"manager"}}]')`,
            );
          const approvalId = await requestApproval(tx, 'leave.request', employeeId, auth.userId, {
            leaveRequestId: r.id,
            leaveType: type.key,
            startDate: b.startDate,
            endDate: b.endDate,
            amountDays: amount.days,
            ...(cover.length ? { coverWarnings: cover.length } : {}),
          });
          if (approvalId)
            await tx.exec('UPDATE app.leave_requests SET approval_request_id = $2 WHERE id = $1', [
              r.id,
              approvalId,
            ]);
          else {
            await tx.exec(
              `UPDATE app.leave_requests SET status = 'approved', decided_at = now() WHERE id = $1`,
              [r.id],
            );
            status = 'approved';
          }
        }
        await app.audit(tx, req, {
          action: 'leave.requested',
          targetType: 'leave_request',
          targetId: r.id,
          diff: {
            employeeId,
            type: type.key,
            start: b.startDate,
            end: b.endDate,
            days: amount.days,
            hours: amount.hours,
            ...(b.fmlaCaseId ? { fmlaCaseId: b.fmlaCaseId } : {}),
          },
          sensitive: SENSITIVE_CATEGORIES.has(type.category) || !!b.fmlaCaseId,
        });
        return { id: r.id, status, amountDays: amount.days, amountHours: amount.hours, warnings: cover };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/leave/requests',
    {
      schema: {
        tags: ['leave'],
        querystring: Type.Object({ employeeId: Type.Optional(Uuid), status: Type.Optional(Type.String()) }),
        response: { 200: Type.Array(LeaveRequest), 403: Problem },
      },
    },
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
          // Sensitive leave types are shown only where the viewer may read absence detail for that employee.
          const absence = scopePredicate(auth.principal, 'absence.read', params);
          const rows = await tx.query<{
            id: string;
            employee_id: string;
            display_name: string | null;
            key: string;
            category: string;
            start_date: string;
            end_date: string;
            amount_days: string;
            amount_hours: string;
            status: string;
            note: string | null;
            absence_visible: boolean;
          }>(
            `SELECT l.*, e.display_name, t.key, t.category, (${absence}) AS absence_visible FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
               JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id WHERE ${where} ORDER BY l.start_date DESC LIMIT 500`,
            params,
          );
          return rows.map((r) => {
            const hide =
              SENSITIVE_CATEGORIES.has(r.category) &&
              r.employee_id !== auth.principal.employeeId &&
              !r.absence_visible;
            return {
              id: r.id,
              employeeId: r.employee_id,
              employeeName: r.display_name,
              leaveType: hide ? 'away' : r.key,
              startDate: r.start_date,
              endDate: r.end_date,
              amountDays: Number(r.amount_days),
              amountHours: Number(r.amount_hours),
              status: r.status,
              note: hide ? null : r.note,
            };
          });
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/leave/requests/:id',
    {
      schema: {
        tags: ['leave'],
        summary:
          'One leave request (ADR-0160): the person, dates, amount, status and who asked. Sensitive kinds show as "away" unless the caller may read absence detail.',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            ...LeaveRequest.properties,
            leaveTypeName: Nullable(Type.Record(Type.String(), Type.String())),
            startHalf: Nullable(Type.String()),
            endHalf: Nullable(Type.String()),
            requestedByName: Nullable(Type.String()),
            createdAt: Type.String(),
            decidedAt: Nullable(Type.String()),
            approvalRequestId: Nullable(Uuid),
            canCancel: Type.Boolean(),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const r = await tx.maybe<{
            id: string;
            employee_id: string;
            display_name: string | null;
            key: string;
            name: Record<string, string>;
            category: string;
            start_date: string;
            end_date: string;
            start_half: string | null;
            end_half: string | null;
            amount_days: string;
            amount_hours: string;
            status: string;
            note: string | null;
            requested_by_name: string | null;
            created_at: string;
            decided_at: string | null;
            approval_request_id: string | null;
          }>(
            `SELECT l.*, e.display_name, t.key, t.name, t.category, u.display_name AS requested_by_name
               FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
               JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id
               LEFT JOIN app.users u ON u.tenant_id = l.tenant_id AND u.id = l.requested_by
              WHERE l.id = $1`,
            [id],
          );
          if (!r) throw new ApiError('notFound');
          if (!(await canActOn(tx, auth, r.employee_id, 'leave.read'))) throw new ApiError('forbidden');
          const own = r.employee_id === auth.principal.employeeId;
          const target = own ? null : await loadTarget(tx, r.employee_id);
          const hide =
            SENSITIVE_CATEGORIES.has(r.category) && !own && !can(auth.principal, 'absence.read', target!);
          // the approval request is linked only for those who may open it (its approvers, whoever asked, HR)
          const approvalVisible =
            !!r.approval_request_id &&
            (canSome(auth.principal, 'approvals.manage') ||
              !!(await tx.maybe(
                `SELECT 1 FROM app.approval_requests a WHERE a.id = $1 AND (a.requested_by = $2
                   OR EXISTS (SELECT 1 FROM app.approval_steps s WHERE s.request_id = a.id AND $2 = ANY(s.approver_user_ids)))`,
                [r.approval_request_id, auth.userId],
              )));
          const cancellable =
            ['pending', 'approved'].includes(r.status) &&
            r.category !== 'sickness' &&
            (own
              ? r.status === 'pending' || compareDates(r.start_date, today('UTC')) > 0
              : can(auth.principal, 'leave.record', target!));
          return {
            id: r.id,
            employeeId: r.employee_id,
            employeeName: r.display_name,
            leaveType: hide ? 'away' : r.key,
            leaveTypeName: hide ? null : r.name,
            startDate: r.start_date,
            endDate: r.end_date,
            startHalf: r.start_half,
            endHalf: r.end_half,
            amountDays: Number(r.amount_days),
            amountHours: Number(r.amount_hours),
            status: r.status,
            note: hide ? null : r.note,
            requestedByName: r.requested_by_name,
            createdAt: r.created_at,
            decidedAt: r.decided_at,
            approvalRequestId: approvalVisible ? r.approval_request_id : null,
            canCancel: cancellable,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/leave/requests/:id/cancel',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<{
          employee_id: string;
          status: string;
          start_date: string;
          approval_request_id: string | null;
        }>('SELECT * FROM app.leave_requests WHERE id = $1 FOR UPDATE', [id]);
        if (!r) throw new ApiError('notFound');
        const own = r.employee_id === auth.principal.employeeId;
        if (!own && !can(auth.principal, 'leave.record', await loadTarget(tx, r.employee_id)))
          throw new ApiError('forbidden');
        if (!['pending', 'approved'].includes(r.status)) throw new ApiError('conflict');
        if (own && r.status === 'approved' && compareDates(r.start_date, today('UTC')) <= 0)
          throw new ApiError('conflict', 'Leave already started — ask HR to change it');
        await tx.exec(
          `UPDATE app.leave_requests SET status = 'cancelled', decided_at = now() WHERE id = $1`,
          [id],
        );
        if (r.approval_request_id) {
          await tx.exec(
            `UPDATE app.approval_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`,
            [r.approval_request_id],
          );
          await tx.exec(
            `UPDATE app.tasks SET status = 'cancelled' WHERE source = 'approval' AND source_id = $1 AND status = 'open'`,
            [r.approval_request_id],
          );
        }
        await app.audit(tx, req, {
          action: 'leave.cancelled',
          targetType: 'leave_request',
          targetId: id,
          diff: { previousStatus: r.status },
        });
        return { id, status: 'cancelled' };
      });
    },
  );

  // ---- calendar and ICS feeds ---------------------------------------------------------------------------
  app.get(
    '/v1/leave/calendar',
    {
      schema: {
        tags: ['leave'],
        querystring: Type.Object({ from: CivilDate, to: CivilDate }),
        response: {
          200: Type.Object({
            entries: Type.Array(
              Type.Object({
                employeeId: Uuid,
                name: Type.String(),
                start: Type.String(),
                end: Type.String(),
                kind: Type.String(),
                status: Type.String(),
              }),
            ),
            holidays: Type.Array(Type.Object({ date: Type.String(), name: Type.String() })),
          }),
        },
      },
    },
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
          const absence = scopePredicate(auth.principal, 'absence.read', params);
          params.push(auth.principal.employeeId, q.from, q.to);
          const n = params.length;
          const rows = await tx.query<{
            employee_id: string;
            display_name: string;
            start_date: string;
            end_date: string;
            key: string;
            category: string;
            status: string;
            absence_visible: boolean;
          }>(
            `SELECT l.employee_id, e.display_name, l.start_date, l.end_date, t.key, t.category, l.status, (${absence}) AS absence_visible FROM app.leave_requests l
               JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id
              WHERE l.status IN ('approved', 'pending') AND l.start_date <= $${n} AND l.end_date >= $${n - 1}
                AND (${scope} OR l.employee_id = $${n - 2} OR e.manager_id = $${n - 2}) ORDER BY l.start_date LIMIT 5000`,
            params,
          );
          const holidays = auth.principal.employeeId
            ? await holidaysFor(
                tx,
                book,
                await leaveContext(tx, auth.principal.employeeId, q.from),
                q.from,
                q.to,
              )
            : [];
          const names = new Map<string, string>();
          if (auth.principal.employeeId) {
            const ctx = await leaveContext(tx, auth.principal.employeeId, q.from);
            for (let y = dateParts(q.from).year; y <= dateParts(q.to).year; y++)
              for (const h of book.holidays(ctx.country ?? 'GB', y, ctx.region ?? undefined))
                names.set(h.observed ?? h.date, h.name);
          }
          return {
            entries: rows.map((r) => ({
              employeeId: r.employee_id,
              name: r.display_name,
              start: r.start_date,
              end: r.end_date,
              kind:
                SENSITIVE_CATEGORIES.has(r.category) &&
                !r.absence_visible &&
                r.employee_id !== auth.principal.employeeId
                  ? 'away'
                  : r.key,
              status: r.status,
            })),
            holidays: holidays.map((d) => ({ date: d, name: names.get(d) ?? '' })),
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/leave/ics-tokens',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({ scope: Type.Union([Type.Literal('me'), Type.Literal('team')]) }),
        response: { 201: Type.Object({ id: Uuid, url: Type.String() }) },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const scope = (req.body as { scope: 'me' | 'team' }).scope;
      const secret = newToken();
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.ics_tokens (tenant_id, user_id, scope, token_hash) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
          [auth.userId, scope, hashToken(secret)],
        );
        await app.audit(tx, req, {
          action: 'ics.token_created',
          targetType: 'ics_token',
          targetId: r.id,
          diff: { scope },
        });
        return r;
      });
      return reply.status(201).send({
        id: row.id,
        url: `${deps.config.apiBaseUrl}/v1/ics/${composeToken(ICS_PREFIX, auth.tenantId, secret)}.ics`,
      });
    },
  );

  app.delete(
    '/v1/leave/ics-tokens/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        // Only the token's owner can revoke it; another user's token is reported as not found.
        const tok = await tx.maybe<{ revoked_at: string | null }>(
          'SELECT revoked_at FROM app.ics_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [id, auth.userId],
        );
        if (!tok) throw new ApiError('notFound');
        if (tok.revoked_at) return;
        await tx.exec('UPDATE app.ics_tokens SET revoked_at = now() WHERE id = $1', [id]);
        await app.audit(tx, req, { action: 'ics.token_revoked', targetType: 'ics_token', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );

  /** Public, token-authenticated calendar feed. Never contains leave types, notes or sensitive detail. */
  app.get(
    '/v1/ics/:token',
    {
      config: { auth: 'public' },
      schema: { hide: true, params: Type.Object({ token: Type.String({ maxLength: 200 }) }) },
    },
    async (req, reply) => {
      const parsed = parseToken(ICS_PREFIX, (req.params as { token: string }).token.replace(/\.ics$/, ''));
      if (!parsed) throw new ApiError('notFound');
      const events = await withTenant(deps.router, parsed.tenantId, async (tx) => {
        const tok = await tx.maybe<{ user_id: string; scope: string }>(
          'SELECT user_id, scope FROM app.ics_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
          [hashToken(parsed.secret)],
        );
        if (!tok) throw new ApiError('notFound');
        const user = await tx.one<{ employee_id: string | null }>(
          'SELECT employee_id FROM app.users WHERE id = $1',
          [tok.user_id],
        );
        if (!user.employee_id) return [];
        return tx.query<{ id: string; display_name: string; start_date: string; end_date: string }>(
          `SELECT l.id, e.display_name, l.start_date, l.end_date FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
          WHERE l.status = 'approved' AND l.end_date >= current_date - 90 AND (l.employee_id = $1 OR ($2 = 'team' AND e.manager_id = $1)) ORDER BY l.start_date LIMIT 1000`,
          [user.employee_id, tok.scope],
        );
      }).catch((err: unknown) => {
        // An unknown tenant id in the token is "not found", never a routing error.
        if (err instanceof ApiError) throw err;
        throw new ApiError('notFound');
      });
      const fmt = (d: string) => d.replace(/-/g, '');
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Thapsus//Thapsus-HR//EN',
        'CALSCALE:GREGORIAN',
        'X-WR-CALNAME:Time off',
      ];
      for (const e of events)
        lines.push(
          'BEGIN:VEVENT',
          `UID:${e.id}@thapsus-hr`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${fmt(e.start_date)}`,
          `DTEND;VALUE=DATE:${fmt(addDays(e.end_date, 1))}`,
          `SUMMARY:${e.display_name.replace(/[,;\\]/g, ' ')} – out of office`,
          'TRANSP:TRANSPARENT',
          'END:VEVENT',
        );
      lines.push('END:VCALENDAR');
      return reply.type('text/calendar; charset=utf-8').send(lines.join('\r\n'));
    },
  );

  // ---- absence settings ---------------------------------------------------------------------------------
  const AbsenceSettingsSchema = Type.Object({
    fitNoteAfterCalendarDays: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 365 }))),
    fmla: Type.Optional(
      Type.Object({
        leaveYearMethod: Type.Optional(Type.String({ maxLength: 60 })),
        fixedYearStart: Type.Optional(MonthDay),
        publicAgency: Type.Optional(Type.Boolean()),
      }),
    ),
  });
  app.get(
    '/v1/settings/absence',
    { schema: { tags: ['absence'], response: { 200: AbsenceSettingsSchema, 403: Problem } } },
    async (req) => {
      authorize(req, 'absence.manage');
      return app.tenantTx(req, (tx) => absenceSettings(tx), { readOnly: true });
    },
  );
  app.put(
    '/v1/settings/absence',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        description:
          'Company absence policy: fit-note threshold and the uniform FMLA leave-year method (validated against the US pack).',
        body: AbsenceSettingsSchema,
        response: { 200: AbsenceSettingsSchema, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      authorize(req, 'absence.manage');
      const b = req.body as AbsenceSettings & { fitNoteAfterCalendarDays?: number | null };
      const book = await ruleBook(app);
      if (b.fmla?.leaveYearMethod) {
        const methods =
          book.resolve<FmlaRule>('US', 'family_leave.fmla', today('UTC')).value.leaveYearMethods ?? [];
        if (!methods.includes(b.fmla.leaveYearMethod))
          throw new ApiError('unprocessable', 'Unknown FMLA leave-year method', { allowed: methods });
      }
      return app.tenantTx(req, async (tx) => {
        const before = await absenceSettings(tx);
        const next: AbsenceSettings = { ...before, ...b, fmla: { ...before.fmla, ...b.fmla } };
        if (b.fitNoteAfterCalendarDays === null) delete next.fitNoteAfterCalendarDays;
        await tx.exec(
          `UPDATE app.tenants SET features = jsonb_set(coalesce(features, '{}'::jsonb), '{absence}', $1::jsonb)`,
          [JSON.stringify(next)],
        );
        await app.audit(tx, req, {
          action: 'absence_settings.updated',
          targetType: 'tenant',
          targetId: req.auth!.tenantId,
          diff: { before, after: next },
        });
        return next;
      });
    },
  );

  // ---- sickness ----------------------------------------------------------------------------------------
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.post(
    '/v1/sickness',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        body: Type.Object({
          employeeId: Type.Optional(Uuid),
          startDate: CivilDate,
          endDate: Type.Optional(Nullable(CivilDate)),
          reason: Type.Optional(Type.String({ maxLength: 500 })),
        }),
        response: {
          201: Type.Object({ id: Uuid, rtwStatus: Type.String(), fitNoteRequired: Type.Boolean() }),
          403: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId?: string;
        startDate: string;
        endDate?: string | null;
        reason?: string;
      };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation');
      if (b.endDate && compareDates(b.endDate, b.startDate) < 0)
        throw new ApiError('validation', 'endDate before startDate');
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
        const fitNoteAfter = (await absenceSettings(tx)).fitNoteAfterCalendarDays;
        const fitNoteRequired = !!(
          b.endDate &&
          fitNoteAfter !== undefined &&
          daysBetween(b.startDate, b.endDate) + 1 > fitNoteAfter
        );
        const rec = await tx.one<{ id: string }>(
          `INSERT INTO app.sickness_records (tenant_id, employee_id, start_date, end_date, leave_request_id, fit_note_required, rtw_status, recorded_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            employeeId,
            b.startDate,
            b.endDate ?? null,
            lr.id,
            fitNoteRequired,
            b.endDate ? 'due' : 'not_required',
            auth.userId,
          ],
        );
        if (b.reason) {
          const vid = await vault.put(
            tx,
            {
              principal: own
                ? {
                    ...auth.principal,
                    grants: [
                      ...auth.principal.grants,
                      {
                        roleKey: 'self-disclosure',
                        isAdmin: false,
                        permissions: ['vault.write:sickness'],
                        fieldAccess: {},
                        scope: { type: 'self' },
                      },
                    ],
                  }
                : auth.principal,
              actorType: 'user',
              requestId: req.id,
              ip: req.ctx.ip,
            },
            auth.tenantId,
            target,
            'sickness',
            `reason:${rec.id}`,
            b.reason,
          );
          await tx.exec('UPDATE app.sickness_records SET reason_vault_id = $2 WHERE id = $1', [rec.id, vid]);
        }
        const manager = await userForEmployee(
          tx,
          (
            await tx.maybe<{ manager_id: string | null }>(
              'SELECT manager_id FROM app.employees WHERE id = $1',
              [employeeId],
            )
          )?.manager_id,
        );
        if (manager && b.endDate) await createReturnToWorkTask(tx, rec.id, employeeId, manager, b.endDate);
        await app.audit(tx, req, {
          action: 'sickness.recorded',
          targetType: 'sickness_record',
          targetId: rec.id,
          diff: { employeeId, start: b.startDate, end: b.endDate ?? null, fitNoteRequired },
          sensitive: true,
        });
        return { id: rec.id, rtwStatus: b.endDate ? 'due' : 'not_required', fitNoteRequired };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/sickness',
    {
      schema: {
        tags: ['absence'],
        description:
          'Sickness records (dates and status only — reasons, fit notes and return-to-work answers stay in the vault).',
        querystring: Type.Object({ employeeId: Type.Optional(Uuid) }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              employeeId: Uuid,
              employeeName: Nullable(Type.String()),
              startDate: Type.String(),
              endDate: Nullable(Type.String()),
              rtwStatus: Type.String(),
              fitNoteRequired: Type.Boolean(),
              hasFitNote: Type.Boolean(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { employeeId?: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          let where: string;
          if (q.employeeId) {
            const own = q.employeeId === auth.principal.employeeId;
            if (!own && !can(auth.principal, 'absence.read', await loadTarget(tx, q.employeeId)))
              throw new ApiError('forbidden');
            params.push(q.employeeId);
            where = 's.employee_id = $1';
          } else where = scopePredicate(auth.principal, 'absence.read', params);
          const rows = await tx.query<{
            id: string;
            employee_id: string;
            display_name: string | null;
            start_date: string;
            end_date: string | null;
            rtw_status: string;
            fit_note_required: boolean;
            fit_note_vault_id: string | null;
          }>(
            `SELECT s.*, e.display_name FROM app.sickness_records s JOIN app.employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id WHERE ${where} ORDER BY s.start_date DESC LIMIT 500`,
            params,
          );
          return rows.map((r) => ({
            id: r.id,
            employeeId: r.employee_id,
            employeeName: r.display_name,
            startDate: r.start_date,
            endDate: r.end_date,
            rtwStatus: r.rtw_status,
            fitNoteRequired: r.fit_note_required,
            hasFitNote: !!r.fit_note_vault_id,
          }));
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/sickness/:id/medical',
    {
      schema: {
        tags: ['absence'],
        description:
          'Medical detail of a sickness record from the vault. Needs vault.read:sickness (HR); every read and every refusal is audit-logged.',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            id: Uuid,
            reason: Nullable(Type.String()),
            fitNote: Nullable(Type.Object({ fileName: Type.String() })),
            returnToWork: Nullable(Type.Any()),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const result = await app.tenantTx(req, async (tx) => {
        const rec = await tx.maybe<{ employee_id: string }>(
          'SELECT employee_id FROM app.sickness_records WHERE id = $1',
          [id],
        );
        if (!rec) throw new ApiError('notFound');
        const target = await loadTarget(tx, rec.employee_id);
        // Employees may read what they disclosed about themselves; others need the vault permission.
        const principal =
          rec.employee_id === auth.principal.employeeId
            ? {
                ...auth.principal,
                grants: [
                  ...auth.principal.grants,
                  {
                    roleKey: 'self-disclosure',
                    isAdmin: false,
                    permissions: ['vault.read:sickness'],
                    fieldAccess: {},
                    scope: { type: 'self' as const },
                  },
                ],
              }
            : auth.principal;
        const actor = { principal, actorType: 'user' as const, requestId: req.id, ip: req.ctx.ip };
        if (!can(principal, 'vault.read:sickness', target)) {
          // Committed (not rolled back with an error) so the refusal stays in the audit log.
          await writeAudit(tx, {
            actorType: 'user',
            actorId: auth.userId,
            action: 'vault.read_denied',
            targetType: 'vault:sickness',
            targetId: rec.employee_id,
            diff: { subjectId: rec.employee_id, record: id },
            sensitive: true,
            requestId: req.id,
            ip: req.ctx.ip,
          });
          return null;
        }
        const values = await vault.read(tx, actor, auth.tenantId, target, 'sickness', [
          `reason:${id}`,
          `fit_note:${id}`,
          `rtw:${id}`,
        ]);
        const get = (f: string) => values.find((v) => v.field === `${f}:${id}`)?.value ?? null;
        const rtw = get('rtw');
        const fitNote = get('fit_note');
        return {
          id,
          reason: get('reason'),
          fitNote: fitNote ? { fileName: fitNote } : null,
          returnToWork: rtw ? (JSON.parse(rtw) as unknown) : null,
        };
      });
      req.auditWritten = true;
      if (!result) throw new ApiError('forbidden');
      return result;
    },
  );

  app.post(
    '/v1/sickness/:id/fit-note',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        consumes: ['multipart/form-data'],
        params: Type.Object({ id: Uuid }),
        response: { 201: Type.Object({ vaultId: Uuid }), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const file = await req.file();
      if (!file || !['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype))
        throw new ApiError('validation', 'Upload a PDF or image');
      const buf = await file.toBuffer();
      if (!matchesMagic(file.mimetype, buf))
        throw new ApiError('validation', 'The file content does not match its type');
      const out = await app.tenantTx(req, async (tx) => {
        const rec = await tx.maybe<{ employee_id: string }>(
          'SELECT employee_id FROM app.sickness_records WHERE id = $1',
          [id],
        );
        if (!rec) throw new ApiError('notFound');
        const target = await loadTarget(tx, rec.employee_id);
        const own = rec.employee_id === auth.principal.employeeId;
        const principal = own
          ? {
              ...auth.principal,
              grants: [
                ...auth.principal.grants,
                {
                  roleKey: 'self-disclosure',
                  isAdmin: false,
                  permissions: ['vault.write:sickness'],
                  fieldAccess: {},
                  scope: { type: 'self' as const },
                },
              ],
            }
          : auth.principal;
        // The file is stored in the home-region bucket under a vault key; access only via the vault (audited).
        const key = objectKey(
          auth.tenantId,
          `vault/sickness/${rec.employee_id}`,
          file.mimetype === 'application/pdf' ? '.pdf' : '.img',
        );
        await deps.objects.put(key, buf, file.mimetype);
        const vid = await vault.put(
          tx,
          { principal, actorType: 'user', requestId: req.id, ip: req.ctx.ip },
          auth.tenantId,
          target,
          'sickness',
          `fit_note:${id}`,
          file.filename,
          key,
        );
        await tx.exec('UPDATE app.sickness_records SET fit_note_vault_id = $2 WHERE id = $1', [id, vid]);
        req.auditWritten = true;
        return { vaultId: vid };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/sickness/:id/return-to-work',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          answers: Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 2000 })),
          fitForWork: Type.Boolean(),
          adjustments: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
        response: { 200: Type.Object({ id: Uuid, rtwStatus: Type.String() }), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { answers: Record<string, string>; fitForWork: boolean; adjustments?: string };
      return app.tenantTx(req, async (tx) => {
        const rec = await tx.maybe<{ employee_id: string }>(
          'SELECT employee_id FROM app.sickness_records WHERE id = $1',
          [id],
        );
        if (!rec) throw new ApiError('notFound');
        const target = await loadTarget(tx, rec.employee_id);
        if (!can(auth.principal, 'absence.record', target)) throw new ApiError('forbidden');
        // Managers record the conversation without being able to read medical detail afterwards.
        const writer = {
          ...auth.principal,
          grants: [
            ...auth.principal.grants,
            {
              roleKey: 'rtw-writer',
              isAdmin: false,
              permissions: ['vault.write:sickness'],
              fieldAccess: {},
              scope: { type: 'all' as const },
            },
          ],
        };
        const vid = await vault.put(
          tx,
          { principal: writer, actorType: 'user', requestId: req.id, ip: req.ctx.ip },
          auth.tenantId,
          target,
          'sickness',
          `rtw:${id}`,
          JSON.stringify(b),
        );
        await tx.exec(
          `UPDATE app.sickness_records SET rtw_status = 'completed', rtw_vault_id = $2 WHERE id = $1`,
          [id, vid],
        );
        // the manager's return-to-work task closes with the record (ADR-0192)
        await completeTasksFor(tx, {
          recordType: 'return_to_work',
          recordId: id,
          by: auth.userId,
          reason: 'sickness.rtw_recorded',
        });
        req.auditWritten = true;
        return { id, rtwStatus: 'completed' };
      });
    },
  );

  app.get(
    '/v1/sickness/:employeeId/statutory-pay',
    {
      schema: {
        tags: ['absence'],
        params: Type.Object({ employeeId: Uuid }),
        querystring: Type.Object({
          asOf: Type.Optional(CivilDate),
          normalWeeklyEarningsMinor: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        response: {
          200: Type.Object({
            jurisdiction: Nullable(Type.String()),
            scheme: Type.String(),
            result: Type.Any(),
            source: Nullable(Type.Object({ url: Type.String(), title: Type.String() })),
          }),
          403: Problem,
        },
      },
    },
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
          if (!can(auth.principal, 'absence.read', target) && !can(auth.principal, 'payroll.read', target))
            throw new ApiError('forbidden');
          const ctx = await leaveContext(tx, employeeId, asOf);
          const rows = await tx.query<{ start_date: string; end_date: string | null }>(
            `SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= ($2::date - 400)) ORDER BY start_date`,
            [employeeId, asOf],
          );
          const spells = rows.map((s) => ({ start: s.start_date, end: minDate(s.end_date ?? asOf, asOf) }));
          const pay = await tx.maybe<{ amount_minor: string; frequency: string }>(
            `SELECT amount_minor, frequency FROM app.employee_pay WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
            [employeeId, asOf],
          );
          const weeklyHours = weeklyHoursOf(ctx.pattern);
          const weekly =
            q.normalWeeklyEarningsMinor ??
            (pay
              ? Math.round(
                  pay.frequency === 'annual'
                    ? Number(pay.amount_minor) / 52
                    : pay.frequency === 'monthly'
                      ? (Number(pay.amount_minor) * 12) / 52
                      : pay.frequency === 'hourly'
                        ? Number(pay.amount_minor) * weeklyHours
                        : Number(pay.amount_minor),
                )
              : 0);
          const country = ctx.country;
          if (country === 'GB') {
            // Each day uses the rule version in force on it (e.g. spells spanning 6 April 2026).
            const r = book.resolve<UkSspRule>('GB', 'sick_pay.statutory', asOf);
            return {
              jurisdiction: 'GB',
              scheme: 'uk_ssp',
              result: ukSsp({
                rule: (d) => book.resolve<UkSspRule>('GB', 'sick_pay.statutory', d),
                normalWeeklyEarningsMinor: weekly,
                pattern: ctx.pattern,
                spells,
              }),
              source: r.source,
            };
          }
          if (country && country !== 'US') {
            const r = book.tryResolve<Record<string, unknown>>(country, 'sick_pay.statutory', asOf);
            const last = spells.at(-1);
            if (!r) return { jurisdiction: country, scheme: 'not_modelled', result: null, source: null };
            const result = last
              ? employerContinuedPay(r.value, {
                  startDate: ctx.startDate,
                  sickStart: last.start,
                  sickEnd: last.end,
                  weeklyPayMinor: weekly,
                  pattern: ctx.pattern,
                  holidays: await holidaysFor(tx, book, ctx, last.start, last.end),
                  priorSpells: spells.slice(0, -1),
                })
              : null;
            if (result?.scheme === 'not_modelled')
              return { jurisdiction: r.jurisdiction, scheme: 'not_modelled', result: null, source: r.source };
            return {
              jurisdiction: r.jurisdiction,
              scheme: 'employer_continued_pay',
              result,
              source: r.source,
            };
          }
          // US: state paid sick leave for the current calendar year (no locality layer yet → state/federal only).
          const region = ctx.region ?? 'US';
          const r = book.tryResolve<UsSickRule>(region, 'sick_pay.paid_sick_leave_accrual', asOf);
          if (!r) return { jurisdiction: region, scheme: 'not_modelled', result: null, source: null };
          const from = maxDate(`${dateParts(asOf).year}-01-01`, ctx.startDate);
          const worked = await hoursWorked(tx, employeeId, from, addDays(asOf, 1), {
            pattern: ctx.pattern,
            startDate: ctx.startDate,
            endDate: ctx.endDate,
          });
          const sizes = await tx.one<{ all: number; state: number }>(
            `SELECT count(*)::int AS all, count(*) FILTER (WHERE coalesce(e.region_code, le.region_code) = $1)::int AS state
               FROM app.employees e LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.entity_id WHERE e.status = 'active'`,
            [region],
          );
          const yearAgo = maxDate(addDays(asOf, -364), ctx.startDate);
          const daysWorked =
            compareDates(yearAgo, asOf) <= 0
              ? requestAmount({ start: yearAgo, end: asOf, pattern: ctx.pattern, holidays: [] }).days
              : 0;
          const result = usSickAccrual(r.value, {
            hoursWorked: worked.hours,
            hoursPerDay: averageDayHours(ctx.pattern) || 8,
            employerSize: sizes.all,
            stateEmployees: sizes.state,
            startDate: ctx.startDate,
            asOf,
            daysWorkedInStateWithinYear: daysWorked,
          });
          return {
            jurisdiction: r.jurisdiction,
            scheme: result.required ? 'us_paid_sick_leave' : 'no_statutory_requirement',
            result: {
              ...result,
              hoursWorked: worked.hours,
              hoursSource: worked.source,
              accrualYear: [from, `${dateParts(asOf).year + 1}-01-01`],
            },
            source: r.source,
          };
        },
        { readOnly: true },
      );
    },
  );

  // ---- FMLA ------------------------------------------------------------------------------------------
  const FmlaCase = Type.Object({
    id: Uuid,
    eligible: Type.Boolean(),
    failed: Type.Array(Type.String()),
    entitlementHours: Type.Number(),
    leaveYearMethod: Type.String(),
    employerCovered: Type.Boolean(),
    employeesWithinRadius: Type.Integer(),
    hoursPrior12Months: Type.Number(),
    hoursSource: Type.String(),
  });
  app.post(
    '/v1/fmla/cases',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        description:
          'Opens an FMLA case. Eligibility (employer coverage from headcount history, service, hours worked, employees within the radius) and the allowed leave-year methods come from the US pack.',
        body: Type.Object({
          employeeId: Uuid,
          reason: Type.Union(
            [
              'own_health',
              'family_care',
              'birth_bonding',
              'placement',
              'military_exigency',
              'military_caregiver',
            ].map((r) => Type.Literal(r)),
          ),
          leaveYearMethod: Type.Optional(
            Type.String({
              maxLength: 60,
              description: 'One of family_leave.fmla.leaveYearMethods; defaults to the company setting.',
            }),
          ),
          startDate: CivilDate,
          intermittent: Type.Optional(Type.Boolean()),
          hoursPrior12Months: Type.Optional(
            Type.Number({
              minimum: 0,
              description:
                'Hours worked in the 12 months before the leave, when HR has a better record than the system.',
            }),
          ),
        }),
        response: { 201: FmlaCase, 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId: string;
        reason: string;
        leaveYearMethod?: string;
        startDate: string;
        intermittent?: boolean;
        hoursPrior12Months?: number;
      };
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, b.employeeId);
        if (!can(auth.principal, 'absence.record', target)) throw new ApiError('forbidden');
        const rule = book.resolve<
          FmlaRule & {
            entitlementWorkweeks: number;
            militaryCaregiverWorkweeks: number;
            leaveYearMethodMustBeUniform?: boolean;
          }
        >('US', 'family_leave.fmla', b.startDate);
        const settings = (await absenceSettings(tx)).fmla ?? {};
        const existing = (
          await tx.query<{ m: string }>(`SELECT DISTINCT leave_year_method AS m FROM app.fmla_cases`)
        ).map((r) => fmlaMethod(r.m));
        const method = b.leaveYearMethod ?? settings.leaveYearMethod ?? existing[0];
        if (!method)
          throw new ApiError('unprocessable', 'Choose the FMLA leave-year method', {
            allowed: rule.value.leaveYearMethods,
          });
        if (!(rule.value.leaveYearMethods ?? []).includes(method))
          throw new ApiError('unprocessable', 'Unknown FMLA leave-year method', {
            allowed: rule.value.leaveYearMethods,
          });
        const uniform = settings.leaveYearMethod ? [settings.leaveYearMethod] : existing;
        if (rule.value.leaveYearMethodMustBeUniform && uniform.some((m) => m !== method))
          throw new ApiError(
            'unprocessable',
            'The FMLA leave-year method must be the same for every employee',
            { method: uniform[0] },
          );
        const ctx = await leaveContext(tx, b.employeeId, b.startDate);
        const weeklyHours = weeklyHoursOf(ctx.pattern);
        const serviceMonths =
          compareDates(ctx.startDate, b.startDate) < 0 ? monthsBetween(ctx.startDate, b.startDate) : 0;
        // Employer coverage from US headcount in each workweek of the current and preceding calendar year.
        const coverage = fmlaEmployerCoverage(rule.value, {
          asOf: b.startDate,
          weeklyHeadcounts: await usWeeklyHeadcounts(
            tx,
            `${dateParts(b.startDate).year - 1}-01-01`,
            b.startDate,
          ),
          publicAgency: settings.publicAgency,
        });
        // Worksite: active employees at locations within the radius of the employee's location (geofence
        // coordinates); without coordinates only the employee's own location counts.
        const radius = rule.value.eligibility.radiusMiles ?? 0;
        const here = ctx.locationId
          ? await tx.maybe<{ geofence: { lat: number; lng: number } | null }>(
              'SELECT geofence FROM app.locations WHERE id = $1',
              [ctx.locationId],
            )
          : undefined;
        let within = 0;
        const locs = await tx.query<{ id: string; geofence: { lat: number; lng: number } | null; n: number }>(
          `SELECT l.id, l.geofence, (SELECT count(*)::int FROM app.employees e WHERE e.location_id = l.id AND e.status = 'active') AS n FROM app.locations l`,
        );
        for (const l of locs)
          if (
            l.id === ctx.locationId ||
            (here?.geofence && l.geofence && milesBetween(here.geofence, l.geofence) <= radius)
          )
            within += l.n;
        // Hours: HR's figure, else recorded hours (timesheets / worked hours), else the contracted pattern.
        const recorded =
          b.hoursPrior12Months === undefined
            ? await hoursWorked(tx, b.employeeId, addMonths(b.startDate, -12), b.startDate, {
                pattern: ctx.pattern,
                startDate: ctx.startDate,
                endDate: ctx.endDate,
              })
            : undefined;
        const hours = b.hoursPrior12Months ?? recorded!.hours;
        const hoursSource = b.hoursPrior12Months !== undefined ? 'provided' : recorded!.source;
        const elig = fmlaEligibility(rule.value, {
          serviceMonths,
          hoursPrior12Months: hours,
          employeesWithinRadius: within,
          employerCovered: coverage.covered,
        });
        const weeks =
          b.reason === 'military_caregiver'
            ? rule.value.militaryCaregiverWorkweeks
            : rule.value.entitlementWorkweeks;
        const entitlementHours = weeks * weeklyHours;
        await ensureLeaveType(tx, 'fmla');
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.fmla_cases (tenant_id, employee_id, reason, leave_year_method, start_date, intermittent, entitlement_hours, eligibility, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            b.employeeId,
            b.reason,
            method,
            b.startDate,
            b.intermittent ?? false,
            entitlementHours,
            JSON.stringify({
              ...elig,
              serviceMonths,
              hours,
              hoursSource,
              within,
              coverage,
              source: rule.source,
            }),
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'fmla.case_opened',
          targetType: 'fmla_case',
          targetId: r.id,
          diff: { eligible: elig.eligible, method },
          sensitive: true,
        });
        return {
          id: r.id,
          eligible: elig.eligible,
          failed: elig.failed,
          entitlementHours,
          leaveYearMethod: method,
          employerCovered: coverage.covered,
          employeesWithinRadius: within,
          hoursPrior12Months: hours,
          hoursSource,
        };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/fmla/cases/:id',
    {
      schema: {
        tags: ['absence'],
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({
            id: Uuid,
            eligible: Type.Boolean(),
            intermittent: Type.Boolean(),
            leaveYearMethod: Type.String(),
            entitlementHours: Type.Number(),
            usedHours: Type.Number(),
            remainingHours: Type.Number(),
            requests: Type.Integer(),
            leaveYear: Type.Array(Type.String()),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today('UTC');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const c = await tx.maybe<FmlaCaseRow>('SELECT * FROM app.fmla_cases WHERE id = $1', [id]);
          if (!c) throw new ApiError('notFound');
          if (!can(auth.principal, 'absence.read', await loadTarget(tx, c.employee_id)))
            throw new ApiError('forbidden');
          const st = await fmlaStatus(tx, book, c, asOf);
          return {
            id,
            eligible: c.eligibility.eligible,
            intermittent: c.intermittent,
            leaveYearMethod: fmlaMethod(c.leave_year_method),
            entitlementHours: st.entitlementHours,
            usedHours: st.usedHours,
            remainingHours: st.remainingHours,
            requests: st.requests,
            leaveYear: [...st.leaveYear],
          };
        },
        { readOnly: true },
      );
    },
  );

  // ---- analytics, triggers, cover ---------------------------------------------------------------------
  app.get(
    '/v1/absence/bradford/:employeeId',
    {
      schema: {
        tags: ['absence'],
        params: Type.Object({ employeeId: Uuid }),
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({ spells: Type.Integer(), days: Type.Number(), score: Type.Number() }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = (req.query as { asOf?: string }).asOf ?? today('UTC');
      return app.tenantTx(
        req,
        async (tx) => {
          if (!can(auth.principal, 'absence.read', await loadTarget(tx, employeeId)))
            throw new ApiError('forbidden');
          const ctx = await leaveContext(tx, employeeId, asOf);
          const spells = await tx.query<{ start_date: string; end_date: string | null }>(
            `SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1`,
            [employeeId],
          );
          return bradfordFactor(
            spells.map((s) => ({ start: s.start_date, end: s.end_date ?? asOf })),
            asOf,
            ctx.pattern,
          );
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/absence/triggers',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['absence'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          bradfordThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
          spellsThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
          windowDays: Type.Optional(Type.Integer({ minimum: 7, maximum: 730 })),
          notifyRole: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{1,40}$' })),
          notifyManager: Type.Optional(Type.Boolean()),
        }),
        response: { 201: Type.Object({ id: Uuid }), 422: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'absence.manage');
      const b = req.body as {
        name: string;
        bradfordThreshold?: number;
        spellsThreshold?: number;
        windowDays?: number;
        notifyRole?: string;
        notifyManager?: boolean;
      };
      if (b.bradfordThreshold === undefined && b.spellsThreshold === undefined)
        throw new ApiError('unprocessable', 'Set a Bradford or spells threshold');
      const r = await app.tenantTx(req, async (tx) => {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.absence_triggers (tenant_id, name, bradford_threshold, spells_threshold, window_days, notify_role, notify_manager) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            b.name,
            b.bradfordThreshold ?? null,
            b.spellsThreshold ?? null,
            b.windowDays ?? 365,
            b.notifyRole ?? 'hr_admin',
            b.notifyManager ?? true,
          ],
        );
        await app.audit(tx, req, {
          action: 'absence_trigger.created',
          targetType: 'absence_trigger',
          targetId: row.id,
          diff: b,
        });
        return row;
      });
      return reply.status(201).send(r);
    },
  );

  app.get(
    '/v1/absence/triggers',
    {
      schema: {
        tags: ['absence'],
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              name: Type.String(),
              bradfordThreshold: Nullable(Type.Integer()),
              spellsThreshold: Nullable(Type.Integer()),
              windowDays: Type.Integer(),
              notifyRole: Type.String(),
              notifyManager: Type.Boolean(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'absence.manage');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            name: string;
            bradford_threshold: number | null;
            spells_threshold: number | null;
            window_days: number;
            notify_role: string;
            notify_manager: boolean;
          }>('SELECT * FROM app.absence_triggers ORDER BY name'),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        bradfordThreshold: r.bradford_threshold,
        spellsThreshold: r.spells_threshold,
        windowDays: r.window_days,
        notifyRole: r.notify_role,
        notifyManager: r.notify_manager,
      }));
    },
  );

  app.get(
    '/v1/leave/cover-rules',
    {
      schema: {
        tags: ['leave'],
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              name: Type.String(),
              departmentId: Nullable(Uuid),
              locationId: Nullable(Uuid),
              minPresent: Type.Integer(),
              enforcement: Type.String(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'leave.manage');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            name: string;
            department_id: string | null;
            location_id: string | null;
            min_present: number;
            enforcement: string;
          }>('SELECT * FROM app.cover_rules ORDER BY name'),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        departmentId: r.department_id,
        locationId: r.location_id,
        minPresent: r.min_present,
        enforcement: r.enforcement,
      }));
    },
  );

  app.get(
    '/v1/settings/company-calendars',
    {
      schema: {
        tags: ['leave'],
        summary: 'Company closure days (on top of public holidays), per entity or location',
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              name: Type.String(),
              entityId: Nullable(Uuid),
              locationId: Nullable(Uuid),
              days: Type.Array(Type.Object({ date: Type.String(), name: Type.String() })),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'leave.manage');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            name: string;
            entity_id: string | null;
            location_id: string | null;
            days: Array<{ date: string; name: string }>;
          }>('SELECT * FROM app.company_calendars ORDER BY name'),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        entityId: r.entity_id,
        locationId: r.location_id,
        days: [...r.days].sort((a, b) => compareDates(a.date, b.date)),
      }));
    },
  );

  app.post(
    '/v1/leave/cover-rules',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          departmentId: Type.Optional(Nullable(Uuid)),
          locationId: Type.Optional(Nullable(Uuid)),
          minPresent: Type.Integer({ minimum: 0 }),
          enforcement: Type.Union([Type.Literal('warn'), Type.Literal('block')]),
        }),
        response: { 201: Type.Object({ id: Uuid }) },
      },
    },
    async (req, reply) => {
      authorize(req, 'leave.manage');
      const b = req.body as {
        name: string;
        departmentId?: string | null;
        locationId?: string | null;
        minPresent: number;
        enforcement: string;
      };
      const r = await app.tenantTx(req, async (tx) => {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.cover_rules (tenant_id, name, department_id, location_id, min_present, enforcement) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [b.name, b.departmentId ?? null, b.locationId ?? null, b.minPresent, b.enforcement],
        );
        await app.audit(tx, req, {
          action: 'cover_rule.created',
          targetType: 'cover_rule',
          targetId: row.id,
          diff: b,
        });
        return row;
      });
      return reply.status(201).send(r);
    },
  );

  app.post(
    '/v1/settings/company-calendars',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['leave'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          entityId: Type.Optional(Nullable(Uuid)),
          locationId: Type.Optional(Nullable(Uuid)),
          days: Type.Array(Type.Object({ date: CivilDate, name: Type.String({ maxLength: 120 }) }), {
            maxItems: 366,
          }),
        }),
        response: { 201: Type.Object({ id: Uuid }) },
      },
    },
    async (req, reply) => {
      authorize(req, 'leave.manage');
      const b = req.body as {
        name: string;
        entityId?: string | null;
        locationId?: string | null;
        days: unknown[];
      };
      const r = await app.tenantTx(req, async (tx) => {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.company_calendars (tenant_id, name, entity_id, location_id, days) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
          [b.name, b.entityId ?? null, b.locationId ?? null, JSON.stringify(b.days)],
        );
        await app.audit(tx, req, {
          action: 'company_calendar.created',
          targetType: 'company_calendar',
          targetId: row.id,
        });
        return row;
      });
      return reply.status(201).send(r);
    },
  );
}

// ---- approval effects ------------------------------------------------------------------------------------
approvalHandlers['leave.request'] = async (tx, r) => {
  await tx.exec(
    `UPDATE app.leave_requests SET status = 'approved', decided_at = now() WHERE id = $1 AND status = 'pending'`,
    [r.payload.leaveRequestId],
  );
  const user = await userForEmployee(tx, r.subject_employee_id);
  if (user)
    await notify(tx, {
      userIds: [user],
      kind: 'leave.approved',
      titleKey: 'notify.leaveApproved',
      target: { type: 'leave_request', id: String(r.payload.leaveRequestId) },
      dedupeKey: `leave-ok:${r.payload.leaveRequestId}`,
    });
};
rejectionHandlers['leave.request'] = async (tx, r) => {
  await tx.exec(
    `UPDATE app.leave_requests SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'`,
    [r.payload.leaveRequestId],
  );
  const user = await userForEmployee(tx, r.subject_employee_id);
  if (user)
    await notify(tx, {
      userIds: [user],
      kind: 'leave.rejected',
      titleKey: 'notify.leaveRejected',
      target: { type: 'leave_request', id: String(r.payload.leaveRequestId) },
      dedupeKey: `leave-no:${r.payload.leaveRequestId}`,
    });
};

// ---- absence trigger alerts (daily, deduplicated per employee per window) ---------------------------------
registerJob('absence.triggers', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    const triggers = await tx.query<{
      id: string;
      name: string;
      bradford_threshold: number | null;
      spells_threshold: number | null;
      window_days: number;
      notify_role: string;
      notify_manager: boolean;
    }>('SELECT * FROM app.absence_triggers');
    if (!triggers.length) return { alerts: 0 };
    let alerts = 0;
    const emps = await tx.query<{ employee_id: string }>(
      `SELECT DISTINCT employee_id FROM app.sickness_records WHERE start_date >= ($1::date - 730)`,
      [date],
    );
    for (const { employee_id } of emps) {
      const spells = await tx.query<{ start_date: string; end_date: string | null }>(
        'SELECT start_date, end_date FROM app.sickness_records WHERE employee_id = $1 AND start_date <= $2',
        [employee_id, date],
      );
      const lc = await leaveContext(tx, employee_id, date);
      for (const t of triggers) {
        const bf = bradfordFactor(
          spells.map((s) => ({ start: s.start_date, end: s.end_date ?? date })),
          date,
          lc.pattern,
          t.window_days,
        );
        const hit =
          (t.bradford_threshold !== null && bf.score >= t.bradford_threshold) ||
          (t.spells_threshold !== null && bf.spells >= t.spells_threshold);
        if (!hit) continue;
        const recipients = [...(await usersWithRole(tx, t.notify_role))];
        // Small companies often have no HR admin: the owner handles HR, so the alert goes to them.
        if (!recipients.length) recipients.push(...(await usersWithRole(tx, 'owner')));
        if (t.notify_manager) {
          const m = await userForEmployee(
            tx,
            (
              await tx.maybe<{ manager_id: string | null }>(
                'SELECT manager_id FROM app.employees WHERE id = $1',
                [employee_id],
              )
            )?.manager_id,
          );
          if (m) recipients.push(m);
        }
        alerts += (
          await notify(tx, {
            userIds: [...new Set(recipients)],
            kind: 'absence.trigger',
            titleKey: 'notify.absenceTrigger',
            params: { trigger: t.name, score: bf.score },
            target: { type: 'employee', id: employee_id },
            link: personHref(employee_id, 'time-off'),
            dedupeKey: `trigger:${t.id}:${employee_id}:${bf.spells}`,
          })
        ).length;
        await writeAudit(tx, {
          actorType: 'system',
          action: 'absence.trigger_fired',
          targetType: 'employee',
          targetId: employee_id,
          diff: { trigger: t.id, score: bf.score, spells: bf.spells },
          sensitive: true,
        });
      }
    }
    return { alerts };
  });
});
periodic.push(async (tx, now) => {
  const date = now.toISOString().slice(0, 10);
  await enqueueJob(tx, 'absence.triggers', date, { date });
});
