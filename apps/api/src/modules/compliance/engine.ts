import {
  addDays,
  addMonths,
  addYears,
  compareDates,
  dayOfWeek,
  daysBetween,
  maxDate,
} from '@thapsus/core/time';
import { codeLineage, type RuleBook } from '@thapsus/rules';

/**
 * Compliance calculators. Pure functions over jurisdiction-pack rule values (never hard-coded law):
 * the caller resolves the rule for the right jurisdiction and date and passes its value in. Golden
 * tests: apps/api/test/compliance-engine.test.ts.
 */

// ---- shared helpers ---------------------------------------------------------------------------
/** Adds an ISO 8601 date period of whole years, months or days (P2Y, P6M, P1Y6M, P30D). */
export function addPeriod(date: string, period: string): string {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(period);
  if (!m || period === 'P') throw new RangeError(`Unsupported period ${period}`);
  let d = date;
  if (m[1]) d = addYears(d, Number(m[1]));
  if (m[2]) d = addMonths(d, Number(m[2]));
  if (m[3]) d = addDays(d, Number(m[3]));
  return d;
}
const cmp = compareDates;

// ---- UK right to work -------------------------------------------------------------------------
export type RtwListType =
  'list_a' | 'list_b_group_1' | 'list_b_group_2' | 'online_unlimited' | 'online_time_limited';
type FollowUpSpec =
  | null
  | { dueBy: 'permission_expiry_date' }
  | { excusePeriod: string; from: 'positive_verification_notice_date'; dueBy: 'before_excuse_expires' };
export interface RtwDocumentRules {
  methods: Array<{ id: string }>;
  listTypes: RtwListType[];
  followUp: Record<RtwListType, FollowUpSpec>;
  documentCatalogue?: Record<string, string[]>;
}

export class RtwInputError extends Error {}

/**
 * Statutory excuse and follow-up date for a right-to-work check (Home Office Employer's guide):
 * continuous excuse → no follow-up; time-limited permission → follow-up on or before the permission
 * end date; Positive Verification Notice → excuse for the pack period from the PVN date, follow-up
 * before it expires (the day before the period ends).
 */
export function rtwFollowUp(
  rule: RtwDocumentRules,
  i: {
    listType: RtwListType;
    checkedOn: string;
    permissionExpiresOn?: string | null;
    pvnDate?: string | null;
  },
) {
  if (!rule.listTypes.includes(i.listType)) throw new RtwInputError(`unknown list type ${i.listType}`);
  const spec = rule.followUp[i.listType];
  if (spec === null || spec === undefined)
    return { excuse: 'continuous' as const, excuseEndsOn: null, followUpDueOn: null };
  if ('excusePeriod' in spec) {
    if (!i.pvnDate) throw new RtwInputError('pvnDate is required for this list');
    const ends = addPeriod(i.pvnDate, spec.excusePeriod);
    return { excuse: 'time_limited' as const, excuseEndsOn: ends, followUpDueOn: addDays(ends, -1) };
  }
  if (!i.permissionExpiresOn) throw new RtwInputError('permissionExpiresOn is required for this list');
  return {
    excuse: 'time_limited' as const,
    excuseEndsOn: i.permissionExpiresOn,
    followUpDueOn: i.permissionExpiresOn,
  };
}

/** Right-to-work records are kept during employment and for the pack period after it ends. */
export function rtwRetainUntil(
  rule: { retainAfterEmploymentEnds: string },
  employmentEndedOn: string | null,
): string | null {
  return employmentEndedOn ? addPeriod(employmentEndedOn, rule.retainAfterEmploymentEnds) : null;
}

// ---- US Form I-9 ------------------------------------------------------------------------------
export interface I9CompletionRule {
  section1: { dueBy: 'first_day_of_employment' };
  section2: {
    businessDaysAfterFirstDay: number;
    ifEmploymentShorterThanBusinessDays: number;
    thenDueBy: 'first_day_of_employment';
  };
}

