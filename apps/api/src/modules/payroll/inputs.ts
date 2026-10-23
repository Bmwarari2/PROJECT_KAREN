import { createHash } from 'node:crypto';
import { addDays, compareDates, daysBetween, maxDate, minDate } from '@thapsus/core/time';
import type { RuleBook } from '@thapsus/rules';
import type { Tx } from '@thapsus/db';
import { ukSsp, type UkSspRule, type WorkPattern } from '../leave/engine';
import { amountFor, leaveContext } from '../leave/service';

/**
 * Canonical payroll inputs for one pay period. This is the only data a payroll connector sees. It is
 * rebuilt from live records while a period is open and frozen (snapshotted) when the period closes, so
 * exports of a closed period are reproducible byte for byte. Everything is sorted and free of
 * timestamps of "now", which keeps the canonical JSON (and its hash) stable.
 *
 * Attribution rules (ADR-0062):
 *  - hours: approved timesheets whose week starts inside the period (weeks never split across periods);
 *  - absences: approved leave (including sickness) overlapping the period, clipped to the period, with
 *    working days recalculated for the clipped part from the employee's pattern and public holidays;
 *  - sick pay: UK statutory sick pay payable for days inside the period (pack rule `sick_pay.statutory`);
 *  - pay changes: effective-dated pay records starting inside the period (not the starting record);
 *  - starters / leavers: start date / last working day inside the period.
 */
export interface PayrollInputs {
  version: 1;
  period: {
    id: string;
    name: string;
    entityId: string | null;
    frequency: string;
    startDate: string;
    endDate: string;
    payDate: string | null;
  };
  employees: InputEmployee[];
  hours: HoursRow[];
  absences: AbsenceRow[];
  sickPay: SickPayRow[];
  payChanges: PayChangeRow[];
  starters: StarterRow[];
  leavers: LeaverRow[];
}
export interface InputEmployee {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  displayName: string;
  entityId: string | null;
  country: string | null;
}
interface Keyed {
  employeeId: string;
  employeeNumber: string;
}
export interface HoursRow extends Keyed {
  weekStart: string;
  weekEnd: string;
  workedMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  doubleMinutes: number;
  approvedAt: string | null;
}
export interface AbsenceRow extends Keyed {
  leaveRequestId: string;
  leaveType: string;
  leaveCategory: string;
  paid: boolean;
  startDate: string;
  endDate: string;
  days: number;
  hours: number;
}
export interface SickPayRow extends Keyed {
  jurisdiction: string;
  scheme: 'uk_ssp';
  sicknessDays: number;
  qualifyingDaysPaid: number;
  waitingDays: number;
  amountMinor: number;
  currency: string;
  weeklyRateMinor: number;
  source: string;
}
export interface PayChangeRow extends Keyed {
  effectiveDate: string;
  amountMinor: number;
  currency: string;
  frequency: string;
  previousAmountMinor: number | null;
  previousCurrency: string | null;
  previousFrequency: string | null;
}
export interface StarterRow extends Keyed {
  startDate: string;
  dateOfBirth: string | null;
  workEmail: string | null;
  jobTitle: string | null;
  employmentType: string | null;
  contractType: string | null;
  weeklyHours: number | null;
  payAmountMinor: number | null;
  currency: string | null;
  payFrequency: string | null;
}
export interface LeaverRow extends Keyed {
  endDate: string;
}

export const SECTIONS = ['hours', 'absences', 'sickPay', 'payChanges', 'starters', 'leavers'] as const;
export type SectionKey = (typeof SECTIONS)[number];

export interface PeriodRow {
  id: string;
  name: string;
  entity_id: string | null;
  frequency: string;
  start_date: string;
  end_date: string;
  pay_date: string | null;
  status: string;
  snapshot_id: string | null;
}

