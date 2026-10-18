import { addDays, addMonths, addYears, compareDates, dateParts, dayOfWeek, daysBetween, eachDay, maxDate, minDate, monthsBetween } from '@thapsus/core/time';

/**
 * Pure leave and absence calculations (no I/O). All dates are civil dates; amounts in days are
 * rounded to 4 dp internally (policy rounding applies to entitlements). Money is integer minor units.
 */
export type WorkPattern = Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>; // hours per ISO weekday

export interface LeavePolicy {
  accrual: { method: 'annual_upfront' | 'monthly'; days: number } | { method: 'per_hour_worked'; percent: number };
  unit: 'days' | 'hours';
  /** Leave-year start as MM-DD. */
  yearStart: string;
  proRata: boolean;
  /** Public holidays on working days are deducted from the entitlement (e.g. UK 28 days incl. bank holidays). */
  includesPublicHolidays: boolean;
  waitingDays: number;
  carryOver?: { maxDays: number; expiresAfterMonths?: number };
  capDays?: number;
  allowNegativeDays: number;
  rounding: 'none' | 'up_half_day' | 'nearest_half_day' | 'up_whole_day';
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface EmployeeFacts {
  startDate: string;
  endDate?: string | null;
  fte: number;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function leaveYearFor(date: string, yearStart: string): [string, string] {
  const { year } = dateParts(date);
  let start = `${year}-${yearStart}`;
  if (compareDates(start, date) > 0) start = `${year - 1}-${yearStart}`;
  return [start, addYears(start, 1)];
}

export function dailyHours(weeklyHours: number, daysPerWeek = 5): WorkPattern {
  const per = r2(weeklyHours / daysPerWeek);
  const p = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as WorkPattern;
  for (let d = 1; d <= daysPerWeek; d++) p[d as 1] = per;
  return p;
}

function applyRounding(v: number, mode: LeavePolicy['rounding']) {
  switch (mode) {
    case 'up_half_day':
      return Math.ceil(r4(v) * 2) / 2;
    case 'nearest_half_day':
      return Math.round(v * 2) / 2;
    case 'up_whole_day':
      return Math.ceil(r4(v));
    default:
      return r4(v);
  }
}

/** Annual entitlement for a leave year, pro-rated for FTE, part-year employment and policy validity. */
export function entitlementForYear(policy: LeavePolicy, emp: EmployeeFacts, year: number): number {
  if (policy.accrual.method === 'per_hour_worked') return 0;
  const ys = `${year}-${policy.yearStart}`;
  const ye = addYears(ys, 1);
  if (!policy.proRata) return applyRounding(policy.accrual.days, policy.rounding);
  let from = maxDate(ys, emp.startDate);
  if (policy.effectiveFrom) from = maxDate(from, policy.effectiveFrom);
  let to = ye;
  if (emp.endDate) to = minDate(to, addDays(emp.endDate, 1));
  if (policy.effectiveTo) to = minDate(to, policy.effectiveTo);
  const covered = Math.max(0, daysBetween(from, to));
  const share = covered / daysBetween(ys, ye);
  return applyRounding(policy.accrual.days * emp.fte * share, policy.rounding);
}

export interface Req {
  start: string;
  end: string;
  status: 'approved' | 'pending' | 'rejected' | 'cancelled';
  startHalf?: 'am' | 'pm';
  endHalf?: 'am' | 'pm';
}

/** Working days/hours in a request: pattern working days, minus public holidays, with half days. */
export function requestAmount(r: { start: string; end: string; pattern: WorkPattern; holidays: string[]; startHalf?: 'am' | 'pm'; endHalf?: 'am' | 'pm' }) {
  const holidays = new Set(r.holidays);
  let days = 0;
  let hours = 0;
  for (const d of eachDay(r.start, r.end)) {
    const h = r.pattern[dayOfWeek(d) as 1];
    if (!h || holidays.has(d)) continue;
    let f = 1;
    if (d === r.start && r.startHalf === 'pm') f -= 0.5;
    if (d === r.end && r.endHalf === 'am') f -= 0.5;
    if (r.start === r.end && r.startHalf && r.endHalf) f = 0.5;
    days += f;
    hours += h * f;
  }
  return { days: r4(days), hours: r2(hours) };
}

export interface BalanceInput {
  policy: LeavePolicy;
  employee: EmployeeFacts;
  year: number;
  asOf: string;
  pattern: WorkPattern;
  holidays: string[];
  requests: Req[];
  adjustments: Array<{ days: number; effectiveDate: string }>;
  carriedIn: number;
  hoursWorked?: number;
}

export function computeBalance(i: BalanceInput) {
  const p = i.policy;
  const [ys, ye] = [`${i.year}-${p.yearStart}`, addYears(`${i.year}-${p.yearStart}`, 1)];
  const entitlement = entitlementForYear(p, i.employee, i.year);
  let accrued = entitlement;
  if (p.accrual.method === 'monthly') {
    const from = maxDate(ys, i.employee.startDate);
    const months = Math.max(0, Math.min(12, monthsBetween(from, minDate(addDays(i.asOf, 1), ye))));
    accrued = r4((p.accrual.days / 12) * months * i.employee.fte);
  } else if (p.accrual.method === 'per_hour_worked') {
    accrued = r2(((i.hoursWorked ?? 0) * p.accrual.percent) / 100);
  }
  const yearHolidays = i.holidays.filter((d) => compareDates(d, ys) >= 0 && compareDates(d, ye) < 0);
  const publicHolidays = p.includesPublicHolidays ? yearHolidays.filter((d) => i.pattern[dayOfWeek(d) as 1] > 0 && compareDates(d, i.employee.startDate) >= 0).length : 0;
  let taken = 0;
  let booked = 0;
  let pending = 0;
  let takenBeforeExpiry = 0;
  const expiry = p.carryOver?.expiresAfterMonths ? addMonths(ys, p.carryOver.expiresAfterMonths) : null;
  for (const r of i.requests) {
    if (r.status === 'rejected' || r.status === 'cancelled') continue;
    const amount = requestAmount({ ...r, pattern: i.pattern, holidays: i.holidays });
    const v = p.unit === 'hours' ? amount.hours : amount.days;
    if (r.status === 'pending') pending += v;
    else if (compareDates(r.start, i.asOf) <= 0) taken += v;
    else booked += v;
    if (r.status === 'approved' && expiry && compareDates(r.start, expiry) < 0) takenBeforeExpiry += v;
  }
  const carriedCapped = Math.min(i.carriedIn, p.carryOver?.maxDays ?? 0);
  let carryOverExpired = 0;
  if (expiry && compareDates(i.asOf, expiry) >= 0) carryOverExpired = Math.max(0, carriedCapped - takenBeforeExpiry);
  const carriedOver = carriedCapped - carryOverExpired - (expiry && compareDates(i.asOf, expiry) >= 0 ? Math.min(carriedCapped, takenBeforeExpiry) : 0);
  const adjustments = r4(i.adjustments.filter((a) => compareDates(a.effectiveDate, i.asOf) <= 0).reduce((s, a) => s + a.days, 0));
  let pot = accrued + carriedCapped - carryOverExpired + adjustments;
  if (p.capDays !== undefined) pot = Math.min(pot, p.capDays);
  const available = r4(pot - publicHolidays - taken - booked - pending);
  const waitingEnds = addDays(i.employee.startDate, p.waitingDays);
  const inWaitingPeriod = p.waitingDays > 0 && compareDates(i.asOf, waitingEnds) < 0;
  return {
    entitlement,
    accrued,
    carriedOver: r4(Math.max(0, carriedOver)),
    carryOverExpired: r4(carryOverExpired),
    adjustments,
    publicHolidays,
    taken: r4(taken),
    booked: r4(booked),
    pending: r4(pending),
    available,
    inWaitingPeriod,
    waitingEnds,
    canBook: (amount: number) => !inWaitingPeriod && available - amount >= -p.allowNegativeDays,
  };
}

// ---- statutory sick pay -------------------------------------------------------------------------------

export interface UkSspRule {
  weeklyRate: { amountMinor: number; currency: string };
  percentOfNormalWeeklyEarnings: number;
  waitingDays: number;
  maxWeeks: number;
  linkingPeriodWeeks: number;
}

/** UK SSP across spells (periods of incapacity linked when the gap is ≤ the linking period). */
export function ukSsp(i: { rule: UkSspRule; normalWeeklyEarningsMinor: number; spells: Array<{ start: string; end: string }>; pattern: WorkPattern }) {
  const weekly = Math.min(i.rule.weeklyRate.amountMinor, Math.round((i.normalWeeklyEarningsMinor * i.rule.percentOfNormalWeeklyEarnings) / 100));
  const qdPerWeek = Object.values(i.pattern).filter((h) => h > 0).length || 5;
  const daily = Math.ceil(weekly / qdPerWeek);
  const spells = [...i.spells].sort((a, b) => compareDates(a.start, b.start));
  const maxDays = i.rule.maxWeeks * qdPerWeek;
  let paidDays = 0;
  let waitingApplied = 0;
  let exhaustedOn: string | null = null;
  let prevEnd: string | null = null;
  for (const s of spells) {
    const linked = prevEnd !== null && daysBetween(prevEnd, s.start) <= i.rule.linkingPeriodWeeks * 7;
    if (!linked) paidDays = 0;
    let waiting = linked ? 0 : i.rule.waitingDays;
    for (const d of eachDay(s.start, s.end)) {
      if (!(i.pattern[dayOfWeek(d) as 1] > 0)) continue;
      if (waiting > 0) {
        waiting--;
        waitingApplied++;
        continue;
      }
      if (paidDays >= maxDays) {
        exhaustedOn ??= d;
        continue;
      }
      paidDays++;
    }
    prevEnd = s.end;
  }
  const weeks = Math.floor(paidDays / qdPerWeek);
  const payableMinor = weeks * weekly + (paidDays - weeks * qdPerWeek) * daily;
  return { weeklyRateMinor: weekly, dailyRateMinor: daily, daysPaid: paidDays, weeksPaid: r2(paidDays / qdPerWeek), payableMinor, waitingDaysApplied: waitingApplied, exhaustedOn };
}

/** Employer continued pay for EU member-state rules (shapes from the packs: DE/NL percent+weeks, IE days/year+cap). */
export function employerContinuedPay(
  rule: { continuedPayPercent?: number; maxWeeksPerIncapacity?: number; maxWeeks?: number; qualifyingServiceWeeks?: number; daysPerYear?: number; ratePercent?: number; dailyCap?: { amountMinor: number } },
  i: { startDate: string; sickStart: string; sickEnd: string; dailyPayMinor?: number; workingDays?: number; usedThisYear?: number },
) {
  const eligibleFrom = addDays(i.startDate, (rule.qualifyingServiceWeeks ?? 0) * 7);
  if (rule.daysPerYear !== undefined) {
    if (compareDates(i.sickStart, eligibleFrom) < 0) return { paidDays: 0, dailyAmountMinor: 0, totalMinor: 0, percent: rule.ratePercent ?? 0 };
    const remaining = Math.max(0, rule.daysPerYear - (i.usedThisYear ?? 0));
    const paidDays = Math.min(remaining, i.workingDays ?? 0);
    const raw = Math.round(((i.dailyPayMinor ?? 0) * (rule.ratePercent ?? 0)) / 100);
    const dailyAmountMinor = rule.dailyCap ? Math.min(raw, rule.dailyCap.amountMinor) : raw;
    return { paidDays, dailyAmountMinor, totalMinor: paidDays * dailyAmountMinor, percent: rule.ratePercent ?? 0 };
  }
  const weeks = rule.maxWeeksPerIncapacity ?? rule.maxWeeks ?? 0;
  const from = maxDate(i.sickStart, eligibleFrom);
  const to = minDate(addDays(i.sickStart, weeks * 7 - 1), i.sickEnd);
  const paidCalendarDays = compareDates(from, to) > 0 ? 0 : daysBetween(from, to) + 1;
  return { percent: rule.continuedPayPercent ?? 0, paidCalendarDays, paidDays: paidCalendarDays };
}

/** US state paid sick leave accrual (hours per hours worked, caps "greater of hours/days", NY size tiers). */
export function usSickAccrual(
  rule: { accrual?: { hoursEarned: number; perHoursWorked: number }; accrualCap?: { hours?: number; days?: number; rule?: string }; tiers?: Array<{ minEmployees: number; maxEmployees: number | null; hours: number; paid: boolean; netIncomeMaxMinor?: number; netIncomeAboveMinor?: number }> },
  i: { hoursWorked: number; hoursPerDay?: number; employerSize?: number; employerNetIncomeMinor?: number },
) {
  const earned = rule.accrual ? Math.floor(i.hoursWorked / rule.accrual.perHoursWorked) * rule.accrual.hoursEarned : 0;
  let cap = Infinity;
  let paid = true;
  if (rule.accrualCap) {
    const fromDays = rule.accrualCap.days !== undefined ? rule.accrualCap.days * (i.hoursPerDay ?? 8) : 0;
    cap = rule.accrualCap.rule === 'greater_of' ? Math.max(rule.accrualCap.hours ?? 0, fromDays) : Math.min(rule.accrualCap.hours ?? Infinity, fromDays || Infinity);
  }
  if (rule.tiers && i.employerSize !== undefined) {
    const size = i.employerSize;
    const tier = rule.tiers.find(
      (t) =>
        size >= t.minEmployees &&
        (t.maxEmployees === null || size <= t.maxEmployees) &&
        (t.netIncomeMaxMinor === undefined || (i.employerNetIncomeMinor ?? 0) <= t.netIncomeMaxMinor) &&
        (t.netIncomeAboveMinor === undefined || (i.employerNetIncomeMinor ?? Infinity) > t.netIncomeAboveMinor),
    );
    if (tier) {
      cap = tier.hours;
      paid = tier.paid;
    }
  }
  return { accruedHours: Math.min(earned, cap), paid };
}

// ---- analytics ---------------------------------------------------------------------------------------

/** Bradford factor S² × D for sickness spells overlapping the 52 weeks up to `asOf`. */
export function bradfordFactor(spells: Array<{ start: string; end: string }>, asOf: string, pattern: WorkPattern) {
  const windowStart = addDays(asOf, -364);
  let s = 0;
  let d = 0;
  for (const sp of spells) {
    if (compareDates(sp.end, windowStart) < 0 || compareDates(sp.start, asOf) > 0) continue;
    s++;
    d += requestAmount({ start: maxDate(sp.start, windowStart), end: minDate(sp.end, asOf), pattern, holidays: [] }).days;
  }
  return { spells: s, days: d, score: s * s * d };
}

/** FMLA eligibility from the US pack rule. */
export function fmlaEligibility(
  rule: { coveredEmployer: { privateSectorMinEmployees: number }; eligibility: { minMonthsOfService: number; minHoursInPrior12Months: number; minEmployeesWithinRadius: number } },
  i: { serviceMonths: number; hoursPrior12Months: number; employeesWithin75Miles: number; employerEmployees: number },
) {
  const failed: string[] = [];
  if (i.employerEmployees < rule.coveredEmployer.privateSectorMinEmployees) failed.push('employer');
  if (i.serviceMonths < rule.eligibility.minMonthsOfService) failed.push('service');
  if (i.hoursPrior12Months < rule.eligibility.minHoursInPrior12Months) failed.push('hours');
  if (Math.min(i.employeesWithin75Miles, i.employerEmployees) < rule.eligibility.minEmployeesWithinRadius) failed.push('worksite');
  return { eligible: failed.length === 0, failed };
}

/** Great-circle distance in miles (for the FMLA 75-mile worksite count). */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3958.8;
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
