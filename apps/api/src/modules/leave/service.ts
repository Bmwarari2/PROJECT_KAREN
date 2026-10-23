import type { Tx } from '@thapsus/db';
import {
  addDays,
  compareDates,
  dateParts,
  dayOfWeek,
  daysBetween,
  eachDay,
  maxDate,
  minDate,
  today,
} from '@thapsus/core/time';
import type { RuleBook } from '@thapsus/rules';
import { ApiError } from '../../http/errors';
import {
  computeBalance,
  dailyHours,
  fmlaLeaveYear,
  leaveYearFor,
  requestAmount,
  type FmlaRule,
  type LeavePolicy,
  type PolicyPeriod,
  type WorkPattern,
} from './engine';

export interface LeaveContext {
  employeeId: string;
  startDate: string;
  endDate: string | null;
  fte: number;
  pattern: WorkPattern;
  country: string | null;
  region: string | null;
  entityId: string | null;
  locationId: string | null;
  departmentId: string | null;
}

export async function leaveContext(tx: Tx, employeeId: string, date: string): Promise<LeaveContext> {
  const e = await tx.maybe<{
    start_date: string;
    end_date: string | null;
    country: string | null;
    region_code: string | null;
    entity_id: string | null;
    location_id: string | null;
    department_id: string | null;
    fte: string | null;
    weekly_hours: string | null;
    work_pattern: WorkPattern | null;
    job_entity: string | null;
    job_location: string | null;
  }>(
    `SELECT e.start_date, e.end_date, e.country, e.region_code, e.entity_id, e.location_id, e.department_id, j.fte, j.weekly_hours, j.work_pattern, j.entity_id AS job_entity, j.location_id AS job_location
       FROM app.employees e LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= $2 AND (j.valid_to IS NULL OR j.valid_to > $2)
      WHERE e.id = $1`,
    [employeeId, date],
  );
  if (!e) throw new ApiError('notFound');
  let country = e.country;
  let region = e.region_code;
  if ((!country || !region) && e.job_entity) {
    const ent = await tx.maybe<{ country: string; region_code: string | null }>(
      'SELECT country, region_code FROM app.legal_entities WHERE id = $1',
      [e.job_entity],
    );
    country = country ?? ent?.country ?? null;
    region = region ?? ent?.region_code ?? null;
  }
  const weekly = e.weekly_hours ? Number(e.weekly_hours) : 37.5 * Number(e.fte ?? 1);
  return {
    employeeId,
    startDate: e.start_date,
    endDate: e.end_date,
    fte: Number(e.fte ?? 1),
    pattern: e.work_pattern ?? dailyHours(weekly, 5),
    country,
    region,
    entityId: e.job_entity ?? e.entity_id,
    locationId: e.job_location ?? e.location_id,
    departmentId: e.department_id,
  };
}

/** Public holidays (observed days off) plus company closure days for the employee, for a date range. */
export async function holidaysFor(
  tx: Tx,
  book: RuleBook,
  ctx: LeaveContext,
  from: string,
  to: string,
): Promise<string[]> {
  const out = new Set<string>();
  if (ctx.country) {
    for (let y = dateParts(from).year; y <= dateParts(to).year; y++)
      for (const d of book.daysOff(ctx.country, y, ctx.region ?? undefined)) out.add(d);
  }
  const cals = await tx.query<{ days: Array<{ date: string }> }>(
    `SELECT days FROM app.company_calendars WHERE (entity_id IS NULL AND location_id IS NULL) OR entity_id = $1 OR location_id = $2`,
    [ctx.entityId, ctx.locationId],
  );
  for (const c of cals) for (const d of c.days) out.add(d.date);
  return [...out].filter((d) => d >= from && d <= to).sort();
}

export interface PolicyRow {
  id: string;
  name: string;
  leave_type_id: string;
  config: LeavePolicy;
  effective_from: string;
  effective_to: string | null;
}