/** JSON with object keys sorted recursively (stable across jsonb round trips). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}
export const sha256Hex = (data: string | Buffer | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const byKey =
  <T extends Keyed>(...extra: Array<(r: T) => string>) =>
  (a: T, b: T) => {
    const ka = [a.employeeNumber, ...extra.map((f) => f(a))];
    const kb = [b.employeeNumber, ...extra.map((f) => f(b))];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  };
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function sectionCounts(i: PayrollInputs): Record<SectionKey, number> {
  return Object.fromEntries(SECTIONS.map((s) => [s, i[s].length])) as Record<SectionKey, number>;
}

export async function buildPayrollInputs(tx: Tx, book: RuleBook, period: PeriodRow): Promise<PayrollInputs> {
  const start = period.start_date;
  const end = period.end_date;
  const people = await tx.query<{
    id: string;
    employee_number: string;
    display_name: string;
    work_email: string | null;
    start_date: string;
    end_date: string | null;
    entity_id: string | null;
    country: string | null;
    first: string | null;
    last: string | null;
    dob: string | null;
  }>(
    `WITH scope AS (
       SELECT e.id, e.employee_number, e.display_name, e.work_email, e.start_date, e.end_date, e.country,
              (SELECT j.entity_id FROM app.employee_jobs j WHERE j.employee_id = e.id AND j.valid_from <= $2 AND (j.valid_to IS NULL OR j.valid_to > $1)
                ORDER BY j.valid_from DESC LIMIT 1) AS entity_id
         FROM app.employees e WHERE e.start_date <= $2 AND (e.end_date IS NULL OR e.end_date >= $1)
     )
     SELECT s.*, p.legal_first_name AS first, p.legal_last_name AS last, p.date_of_birth AS dob
       FROM scope s
       LEFT JOIN LATERAL (SELECT legal_first_name, legal_last_name, date_of_birth FROM app.employee_personal x WHERE x.employee_id = s.id
                            AND x.valid_from <= $2 AND (x.valid_to IS NULL OR x.valid_to > $1) ORDER BY x.valid_from DESC LIMIT 1) p ON true
      WHERE ($3::uuid IS NULL OR s.entity_id = $3)
      ORDER BY s.employee_number`,
    [start, end, period.entity_id],
  );
  const ids = people.map((p) => p.id);
  const numberOf = new Map(people.map((p) => [p.id, p.employee_number]));
  const employees: InputEmployee[] = people.map((p) => ({
    employeeId: p.id,
    employeeNumber: p.employee_number,
    firstName: p.first ?? '',
    lastName: p.last ?? '',
    displayName: p.display_name,
    entityId: p.entity_id,
    country: p.country,
  }));

  // ---- hours ----------------------------------------------------------------------------------------
  const ts = await tx.query<{
    employee_id: string;
    week_start: string;
    worked_minutes: number;
    regular_minutes: number;
    overtime_minutes: number;
    double_minutes: number;
    decided_at: string | null;
  }>(
    `SELECT employee_id, week_start, worked_minutes, regular_minutes, overtime_minutes, double_minutes, decided_at FROM app.timesheets
      WHERE status = 'approved' AND week_start BETWEEN $1 AND $2 AND employee_id = ANY($3::uuid[])`,
    [start, end, ids],
  );
  const hours: HoursRow[] = ts
    .map((t) => ({
      employeeId: t.employee_id,
      employeeNumber: numberOf.get(t.employee_id)!,
      weekStart: t.week_start,
      weekEnd: addDays(t.week_start, 6),
      workedMinutes: t.worked_minutes,
      regularMinutes: t.regular_minutes,
      overtimeMinutes: t.overtime_minutes,
      doubleMinutes: t.double_minutes,
      approvedAt: t.decided_at,
    }))
    .sort(byKey((r) => r.weekStart));

  // ---- absences (approved leave incl. sickness), clipped to the period ----------------------------------------
  const leave = await tx.query<{
    id: string;
    employee_id: string;
    start_date: string;
    end_date: string;
    start_half: 'am' | 'pm' | null;
    end_half: 'am' | 'pm' | null;
    amount_days: string;
    amount_hours: string;
    key: string;
    category: string;
    paid: boolean;
  }>(
    `SELECT l.id, l.employee_id, l.start_date, l.end_date, l.start_half, l.end_half, l.amount_days, l.amount_hours, t.key, t.category, t.paid
       FROM app.leave_requests l JOIN app.leave_types t ON t.tenant_id = l.tenant_id AND t.id = l.leave_type_id
      WHERE l.status = 'approved' AND l.start_date <= $2 AND l.end_date >= $1 AND l.employee_id = ANY($3::uuid[])`,
    [start, end, ids],
  );
  const absences: AbsenceRow[] = [];
  for (const l of leave) {
    const from = maxDate(l.start_date, start);
    const to = minDate(l.end_date, end);
    let days = Number(l.amount_days);
    let hrs = Number(l.amount_hours);
    if (from !== l.start_date || to !== l.end_date) {
      const a = await amountFor(
        tx,
        book,
        l.employee_id,
        from,
        to,
        from === l.start_date ? (l.start_half ?? undefined) : undefined,
        to === l.end_date ? (l.end_half ?? undefined) : undefined,
      );
      days = a.days;
      hrs = a.hours;
    }
    absences.push({
      employeeId: l.employee_id,
      employeeNumber: numberOf.get(l.employee_id)!,
      leaveRequestId: l.id,
      leaveType: l.key,
      leaveCategory: l.category,
      paid: l.paid,
      startDate: from,
      endDate: to,
      days,
      hours: hrs,
    });
  }
  absences.sort(
    byKey(
      (r) => r.startDate,
      (r) => r.leaveRequestId,
    ),
  );

  // ---- statutory sick pay (UK SSP from the GB pack) ------------------------------------------------------------
  const sickPay: SickPayRow[] = [];
  const sick = await tx.query<{ employee_id: string; start_date: string; end_date: string | null }>(
    `SELECT employee_id, start_date, end_date FROM app.sickness_records
      WHERE employee_id = ANY($3::uuid[]) AND start_date <= $2 AND (end_date IS NULL OR end_date >= ($1::date - 365)) ORDER BY employee_id, start_date`,
    [start, end, ids],
  );
  const spellsBy = new Map<string, Array<{ start: string; end: string | null }>>();
  for (const s of sick)
    (spellsBy.get(s.employee_id) ?? spellsBy.set(s.employee_id, []).get(s.employee_id)!).push({
      start: s.start_date,
      end: s.end_date,
    });
  const sspRule = book.tryResolve<UkSspRule>('GB', 'sick_pay.statutory', end);
  for (const [employeeId, spells] of spellsBy) {
    const inPeriod = spells.filter(
      (s) => compareDates(s.start, end) <= 0 && compareDates(s.end ?? end, start) >= 0,
    );
    if (!inPeriod.length || !sspRule) continue;
    const ctx = await leaveContext(tx, employeeId, end);
    if (ctx.country !== 'GB') continue;
    const weekly = await normalWeeklyEarnings(tx, employeeId, end, ctx.pattern);
    const rule = sspRuleFor(sspRule.value, weekly);
    const upTo = (limit: string) =>
      spells
        .filter((s) => compareDates(s.start, limit) <= 0)
        .map((s) => ({ start: s.start, end: minDate(s.end ?? end, limit) }));
    const full = ukSsp({ rule, normalWeeklyEarningsMinor: weekly, pattern: ctx.pattern, spells: upTo(end) });
    const before = ukSsp({
      rule,
      normalWeeklyEarningsMinor: weekly,
      pattern: ctx.pattern,
      spells: upTo(addDays(start, -1)),
    });
    const sicknessDays = inPeriod.reduce(
      (n, s) => n + daysBetween(maxDate(s.start, start), minDate(s.end ?? end, end)) + 1,
      0,
    );
    sickPay.push({
      employeeId,
      employeeNumber: numberOf.get(employeeId)!,
      jurisdiction: 'GB',
      scheme: 'uk_ssp',
      sicknessDays,
      qualifyingDaysPaid: full.daysPaid - before.daysPaid,
      waitingDays: full.waitingDaysApplied - before.waitingDaysApplied,
      amountMinor: full.payableMinor - before.payableMinor,
      currency: sspRule.value.weeklyRate.currency,
      weeklyRateMinor: full.weeklyRateMinor,
      source: sspRule.source.url,
    });
  }
  sickPay.sort(byKey());

  // ---- pay changes ----------------------------------------------------------------------------------------------
  const pay = await tx.query<{
    employee_id: string;
    valid_from: string;
    amount_minor: string;
    currency: string;
    frequency: string;
    prev_amount: string | null;
    prev_currency: string | null;
    prev_frequency: string | null;
  }>(
    `SELECT p.employee_id, p.valid_from, p.amount_minor, p.currency, p.frequency, q.amount_minor AS prev_amount, q.currency AS prev_currency, q.frequency AS prev_frequency
       FROM app.employee_pay p JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id
       LEFT JOIN app.employee_pay q ON q.tenant_id = p.tenant_id AND q.employee_id = p.employee_id AND q.valid_to = p.valid_from
      WHERE p.valid_from BETWEEN $1 AND $2 AND p.valid_from > e.start_date AND p.employee_id = ANY($3::uuid[])`,
    [start, end, ids],
  );
  const payChanges: PayChangeRow[] = pay
    .filter(
      (p) =>
        !(
          p.prev_amount === p.amount_minor &&
          p.prev_currency === p.currency &&
          p.prev_frequency === p.frequency
        ),
    )
    .map((p) => ({
      employeeId: p.employee_id,
      employeeNumber: numberOf.get(p.employee_id)!,
      effectiveDate: p.valid_from,
      amountMinor: Number(p.amount_minor),
      currency: p.currency,
      frequency: p.frequency,
      previousAmountMinor: num(p.prev_amount),
      previousCurrency: p.prev_currency,
      previousFrequency: p.prev_frequency,
    }))
    .sort(byKey((r) => r.effectiveDate));

  // ---- starters and leavers -------------------------------------------------------------------------------------
  const startRows = await tx.query<{
    id: string;
    start_date: string;
    work_email: string | null;
    job_title: string | null;
    employment_type: string | null;
    weekly_hours: string | null;
    contract_type: string | null;
    amount_minor: string | null;
    currency: string | null;
    frequency: string | null;
  }>(
    `SELECT e.id, e.start_date, e.work_email, j.job_title, j.employment_type, j.weekly_hours, c.contract_type, p.amount_minor, p.currency, p.frequency
       FROM app.employees e
       LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= e.start_date AND (j.valid_to IS NULL OR j.valid_to > e.start_date)
       LEFT JOIN app.employee_contracts c ON c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.valid_from <= e.start_date AND (c.valid_to IS NULL OR c.valid_to > e.start_date)
       LEFT JOIN app.employee_pay p ON p.tenant_id = e.tenant_id AND p.employee_id = e.id AND p.valid_from <= e.start_date AND (p.valid_to IS NULL OR p.valid_to > e.start_date)
      WHERE e.start_date BETWEEN $1 AND $2 AND e.id = ANY($3::uuid[])`,
    [start, end, ids],
  );
  const dob = new Map(people.map((p) => [p.id, p.dob]));
  const starters: StarterRow[] = startRows
    .map((r) => ({
      employeeId: r.id,
      employeeNumber: numberOf.get(r.id)!,
      startDate: r.start_date,
      dateOfBirth: dob.get(r.id) ?? null,
      workEmail: r.work_email,
      jobTitle: r.job_title,
      employmentType: r.employment_type,
      contractType: r.contract_type,
      weeklyHours: num(r.weekly_hours),
      payAmountMinor: num(r.amount_minor),
      currency: r.currency,
      payFrequency: r.frequency,
    }))
    .sort(byKey());
  const leavers: LeaverRow[] = people
    .filter((p) => p.end_date && compareDates(p.end_date, start) >= 0 && compareDates(p.end_date, end) <= 0)
    .map((p) => ({ employeeId: p.id, employeeNumber: p.employee_number, endDate: p.end_date! }))
    .sort(byKey());

  // Only people who appear in a section are carried into the export (data minimisation).
  const used = new Set(
    [...hours, ...absences, ...sickPay, ...payChanges, ...starters, ...leavers].map((r) => r.employeeId),
  );
  return {
    version: 1,
    period: {
      id: period.id,
      name: period.name,
      entityId: period.entity_id,
      frequency: period.frequency,
      startDate: start,
      endDate: end,
      payDate: period.pay_date,
    },
    employees: employees.filter((e) => used.has(e.employeeId)),
    hours,
    absences,
    sickPay,
    payChanges,
    starters,
    leavers,
  };
}

/**
 * Adapts the pack value to the SSP engine: before 6 April 2026 SSP was a flat rate for anyone earning at
 * least the lower earnings limit (no percentage cap); from then it is the lower of the flat rate and a
 * percentage of normal weekly earnings. Both shapes come from the GB pack, never from code.
 */