/** Section 1 by the first day; Section 2 within N business days after it (or by the first day for short hires). */
export function i9Deadlines(
  rule: I9CompletionRule,
  i: { firstDay: string; lastDay?: string | null; businessWeekdays: number[]; closedDates?: string[] },
) {
  const closed = new Set(i.closedDates ?? []);
  const isBusinessDay = (d: string) => i.businessWeekdays.includes(dayOfWeek(d)) && !closed.has(d);
  if (i.lastDay) {
    let days = 0;
    for (
      let d = i.firstDay;
      cmp(d, i.lastDay) <= 0 && days < rule.section2.ifEmploymentShorterThanBusinessDays;
      d = addDays(d, 1)
    )
      if (isBusinessDay(d)) days++;
    if (days < rule.section2.ifEmploymentShorterThanBusinessDays)
      return { section1DueOn: i.firstDay, section2DueOn: i.firstDay };
  }
  let d = i.firstDay;
  for (let n = 0; n < rule.section2.businessDaysAfterFirstDay;) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) n++;
  }
  return { section1DueOn: i.firstDay, section2DueOn: d };
}

/** Retention: the later of N years after hire and M years after employment ends (null end = still employed). */
export function i9RetainUntil(
  rule: { rule: 'later_of'; afterHireYears: number; afterEmploymentEndsYears: number },
  i: { hireDate: string; terminationDate: string | null },
) {
  const fromHire = addYears(i.hireDate, rule.afterHireYears);
  if (!i.terminationDate) return { retainUntil: null, atLeastUntil: fromHire };
  return {
    retainUntil: maxDate(fromHire, addYears(i.terminationDate, rule.afterEmploymentEndsYears)),
    atLeastUntil: fromHire,
  };
}

/** Reverification is due no later than the date employment authorization expires. */
export function i9Reverification(
  rule: { suggestedAdvanceNoticeDays?: number },
  workAuthorizationExpiresOn: string | null,
) {
  if (!workAuthorizationExpiresOn) return { dueOn: null, remindFrom: null };
  return {
    dueOn: workAuthorizationExpiresOn,
    remindFrom: rule.suggestedAdvanceNoticeDays
      ? addDays(workAuthorizationExpiresOn, -rule.suggestedAdvanceNoticeDays)
      : null,
  };
}

// ---- service length (unfair dismissal qualifying period) ----------------------------------------
/** Last day of a period of continuous employment of `period` beginning on `start` (ERA 1996 s.211(1): start and end days count). */
export const serviceCompletedOn = (start: string, period: string) => addDays(addPeriod(start, period), -1);

/**
 * Earliest effective date of termination on which the employee has the qualifying period in force on
 * that date (the period is selected by EDT, so a shorter period commencing later can bring the date
 * forward: ERA 2025 s.25 from 1 January 2027, S.I. 2026/559 reg. 4). Returns null where no rule exists.
 */
export function unfairDismissalQualifyingDate(book: RuleBook, jurisdiction: string, startDate: string) {
  let at = startDate;
  for (let guard = 0; guard < 20; guard++) {
    const r = book.tryResolve<{ qualifyingPeriod: string }>(
      jurisdiction,
      'employment.unfair_dismissal_qualifying_period',
      at,
    );
    if (!r) return null;
    const candidate = maxDate(
      serviceCompletedOn(startDate, r.value.qualifyingPeriod),
      maxDate(at, r.effectiveFrom),
    );
    if (r.effectiveTo === null || cmp(candidate, r.effectiveTo) < 0)
      return {
        date: candidate,
        qualifyingPeriod: r.value.qualifyingPeriod,
        source: r.source,
        jurisdiction: r.jurisdiction,
        effectiveFrom: r.effectiveFrom,
      };
    at = r.effectiveTo;
  }
  return null;
}

// ---- UK irregular-hours and part-year accrual (WTR reg. 15B) ------------------------------------
export interface IrregularHoursRule {
  accrualPercentOfHoursWorked: number;
  capDaysPerLeaveYear?: number;
  rounding?: { unit: 'hour'; fractionBelowMinutesIsZero: number; fractionFromMinutesIsOneHour: number };
}

/** Holiday accrued in a pay period, in hours (exact integer arithmetic on minutes, rounded per the pack). */
export function irregularHoursAccrual(rule: IrregularHoursRule, i: { minutesWorked: number }) {
  if (!Number.isInteger(i.minutesWorked) || i.minutesWorked < 0)
    throw new RangeError('minutesWorked must be a non-negative integer');
  const bp = BigInt(Math.round(rule.accrualPercentOfHoursWorked * 100)); // basis points of a percent: 12.07% → 1207
  const scaled = BigInt(i.minutesWorked) * bp; // accrued minutes × 10,000
  const perHour = 60n * 10_000n;
  const wholeHours = scaled / perHour;
  const fractionMinutesScaled = scaled % perHour;
  const threshold = BigInt(rule.rounding?.fractionFromMinutesIsOneHour ?? 30) * 10_000n;
  const roundedHours = Number(wholeHours) + (rule.rounding && fractionMinutesScaled >= threshold ? 1 : 0);
  const exactHours = Number(scaled) / Number(perHour);
  return { exactHours, accruedHours: rule.rounding ? roundedHours : exactHours };
}

