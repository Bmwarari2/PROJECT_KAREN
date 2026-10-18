import type { Tx } from '@thapsus/db';
import { addDays, dateParts, dayOfWeek, eachDay } from '@thapsus/core/time';
import type { RuleBook } from '@thapsus/rules';
import { ApiError } from '../../http/errors';
import { computeBalance, dailyHours, leaveYearFor, requestAmount, type LeavePolicy, type WorkPattern } from './engine';

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
  const e = await tx.maybe<{ start_date: string; end_date: string | null; country: string | null; region_code: string | null; entity_id: string | null; location_id: string | null; department_id: string | null; fte: string | null; weekly_hours: string | null; work_pattern: WorkPattern | null; job_entity: string | null; job_location: string | null }>(
    `SELECT e.start_date, e.end_date, e.country, e.region_code, e.entity_id, e.location_id, e.department_id, j.fte, j.weekly_hours, j.work_pattern, j.entity_id AS job_entity, j.location_id AS job_location
       FROM app.employees e LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= $2 AND (j.valid_to IS NULL OR j.valid_to > $2)
      WHERE e.id = $1`,
    [employeeId, date],
  );
  if (!e) throw new ApiError('notFound');
  let country = e.country;
  let region = e.region_code;
  if ((!country || !region) && e.job_entity) {
    const ent = await tx.maybe<{ country: string; region_code: string | null }>('SELECT country, region_code FROM app.legal_entities WHERE id = $1', [e.job_entity]);
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
export async function holidaysFor(tx: Tx, book: RuleBook, ctx: LeaveContext, from: string, to: string): Promise<string[]> {
  const out = new Set<string>();
  if (ctx.country) {
    for (let y = dateParts(from).year; y <= dateParts(to).year; y++) for (const d of book.daysOff(ctx.country, y, ctx.region ?? undefined)) out.add(d);
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
export async function policyFor(tx: Tx, ctx: LeaveContext, leaveTypeId: string, date: string): Promise<PolicyRow | undefined> {
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

export async function balanceFor(tx: Tx, book: RuleBook, employeeId: string, leaveTypeId: string, asOf: string, depth = 0): Promise<ReturnType<typeof computeBalance> & { policy: string; year: [string, string] } | undefined> {
  const ctx = await leaveContext(tx, employeeId, asOf);
  const policy = await policyFor(tx, ctx, leaveTypeId, asOf);
  if (!policy) return undefined;
  const [ys, ye] = leaveYearFor(asOf, policy.config.yearStart);
  const year = dateParts(ys).year;
  const holidays = await holidaysFor(tx, book, ctx, ys, ye);
  const requests = await tx.query<{ start_date: string; end_date: string; status: 'approved' | 'pending'; start_half: 'am' | 'pm' | null; end_half: 'am' | 'pm' | null }>(
    `SELECT start_date, end_date, status, start_half, end_half FROM app.leave_requests WHERE employee_id = $1 AND leave_type_id = $2 AND status IN ('pending', 'approved') AND start_date < $4 AND end_date >= $3`,
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
    employee: { startDate: ctx.startDate, endDate: ctx.endDate, fte: ctx.fte },
    year,
    asOf,
    pattern: ctx.pattern,
    holidays,
    requests: requests.map((r) => ({ start: r.start_date, end: r.end_date, status: r.status, startHalf: r.start_half ?? undefined, endHalf: r.end_half ?? undefined })),
    adjustments: adjustments.map((a) => ({ days: Number(a.amount), effectiveDate: a.effective_date })),
    carriedIn,
  });
  return { ...b, policy: policy.name, year: [ys, ye] };
}

export async function amountFor(tx: Tx, book: RuleBook, employeeId: string, start: string, end: string, startHalf?: 'am' | 'pm', endHalf?: 'am' | 'pm') {
  const ctx = await leaveContext(tx, employeeId, start);
  const holidays = await holidaysFor(tx, book, ctx, start, end);
  return requestAmount({ start, end, pattern: ctx.pattern, holidays, startHalf, endHalf });
}

/** Default leave types and an annual policy based on the tenant's home-region statutory minimum. */
export async function ensureLeaveDefaults(tx: Tx, book: RuleBook) {
  const has = await tx.maybe('SELECT 1 FROM app.leave_types LIMIT 1');
  if (has) return;
  const t = await tx.one<{ home_region: string }>('SELECT home_region FROM app.tenants');
  const types: Array<[string, string, string, boolean, boolean]> = [
    ['annual', 'Annual leave', 'annual', true, true],
    ['sickness', 'Sickness', 'sickness', true, false],
    ['unpaid', 'Unpaid leave', 'unpaid', false, true],
    ['family', 'Family leave', 'family', true, true],
    ['toil', 'Time off in lieu', 'toil', true, true],
  ];
  if (t.home_region === 'us') types.push(['fmla', 'FMLA leave', 'fmla', false, true]);
  const ids: Record<string, string> = {};
  for (const [key, name, category, paid, approval] of types) {
    ids[key] = (await tx.one<{ id: string }>(
      `INSERT INTO app.leave_types (tenant_id, key, name, category, paid, requires_approval, deducts_balance) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [key, JSON.stringify({ 'en-GB': name, 'en-US': name === 'Annual leave' ? 'Vacation' : name }), category, paid, approval, key === 'annual' || key === 'toil'],
    )).id;
  }
  // Statutory minimums come from the jurisdiction packs, never from code.
  const today = new Date().toISOString().slice(0, 10);
  let days: number;
  let includesPublicHolidays = false;
  if (t.home_region === 'uk') {
    const r = book.tryResolve<{ capDays: number }>('GB', 'leave.statutory_annual_minimum', today);
    days = r?.value.capDays ?? 28;
    includesPublicHolidays = true;
  } else if (t.home_region === 'eu') {
    const r = book.tryResolve<{ weeks: number }>('EU', 'leave.statutory_annual_minimum', today);
    days = (r?.value.weeks ?? 4) * 5;
  } else {
    days = 15; // no US federal statutory minimum: a common company default, editable
  }
  await tx.exec(
    `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, config) VALUES (app.current_tenant(), $1, $2, $3)`,
    [`Standard annual leave (${days} days)`, ids.annual, JSON.stringify({ accrual: { method: 'annual_upfront', days }, unit: 'days', yearStart: '01-01', proRata: true, includesPublicHolidays, waitingDays: 0, carryOver: { maxDays: 5, expiresAfterMonths: 3 }, allowNegativeDays: 0, rounding: 'up_half_day' } satisfies LeavePolicy)],
  );
  await tx.exec(
    `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, config) VALUES (app.current_tenant(), 'Time off in lieu', $1, $2)`,
    [ids.toil, JSON.stringify({ accrual: { method: 'annual_upfront', days: 0 }, unit: 'days', yearStart: '01-01', proRata: false, includesPublicHolidays: false, waitingDays: 0, allowNegativeDays: 0, rounding: 'none' } satisfies LeavePolicy)],
  );
}

/** Cover check: for each day, would approving leave drop present staff below a rule's minimum? */
export async function coverProblems(tx: Tx, ctx: LeaveContext, start: string, end: string, excludeRequestId?: string) {
  const rules = await tx.query<{ id: string; name: string; min_present: number; enforcement: 'warn' | 'block'; department_id: string | null; location_id: string | null }>(
    `SELECT * FROM app.cover_rules WHERE (department_id IS NULL OR department_id = $1) AND (location_id IS NULL OR location_id = $2)`,
    [ctx.departmentId, ctx.locationId],
  );
  const problems: Array<{ rule: string; date: string; present: number; min: number; enforcement: 'warn' | 'block' }> = [];
  for (const r of rules) {
    const headcount = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees WHERE status = 'active' AND ($1::uuid IS NULL OR department_id = $1) AND ($2::uuid IS NULL OR location_id = $2)`, [r.department_id, r.location_id])).n;
    for (const d of eachDay(start, end)) {
      if (!ctx.pattern[dayOfWeek(d) as 1]) continue;
      const away = (await tx.one<{ n: number }>(
        `SELECT count(DISTINCT l.employee_id)::int AS n FROM app.leave_requests l JOIN app.employees e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
          WHERE l.status IN ('approved', 'pending') AND l.start_date <= $1 AND l.end_date >= $1 AND ($2::uuid IS NULL OR e.department_id = $2) AND ($3::uuid IS NULL OR e.location_id = $3) AND ($4::uuid IS NULL OR l.id <> $4)`,
        [d, r.department_id, r.location_id, excludeRequestId ?? null],
      )).n;
      const present = headcount - away - 1;
      if (present < r.min_present) problems.push({ rule: r.name, date: d, present, min: r.min_present, enforcement: r.enforcement });
    }
  }
  return problems;
}