function sspRuleFor(
  v: UkSspRule & {
    lowerEarningsLimitWeekly?: { amountMinor: number } | null;
    percentOfNormalWeeklyEarnings?: number;
  },
  weeklyEarningsMinor: number,
): UkSspRule {
  const belowLel =
    !!v.lowerEarningsLimitWeekly && weeklyEarningsMinor < v.lowerEarningsLimitWeekly.amountMinor;
  return {
    ...v,
    weeklyRate: belowLel ? { ...v.weeklyRate, amountMinor: 0 } : v.weeklyRate,
    percentOfNormalWeeklyEarnings: v.percentOfNormalWeeklyEarnings ?? 1_000_000,
  };
}

/** Normal weekly earnings from the effective-dated pay record (same basis as the statutory pay endpoint). */
async function normalWeeklyEarnings(tx: Tx, employeeId: string, asOf: string, pattern: WorkPattern) {
  const pay = await tx.maybe<{ amount_minor: string; frequency: string }>(
    `SELECT amount_minor, frequency FROM app.employee_pay WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
    [employeeId, asOf],
  );
  if (!pay) return 0;
  const amount = Number(pay.amount_minor);
  const weeklyHours = Object.values(pattern).reduce((s, h) => s + h, 0);
  switch (pay.frequency) {
    case 'annual':
      return Math.round(amount / 52);
    case 'monthly':
      return Math.round((amount * 12) / 52);
    case 'hourly':
      return Math.round(amount * weeklyHours);
    case 'daily':
      return Math.round(amount * Object.values(pattern).filter((h) => h > 0).length);
    default:
      return amount;
  }
}