/** Whether a leave policy meets reg. 15B for an irregular-hours / part-year worker. */
export function irregularHoursPolicyCheck(
  rule: IrregularHoursRule,
  policy: { accrual: { method: string; percent?: number; days?: number } } | null,
) {
  if (!policy) return { ok: false, issue: 'no_policy' as const };
  if (policy.accrual.method !== 'per_hour_worked')
    return { ok: false, issue: 'not_accrued_per_hour_worked' as const };
  if ((policy.accrual.percent ?? 0) < rule.accrualPercentOfHoursWorked)
    return { ok: false, issue: 'below_statutory_percent' as const };
  return { ok: true, issue: null };
}

// ---- pay-gap statistics (UK gender pay gap, EU pay transparency) --------------------------------
/** Hourly rates are carried as integer thousandths of a minor unit, so sums stay exact. */
export const RATE_SCALE = 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
/** (A − B) / A × 100 — difference as a percentage of the male figure (S.I. 2017/172 regs 8–11; Directive 2023/970 art. 3(1)(c),(e)). */
export function gapPercent(male: number | null, female: number | null): number | null {
  if (male === null || female === null || male === 0) return null;
  return ((male - female) / male) * 100;
}
const round = (x: number | null, dp = 1) => (x === null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

export interface GpgRule {
  employeeThreshold: number;
  hourlyRate: { daysPerMonth: number; daysPerYear: number };
  quartiles: { bands: string[]; remainderAllocation: Record<string, string[]> };
}

/**
 * Hourly rate of pay (S.I. 2017/172 reg. 6): ordinary pay plus bonus attributed to the relevant pay
 * period, × 7 / days in the period (a month counts as the pack's days per month), ÷ weekly working hours.
 */
export function gpgHourlyRate(
  rule: GpgRule,
  i: {
    ordinaryPayMinor: number;
    bonusInPeriodMinor?: number;
    period: 'weekly' | 'monthly' | 'annual' | { days: number };
    weeklyHours: number;
  },
): number {
  const days =
    i.period === 'weekly'
      ? 7
      : i.period === 'monthly'
        ? rule.hourlyRate.daysPerMonth
        : i.period === 'annual'
          ? rule.hourlyRate.daysPerYear
          : i.period.days;
  if (!(i.weeklyHours > 0) || !(days > 0))
    throw new RangeError('weeklyHours and period days must be positive');
  const pay = BigInt(i.ordinaryPayMinor + (i.bonusInPeriodMinor ?? 0));
  // rate × RATE_SCALE = pay × 7 × RATE_SCALE / (days × hours); days and hours carried to 2 decimal places
  const num = pay * 7n * BigInt(RATE_SCALE) * 100n * 100n;
  const den = BigInt(Math.round(days * 100)) * BigInt(Math.round(i.weeklyHours * 100));
  return Number((num * 2n + den) / (2n * den)); // rounded half up
}

export type Sex = 'male' | 'female';
export interface GpgEmployee {
  sex: Sex | null;
  fullPay: boolean;
  /** Hourly rate × RATE_SCALE (integer), from gpgHourlyRate. */
  hourlyRate: number;
  bonus12MonthsMinor: number;
}

const BAND_ORDER = ['lower', 'lower_middle', 'upper_middle', 'upper'];

/** Band sizes: equal so far as possible; the remainder goes to the bands the pack lists for it. */
export function quartileSizes(
  n: number,
  remainderAllocation: Record<string, string[]> | null,
  bands = BAND_ORDER,
): number[] {
  const q = Math.floor(n / bands.length);
  const r = n - q * bands.length;
  const extra = r === 0 ? [] : (remainderAllocation?.[String(r)] ?? bands.slice(0, r));
  return bands.map((b) => q + (extra.includes(b) ? 1 : 0));
}

/** Largest-remainder apportionment of `total` items over weights, keeping integers. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

/**
 * Proportion of men and women in each quartile pay band. Employees are ranked by rate; where people
 * on the same rate span bands, men and women on that rate are split across those bands in the same
 * proportion (S.I. 2017/172 reg. 13(2)).
 */
export function quartileBands(
  rows: Array<{ sex: Sex; rate: number }>,
  remainderAllocation: Record<string, string[]> | null,
  bands = BAND_ORDER,
) {
  const sorted = [...rows].sort((a, b) => a.rate - b.rate);
  const sizes = quartileSizes(sorted.length, remainderAllocation, bands);
  const bandOf: number[] = [];
  sizes.forEach((s, b) => {
    for (let k = 0; k < s; k++) bandOf.push(b);
  });
  const counts = bands.map(() => ({ male: 0, female: 0 }));
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j]!.rate === sorted[i]!.rate) j++;
    const group = sorted.slice(i, j);
    const males = group.filter((g) => g.sex === 'male').length;
    const slots = bands.map(() => 0);
    for (let k = i; k < j; k++) slots[bandOf[k]!]!++;
    const maleSplit = apportion(males, slots);
    slots.forEach((s, b) => {
      counts[b]!.male += maleSplit[b]!;
      counts[b]!.female += s - maleSplit[b]!;
    });
    i = j;
  }
  return bands.map((band, b) => {
    const total = sizes[b]!;
    const c = counts[b]!;
    return {
      band,
      total,
      male: c.male,
      female: c.female,
      malePercent: total ? (c.male / total) * 100 : null,
      femalePercent: total ? (c.female / total) * 100 : null,
    };
  });
}