/** Assigned policy, else the most specific default (entity → country → any) for the leave type. */
export async function policyFor(
  tx: Tx,
  ctx: LeaveContext,
  leaveTypeId: string,
  date: string,
): Promise<PolicyRow | undefined> {
  const assigned = await tx.maybe<PolicyRow>(
    `SELECT p.* FROM app.leave_policy_assignments a JOIN app.leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id
      WHERE a.employee_id = $1 AND a.leave_type_id = $2 AND a.valid_from <= $3 AND (a.valid_to IS NULL OR a.valid_to > $3)`,
    [ctx.employeeId, leaveTypeId, date],
  );
  if (assigned) return assigned;
  return tx.maybe<PolicyRow>(
    `SELECT * FROM app.leave_policies WHERE leave_type_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
       AND (entity_id IS NULL OR entity_id = $3) AND (country IS NULL OR country = $4)
     ORDER BY (entity_id IS NOT NULL) DESC, (country IS NOT NULL) DESC, created_at LIMIT 1`,
    [leaveTypeId, date, ctx.entityId, ctx.country],
  );
}

/**
 * The leave year split wherever the applicable policy (assignment or default) or the employee's FTE
 * changes, so entitlement is summed over each part (ADR-0029).
 */
export async function policyPeriods(
  tx: Tx,
  ctx: LeaveContext,
  leaveTypeId: string,
  ys: string,
  ye: string,
): Promise<Array<{ from: string; to: string; row: PolicyRow; fte: number }>> {
  const cuts = new Set([ys, ye]);
  const add = (d: string | null) => {
    if (d && d > ys && d < ye) cuts.add(d);
  };
  const ranges = [
    ...(await tx.query<{ f: string; t: string | null }>(
      `SELECT valid_from AS f, valid_to AS t FROM app.leave_policy_assignments WHERE employee_id = $1 AND leave_type_id = $2 AND valid_from < $4 AND (valid_to IS NULL OR valid_to > $3)`,
      [ctx.employeeId, leaveTypeId, ys, ye],
    )),
    ...(await tx.query<{ f: string; t: string | null }>(
      `SELECT effective_from AS f, effective_to AS t FROM app.leave_policies WHERE leave_type_id = $1 AND effective_from < $3 AND (effective_to IS NULL OR effective_to > $2)`,
      [leaveTypeId, ys, ye],
    )),
  ];
  const jobs = await tx.query<{ f: string; t: string | null; fte: string }>(
    `SELECT valid_from AS f, valid_to AS t, fte FROM app.employee_jobs WHERE employee_id = $1 AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from`,
    [ctx.employeeId, ys, ye],
  );
  for (const r of [...ranges, ...jobs]) {
    add(r.f);
    add(r.t);
  }
  const points = [...cuts].sort();
  const out: Array<{ from: string; to: string; row: PolicyRow; fte: number }> = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [from, to] = [points[k]!, points[k + 1]!];
    const row = await policyFor(tx, ctx, leaveTypeId, from);
    if (!row) continue;
    const job = jobs.find((j) => j.f <= from && (j.t === null || j.t > from));
    const fte = job ? Number(job.fte) : ctx.fte;
    const prev = out.at(-1);
    if (prev && prev.row.id === row.id && prev.fte === fte && prev.to === from) prev.to = to;
    else out.push({ from, to, row, fte });
  }
  return out;
}

export type HoursSource = 'timesheets' | 'recorded' | 'estimated' | 'none';

/**
 * Hours worked in [from, to): approved timesheets when the time-tracking module's table exists and has
 * weeks in the range; else hours recorded in app.worked_hours (pro-rated by days for partial overlaps);
 * else, only when `estimate` is given, the working pattern over the days employed; else none (ADR-0030).
 */
