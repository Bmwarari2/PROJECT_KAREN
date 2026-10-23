import {
  addDays,
  addMonths,
  addYears,
  compareDates,
  dateParts,
  dayOfWeek,
  daysBetween,
  eachDay,
  maxDate,
  minDate,
  monthsBetween,
} from '@thapsus/core/time';

/**
 * Pure leave and absence calculations (no I/O). All dates are civil dates; amounts in days are
 * rounded to 4 dp internally (policy rounding applies to entitlements). Money is integer minor units.
 * Statutory values always come from the jurisdiction packs (passed in as rule values), never from code.
 */
export type WorkPattern = Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>; // hours per ISO weekday

export interface LeavePolicy {
  /**
   * Annual/monthly amounts are full-time days (a full-time week being five days), pro-rated by FTE and
   * converted to hours for hours-unit policies; per-hour-worked accrual earns hours.
   */
  accrual:
    { method: 'annual_upfront' | 'monthly'; days: number } | { method: 'per_hour_worked'; percent: number };
  /** Unit balances are kept in. Adjustments, carry-over, caps and the negative allowance are in this unit. */
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

const patternHours = (p: WorkPattern, d: string) => p[dayOfWeek(d) as 1] ?? 0;
export const weeklyHoursOf = (p: WorkPattern) => Object.values(p).reduce((s, h) => s + h, 0);
export const workingDaysPerWeek = (p: WorkPattern) => Object.values(p).filter((h) => h > 0).length;
/** Average hours on one of the employee's working days. */
export const averageDayHours = (p: WorkPattern) =>
  workingDaysPerWeek(p) ? weeklyHoursOf(p) / workingDaysPerWeek(p) : 0;

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

/**
 * Unrounded entitlement (days) earned by `policy` over [from, to) of the leave year [ys, ye): the
 * share of the year covered by the period and the policy's validity; for pro-rata policies also
 * limited to employment and scaled by FTE.
 */
function rawEntitlement(
  policy: LeavePolicy,
  emp: EmployeeFacts,
  ys: string,
  ye: string,
  from = ys,
  to = ye,
): number {
  if (policy.accrual.method === 'per_hour_worked') return 0;
  let a = maxDate(ys, from);
  let b = minDate(ye, to);
  if (policy.effectiveFrom) a = maxDate(a, policy.effectiveFrom);
  if (policy.effectiveTo) b = minDate(b, policy.effectiveTo);
  const yearDays = daysBetween(ys, ye);
  if (!policy.proRata) return (policy.accrual.days * Math.max(0, daysBetween(a, b))) / yearDays;
  a = maxDate(a, emp.startDate);
  if (emp.endDate) b = minDate(b, addDays(emp.endDate, 1));
  return (policy.accrual.days * emp.fte * Math.max(0, daysBetween(a, b))) / yearDays;
}

/** Annual entitlement for a leave year, pro-rated for FTE, part-year employment and policy validity. */
export function entitlementForYear(policy: LeavePolicy, emp: EmployeeFacts, year: number): number {
  if (policy.accrual.method === 'per_hour_worked') return 0;
  const ys = `${year}-${policy.yearStart}`;
  return applyRounding(rawEntitlement(policy, emp, ys, addYears(ys, 1)), policy.rounding);
}

/** A slice of the leave year governed by one policy and one FTE (mid-year policy or contract changes). */
export interface PolicyPeriod {
  from: string;
  to: string;
  policy: LeavePolicy;
  fte?: number;
  /** Hours actually worked in this period (per-hour-worked accrual). */
  hoursWorked?: number;
}

/**
 * Entitlement in days summed over the policy periods of a leave year: unrounded per period, then
 * rounded once with `rounding` (the policy in force at the balance date).
 */
export function entitlementForPeriods(
  periods: PolicyPeriod[],
  emp: EmployeeFacts,
  ys: string,
  rounding: LeavePolicy['rounding'],
): number {
  const ye = addYears(ys, 1);
  const total = periods.reduce(
    (s, p) => s + rawEntitlement(p.policy, { ...emp, fte: p.fte ?? emp.fte }, ys, ye, p.from, p.to),
    0,
  );
  return applyRounding(total, rounding);
}

export interface Req {
  start: string;
  end: string;
  status: 'approved' | 'pending' | 'rejected' | 'cancelled';
  startHalf?: 'am' | 'pm';
  endHalf?: 'am' | 'pm';
  /** Explicit hours for a partial single day (hourly leave, intermittent FMLA). */
  hours?: number;
}

/**
 * Working days/hours in a request: the pattern's working days minus public holidays, with half days.
 * A single-day request may give explicit `hours` (capped at that day's pattern hours).
 */
export function requestAmount(r: {
  start: string;
  end: string;
  pattern: WorkPattern;
  holidays: string[];
  startHalf?: 'am' | 'pm';
  endHalf?: 'am' | 'pm';
  hours?: number;
}) {
  if (r.hours !== undefined && r.start === r.end) {
    const day = patternHours(r.pattern, r.start);
    if (!day || r.holidays.includes(r.start)) return { days: 0, hours: 0 };
    const hours = Math.min(r.hours, day);
    return { days: r4(hours / day), hours: r2(hours) };
  }
  const holidays = new Set(r.holidays);
  let days = 0;
  let hours = 0;
  for (const d of eachDay(r.start, r.end)) {
    const h = patternHours(r.pattern, d);
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
  /** Policy in force at the balance date: its unit, carry-over, caps, waiting period and rounding apply. */
  policy: LeavePolicy;
  employee: EmployeeFacts;
  year: number;
  asOf: string;
  pattern: WorkPattern;
  holidays: string[];
  requests: Req[];
  /** In the policy unit. */
  adjustments: Array<{ days: number; effectiveDate: string }>;
  carriedIn: number;
  /** Hours worked in the leave year up to `asOf` (per-hour-worked accrual, single-policy years). */
  hoursWorked?: number;
  /** Policy periods across the leave year (mid-year changes); defaults to `policy` for the whole year. */
  periods?: PolicyPeriod[];
  /** Length of a full-time day in hours (hours-unit conversion); default (weekly hours ÷ FTE) ÷ 5. */
  fullTimeDayHours?: number;
}

export function computeBalance(i: BalanceInput) {
  const p = i.policy;
  const [ys, ye] = [`${i.year}-${p.yearStart}`, addYears(`${i.year}-${p.yearStart}`, 1)];
  const periods: PolicyPeriod[] = i.periods?.length
    ? i.periods
    : [{ from: ys, to: ye, policy: p, hoursWorked: i.hoursWorked }];
  const fullDay = i.fullTimeDayHours ?? weeklyHoursOf(i.pattern) / (i.employee.fte || 1) / 5;
  const dayHours = averageDayHours(i.pattern);
  const daysToUnit = (days: number) => (p.unit === 'hours' ? r2(days * fullDay) : days);
  const hoursToUnit = (hours: number) => (p.unit === 'hours' ? hours : dayHours ? hours / dayHours : 0);
  const entitlement = daysToUnit(entitlementForPeriods(periods, i.employee, ys, p.rounding));

  // Accrued so far: upfront = entitlement; monthly = completed months; per hour worked = % of hours.
  let accrued: number;
  if (periods.every((x) => x.policy.accrual.method === 'annual_upfront')) accrued = entitlement;
  else {
    let days = 0;
    let hours = 0;
    for (const per of periods) {
      const acc = per.policy.accrual;
      const fte = per.fte ?? i.employee.fte;
      if (acc.method === 'per_hour_worked') hours += ((per.hoursWorked ?? 0) * acc.percent) / 100;
      else if (acc.method === 'monthly') {
        const from = maxDate(maxDate(ys, per.from), i.employee.startDate);
        const to = minDate(minDate(addDays(i.asOf, 1), ye), per.to);
        const months = compareDates(from, to) >= 0 ? 0 : Math.max(0, Math.min(12, monthsBetween(from, to)));
        days += (acc.days / 12) * months * fte;
      } else days += rawEntitlement(per.policy, { ...i.employee, fte }, ys, ye, per.from, per.to);
    }
    accrued = r4(daysToUnit(r4(days)) + hoursToUnit(r2(hours)));
  }

  const yearHolidays = i.holidays.filter((d) => compareDates(d, ys) >= 0 && compareDates(d, ye) < 0);
  // Only holidays on the employee's own working days while employed are deducted (part-timers, joiners, leavers).
  const deductible = p.includesPublicHolidays
    ? yearHolidays.filter(
        (d) =>
          patternHours(i.pattern, d) > 0 &&
          compareDates(d, i.employee.startDate) >= 0 &&
          (!i.employee.endDate || compareDates(d, i.employee.endDate) <= 0),
      )
    : [];
  const publicHolidays =
    p.unit === 'hours'
      ? r2(deductible.reduce((s, d) => s + patternHours(i.pattern, d), 0))
      : deductible.length;
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
  if (expiry && compareDates(i.asOf, expiry) >= 0)
    carryOverExpired = Math.max(0, carriedCapped - takenBeforeExpiry);
  const carriedOver =
    carriedCapped -
    carryOverExpired -
    (expiry && compareDates(i.asOf, expiry) >= 0 ? Math.min(carriedCapped, takenBeforeExpiry) : 0);
  const adjustments = r4(
    i.adjustments.filter((a) => compareDates(a.effectiveDate, i.asOf) <= 0).reduce((s, a) => s + a.days, 0),
  );
  let pot = accrued + carriedCapped - carryOverExpired + adjustments;
  if (p.capDays !== undefined) pot = Math.min(pot, p.capDays);
  const available = r4(pot - publicHolidays - taken - booked - pending);
  const waitingEnds = addDays(i.employee.startDate, p.waitingDays);
  const inWaitingPeriod = p.waitingDays > 0 && compareDates(i.asOf, waitingEnds) < 0;
  return {
    unit: p.unit,
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
    /** `amount` is in the policy unit (hours for hours-unit policies). */
    canBook: (amount: number) => !inWaitingPeriod && available - amount >= -p.allowNegativeDays,
  };
}

// ---- statutory sick pay: UK SSP ------------------------------------------------------------------------

interface Money {
  amountMinor: number;
  currency: string;
}

/** Shape of GB `sick_pay.statutory` (both the 2025-26 flat-rate version and the 2026 version). */
export interface UkSspRule {
  weeklyRate: Money;
  calculation?: string;
  percentOfNormalWeeklyEarnings?: number;
  waitingDays: number;
  /** Consecutive calendar days that make a period of incapacity for work (SSCBA 1992 s.152(2)). */
  minPeriodOfIncapacityDays?: number;
  lowerEarningsLimitWeekly?: Money | null;
  maxWeeks: number;
  linkingPeriodWeeks: number;
  transitional?: {
    protectedBandNormalWeeklyEarnings: { min: Money; max: Money };
    protectedWeeklyRate: Money;
  };
}

export interface RuleAt<V> {
  value: V;
  effectiveFrom: string;
}

/**
 * UK SSP across spells, applying the rule version in force on each day, so a period spanning
 * 6 April 2026 uses the 2025-26 rules before and the 2026 rules after:
 * - a spell is a period of incapacity for work (PIW) when it lasts at least `minPeriodOfIncapacityDays`
 *   consecutive calendar days (the shortest requirement among the versions in force during it);
 * - PIWs separated by no more than `linkingPeriodWeeks` are linked into one period of entitlement;
 * - waiting days are served once per period of entitlement; days when normal weekly earnings are below
 *   the lower earnings limit are not payable; payment stops after `maxWeeks` × qualifying days a week;
 * - the 2026 transitional protected rate (pack `transitional`) applies to a spell that began before the
 *   change, continues after it and already had SSP paid before it, for NWE inside the protected band.
 * Qualifying days are the employee's working days.
 */
export function ukSsp(i: {
  rule: UkSspRule | ((date: string) => RuleAt<UkSspRule>);
  normalWeeklyEarningsMinor: number;
  spells: Array<{ start: string; end: string }>;
  pattern: WorkPattern;
}) {
  const fixed = typeof i.rule === 'function' ? null : i.rule;
  const ruleOn: (d: string) => RuleAt<UkSspRule> =
    typeof i.rule === 'function' ? i.rule : () => ({ value: fixed!, effectiveFrom: '0001-01-01' });
  const nwe = i.normalWeeklyEarningsMinor;
  const qdPerWeek = workingDaysPerWeek(i.pattern) || 5;
  const spells = [...i.spells].sort((a, b) => compareDates(a.start, b.start));
  const baseRate = (r: UkSspRule) =>
    r.calculation === 'flat_rate' || r.percentOfNormalWeeklyEarnings === undefined
      ? r.weeklyRate.amountMinor
      : Math.min(r.weeklyRate.amountMinor, Math.round((nwe * r.percentOfNormalWeeklyEarnings) / 100));
  const paidByRate = new Map<number, number>();
  let waitingApplied = 0;
  let belowLelDays = 0;
  let notPiw = 0;
  let exhaustedOn: string | null = null;
  let prevEnd: string | null = null;
  let lastRate: number | null = null;
  let chain = { paidDays: 0, waitingServed: 0, firstPaid: null as string | null };
  for (const s of spells) {
    const days = eachDay(s.start, s.end);
    const rules = days.map(ruleOn);
    const minPiw = Math.min(...rules.map((r) => r.value.minPeriodOfIncapacityDays ?? 1));
    if (days.length < minPiw) {
      notPiw++;
      continue;
    }
    const linked =
      prevEnd !== null && daysBetween(prevEnd, s.start) - 1 <= rules[0]!.value.linkingPeriodWeeks * 7;
    if (!linked) chain = { paidDays: 0, waitingServed: 0, firstPaid: null };
    days.forEach((d, k) => {
      if (!(patternHours(i.pattern, d) > 0)) return;
      const { value: r, effectiveFrom } = rules[k]!;
      if (r.lowerEarningsLimitWeekly && nwe < r.lowerEarningsLimitWeekly.amountMinor) {
        belowLelDays++;
        return;
      }
      if (chain.waitingServed < r.waitingDays) {
        chain.waitingServed++;
        waitingApplied++;
        return;
      }
      if (chain.paidDays >= r.maxWeeks * qdPerWeek) {
        exhaustedOn ??= d;
        return;
      }
      let rate = baseRate(r);
      const t = r.transitional;
      const band = t?.protectedBandNormalWeeklyEarnings;
      if (
        t &&
        band &&
        compareDates(s.start, effectiveFrom) < 0 &&
        chain.firstPaid !== null &&
        compareDates(chain.firstPaid, effectiveFrom) < 0 &&
        nwe >= band.min.amountMinor &&
        nwe <= band.max.amountMinor
      ) {
        rate = t.protectedWeeklyRate.amountMinor;
      }
      chain.paidDays++;
      chain.firstPaid ??= d;
      lastRate = rate;
      paidByRate.set(rate, (paidByRate.get(rate) ?? 0) + 1);
    });
    prevEnd = s.end;
  }
  let payableMinor = 0;
  let daysPaid = 0;
  const breakdown: Array<{
    weeklyRateMinor: number;
    dailyRateMinor: number;
    days: number;
    payableMinor: number;
  }> = [];
  for (const [rate, n] of paidByRate) {
    // Whole weeks at the weekly rate; odd days at weekly ÷ qualifying days, rounded up to the penny.
    const daily = Math.ceil(rate / qdPerWeek);
    const weeks = Math.floor(n / qdPerWeek);
    const amount = weeks * rate + (n - weeks * qdPerWeek) * daily;
    breakdown.push({ weeklyRateMinor: rate, dailyRateMinor: daily, days: n, payableMinor: amount });
    payableMinor += amount;
    daysPaid += n;
  }
  const last = spells.at(-1);
  const weekly = lastRate ?? (fixed ? baseRate(fixed) : last ? baseRate(ruleOn(last.end).value) : 0);
  return {
    eligible: daysPaid > 0 || belowLelDays === 0,
    weeklyRateMinor: weekly,
    dailyRateMinor: Math.ceil(weekly / qdPerWeek),
    daysPaid,
    weeksPaid: r2(daysPaid / qdPerWeek),
    payableMinor,
    waitingDaysApplied: waitingApplied,
    belowLowerEarningsLimitDays: belowLelDays,
    spellsNotPeriodsOfIncapacity: notPiw,
    exhaustedOn,
    breakdown,
  };
}

// ---- statutory sick pay: EU employer obligations ---------------------------------------------------------

export interface EuSickInput {
  /** Employment start date. */
  startDate: string;
  sickStart: string;
  sickEnd: string;
  /** Normal gross weekly pay (minor units). */
  weeklyPayMinor: number;
  pattern: WorkPattern;
  holidays?: string[];
  /** Earlier sickness spells (per-year and rolling-12-month limits). */
  priorSpells?: Array<{ start: string; end: string }>;
  /** e.g. 'work_accident', 'occupational_disease', 'illness_during_pregnancy'. */
  cause?: string;
  age50Plus?: boolean;
}

export interface EuSickBand {
  percent: number;
  from: string;
  to: string;
  days: number;
  dailyAmountMinor: number;
  totalMinor: number;
}

export interface EuSickResult {
  scheme:
    'continued_pay' | 'paid_days_per_year' | 'employer_days_window' | 'employer_complement' | 'not_modelled';
  eligible: boolean;
  /** Basis of `paidDays`. */
  dayBasis: 'calendar' | 'working';
  paidDays: number;
  /** Calendar days covered by employer pay. */
  paidCalendarDays: number;
  percent: number | null;
  dailyAmountMinor: number | null;
  totalMinor: number | null;
  bands: EuSickBand[];
  notes: string[];
}

const workingDaysIn = (from: string, to: string, pattern: WorkPattern, holidays: string[] = []) =>
  compareDates(from, to) > 0 ? 0 : requestAmount({ start: from, end: to, pattern, holidays }).days;
const calendarDaysIn = (from: string, to: string) =>
  compareDates(from, to) > 0 ? 0 : daysBetween(from, to) + 1;
const clampRange = (from: string, to: string, lo: string, hi: string): [string, string] => [
  maxDate(from, lo),
  minDate(to, hi),
];

/**
 * Employer sick-pay obligations for the EU member-state shapes held in the packs:
 * DE/NL `continuedPayPercent` + weeks; IE `daysPerYear`; ES `employerPaysDays`; FR `employerComplement`;
 * PL `maxDaysPerCalendarYear`. Anything else is reported as not modelled.
 */
export function employerContinuedPay(rule: Record<string, unknown>, i: EuSickInput): EuSickResult {
  const notes: string[] = [];
  const none = { bands: [] as EuSickBand[], notes };
  const perWorkingDay = i.weeklyPayMinor / (workingDaysPerWeek(i.pattern) || 5);
  const perCalendarDay = i.weeklyPayMinor / 7;
  const prior = (i.priorSpells ?? []).filter((s) => compareDates(s.start, i.sickStart) < 0);

  // FR — employer complement to the social-security daily allowance (IJSS).
  if (rule.employerComplement && typeof rule.employerComplement === 'object') {
    const c = rule.employerComplement as {
      minServiceYears: number;
      waitingDays: number;
      noWaitingDaysFor?: string[];
      firstRatePercentOfGross: number;
      secondRatePercentOfGross: number;
      ijssDeducted?: boolean;
      priorDaysInRolling12MonthsDeducted?: boolean;
      bandsByServiceYears: Array<{ minServiceYears: number; days90: number; days6666: number }>;
    };
    const ss = rule.socialSecurityDailyAllowance as
      { waitingDays?: number; percentOfDailyBasicWage?: number } | undefined;
    const serviceYears = Math.floor(monthsBetween(i.startDate, i.sickStart) / 12);
    const band = [...c.bandsByServiceYears]
      .sort((a, b) => b.minServiceYears - a.minServiceYears)
      .find((b) => serviceYears >= b.minServiceYears);
    if (serviceYears < c.minServiceYears || !band)
      return {
        ...none,
        scheme: 'employer_complement',
        eligible: false,
        dayBasis: 'calendar',
        paidDays: 0,
        paidCalendarDays: 0,
        percent: null,
        dailyAmountMinor: 0,
        totalMinor: 0,
      };
    const waiting = i.cause && (c.noWaitingDaysFor ?? []).includes(i.cause) ? 0 : c.waitingDays;
    // Days the employer already paid in the 12 months before this stoppage reduce the durations.
    let used = 0;
    if (c.priorDaysInRolling12MonthsDeducted) {
      const lookback = addMonths(i.sickStart, -12);
      for (const s of prior)
        used += calendarDaysIn(
          ...clampRange(addDays(s.start, waiting), s.end, lookback, addDays(i.sickStart, -1)),
        );
    }
    const first = Math.max(0, band.days90 - used);
    const second = Math.max(0, band.days6666 - Math.max(0, used - band.days90));
    const ijssPercent = c.ijssDeducted ? (ss?.percentOfDailyBasicWage ?? 0) : 0;
    const ijssFrom = addDays(i.sickStart, ss?.waitingDays ?? 0);
    const bands: EuSickBand[] = [];
    let cursor = addDays(i.sickStart, waiting);
    for (const [percent, days] of [
      [c.firstRatePercentOfGross, first],
      [c.secondRatePercentOfGross, second],
    ] as const) {
      if (days <= 0 || compareDates(cursor, i.sickEnd) > 0) continue;
      const to = minDate(addDays(cursor, days - 1), i.sickEnd);
      const n = calendarDaysIn(cursor, to);
      // The employer tops up to `percent` of gross pay, less the IJSS (paid after its own waiting days).
      const daily = Math.round((perCalendarDay * percent) / 100);
      const ijss = Math.round(
        calendarDaysIn(maxDate(cursor, ijssFrom), to) * ((perCalendarDay * ijssPercent) / 100),
      );
      bands.push({
        percent,
        from: cursor,
        to,
        days: n,
        dailyAmountMinor: daily,
        totalMinor: Math.max(0, n * daily - ijss),
      });
      cursor = addDays(to, 1);
    }
    notes.push(
      'guaranteedPercentIncludesIjss',
      'ijssDailyCapNotModelled',
      'collectiveAgreementMayBeMoreFavourable',
    );
    const paid = bands.reduce((s, b) => s + b.days, 0);
    return {
      scheme: 'employer_complement',
      eligible: true,
      dayBasis: 'calendar',
      paidDays: paid,
      paidCalendarDays: paid,
      percent: bands[0]?.percent ?? null,
      dailyAmountMinor: bands[0]?.dailyAmountMinor ?? null,
      totalMinor: bands.reduce((s, b) => s + b.totalMinor, 0),
      bands,
      notes,
    };
  }

  // ES — the employer pays the benefit for days `from`–`to` of the incapacity; social security thereafter.
  if (rule.employerPaysDays && typeof rule.employerPaysDays === 'object') {
    const w = rule.employerPaysDays as { from: number; to: number };
    if (i.cause === 'work_accident' || i.cause === 'occupational_disease')
      notes.push('occupationalContingencyNotModelled');
    const n = calendarDaysIn(
      ...clampRange(addDays(i.sickStart, w.from - 1), addDays(i.sickStart, w.to - 1), i.sickStart, i.sickEnd),
    );
    if (
      typeof rule.maxDurationDays === 'number' &&
      calendarDaysIn(i.sickStart, i.sickEnd) > rule.maxDurationDays
    )
      notes.push('maxDurationExceeded');
    notes.push('benefitPercentNotModelled', `socialSecurityFromDay:${w.to + 1}`);
    return {
      ...none,
      scheme: 'employer_days_window',
      eligible: n > 0,
      dayBasis: 'calendar',
      paidDays: n,
      paidCalendarDays: n,
      percent: null,
      dailyAmountMinor: null,
      totalMinor: null,
      notes,
    };
  }

  // PL — the employer pays sickness remuneration for up to N calendar days per calendar year.
  if (typeof rule.maxDaysPerCalendarYear === 'number') {
    if (i.age50Plus === undefined) notes.push('assumedUnder50');
    const limit =
      i.age50Plus && typeof rule.maxDaysPerCalendarYearAge50Plus === 'number'
        ? rule.maxDaysPerCalendarYearAge50Plus
        : rule.maxDaysPerCalendarYear;
    const { year } = dateParts(i.sickStart);
    const [ys, ye] = [`${year}-01-01`, `${year}-12-31`];
    const used = prior.reduce((s, sp) => s + calendarDaysIn(...clampRange(sp.start, sp.end, ys, ye)), 0);
    const n = Math.min(
      Math.max(0, limit - used),
      calendarDaysIn(...clampRange(i.sickStart, i.sickEnd, ys, ye)),
    );
    const percent =
      i.cause && Array.isArray(rule.hundredPercentCases) && rule.hundredPercentCases.includes(i.cause)
        ? 100
        : (rule.continuedPayPercent as number);
    const daily = Math.round((perCalendarDay * percent) / 100);
    notes.push('payBasisApproximatedFromCurrentPay');
    return {
      ...none,
      scheme: 'paid_days_per_year',
      eligible: n > 0,
      dayBasis: 'calendar',
      paidDays: n,
      paidCalendarDays: n,
      percent,
      dailyAmountMinor: daily,
      totalMinor: n * daily,
      notes,
    };
  }

  const eligibleFrom = addDays(
    i.startDate,
    (typeof rule.qualifyingServiceWeeks === 'number' ? rule.qualifyingServiceWeeks : 0) * 7,
  );

  // IE — statutory sick days per year at a percentage of daily pay, with a daily cap.
  if (typeof rule.daysPerYear === 'number') {
    const percent = typeof rule.ratePercent === 'number' ? rule.ratePercent : 0;
    if (compareDates(i.sickStart, eligibleFrom) < 0)
      return {
        ...none,
        scheme: 'paid_days_per_year',
        eligible: false,
        dayBasis: 'working',
        paidDays: 0,
        paidCalendarDays: 0,
        percent,
        dailyAmountMinor: 0,
        totalMinor: 0,
      };
    const { year } = dateParts(i.sickStart);
    const [ys, ye] = [`${year}-01-01`, `${year}-12-31`];
    const used = prior.reduce(
      (s, sp) => s + workingDaysIn(...clampRange(sp.start, sp.end, ys, ye), i.pattern, i.holidays),
      0,
    );
    const paidDays = Math.min(
      Math.max(0, rule.daysPerYear - used),
      workingDaysIn(...clampRange(i.sickStart, i.sickEnd, ys, ye), i.pattern, i.holidays),
    );
    const raw = Math.round((perWorkingDay * percent) / 100);
    const cap = rule.dailyCap as { amountMinor: number } | undefined;
    const daily = cap ? Math.min(raw, cap.amountMinor) : raw;
    return {
      ...none,
      scheme: 'paid_days_per_year',
      eligible: true,
      dayBasis: 'working',
      paidDays,
      paidCalendarDays: paidDays,
      percent,
      dailyAmountMinor: daily,
      totalMinor: paidDays * daily,
    };
  }

  // DE / NL — continued pay at a percentage for a number of weeks of the incapacity.
  if (typeof rule.continuedPayPercent === 'number') {
    const weeks = (rule.maxWeeksPerIncapacity ?? rule.maxWeeks ?? 0) as number;
    const from = maxDate(i.sickStart, eligibleFrom);
    const to = minDate(addDays(i.sickStart, weeks * 7 - 1), i.sickEnd);
    const paidCalendarDays = calendarDaysIn(from, to);
    const paidWorking = workingDaysIn(from, to, i.pattern, i.holidays);
    const daily = Math.round((perWorkingDay * rule.continuedPayPercent) / 100);
    if (rule.minimumWageFloorFirstWeeks) notes.push('minimumWageFloorNotApplied');
    if (rule.wageCap) notes.push('wageCapNotApplied');
    return {
      ...none,
      scheme: 'continued_pay',
      eligible: paidCalendarDays > 0,
      dayBasis: 'working',
      paidDays: paidWorking,
      paidCalendarDays,
      percent: rule.continuedPayPercent,
      dailyAmountMinor: daily,
      totalMinor: paidWorking * daily,
      notes,
    };
  }

  return {
    ...none,
    scheme: 'not_modelled',
    eligible: false,
    dayBasis: 'calendar',
    paidDays: 0,
    paidCalendarDays: 0,
    percent: null,
    dailyAmountMinor: null,
    totalMinor: null,
  };
}

// ---- US state paid sick leave ---------------------------------------------------------------------------

/** Shapes of `sick_pay.paid_sick_leave_accrual` in the US federal and state packs. */
export interface UsSickRule {
  federal?: boolean;
  statewide?: boolean;
  accrual?: { hoursEarned: number; perHoursWorked: number };
  /** Balance cap (CA): greater (or lesser) of hours and days × hours per day. */
  accrualCap?: { hours?: number; days?: number; rule?: string };
  /** Use the employer may limit per year (CA). */
  annualUseCap?: { hours?: number; days?: number; rule?: string };
  /** Accrual cap per year (CO, MA, OR). */
  annualCapHours?: number;
  /** Accrual cap per 12-month period (IL). */
  capHoursPer12Months?: number;
  /** Employer-size tiers: hours per year, paid or unpaid (NY). */
  tiers?: Array<{
    minEmployees: number;
    maxEmployees: number | null;
    hours: number;
    paid: boolean;
    netIncomeMaxMinor?: number;
    netIncomeAboveMinor?: number;
  }>;
  /** Leave must be paid when the employer has at least this many employees, else it may be unpaid (MA). */
  paidIfEmployeesAtLeast?: number;
  /** Use may begin this many days after the start date (IL, MA). */
  useBeginsAfterDays?: number;
  /** Use may begin this many calendar days after the first day of work (WA). */
  useBeginsCalendarDay?: number;
  /** The employer may defer use until this calendar day of employment, day 1 being the start date (OR). */
  useMayBeDeferredUntilCalendarDay?: number;
  /** CA: days worked in the state within a year; employment period before use. */
  eligibility?: { minDaysWorkedInStateWithinYear?: number; employmentPeriodDaysBeforeUse?: number };
  [k: string]: unknown;
}

/** Keys whose condition depends on a locality (a city or county location or ordinance). */
const LOCALITY_DEPENDENT = /Location$|[Oo]rdinance/;
/** "paidIf<State>EmployeesAtLeast": paid when the employer has this many employees in the state (OR). */
const STATE_HEADCOUNT = /^paidIf[A-Z][A-Za-z]*EmployeesAtLeast$/;

const capOf = (c: { hours?: number; days?: number; rule?: string }, hoursPerDay: number) => {
  const fromDays = c.days !== undefined ? c.days * hoursPerDay : undefined;
  if (c.hours === undefined) return fromDays ?? Infinity;
  if (fromDays === undefined) return c.hours;
  return c.rule === 'lesser_of' ? Math.min(c.hours, fromDays) : Math.max(c.hours, fromDays);
};

/**
 * US state paid sick leave for one accrual year: hours earned per hours worked, capped by the state's
 * balance, annual, 12-month or employer-size-tier cap; paid or unpaid by employer size; the date use
 * may begin. Conditions that need a locality (e.g. a city location) are listed in `notEvaluated`
 * until a locality layer supplies them; nothing breaks when no locality is known.
 */
export function usSickAccrual(
  rule: UsSickRule,
  i: {
    hoursWorked: number;
    hoursPerDay?: number;
    employerSize?: number;
    stateEmployees?: number;
    employerNetIncomeMinor?: number;
    startDate?: string;
    asOf?: string;
    daysWorkedInStateWithinYear?: number;
  },
) {
  const hoursPerDay = i.hoursPerDay ?? 8;
  const notEvaluated = Object.keys(rule).filter((k) => LOCALITY_DEPENDENT.test(k));
  if (!rule.accrual)
    return {
      required: false,
      earnedHours: 0,
      accruedHours: 0,
      capHours: null,
      useCapHours: null,
      paid: false,
      eligible: false,
      usableFrom: null,
      canUse: false,
      notEvaluated,
    };
  const earned = Math.floor(i.hoursWorked / rule.accrual.perHoursWorked) * rule.accrual.hoursEarned;
  let cap = Infinity;
  let useCap: number | null = null;
  let paid = true;
  if (rule.accrualCap) cap = Math.min(cap, capOf(rule.accrualCap, hoursPerDay));
  for (const yearly of [rule.annualCapHours, rule.capHoursPer12Months]) {
    if (yearly === undefined) continue;
    cap = Math.min(cap, yearly);
    useCap = yearly;
  }
  if (rule.annualUseCap) useCap = capOf(rule.annualUseCap, hoursPerDay);
  if (rule.tiers) {
    const size = i.employerSize;
    const tier =
      size === undefined
        ? undefined
        : rule.tiers.find(
            (t) =>
              size >= t.minEmployees &&
              (t.maxEmployees === null || size <= t.maxEmployees) &&
              (t.netIncomeMaxMinor === undefined || (i.employerNetIncomeMinor ?? 0) <= t.netIncomeMaxMinor) &&
              (t.netIncomeAboveMinor === undefined ||
                (i.employerNetIncomeMinor ?? Infinity) > t.netIncomeAboveMinor),
          );
    if (!tier) notEvaluated.push('tiers');
    else {
      cap = Math.min(cap, tier.hours);
      useCap = tier.hours;
      paid = tier.paid;
    }
  }
  if (rule.paidIfEmployeesAtLeast !== undefined) {
    if (i.employerSize === undefined) notEvaluated.push('paidIfEmployeesAtLeast');
    else paid &&= i.employerSize >= rule.paidIfEmployeesAtLeast;
  }
  for (const [k, v] of Object.entries(rule)) {
    if (!STATE_HEADCOUNT.test(k) || typeof v !== 'number') continue;
    if (i.stateEmployees === undefined) notEvaluated.push(k);
    else paid &&= i.stateEmployees >= v;
  }
  let usableFrom: string | null = i.startDate ?? null;
  if (i.startDate) {
    const after =
      rule.useBeginsAfterDays ?? rule.useBeginsCalendarDay ?? rule.eligibility?.employmentPeriodDaysBeforeUse;
    if (after !== undefined) usableFrom = addDays(i.startDate, after);
    else if (rule.useMayBeDeferredUntilCalendarDay !== undefined)
      usableFrom = addDays(i.startDate, rule.useMayBeDeferredUntilCalendarDay - 1);
  }
  const minDays = rule.eligibility?.minDaysWorkedInStateWithinYear;
  if (minDays !== undefined && i.daysWorkedInStateWithinYear === undefined)
    notEvaluated.push('minDaysWorkedInStateWithinYear');
  const eligible =
    minDays === undefined ||
    i.daysWorkedInStateWithinYear === undefined ||
    i.daysWorkedInStateWithinYear >= minDays;
  return {
    required: true,
    earnedHours: earned,
    accruedHours: eligible ? Math.min(earned, cap) : 0,
    capHours: Number.isFinite(cap) ? cap : null,
    useCapHours: useCap,
    paid,
    eligible,
    usableFrom,
    canUse: eligible && (!usableFrom || !i.asOf || compareDates(i.asOf, usableFrom) >= 0),
    notEvaluated,
  };
}

// ---- analytics ---------------------------------------------------------------------------------------

/** Bradford factor S² × D for sickness spells overlapping the `windowDays` up to and including `asOf`. */
export function bradfordFactor(
  spells: Array<{ start: string; end: string }>,
  asOf: string,
  pattern: WorkPattern,
  windowDays = 365,
) {
  const windowStart = addDays(asOf, -(windowDays - 1));
  let s = 0;
  let d = 0;
  for (const sp of spells) {
    if (compareDates(sp.end, windowStart) < 0 || compareDates(sp.start, asOf) > 0) continue;
    s++;
    d += requestAmount({
      start: maxDate(sp.start, windowStart),
      end: minDate(sp.end, asOf),
      pattern,
      holidays: [],
    }).days;
  }
  return { spells: s, days: d, score: s * s * d };
}

// ---- US FMLA ----------------------------------------------------------------------------------------

/** Shape of US `family_leave.fmla`. */
export interface FmlaRule {
  coveredEmployer: {
    privateSectorMinEmployees: number;
    inWorkweeks?: number;
    publicAgenciesCoveredRegardlessOfSize?: boolean;
  };
  eligibility: {
    minMonthsOfService: number;
    minHoursInPrior12Months: number;
    minEmployeesWithinRadius: number;
    radiusMiles?: number;
  };
  entitlementWorkweeks?: number;
  militaryCaregiverWorkweeks?: number;
  leaveYearMethods?: string[];
  militaryCaregiverPeriod?: string;
}

/**
 * Employer coverage (29 CFR 825.104–825.105): at least `privateSectorMinEmployees` employees on the
 * payroll in each of `inWorkweeks` or more calendar workweeks (not necessarily consecutive) in the
 * current or preceding calendar year. A workweek belongs to the calendar year of its first day.
 * Public agencies are covered regardless of size when the pack says so.
 */
export function fmlaEmployerCoverage(
  rule: FmlaRule,
  i: {
    asOf: string;
    weeklyHeadcounts: Array<{ weekStart: string; employees: number }>;
    publicAgency?: boolean;
  },
) {
  const min = rule.coveredEmployer.privateSectorMinEmployees;
  const needed = rule.coveredEmployer.inWorkweeks ?? 1;
  const { year } = dateParts(i.asOf);
  let current = 0;
  let preceding = 0;
  for (const w of i.weeklyHeadcounts) {
    if (compareDates(w.weekStart, i.asOf) > 0 || w.employees < min) continue;
    const y = dateParts(w.weekStart).year;
    if (y === year) current++;
    else if (y === year - 1) preceding++;
  }
  const weeks = { qualifyingWeeksCurrentYear: current, qualifyingWeeksPrecedingYear: preceding };
  if (i.publicAgency && rule.coveredEmployer.publicAgenciesCoveredRegardlessOfSize)
    return { covered: true, basis: 'public_agency' as const, ...weeks };
  return { covered: current >= needed || preceding >= needed, basis: 'headcount' as const, ...weeks };
}

/** FMLA employee eligibility from the US pack rule. */
export function fmlaEligibility(
  rule: FmlaRule,
  i: {
    serviceMonths: number;
    hoursPrior12Months: number;
    employeesWithinRadius: number;
    employerCovered: boolean;
  },
) {
  const failed: string[] = [];
  if (!i.employerCovered) failed.push('employer');
  if (i.serviceMonths < rule.eligibility.minMonthsOfService) failed.push('service');
  if (i.hoursPrior12Months < rule.eligibility.minHoursInPrior12Months) failed.push('hours');
  if (i.employeesWithinRadius < rule.eligibility.minEmployeesWithinRadius) failed.push('worksite');
  return { eligible: failed.length === 0, failed };
}

/**
 * The FMLA 12-month period [from, to) that applies on `asOf` (29 CFR 825.200; DOL Fact Sheet #28H):
 * - calendar_year: 1 January to 31 December;
 * - fixed_12_month_period: a fixed leave year starting `fixedYearStart` (MM-DD: fiscal year, anniversary…);
 * - forward_from_first_leave_date: 12 months from the first FMLA leave; the next period begins with the
 *   first FMLA leave after that one ends;
 * - rolling_backward_from_leave_date: the 12 months ending on (and including) `asOf`.
 * Military caregiver leave uses a single 12-month period from its first day when the pack says so.
 */
export function fmlaLeaveYear(i: {
  method: string;
  asOf: string;
  usageDates: string[];
  fixedYearStart?: string;
  reason?: string;
  militaryCaregiverPeriod?: string;
  allowedMethods?: string[];
}): [string, string] {
  if (i.allowedMethods && !i.allowedMethods.includes(i.method))
    throw new Error(`Unknown FMLA leave-year method ${i.method}`);
  const usage = [...i.usageDates].sort(compareDates);
  if (
    i.reason === 'military_caregiver' &&
    i.militaryCaregiverPeriod === 'single_12_month_period_from_first_day_of_caregiver_leave'
  ) {
    const first = usage[0] ?? i.asOf;
    return [first, addMonths(first, 12)];
  }
  const { year } = dateParts(i.asOf);
  switch (i.method) {
    case 'calendar_year':
      return [`${year}-01-01`, `${year + 1}-01-01`];
    case 'fixed_12_month_period':
      return leaveYearFor(i.asOf, i.fixedYearStart ?? '01-01');
    case 'forward_from_first_leave_date': {
      let start = usage.find((d) => compareDates(d, i.asOf) <= 0);
      if (!start) return [i.asOf, addMonths(i.asOf, 12)];
      while (compareDates(addMonths(start, 12), i.asOf) <= 0) {
        const ended: string = addMonths(start, 12);
        const next: string | undefined = usage.find(
          (d) => compareDates(d, ended) >= 0 && compareDates(d, i.asOf) <= 0,
        );
        if (!next) return [i.asOf, addMonths(i.asOf, 12)];
        start = next;
      }
      return [start, addMonths(start, 12)];
    }
    case 'rolling_backward_from_leave_date':
      return [addDays(addMonths(i.asOf, -12), 1), addDays(i.asOf, 1)];
    default:
      throw new Error(`Unknown FMLA leave-year method ${i.method}`);
  }
}

/** Great-circle distance in miles (for the FMLA 75-mile worksite count). */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3958.8;
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- statutory family leave (from the packs) -----------------------------------------------------------------

/** Shapes of GB `family_leave.maternity` / `family_leave.paternity`. */
export interface FamilyLeaveRule {
  leaveWeeks?: number;
  leaveWeeksMax?: number;
  leaveQualifyingService?: { weeks: number } | null;
  pay?: {
    weeks?: number;
    qualifyingServiceWeeks?: number;
    flatRate?: Money;
    remaining33Weeks?: { flatRate?: Money };
  };
}

/**
 * Statutory family leave summary for the employee: leave weeks and whether service so far meets the
 * leave and pay service requirements. Indicative: statutory tests measure service to a qualifying week
 * before the expected week of childbirth, which HR confirms when the leave is notified.
 */
export function familyLeaveInfo(rule: FamilyLeaveRule, i: { startDate: string; asOf: string }) {
  const serviceWeeks = Math.max(0, Math.floor(daysBetween(i.startDate, i.asOf) / 7));
  const leaveService = rule.leaveQualifyingService?.weeks ?? 0;
  const payService = rule.pay?.qualifyingServiceWeeks ?? 0;
  return {
    leaveWeeks: rule.leaveWeeks ?? rule.leaveWeeksMax ?? 0,
    leaveServiceWeeksRequired: leaveService,
    meetsLeaveService: serviceWeeks >= leaveService,
    payWeeks: rule.pay?.weeks ?? null,
    payServiceWeeksRequired: payService,
    meetsPayService: serviceWeeks >= payService,
    serviceWeeks,
    flatWeeklyRate: rule.pay?.flatRate ?? rule.pay?.remaining33Weeks?.flatRate ?? null,
  };
}