/** The six UK gender pay gap figures (S.I. 2017/172 reg. 2(1)(a)–(f)). Percentages unrounded plus rounded to 1 dp. */
export function genderPayGap(rule: GpgRule, employees: GpgEmployee[]) {
  const included = employees.filter(
    (e): e is GpgEmployee & { sex: Sex } => e.sex === 'male' || e.sex === 'female',
  );
  const fullPay = included.filter((e) => e.fullPay);
  const rates = (s: Sex) => fullPay.filter((e) => e.sex === s).map((e) => e.hourlyRate);
  const bonuses = (s: Sex) =>
    included.filter((e) => e.sex === s && e.bonus12MonthsMinor > 0).map((e) => e.bonus12MonthsMinor);
  const relevant = (s: Sex) => included.filter((e) => e.sex === s).length;
  const meanHourly = gapPercent(mean(rates('male')), mean(rates('female')));
  const medianHourly = gapPercent(median(rates('male')), median(rates('female')));
  const meanBonus = gapPercent(mean(bonuses('male')), mean(bonuses('female')));
  const medianBonus = gapPercent(median(bonuses('male')), median(bonuses('female')));
  const prop = (s: Sex) => (relevant(s) ? (bonuses(s).length / relevant(s)) * 100 : null);
  const quartiles = quartileBands(
    fullPay.map((e) => ({ sex: e.sex, rate: e.hourlyRate })),
    rule.quartiles.remainderAllocation,
    rule.quartiles.bands,
  );
  return {
    population: {
      relevantEmployees: included.length,
      fullPayRelevantEmployees: fullPay.length,
      excludedNoSexRecorded: employees.length - included.length,
      male: relevant('male'),
      female: relevant('female'),
    },
    meanHourlyPayGap: meanHourly,
    medianHourlyPayGap: medianHourly,
    meanBonusGap: meanBonus,
    medianBonusGap: medianBonus,
    bonusProportions: { male: prop('male'), female: prop('female') },
    quartiles,
    rounded: {
      meanHourlyPayGap: round(meanHourly),
      medianHourlyPayGap: round(medianHourly),
      meanBonusGap: round(meanBonus),
      medianBonusGap: round(medianBonus),
      bonusProportions: { male: round(prop('male')), female: round(prop('female')) },
      quartiles: quartiles.map((q) => ({
        band: q.band,
        malePercent: round(q.malePercent),
        femalePercent: round(q.femalePercent),
      })),
    },
  };
}

/** Snapshot date and reporting deadline for a year and sector from the pack (e.g. 5 April / 4 April next year). */
export function gpgDates(
  rule: {
    snapshotDates: Record<string, { month: number; day: number }>;
    reportingDeadlines: Record<string, { month: number; day: number; yearOffset: number }>;
  },
  year: number,
  sector: string,
) {
  const s = rule.snapshotDates[sector];
  const d = rule.reportingDeadlines[sector];
  if (!s || !d) throw new RangeError(`unknown sector ${sector}`);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    snapshotDate: `${year}-${pad(s.month)}-${pad(s.day)}`,
    deadline: `${year + d.yearOffset}-${pad(d.month)}-${pad(d.day)}`,
  };
}