export async function hoursWorked(
  tx: Tx,
  employeeId: string,
  from: string,
  to: string,
  estimate?: { pattern: WorkPattern; startDate: string; endDate: string | null },
): Promise<{ hours: number; source: HoursSource }> {
  if (compareDates(from, to) >= 0) return { hours: 0, source: 'none' };
  const hasTimesheets = (
    await tx.one<{ ok: boolean }>(`SELECT to_regclass('app.timesheets') IS NOT NULL AS ok`)
  ).ok;
  if (hasTimesheets) {
    const t = await tx.one<{ n: number; m: string | null }>(
      `SELECT count(*)::int AS n, sum(regular_minutes + overtime_minutes + double_minutes) AS m FROM app.timesheets WHERE employee_id = $1 AND status = 'approved' AND week_start >= $2 AND week_start < $3`,
      [employeeId, from, to],
    );
    if (t.n > 0) return { hours: Math.round(Number(t.m ?? 0) / 0.6) / 100, source: 'timesheets' };
  }
  const rows = await tx.query<{ period_start: string; period_end: string; minutes: number }>(
    `SELECT period_start, period_end, minutes FROM app.worked_hours WHERE employee_id = $1 AND period_start < $3 AND period_end > $2`,
    [employeeId, from, to],
  );
  if (rows.length) {
    let minutes = 0;
    for (const r of rows) {
      const overlap = daysBetween(maxDate(r.period_start, from), minDate(r.period_end, to));
      minutes += (r.minutes * overlap) / daysBetween(r.period_start, r.period_end);
    }
    return { hours: Math.round(minutes / 0.6) / 100, source: 'recorded' };
  }
  if (!estimate) return { hours: 0, source: 'none' };
  const a = maxDate(from, estimate.startDate);
  const b = estimate.endDate ? minDate(to, addDays(estimate.endDate, 1)) : to;
  if (compareDates(a, b) >= 0) return { hours: 0, source: 'estimated' };
  let hours = 0;
  for (const d of eachDay(a, addDays(b, -1))) hours += estimate.pattern[dayOfWeek(d) as 1] ?? 0;
  return { hours: Math.round(hours * 100) / 100, source: 'estimated' };
}

export async function balanceFor(
  tx: Tx,
  book: RuleBook,
  employeeId: string,
  leaveTypeId: string,
  asOf: string,
  depth = 0,
): Promise<(ReturnType<typeof computeBalance> & { policy: string; year: [string, string] }) | undefined> {
  const ctx = await leaveContext(tx, employeeId, asOf);
  const policy = await policyFor(tx, ctx, leaveTypeId, asOf);
  if (!policy) return undefined;
  const [ys, ye] = leaveYearFor(asOf, policy.config.yearStart);
  const year = dateParts(ys).year;
  const segments = await policyPeriods(tx, ctx, leaveTypeId, ys, ye);
  const periods: PolicyPeriod[] = [];
  for (const s of segments) {
    let worked: number | undefined;
    if (s.row.config.accrual.method === 'per_hour_worked')
      worked = (await hoursWorked(tx, employeeId, s.from, minDate(s.to, addDays(asOf, 1)))).hours;
    periods.push({ from: s.from, to: s.to, policy: s.row.config, fte: s.fte, hoursWorked: worked });
  }
  const holidays = await holidaysFor(tx, book, ctx, ys, ye);
  const requests = await tx.query<{
    start_date: string;
    end_date: string;
    status: 'approved' | 'pending';
    start_half: 'am' | 'pm' | null;
    end_half: 'am' | 'pm' | null;
    hours: string | null;
  }>(
    `SELECT start_date, end_date, status, start_half, end_half, CASE WHEN start_date = end_date AND explicit_hours THEN amount_hours END AS hours
       FROM app.leave_requests WHERE employee_id = $1 AND leave_type_id = $2 AND status IN ('pending', 'approved') AND start_date < $4 AND end_date >= $3`,
    [employeeId, leaveTypeId, ys, ye],
  );
  const adjustments = await tx.query<{ amount: string; effective_date: string }>(
    `SELECT amount, effective_date FROM app.leave_adjustments WHERE employee_id = $1 AND leave_type_id = $2 AND effective_date >= $3 AND effective_date < $4`,
    [employeeId, leaveTypeId, ys, ye],
  );
  // Carry-over: what was left at the end of the previous leave year (one level deep).
  let carriedIn = 0;
  if (depth === 0 && policy.config.carryOver?.maxDays && ctx.startDate < ys) {
    const prevEnd = await balanceFor(tx, book, employeeId, leaveTypeId, addDays(ys, -1), 1);
    carriedIn = Math.max(0, prevEnd?.available ?? 0);
  }
  const b = computeBalance({
    policy: policy.config,
    periods,
    employee: { startDate: ctx.startDate, endDate: ctx.endDate, fte: ctx.fte },
    year,
    asOf,
    pattern: ctx.pattern,
    holidays,
    requests: requests.map((r) => ({
      start: r.start_date,
      end: r.end_date,
      status: r.status,
      startHalf: r.start_half ?? undefined,
      endHalf: r.end_half ?? undefined,
      hours: r.hours === null ? undefined : Number(r.hours),
    })),
    adjustments: adjustments.map((a) => ({ days: Number(a.amount), effectiveDate: a.effective_date })),
    carriedIn,
  });
  return { ...b, policy: policy.name, year: [ys, ye] };
}

