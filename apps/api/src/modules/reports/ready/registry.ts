import { Type, type Static } from 'typebox';
import { addDays, compareDates, monthsBetween } from '@thapsus/core/time';
import type { RuleBook } from '@thapsus/rules';
import { ApiError } from '../../../http/errors';
import { CivilDate } from '../../../http/schemas';
import { leaveContext, holidaysFor, policyFor, balanceFor } from '../../leave/service';
import { leaveYearFor } from '../../leave/engine';
import { FieldGate, paramAdder, rowScope } from '../access';
import {
  computeAbsence,
  computeBradford,
  computeOvertime,
  type AbsenceFact,
  type BradfordInput,
  type TimesheetFact,
} from '../calc/absence';
import {
  computeHeadcount,
  computeHeadcountHistory,
  computeTurnover,
  RESTRICTED,
  turnoverTotal,
} from '../calc/people';
import { computeLiability } from '../calc/liability';
import { formatScaled } from '../fixed';
import { DIMENSION_PERM, employeeFacts, groupNames } from './load';
import {
  complianceStatusReportDef,
  eeo1ReportDef,
  genderPayGapReportDef,
  payTransparencyReportDef,
} from './compliance';
import {
  GROUP_BY,
  type Column,
  type GroupBy,
  type ReportContext,
  type ReportDefinition,
  type Row,
} from '../types';

/**
 * Ready-made report registry. Each report declares its parameters (TypeBox, published in OpenAPI), the
 * row-scope permission, the jurisdictions it applies to and its sensitivity; run() executes on the
 * reporting reader inside the caller's tenant context and returns typed columns + rows.
 * Calculations live in ../calc (pure, golden-tested); this file only loads facts and shapes output.
 */
const GroupByParam = Type.Union(
  GROUP_BY.map((g) => Type.Literal(g)),
  { default: 'entity' },
);
const Period = { from: CivilDate, to: CivilDate };
const MAX_PERIOD_MONTHS = 60;

function assertPeriod(from: string, to: string) {
  if (compareDates(from, to) > 0) throw new ApiError('validation', 'from must not be after to');
  if (monthsBetween(from, to) > MAX_PERIOD_MONTHS)
    throw new ApiError('validation', `The period may span at most ${MAX_PERIOD_MONTHS} months`);
}

/** Localised label for a group key (names for entities/departments/locations, codes for countries). */
function labeller(ctx: ReportContext, names: Map<string, string>) {
  return (key: string | null) => {
    if (key === RESTRICTED) return ctx.t('reports.group.restricted');
    if (key === null) return ctx.t('reports.group.unassigned');
    if (key === 'all') return ctx.t('reports.group.all');
    return names.get(key) ?? key;
  };
}

const groupColumn = (groupBy: string): Column => ({
  key: 'group',
  labelKey: `reports.groupBy.${groupBy}`,
  type: 'text',
});

// ---- headcount -----------------------------------------------------------------------------------------
const HeadcountParams = Type.Object(
  { asOf: CivilDate, groupBy: Type.Optional(GroupByParam) },
  { additionalProperties: false },
);
const headcount: ReportDefinition<Static<typeof HeadcountParams>> = {
  id: 'headcount',
  category: 'people',
  titleKey: 'reports.ready.headcount.title',
  descriptionKey: 'reports.ready.headcount.description',
  permission: 'employees.read',
  jurisdictions: ['*'],
  sensitivity: 'standard',
  params: HeadcountParams,
  status: 'available',
  async run(ctx, p) {
    const groupBy = (p.groupBy ?? 'entity') as GroupBy;
    const { facts, restricted } = await employeeFacts(ctx.tx, ctx.principal, p.asOf, p.asOf, groupBy);
    const label = labeller(ctx, await groupNames(ctx.tx, groupBy));
    const rows = computeHeadcount(facts, p.asOf, groupBy);
    const total = computeHeadcount(facts, p.asOf, 'none')[0];
    return {
      columns: [
        groupColumn(groupBy),
        { key: 'headcount', labelKey: 'reports.col.headcount', type: 'integer' },
        { key: 'fte', labelKey: 'reports.col.fte', type: 'decimal', scale: 2 },
      ],
      rows: rows.map((r) => ({ group: label(r.key), headcount: r.headcount, fte: r.fte })),
      totals: [
        { group: ctx.t('reports.total'), headcount: total?.headcount ?? 0, fte: total?.fte ?? '0.00' },
      ],
      chart: { type: 'bar', x: 'group', y: ['headcount'] },
      notes: ['reports.note.headcountDefinition', ...(restricted ? ['reports.note.restricted'] : [])],
      restricted,
    };
  },
};