export interface PayTransparencyRule {
  gapReporting: Array<{
    minWorkers: number;
    maxWorkers: number | null;
    firstReportBy: string;
    frequencyYears: number;
    reportsOn: string;
  }>;
  jointPayAssessment: { minDifferencePercent: number; notRemediedWithinMonthsOfReporting: number };
}
export interface PtWorker {
  sex: Sex | null;
  annualBasicMinor: number;
  annualVariableMinor: number;
  annualHours?: number | null;
  category?: string | null;
}

/**
 * EU Pay Transparency Directive art. 9(1)(a)–(g) indicators. Pay level = gross annual pay (and the
 * gross hourly figure where hours are known). Gaps in complementary or variable components are taken
 * over workers receiving them (ADR-0055: interpretation pending national transposition).
 */
export function payTransparency(rule: PayTransparencyRule, workers: PtWorker[], asOfYear: number) {
  const inc = workers.filter((w): w is PtWorker & { sex: Sex } => w.sex === 'male' || w.sex === 'female');
  const total = (w: PtWorker) => w.annualBasicMinor + w.annualVariableMinor;
  const hourly = inc.every((w) => (w.annualHours ?? 0) > 0);
  const level = (w: PtWorker) => (hourly ? (total(w) * RATE_SCALE) / (w.annualHours as number) : total(w));
  const by = (s: Sex, f: (w: PtWorker) => number, pred: (w: PtWorker) => boolean = () => true) =>
    inc.filter((w) => w.sex === s && pred(w)).map(f);
  const variable = (w: PtWorker) => w.annualVariableMinor > 0;
  const proportion = (s: Sex) => {
    const n = inc.filter((w) => w.sex === s).length;
    return n ? (by(s, () => 1, variable).length / n) * 100 : null;
  };
  const categories = [...new Set(inc.map((w) => w.category ?? null))]
    .filter((c): c is string => c !== null)
    .sort();
  const byCategory = categories.map((c) => {
    const inCat = (w: PtWorker) => w.category === c;
    const basic = gapPercent(
      mean(by('male', (w) => w.annualBasicMinor, inCat)),
      mean(by('female', (w) => w.annualBasicMinor, inCat)),
    );
    const varGap = gapPercent(
      mean(
        by(
          'male',
          (w) => w.annualVariableMinor,
          (w) => inCat(w) && variable(w),
        ),
      ),
      mean(
        by(
          'female',
          (w) => w.annualVariableMinor,
          (w) => inCat(w) && variable(w),
        ),
      ),
    );
    const totalGap = gapPercent(mean(by('male', total, inCat)), mean(by('female', total, inCat)));
    const workersInCat = inc.filter(inCat).length;
    return {
      category: c,
      workers: workersInCat,
      basicPayGap: basic,
      variablePayGap: varGap,
      totalPayGap: totalGap,
      jointPayAssessmentIndicated:
        totalGap !== null && Math.abs(totalGap) >= rule.jointPayAssessment.minDifferencePercent,
    };
  });
  const count = workers.length;
  const band =
    rule.gapReporting.find(
      (b) => count >= b.minWorkers && (b.maxWorkers === null || count <= b.maxWorkers),
    ) ?? null;
  return {
    population: {
      workers: count,
      included: inc.length,
      excludedNoSexRecorded: count - inc.length,
      payLevelBasis: hourly ? 'hourly' : 'annual',
    },
    obligation: band
      ? {
          reportingRequired: true,
          firstReportBy: band.firstReportBy,
          frequencyYears: band.frequencyYears,
          reportsOn: band.reportsOn,
          reportingYear: asOfYear - 1,
        }
      : { reportingRequired: false },
    genderPayGap: gapPercent(mean(by('male', level)), mean(by('female', level))),
    genderPayGapVariable: gapPercent(
      mean(by('male', (w) => w.annualVariableMinor, variable)),
      mean(by('female', (w) => w.annualVariableMinor, variable)),
    ),
    medianGenderPayGap: gapPercent(median(by('male', level)), median(by('female', level))),
    medianGenderPayGapVariable: gapPercent(
      median(by('male', (w) => w.annualVariableMinor, variable)),
      median(by('female', (w) => w.annualVariableMinor, variable)),
    ),
    proportionReceivingVariable: { male: proportion('male'), female: proportion('female') },
    quartiles: quartileBands(
      inc.map((w) => ({ sex: w.sex, rate: level(w) })),
      null,
    ),
    byCategory,
    jointPayAssessment: {
      thresholdPercent: rule.jointPayAssessment.minDifferencePercent,
      categoriesIndicated: byCategory.filter((c) => c.jointPayAssessmentIndicated).map((c) => c.category),
      remedyWithinMonths: rule.jointPayAssessment.notRemediedWithinMonthsOfReporting,
    },
  };
}