export async function amountFor(
  tx: Tx,
  book: RuleBook,
  employeeId: string,
  start: string,
  end: string,
  startHalf?: 'am' | 'pm',
  endHalf?: 'am' | 'pm',
  hours?: number,
) {
  const ctx = await leaveContext(tx, employeeId, start);
  const holidays = await holidaysFor(tx, book, ctx, start, end);
  return requestAmount({ start, end, pattern: ctx.pattern, holidays, startHalf, endHalf, hours });
}

const DEFAULT_TYPES: Array<[key: string, name: string, category: string, paid: boolean, approval: boolean]> =
  [
    ['annual', 'Annual leave', 'annual', true, true],
    ['sickness', 'Sickness', 'sickness', true, false],
    ['unpaid', 'Unpaid leave', 'unpaid', false, true],
    ['family', 'Family leave', 'family', true, true],
    ['toil', 'Time off in lieu', 'toil', true, true],
    ['fmla', 'FMLA leave', 'fmla', false, true],
  ];

/** Creates a built-in leave type if missing (e.g. FMLA for a non-US tenant with US employees). */
export async function ensureLeaveType(tx: Tx, key: string): Promise<string> {
  const has = await tx.maybe<{ id: string }>('SELECT id FROM app.leave_types WHERE key = $1', [key]);
  if (has) return has.id;
  const [, name, category, paid, approval] = DEFAULT_TYPES.find((t) => t[0] === key)!;
  await tx.exec(
    `INSERT INTO app.leave_types (tenant_id, key, name, category, paid, requires_approval, deducts_balance) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, key) DO NOTHING`,
    [
      key,
      JSON.stringify({ 'en-GB': name, 'en-US': name === 'Annual leave' ? 'Vacation' : name }),
      category,
      paid,
      approval,
      key === 'annual' || key === 'toil',
    ],
  );
  return (await tx.one<{ id: string }>('SELECT id FROM app.leave_types WHERE key = $1', [key])).id;
}