const HistoryParams = Type.Object(
  {
    ...Period,
    groupBy: Type.Optional(
      Type.Union(
        GROUP_BY.map((g) => Type.Literal(g)),
        { default: 'none' },
      ),
    ),
  },
  { additionalProperties: false },
);
const headcountHistory: ReportDefinition<Static<typeof HistoryParams>> = {
  id: 'headcount-history',
  category: 'people',
  titleKey: 'reports.ready.headcountHistory.title',
  descriptionKey: 'reports.ready.headcountHistory.description',
  permission: 'employees.read',
  jurisdictions: ['*'],
  sensitivity: 'standard',
  params: HistoryParams,
  status: 'available',
  async run(ctx, p) {
    assertPeriod(p.from, p.to);
    const groupBy = (p.groupBy ?? 'none') as GroupBy;
    const { facts, restricted } = await employeeFacts(ctx.tx, ctx.principal, p.from, p.to, groupBy);
    const label = labeller(ctx, await groupNames(ctx.tx, groupBy));
    const points = computeHeadcountHistory(facts, p.from, p.to, groupBy);
    return {
      columns: [
        { key: 'date', labelKey: 'reports.col.date', type: 'date' },
        groupColumn(groupBy),
        { key: 'headcount', labelKey: 'reports.col.headcount', type: 'integer' },
        { key: 'fte', labelKey: 'reports.col.fte', type: 'decimal', scale: 2 },
      ],
      rows: points.map((r) => ({ date: r.date, group: label(r.key), headcount: r.headcount, fte: r.fte })),
      chart: { type: 'line', x: 'date', y: ['headcount'] },
      notes: [
        'reports.note.headcountDefinition',
        'reports.note.monthEnds',
        ...(restricted ? ['reports.note.restricted'] : []),
      ],
      restricted,
    };
  },
};

// ---- turnover ------------------------------------------------------------------------------------------
const TurnoverParams = Type.Object(
  {
    ...Period,
    groupBy: Type.Optional(
      Type.Union(
        GROUP_BY.map((g) => Type.Literal(g)),
        { default: 'none' },
      ),
    ),
  },
  { additionalProperties: false },
);
const turnover: ReportDefinition<Static<typeof TurnoverParams>> = {
  id: 'turnover',
  category: 'people',
  titleKey: 'reports.ready.turnover.title',
  descriptionKey: 'reports.ready.turnover.description',
  permission: 'employees.read',
  jurisdictions: ['*'],
  sensitivity: 'standard',
  params: TurnoverParams,
  status: 'available',
  async run(ctx, p) {
    assertPeriod(p.from, p.to);
    const groupBy = (p.groupBy ?? 'none') as GroupBy;
    const { facts, restricted } = await employeeFacts(ctx.tx, ctx.principal, p.from, p.to, groupBy);
    const label = labeller(ctx, await groupNames(ctx.tx, groupBy));
    const rows = computeTurnover(facts, p.from, p.to, groupBy);
    const shape = (r: ReturnType<typeof turnoverTotal>, group: string): Row => ({
      group,
      headcountStart: r.headcountStart,
      headcountEnd: r.headcountEnd,
      averageHeadcount: r.averageHeadcount,
      leavers: r.leavers,
      voluntary: r.voluntary,
      involuntary: r.involuntary,
      otherOrUnknown: r.otherOrUnknown,
      turnoverRate: r.turnoverRate,
      voluntaryRate: r.voluntaryRate,
    });
    return {
      columns: [
        groupColumn(groupBy),
        { key: 'headcountStart', labelKey: 'reports.col.headcountStart', type: 'integer' },
        { key: 'headcountEnd', labelKey: 'reports.col.headcountEnd', type: 'integer' },
        { key: 'averageHeadcount', labelKey: 'reports.col.averageHeadcount', type: 'decimal', scale: 1 },
        { key: 'leavers', labelKey: 'reports.col.leavers', type: 'integer' },
        { key: 'voluntary', labelKey: 'reports.col.voluntary', type: 'integer' },
        { key: 'involuntary', labelKey: 'reports.col.involuntary', type: 'integer' },
        { key: 'otherOrUnknown', labelKey: 'reports.col.otherOrUnknown', type: 'integer' },
        { key: 'turnoverRate', labelKey: 'reports.col.turnoverRate', type: 'percent', scale: 2 },
        { key: 'voluntaryRate', labelKey: 'reports.col.voluntaryRate', type: 'percent', scale: 2 },
      ],
      rows: rows.map((r) => shape(r, label(r.key))),
      totals: [shape(turnoverTotal(rows), ctx.t('reports.total'))],
      chart: { type: 'bar', x: 'group', y: ['turnoverRate'] },
      notes: ['reports.note.turnoverMethod', ...(restricted ? ['reports.note.restricted'] : [])],
      restricted,
    };
  },
};