// ---- US exempt / non-exempt classification -----------------------------------------------------
type ThresholdValue = {
  standardWeekly?: { amountMinor: number };
  hceAnnualTotalCompensation?: { amountMinor: number };
  weekly?: { amountMinor: number };
  annual?: { amountMinor: number };
  bands?: Array<{ minEmployees: number; maxEmployees: number | null; weekly: { amountMinor: number } }>;
  multipleOfMinimumWage?: number;
  fullTimeHoursPerWeek?: number;
};

/** Annualised salary-level threshold (minor units) for a jurisdiction: the higher of federal and state, with sources. */
export function exemptThresholds(book: RuleBook, jurisdiction: string, date: string, employerSize: number) {
  const fed = book.tryResolve<ThresholdValue>('US', 'overtime.exempt_salary_threshold', date);
  const out: {
    federalAnnualMinor: number | null;
    stateAnnualMinor: number | null;
    applicableAnnualMinor: number | null;
    hceAnnualMinor: number | null;
    sources: Array<{ jurisdiction: string; url: string; title: string }>;
  } = {
    federalAnnualMinor: null,
    stateAnnualMinor: null,
    applicableAnnualMinor: null,
    hceAnnualMinor: null,
    sources: [],
  };
  if (fed?.value.standardWeekly) {
    out.federalAnnualMinor = fed.value.standardWeekly.amountMinor * 52;
    out.hceAnnualMinor = fed.value.hceAnnualTotalCompensation?.amountMinor ?? null;
    out.sources.push({ jurisdiction: 'US', ...fed.source });
  }
  const st =
    jurisdiction !== 'US'
      ? book.tryResolve<ThresholdValue>(jurisdiction, 'overtime.exempt_salary_threshold', date)
      : undefined;
  if (st && st.jurisdiction !== 'US') {
    const v = st.value;
    let annual: number | null = null;
    if (v.annual) annual = v.annual.amountMinor;
    else if (v.weekly) annual = v.weekly.amountMinor * 52;
    else if (v.bands) {
      const b = v.bands.find(
        (x) => employerSize >= x.minEmployees && (x.maxEmployees === null || employerSize <= x.maxEmployees),
      );
      annual = b ? b.weekly.amountMinor * 52 : null;
    } else if (v.multipleOfMinimumWage && v.fullTimeHoursPerWeek) {
      const mw = book.tryResolve<{ rates: Array<{ region: string; hourlyMinor: number }> }>(
        st.jurisdiction,
        'minimum_wage.rates',
        date,
      );
      const hourly = mw?.value.rates.find((r) => r.region === '*')?.hourlyMinor;
      if (hourly !== undefined)
        annual = Math.round(v.multipleOfMinimumWage * hourly * v.fullTimeHoursPerWeek * 52);
    }
    out.stateAnnualMinor = annual;
    out.sources.push({ jurisdiction: st.jurisdiction, ...st.source });
  }
  const vals = [out.federalAnnualMinor, out.stateAnnualMinor].filter((x): x is number => x !== null);
  out.applicableAnnualMinor = vals.length ? Math.max(...vals) : null;
  return out;
}

export interface DutiesRule {
  categories: Array<{
    id: string;
    salaryTest: 'standard' | 'standard_or_hourly' | 'none' | 'hce';
    duties: string[];
    hourlyAlternative?: { amountMinor: number };
  }>;
}
export type PayFrequency = 'annual' | 'monthly' | 'weekly' | 'hourly' | 'daily';
export const annualise = (amountMinor: number, frequency: PayFrequency, weeklyHours: number) =>
  frequency === 'annual'
    ? amountMinor
    : frequency === 'monthly'
      ? amountMinor * 12
      : frequency === 'weekly'
        ? amountMinor * 52
        : frequency === 'daily'
          ? amountMinor * 5 * 52
          : Math.round(amountMinor * weeklyHours * 52);