/** Default leave types and an annual policy based on the tenant's home-region statutory minimum. */
export async function ensureLeaveDefaults(tx: Tx, book: RuleBook) {
  if (await tx.maybe('SELECT 1 FROM app.leave_types LIMIT 1')) return;
  // First use: pages load balances and types in parallel, so serialise seeding per tenant.
  await tx.exec(
    `SELECT pg_advisory_xact_lock(hashtextextended('thapsus:leave-defaults:' || app.current_tenant()::text, 0))`,
  );
  if (await tx.maybe('SELECT 1 FROM app.leave_types LIMIT 1')) return;
  const t = await tx.one<{ home_region: string }>('SELECT home_region FROM app.tenants');
  const ids: Record<string, string> = {};
  for (const [key] of DEFAULT_TYPES)
    if (key !== 'fmla' || t.home_region === 'us') ids[key] = await ensureLeaveType(tx, key);
  // Statutory minimums come from the jurisdiction packs, never from code.
  const now = today('UTC');
  let days: number;
  let includesPublicHolidays = false;
  if (t.home_region === 'uk') {
    const r = book.tryResolve<{ capDays: number }>('GB', 'leave.statutory_annual_minimum', now);
    days = r?.value.capDays ?? 28;
    includesPublicHolidays = true;
  } else if (t.home_region === 'eu') {
    const r = book.tryResolve<{ weeks: number }>('EU', 'leave.statutory_annual_minimum', now);
    days = (r?.value.weeks ?? 4) * 5;
  } else {
    days = 15; // no US federal statutory minimum: a common company default, editable
  }
  await tx.exec(
    `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, config) VALUES (app.current_tenant(), $1, $2, $3)`,
    [
      `Standard annual leave (${days} days)`,
      ids.annual,
      JSON.stringify({
        accrual: { method: 'annual_upfront', days },
        unit: 'days',
        yearStart: '01-01',
        proRata: true,
        includesPublicHolidays,
        waitingDays: 0,
        carryOver: { maxDays: 5, expiresAfterMonths: 3 },
        allowNegativeDays: 0,
        rounding: 'up_half_day',
      } satisfies LeavePolicy),
    ],
  );
  await tx.exec(
    `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, config) VALUES (app.current_tenant(), 'Time off in lieu', $1, $2)`,
    [
      ids.toil,
      JSON.stringify({
        accrual: { method: 'annual_upfront', days: 0 },
        unit: 'days',
        yearStart: '01-01',
        proRata: false,
        includesPublicHolidays: false,
        waitingDays: 0,
        allowNegativeDays: 0,
        rounding: 'none',
      } satisfies LeavePolicy),
    ],
  );
}