// ---- absence -------------------------------------------------------------------------------------------
const ABSENCE_GROUPS = ['type', 'employee', 'entity', 'department', 'location', 'country'] as const;
const AbsenceParams = Type.Object(
  {
    ...Period,
    groupBy: Type.Optional(
      Type.Union(
        ABSENCE_GROUPS.map((g) => Type.Literal(g)),
        { default: 'type' },
      ),
    ),
  },
  { additionalProperties: false },
);
export const ABSENCE_CATEGORIES = ['sickness', 'unpaid', 'family', 'fmla', 'other'];

export function bradfordEnabled(features: Record<string, unknown>): boolean {
  return (features.reports as { bradfordFactor?: boolean } | undefined)?.bradfordFactor === true;
}

const absence: ReportDefinition<Static<typeof AbsenceParams>> = {
  id: 'absence',
  category: 'absence',
  titleKey: 'reports.ready.absence.title',
  descriptionKey: 'reports.ready.absence.description',
  permission: 'absence.read',
  jurisdictions: ['*'],
  sensitivity: 'special',
  params: AbsenceParams,
  status: 'available',
  async run(ctx, p) {
    assertPeriod(p.from, p.to);
    const groupBy = (p.groupBy ?? 'type') as (typeof ABSENCE_GROUPS)[number];
    const params: unknown[] = [];
    const add = paramAdder(params);
    const scope = rowScope(ctx.principal, 'absence.read', params);
    const rows = await ctx.tx.query<{
      employee_id: string;
      display_name: string;
      employee_number: string;
      entity_id: string | null;
      country: string | null;
      department_id: string | null;
      location_id: string | null;
      type_key: string;
      category: string;
      start_date: string;
      end_date: string;
      start_half: 'am' | 'pm' | null;
      end_half: 'am' | 'pm' | null;
    }>(
      `SELECT r.employee_id, e.display_name, e.employee_number, e.entity_id, e.country, e.department_id, e.location_id, t.key AS type_key, t.category,
              r.start_date, r.end_date, r.start_half, r.end_half
         FROM app.leave_requests r
         JOIN app.employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id
         JOIN app.leave_types t ON t.tenant_id = r.tenant_id AND t.id = r.leave_type_id
        WHERE ${scope} AND r.status = 'approved' AND t.category = ANY(${add(ABSENCE_CATEGORIES)}::text[])
          AND r.start_date <= ${add(p.to)}::date AND r.end_date >= ${add(p.from)}::date
        ORDER BY r.employee_id, r.start_date`,
      params,
    );
    const gate = await FieldGate.create(ctx.tx, ctx.principal);
    const perEmployee = new Map<
      string,
      { pattern: Awaited<ReturnType<typeof leaveContext>>['pattern']; holidays: string[] }
    >();
    const ids = [...new Set(rows.map((r) => r.employee_id))];
    let done = 0;
    for (const id of ids) {
      const lc = await leaveContext(ctx.tx, id, p.from);
      perEmployee.set(id, {
        pattern: lc.pattern,
        holidays: await holidaysFor(ctx.tx, ctx.book, lc, p.from, p.to),
      });
      if (++done % 200 === 0) await ctx.progress?.(done, ids.length);
    }
    let restricted = 0;
    const dimPerm =
      groupBy === 'type' ? null : groupBy === 'employee' ? 'displayName' : DIMENSION_PERM[groupBy];
    const facts: AbsenceFact[] = rows.map((r) => {
      let group: string | null = 'all';
      if (dimPerm) {
        const target = gate.target({ id: r.employee_id, ...r });
        if (!gate.readable(dimPerm, target)) {
          restricted++;
          group = RESTRICTED;
        } else
          group =
            groupBy === 'employee'
              ? r.employee_id
              : (
                  {
                    entity: r.entity_id,
                    department: r.department_id,
                    location: r.location_id,
                    country: r.country,
                  } as Record<string, string | null>
                )[groupBy]!;
      }
      const e = perEmployee.get(r.employee_id)!;
      return {
        employeeId: r.employee_id,
        group,
        leaveType: r.type_key,
        start: r.start_date,
        end: r.end_date,
        startHalf: r.start_half,
        endHalf: r.end_half,
        pattern: e.pattern,
        holidays: e.holidays,
      };
    });
    const byType = groupBy !== 'employee';
    const result = computeAbsence(facts, p.from, p.to, byType);
    const names =
      groupBy === 'employee'
        ? new Map(rows.map((r) => [r.employee_id, `${r.display_name} (${r.employee_number})`]))
        : await groupNames(ctx.tx, groupBy as GroupBy);
    const label = labeller(ctx, names);
    const withBradford = groupBy === 'employee' && bradfordEnabled(ctx.tenant.features);
    let bradford = new Map<string, { spells: number; days: string; score: string }>();
    if (withBradford) {
      const sp = await ctx.tx.query<{ employee_id: string; start_date: string; end_date: string | null }>(
        `SELECT employee_id, start_date, end_date FROM app.sickness_records WHERE employee_id = ANY($1::uuid[]) AND start_date <= $2`,
        [ids, p.to],
      );
      const inputs: BradfordInput[] = ids.map((id) => ({
        employeeId: id,
        pattern: perEmployee.get(id)!.pattern,
        spells: sp.filter((s) => s.employee_id === id).map((s) => ({ start: s.start_date, end: s.end_date })),
      }));
      bradford = computeBradford(inputs, p.to);
    }
    const columns: Column[] = [
      groupColumn(groupBy === 'type' ? 'type' : groupBy),
      ...(byType && groupBy !== 'type'
        ? [{ key: 'leaveType', labelKey: 'reports.col.leaveType', type: 'text' as const }]
        : []),
      { key: 'spells', labelKey: 'reports.col.spells', type: 'integer' },
      { key: 'employees', labelKey: 'reports.col.employees', type: 'integer' },
      { key: 'daysLost', labelKey: 'reports.col.daysLost', type: 'decimal', scale: 2 },
      { key: 'hoursLost', labelKey: 'reports.col.hoursLost', type: 'decimal', scale: 2 },
      ...(withBradford
        ? [
            {
              key: 'bradfordFactor',
              labelKey: 'reports.col.bradfordFactor',
              type: 'decimal' as const,
              scale: 2,
              sensitive: true,
            },
          ]
        : []),
    ];
    const typeNames = new Map(
      (
        await ctx.tx.query<{ key: string; name: Record<string, string> }>(
          'SELECT key, name FROM app.leave_types',
        )
      ).map((x) => [x.key, x.name]),
    );
    const typeLabel = (k: string | null) =>
      k ? (typeNames.get(k)?.[ctx.locale] ?? typeNames.get(k)?.['en-GB'] ?? k) : '';
    return {
      columns,
      rows: result.map((r) => ({
        group: groupBy === 'type' ? typeLabel(r.leaveType) : label(r.key),
        ...(byType && groupBy !== 'type' ? { leaveType: typeLabel(r.leaveType) } : {}),
        spells: r.spells,
        employees: r.employees,
        daysLost: r.daysLost,
        hoursLost: r.hoursLost,
        ...(withBradford
          ? { bradfordFactor: r.key && r.key !== RESTRICTED ? (bradford.get(r.key)?.score ?? '0.00') : null }
          : {}),
      })),
      chart: { type: 'bar', x: 'group', y: ['daysLost'] },
      notes: [
        'reports.note.absenceMethod',
        ...(withBradford ? ['reports.note.bradford'] : []),
        ...(restricted ? ['reports.note.restricted'] : []),
      ],
      restricted,
      sensitive: true,
    };
  },
};