/**
 * Exempt / non-exempt check feeding overtime eligibility: an employee is overtime-eligible unless
 * classified exempt with an attested duties test that is complete and the salary test of that
 * exemption (salary basis + level, computer hourly alternative, HCE compensation) is met.
 */
export function classifyExemption(
  duties: DutiesRule,
  thresholds: { applicableAnnualMinor: number | null; hceAnnualMinor: number | null },
  i: {
    flsaStatus: 'exempt' | 'non_exempt' | null;
    pay: { amountMinor: number; frequency: PayFrequency } | null;
    weeklyHours: number;
    attestation: { exemption: string; duties: string[] } | null;
  },
) {
  if (i.flsaStatus === 'non_exempt')
    return { status: 'non_exempt' as const, overtimeEligible: true, issues: [] as string[] };
  if (i.flsaStatus === null)
    return { status: 'unclassified' as const, overtimeEligible: true, issues: ['no_classification'] };
  const issues: string[] = [];
  const cat = i.attestation ? duties.categories.find((c) => c.id === i.attestation!.exemption) : undefined;
  if (!i.attestation) issues.push('no_duties_attestation');
  else if (!cat) issues.push('unknown_exemption');
  else if (cat.duties.some((d) => !i.attestation!.duties.includes(d))) issues.push('duties_incomplete');
  const test = cat?.salaryTest ?? 'standard';
  if (test !== 'none') {
    if (!i.pay) issues.push('no_pay_record');
    else {
      const salaried =
        i.pay.frequency === 'annual' || i.pay.frequency === 'monthly' || i.pay.frequency === 'weekly';
      const annual = annualise(i.pay.amountMinor, i.pay.frequency, i.weeklyHours);
      if (test === 'standard_or_hourly' && i.pay.frequency === 'hourly') {
        if (cat?.hourlyAlternative && i.pay.amountMinor < cat.hourlyAlternative.amountMinor)
          issues.push('below_computer_hourly_rate');
      } else if (!salaried) issues.push('not_salary_basis');
      else if (thresholds.applicableAnnualMinor !== null && annual < thresholds.applicableAnnualMinor)
        issues.push('below_salary_threshold');
      if (test === 'hce' && thresholds.hceAnnualMinor !== null && annual < thresholds.hceAnnualMinor)
        issues.push('below_hce_compensation');
    }
  }
  return issues.length
    ? { status: 'exempt_at_risk' as const, overtimeEligible: true, issues }
    : { status: 'exempt' as const, overtimeEligible: false, issues };
}

// ---- EEO-1 aggregation with small-cell suppression -----------------------------------------------
export interface Eeo1Rule {
  privateEmployerMinEmployees: number;
  jobCategories: string[];
  raceEthnicityCategories: string[];
  sexCategories: string[];
  workforceSnapshot: { from: { month: number; day: number }; to: { month: number; day: number } };
}

/**
 * EEO-1 Component 1 counts by job category × race/ethnicity × sex. Without `exact`, counts below the
 * suppression threshold k are withheld (null), plus one complementary cell per job category when only
 * one cell would be withheld, so a withheld count cannot be recovered from the row total.
 */