/** Cover check: for each day, would approving leave drop present staff below a rule's minimum? */
export async function coverProblems(
  tx: Tx,
  ctx: LeaveContext,
  start: string,
  end: string,
  excludeRequestId?: string,
) {
  const rules = await tx.query<{
    id: string;
    name: string;
    min_present: number;
    enforcement: 'warn' | 'block';
    department_id: string | null;
    location_id: string | null;
  }>(
    `SELECT * FROM app.cover_rules WHERE (department_id IS NULL OR department_id = $1) AND (location_id IS NULL OR location_id = $2)`,
    [ctx.departmentId, ctx.locationId],
  );
  const problems: Array<{
    rule: string;
    date: string;
    present: number;
    min: number;
    enforcement: 'warn' | 'block';
  }> = [];
  for (const r of rules) {
    const headcount = (
      await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.employees WHERE status = 'active' AND ($1::uuid IS NULL OR department_id = $1) AND ($2::uuid IS NULL OR location_id = $2)`,
        [r.department_id, r.location_id],
      )
    ).n;
    for (const d of eachDay(start, end)) {
      if (!ctx.pattern[dayOfWeek(d) as 1]) continue;
      const away = (
        await tx.one<{ n: number }>(
          `SELECT count(DISTINCT l.employee_id)::int AS n FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
          WHERE l.status IN ('approved', 'pending') AND l.start_date <= $1 AND l.end_date >= $1 AND ($2::uuid IS NULL OR e.department_id = $2) AND ($3::uuid IS NULL OR e.location_id = $3) AND ($4::uuid IS NULL OR l.id <> $4)`,
          [d, r.department_id, r.location_id, excludeRequestId ?? null],
        )
      ).n;
      const present = headcount - away - 1;
      if (present < r.min_present)
        problems.push({ rule: r.name, date: d, present, min: r.min_present, enforcement: r.enforcement });
    }
  }
  return problems;
}

// ---- FMLA ---------------------------------------------------------------------------------------------

/** Methods stored before the pack names were adopted. */
const LEGACY_FMLA_METHODS: Record<string, string> = { rolling_backward: 'rolling_backward_from_leave_date' };
export const fmlaMethod = (m: string) => LEGACY_FMLA_METHODS[m] ?? m;

export interface FmlaSettings {
  /** Leave-year method used for every employee (the pack requires one uniform method). */
  leaveYearMethod?: string;
  /** MM-DD start of a fixed 12-month leave year; defaults to the employee's hire anniversary. */
  fixedYearStart?: string;
  publicAgency?: boolean;
}

export interface AbsenceSettings {
  fitNoteAfterCalendarDays?: number;
  fmla?: FmlaSettings;
}

export async function absenceSettings(tx: Tx): Promise<AbsenceSettings> {
  return (
    (
      await tx.one<{ absence: AbsenceSettings | null }>(
        "SELECT features->'absence' AS absence FROM app.tenants",
      )
    ).absence ?? {}
  );
}

/** US headcount on the payroll for each whole ISO workweek from `from` to `to` (29 CFR 825.105). */
export async function usWeeklyHeadcounts(tx: Tx, from: string, to: string) {
  const rows = await tx.query<{ week_start: string; n: number }>(
    `SELECT w::date::text AS week_start,
            (SELECT count(*)::int FROM app.employees e WHERE e.country = 'US' AND e.start_date <= w::date AND (e.end_date IS NULL OR e.end_date >= w::date + 6)) AS n
       FROM generate_series(date_trunc('week', $1::timestamp), $2::timestamp, interval '7 days') AS w`,
    [from, to],
  );
  return rows.map((r) => ({ weekStart: r.week_start, employees: r.n }));
}

export interface FmlaCaseRow {
  id: string;
  employee_id: string;
  reason: string;
  leave_year_method: string;
  start_date: string;
  intermittent: boolean;
  entitlement_hours: string;
  eligibility: { eligible: boolean; failed?: string[] };
  status: string;
}

/** Hours of FMLA leave (approved, or the given statuses) in the 12-month period that applies on `asOf` for the case's method. */
export async function fmlaStatus(
  tx: Tx,
  book: RuleBook,
  c: FmlaCaseRow,
  asOf: string,
  opts: { excludeRequestId?: string; statuses?: string[] } = {},
) {
  const rule = book.resolve<FmlaRule>('US', 'family_leave.fmla', asOf).value;
  const settings = (await absenceSettings(tx)).fmla ?? {};
  const emp = await tx.one<{ start_date: string }>('SELECT start_date FROM app.employees WHERE id = $1', [
    c.employee_id,
  ]);
  // Usage counts across the employee's FMLA cases (the entitlement is per employee, not per case).
  const usage = await tx.query<{ id: string; start_date: string; amount_hours: string; reason: string }>(
    `SELECT l.id, l.start_date, l.amount_hours, f.reason FROM app.leave_requests l JOIN app.fmla_cases f ON f.tenant_id = l.tenant_id AND f.id = l.fmla_case_id
      WHERE f.employee_id = $1 AND l.status = ANY($3::text[]) AND ($2::uuid IS NULL OR l.id <> $2) ORDER BY l.start_date`,
    [c.employee_id, opts.excludeRequestId ?? null, opts.statuses ?? ['approved']],
  );
  const caregiver = c.reason === 'military_caregiver';
  const relevant = usage.filter((u) => (u.reason === 'military_caregiver') === caregiver);
  const window = fmlaLeaveYear({
    method: fmlaMethod(c.leave_year_method),
    asOf,
    usageDates: relevant.map((u) => u.start_date),
    fixedYearStart: settings.fixedYearStart ?? emp.start_date.slice(5),
    reason: c.reason,
    militaryCaregiverPeriod: rule.militaryCaregiverPeriod,
    allowedMethods: rule.leaveYearMethods,
  });
  const inWindow = relevant.filter((u) => u.start_date >= window[0] && u.start_date < window[1]);
  const usedHours = Math.round(inWindow.reduce((s, u) => s + Number(u.amount_hours), 0) * 100) / 100;
  const entitlement = Number(c.entitlement_hours);
  return {
    leaveYear: window,
    usedHours,
    remainingHours: Math.max(0, Math.round((entitlement - usedHours) * 100) / 100),
    entitlementHours: entitlement,
    requests: inWindow.length,
  };
}