// ---- holiday liability -----------------------------------------------------------------------------------
const LiabilityParams = Type.Object(
  {
    asOf: CivilDate,
    groupBy: Type.Optional(GroupByParam),
    leaveType: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{1,40}$', default: 'annual' })),
  },
  { additionalProperties: false },
);
const holidayLiability: ReportDefinition<Static<typeof LiabilityParams>> = {
  id: 'holiday-liability',
  category: 'pay',
  titleKey: 'reports.ready.holidayLiability.title',
  descriptionKey: 'reports.ready.holidayLiability.description',
  permission: 'leave.read',
  jurisdictions: ['*'],
  sensitivity: 'personal',
  params: LiabilityParams,
  status: 'available',
  async run(ctx, p) {
    const groupBy = (p.groupBy ?? 'entity') as GroupBy;
    const type = await ctx.tx.maybe<{ id: string }>('SELECT id FROM app.leave_types WHERE key = $1', [
      p.leaveType ?? 'annual',
    ]);
    if (!type) throw new ApiError('validation', 'Unknown leave type');
    const params: unknown[] = [];
    const add = paramAdder(params);
    const scope = rowScope(ctx.principal, 'leave.read', params);
    const emps = await ctx.tx.query<{
      id: string;
      entity_id: string | null;
      country: string | null;
      department_id: string | null;
      location_id: string | null;
      amount_minor: string | null;
      currency: string | null;
      frequency: 'annual' | 'monthly' | 'weekly' | 'daily' | 'hourly' | null;
      job_entity: string | null;
      job_department: string | null;
      job_location: string | null;
      job_country: string | null;
    }>(
      `SELECT e.id, e.entity_id, e.country, e.department_id, e.location_id, pay.amount_minor, pay.currency, pay.frequency,
              j.entity_id AS job_entity, j.department_id AS job_department, j.location_id AS job_location, coalesce(l.country, le.country) AS job_country
         FROM app.employees e
         LEFT JOIN app.employee_pay pay ON pay.tenant_id = e.tenant_id AND pay.employee_id = e.id AND pay.valid_from <= ${add(p.asOf)}::date AND (pay.valid_to IS NULL OR pay.valid_to > $${params.length}::date)
         LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= $${params.length}::date AND (j.valid_to IS NULL OR j.valid_to > $${params.length}::date)
         LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = j.location_id
         LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = j.entity_id
        WHERE ${scope} AND e.start_date <= $${params.length}::date AND (e.end_date IS NULL OR e.end_date >= $${params.length}::date)
        ORDER BY e.id`,
      params,
    );
    const gate = await FieldGate.create(ctx.tx, ctx.principal);
    const acc = new Map<
      string,
      { group: string | null; currency: string | null; employees: number; untaken: bigint; liability: bigint }
    >();
    let restricted = 0;
    let done = 0;
    for (const e of emps) {
      const lc = await leaveContext(ctx.tx, e.id, p.asOf);
      const policy = await policyFor(ctx.tx, lc, type.id, p.asOf);
      if (++done % 200 === 0) await ctx.progress?.(done, emps.length);
      if (!policy) continue;
      const [ys, ye] = leaveYearFor(p.asOf, policy.config.yearStart);
      const holidays = await holidaysFor(ctx.tx, ctx.book, lc, ys, ye);
      const requests = await ctx.tx.query<{
        start_date: string;
        end_date: string;
        status: 'approved' | 'pending';
        start_half: 'am' | 'pm' | null;
        end_half: 'am' | 'pm' | null;
      }>(
        `SELECT start_date, end_date, status, start_half, end_half FROM app.leave_requests WHERE employee_id = $1 AND leave_type_id = $2 AND status IN ('pending', 'approved') AND start_date < $4 AND end_date >= $3`,
        [e.id, type.id, ys, ye],
      );
      const adjustments = await ctx.tx.query<{ amount: string; effective_date: string }>(
        `SELECT amount, effective_date FROM app.leave_adjustments WHERE employee_id = $1 AND leave_type_id = $2 AND effective_date >= $3 AND effective_date < $4`,
        [e.id, type.id, ys, ye],
      );
      let carriedIn = 0;
      if (policy.config.carryOver?.maxDays && lc.startDate < ys)
        carriedIn = Math.max(
          0,
          (await balanceFor(ctx.tx, ctx.book, e.id, type.id, addDays(ys, -1), 1))?.available ?? 0,
        );
      const target = gate.target(e);
      const payReadable = gate.readable('pay.amount', target);
      const groupReadable = groupBy === 'none' || gate.readable(DIMENSION_PERM[groupBy], target);
      if (!payReadable || !groupReadable) restricted++;
      const r = computeLiability({
        policy: policy.config,
        employee: { startDate: lc.startDate, endDate: lc.endDate, fte: lc.fte },
        asOf: p.asOf,
        yearStart: ys,
        pattern: lc.pattern,
        holidays,
        requests: requests.map((x) => ({
          start: x.start_date,
          end: x.end_date,
          status: x.status,
          startHalf: x.start_half ?? undefined,
          endHalf: x.end_half ?? undefined,
        })),
        adjustments: adjustments.map((a) => ({ days: Number(a.amount), effectiveDate: a.effective_date })),
        carriedIn,
        pay:
          payReadable && e.amount_minor && e.currency && e.frequency
            ? { amountMinor: e.amount_minor, currency: e.currency.trim(), frequency: e.frequency }
            : null,
      });
      const group = !groupReadable
        ? RESTRICTED
        : groupBy === 'none'
          ? 'all'
          : (
              {
                entity: e.job_entity,
                department: e.job_department,
                location: e.job_location,
                country: e.job_country?.trim() ?? null,
              } as Record<string, string | null>
            )[groupBy]!;
      const currency = r.liabilityMinor === null ? null : r.currency;
      const k = JSON.stringify([group, currency]);
      const a = acc.get(k) ?? { group, currency, employees: 0, untaken: 0n, liability: 0n };
      a.employees++;
      a.untaken += r.untakenE4;
      if (r.liabilityMinor !== null) a.liability += r.liabilityMinor;
      acc.set(k, a);
    }
    const label = labeller(ctx, await groupNames(ctx.tx, groupBy));
    const rows = [...acc.values()].sort(
      (x, y) =>
        label(x.group).localeCompare(label(y.group)) || String(x.currency).localeCompare(String(y.currency)),
    );
    const totals = new Map<string, bigint>();
    for (const r of rows)
      if (r.currency) totals.set(r.currency, (totals.get(r.currency) ?? 0n) + r.liability);
    return {
      columns: [
        groupColumn(groupBy),
        { key: 'employees', labelKey: 'reports.col.employees', type: 'integer' },
        { key: 'untakenDays', labelKey: 'reports.col.untaken', type: 'decimal', scale: 2 },
        { key: 'liability', labelKey: 'reports.col.liability', type: 'money', sensitive: true },
      ],
      rows: rows.map((r) => ({
        group: label(r.group),
        employees: r.employees,
        untakenDays: formatScaled(r.untaken, 4, 2),
        liability: r.currency ? { amountMinor: r.liability.toString(), currency: r.currency } : null,
      })),
      totals: [...totals.entries()].sort().map(([currency, v]) => ({
        group: ctx.t('reports.totalIn', { currency }),
        employees: null,
        untakenDays: null,
        liability: { amountMinor: v.toString(), currency },
      })),
      chart: { type: 'bar', x: 'group', y: ['untakenDays'] },
      notes: [
        'reports.note.liabilityMethod',
        'reports.note.liabilityRounding',
        ...(restricted ? ['reports.note.restricted'] : []),
      ],
      restricted,
    };
  },
};