export function eeo1Aggregate(
  rule: Eeo1Rule,
  rows: Array<{ jobCategory: string | null; raceEthnicity: string | null; sex: string | null }>,
  opts: { k: number; exact?: boolean },
) {
  const key = (j: string, r: string, s: string) => `${j}|${r}|${s}`;
  const counts = new Map<string, number>();
  let notReported = 0;
  let unmappedJobs = 0;
  for (const row of rows) {
    if (!row.jobCategory || !rule.jobCategories.includes(row.jobCategory)) {
      unmappedJobs++;
      continue;
    }
    if (
      !row.raceEthnicity ||
      !row.sex ||
      !rule.raceEthnicityCategories.includes(row.raceEthnicity) ||
      !rule.sexCategories.includes(row.sex)
    ) {
      notReported++;
      continue;
    }
    const k = key(row.jobCategory, row.raceEthnicity, row.sex);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const table = rule.jobCategories.map((j) => {
    const cells = rule.raceEthnicityCategories.flatMap((r) =>
      rule.sexCategories.map((s) => ({
        raceEthnicity: r,
        sex: s,
        count: counts.get(key(j, r, s)) ?? 0,
        suppressed: false,
      })),
    );
    const total = cells.reduce((s, c) => s + c.count, 0);
    if (!opts.exact) {
      for (const c of cells) if (c.count > 0 && c.count < opts.k) c.suppressed = true;
      if (cells.filter((c) => c.suppressed).length === 1) {
        const next = cells.filter((c) => !c.suppressed && c.count > 0).sort((a, b) => a.count - b.count)[0];
        if (next) next.suppressed = true;
      }
    }
    const rowSuppressed = !opts.exact && total > 0 && total < opts.k;
    return {
      jobCategory: j,
      total: rowSuppressed ? null : total,
      cells: cells.map((c) => ({
        raceEthnicity: c.raceEthnicity,
        sex: c.sex,
        count: c.suppressed ? null : c.count,
        suppressed: c.suppressed,
      })),
    };
  });
  const totalEmployees = rows.length;
  return {
    required: totalEmployees >= rule.privateEmployerMinEmployees,
    threshold: rule.privateEmployerMinEmployees,
    totalEmployees,
    notReported,
    unmappedJobs,
    suppressionThreshold: opts.exact ? null : opts.k,
    table,
  };
}

/** The workforce snapshot window (one pay period inside it) for a reporting year. */
export function eeo1SnapshotWindow(rule: Eeo1Rule, year: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(rule.workforceSnapshot.from.month)}-${pad(rule.workforceSnapshot.from.day)}`,
    to: `${year}-${pad(rule.workforceSnapshot.to.month)}-${pad(rule.workforceSnapshot.to.day)}`,
  };
}

// ---- compliance matrix ----------------------------------------------------------------------------
export type MatrixStatus = 'compliant' | 'expiring' | 'expired' | 'missing';
export interface RequirementScope {
  jobTitles?: string[];
  locationIds?: string[];
  entityIds?: string[];
  departmentIds?: string[];
  countries?: string[];
}

/** A requirement applies when every dimension it names matches the employee (any listed value). */
export function requirementApplies(
  scope: RequirementScope,
  e: {
    jobTitle: string | null;
    locationId: string | null;
    entityId: string | null;
    departmentId: string | null;
    country: string | null;
  },
) {
  const match = (list: string[] | undefined, v: string | null) =>
    !list?.length || (v !== null && list.includes(v));
  return (
    match(scope.jobTitles, e.jobTitle) &&
    match(scope.locationIds, e.locationId) &&
    match(scope.entityIds, e.entityId) &&
    match(scope.departmentIds, e.departmentId) &&
    match(scope.countries, e.country)
  );
}

/** Expiry is the last valid day: the recorded expiry date, or the day before issue + validity months. */
export function recordExpiry(
  req: { validityMonths: number | null },
  rec: { issuedOn: string; expiresOn: string | null },
) {
  if (rec.expiresOn) return rec.expiresOn;
  return req.validityMonths ? addDays(addMonths(rec.issuedOn, req.validityMonths), -1) : null;
}

export function matrixStatus(
  req: { validityMonths: number | null; reminderDays: number[] },
  rec: { issuedOn: string; expiresOn: string | null } | null,
  asOf: string,
): { status: MatrixStatus; expiresOn: string | null; daysLeft: number | null } {
  if (!rec) return { status: 'missing', expiresOn: null, daysLeft: null };
  const expiresOn = recordExpiry(req, rec);
  if (!expiresOn) return { status: 'compliant', expiresOn: null, daysLeft: null };
  const daysLeft = daysBetween(asOf, expiresOn);
  if (daysLeft < 0) return { status: 'expired', expiresOn, daysLeft };
  const window = req.reminderDays.length ? Math.max(...req.reminderDays) : 0;
  return { status: daysLeft <= window ? 'expiring' : 'compliant', expiresOn, daysLeft };
}

// ---- law-changes feed relevance ----------------------------------------------------------------
/** Jurisdiction codes an entry may name to be relevant to a tenant operating in `codes` (and their parents, e.g. EU). */
export function relevantJurisdictions(book: RuleBook, codes: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const c of codes) {
    if (!c) continue;
    for (const x of codeLineage(c)) out.add(x);
    for (const x of book.chain(c)) out.add(x);
  }
  return out;
}

/** Days before a due date on which a reminder fires today (for idempotent daily reminder jobs). */
export function reminderOffsetToday(dueOn: string, today: string, offsets: number[]): number | null {
  const left = daysBetween(today, dueOn);
  return offsets.includes(left) ? left : null;
}