// ---- overtime ------------------------------------------------------------------------------------------
const OVERTIME_GROUPS = ['employee', 'week', 'entity', 'department', 'location', 'country'] as const;
const OvertimeParams = Type.Object(
  {
    ...Period,
    groupBy: Type.Optional(
      Type.Union(
        OVERTIME_GROUPS.map((g) => Type.Literal(g)),
        { default: 'department' },
      ),
    ),
  },
  { additionalProperties: false },
);
const overtime: ReportDefinition<Static<typeof OvertimeParams>> = {
  id: 'overtime',
  category: 'time',
  titleKey: 'reports.ready.overtime.title',
  descriptionKey: 'reports.ready.overtime.description',
  permission: 'time.read',
  jurisdictions: ['*'],
  sensitivity: 'standard',
  params: OvertimeParams,
  status: 'available',
  async run(ctx, p) {
    assertPeriod(p.from, p.to);
    const groupBy = (p.groupBy ?? 'department') as (typeof OVERTIME_GROUPS)[number];
    const params: unknown[] = [];
    const add = paramAdder(params);
    const scope = rowScope(ctx.principal, 'time.read', params);
    const rows = await ctx.tx.query<{
      employee_id: string;
      display_name: string;
      employee_number: string;
      entity_id: string | null;
      country: string | null;
      department_id: string | null;
      location_id: string | null;
      week_start: string;
      worked_minutes: number;
      regular_minutes: number;
      overtime_minutes: number;
      double_minutes: number;
      scheduled_minutes: number;
      job_entity: string | null;
      job_department: string | null;
      job_location: string | null;
      job_country: string | null;
    }>(
      `SELECT t.employee_id, e.display_name, e.employee_number, e.entity_id, e.country, e.department_id, e.location_id, t.week_start,
              t.worked_minutes, t.regular_minutes, t.overtime_minutes, t.double_minutes, t.scheduled_minutes,
              j.entity_id AS job_entity, j.department_id AS job_department, j.location_id AS job_location, coalesce(l.country, le.country) AS job_country
         FROM app.timesheets t
         JOIN app.employees e ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
         LEFT JOIN app.employee_jobs j ON j.tenant_id = t.tenant_id AND j.employee_id = t.employee_id AND j.valid_from <= t.week_start AND (j.valid_to IS NULL OR j.valid_to > t.week_start)
         LEFT JOIN app.locations l ON l.tenant_id = t.tenant_id AND l.id = j.location_id
         LEFT JOIN app.legal_entities le ON le.tenant_id = t.tenant_id AND le.id = j.entity_id
        WHERE ${scope} AND t.status = 'approved' AND t.week_start >= ${add(p.from)}::date AND t.week_start <= ${add(p.to)}::date
        ORDER BY t.employee_id, t.week_start`,
      params,
    );
    const gate = await FieldGate.create(ctx.tx, ctx.principal);
    let restricted = 0;
    const dimPerm =
      groupBy === 'week' ? null : groupBy === 'employee' ? 'displayName' : DIMENSION_PERM[groupBy];
    const facts: TimesheetFact[] = rows.map((r) => {
      let group: string | null = r.week_start;
      if (dimPerm) {
        if (!gate.readable(dimPerm, gate.target({ id: r.employee_id, ...r }))) {
          restricted++;
          group = RESTRICTED;
        } else
          group =
            groupBy === 'employee'
              ? r.employee_id
              : (
                  {
                    entity: r.job_entity,
                    department: r.job_department,
                    location: r.job_location,
                    country: r.job_country?.trim() ?? null,
                  } as Record<string, string | null>
                )[groupBy]!;
      }
      return {
        employeeId: r.employee_id,
        group,
        weekStart: r.week_start,
        workedMinutes: r.worked_minutes,
        regularMinutes: r.regular_minutes,
        overtimeMinutes: r.overtime_minutes,
        doubleMinutes: r.double_minutes,
        scheduledMinutes: r.scheduled_minutes,
      };
    });
    const names =
      groupBy === 'employee'
        ? new Map(rows.map((r) => [r.employee_id, `${r.display_name} (${r.employee_number})`]))
        : groupBy === 'week'
          ? new Map<string, string>()
          : await groupNames(ctx.tx, groupBy as GroupBy);
    const label = labeller(ctx, names);
    const result = computeOvertime(facts, p.from, p.to);
    const total = computeOvertime(
      facts.map((f) => ({ ...f, group: 'all' })),
      p.from,
      p.to,
    )[0];
    const shape = (r: (typeof result)[number], group: string): Row => ({
      group,
      timesheets: r.timesheets,
      employees: r.employees,
      workedMinutes: r.workedMinutes,
      regularMinutes: r.regularMinutes,
      overtimeMinutes: r.overtimeMinutes,
      doubleMinutes: r.doubleMinutes,
      scheduledMinutes: r.scheduledMinutes,
      overtimeShare: r.overtimeShare,
    });
    return {
      columns: [
        groupBy === 'week'
          ? { key: 'group', labelKey: 'reports.groupBy.week', type: 'date' }
          : groupColumn(groupBy),
        { key: 'timesheets', labelKey: 'reports.col.timesheets', type: 'integer' },
        { key: 'employees', labelKey: 'reports.col.employees', type: 'integer' },
        { key: 'workedMinutes', labelKey: 'reports.col.worked', type: 'minutes' },
        { key: 'regularMinutes', labelKey: 'reports.col.regular', type: 'minutes' },
        { key: 'overtimeMinutes', labelKey: 'reports.col.overtime', type: 'minutes' },
        { key: 'doubleMinutes', labelKey: 'reports.col.double', type: 'minutes' },
        { key: 'scheduledMinutes', labelKey: 'reports.col.scheduled', type: 'minutes' },
        { key: 'overtimeShare', labelKey: 'reports.col.overtimeShare', type: 'percent', scale: 2 },
      ],
      rows: result.map((r) => shape(r, groupBy === 'week' ? String(r.key) : label(r.key))),
      totals: total ? [shape(total, ctx.t('reports.total'))] : [],
      chart: { type: groupBy === 'week' ? 'line' : 'bar', x: 'group', y: ['overtimeMinutes'] },
      notes: ['reports.note.overtimeMethod', ...(restricted ? ['reports.note.restricted'] : [])],
      restricted,
    };
  },
};

export const READY_REPORTS: ReportDefinition[] = [
  headcount,
  headcountHistory,
  turnover,
  absence,
  holidayLiability,
  overtime,
  complianceStatusReportDef,
  genderPayGapReportDef,
  eeo1ReportDef,
  payTransparencyReportDef,
] as ReportDefinition[];

export function readyReport(id: string): ReportDefinition {
  const def = READY_REPORTS.find((r) => r.id === id);
  if (!def) throw new ApiError('notFound');
  return def;
}

/** Jurisdictions a tenant operates in (its legal entities' countries), resolved through the packs' layering. */
export function tenantJurisdictions(book: RuleBook, countries: string[]): Set<string> {
  const out = new Set<string>(['*']);
  for (const c of countries) {
    const chain = book.chain(c);
    if (chain.includes('GB')) out.add('GB');
    if (chain.includes('US')) out.add('US');
    if (chain.includes('EU')) out.add('EU');
  }
  return out;
}
