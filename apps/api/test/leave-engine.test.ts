import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek } from '@thapsus/core/time';
import { RuleBook } from '@thapsus/rules';
import {
  bradfordFactor,
  computeBalance,
  dailyHours,
  employerContinuedPay,
  entitlementForPeriods,
  entitlementForYear,
  familyLeaveInfo,
  fmlaEligibility,
  fmlaEmployerCoverage,
  fmlaLeaveYear,
  leaveYearFor,
  milesBetween,
  requestAmount,
  ukSsp,
  usSickAccrual,
  type FamilyLeaveRule,
  type FmlaRule,
  type LeavePolicy,
  type UkSspRule,
  type UsSickRule,
  type WorkPattern,
} from '../src/modules/leave/engine';

/** Real pack data: calculation goldens must hold against the values the API actually resolves. */
const book = RuleBook.fromDirectory();

const FULL_TIME: WorkPattern = { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 7.5, 6: 0, 7: 0 };
const THREE_DAY: WorkPattern = { 1: 7.5, 2: 7.5, 3: 7.5, 4: 0, 5: 0, 6: 0, 7: 0 };
const SHORT_DAYS: WorkPattern = { 1: 4.5, 2: 4.5, 3: 4.5, 4: 4.5, 5: 4.5, 6: 0, 7: 0 };
const UK_POLICY: LeavePolicy = {
  accrual: { method: 'annual_upfront', days: 28 },
  unit: 'days',
  yearStart: '01-01',
  proRata: true,
  includesPublicHolidays: true,
  waitingDays: 0,
  carryOver: { maxDays: 5, expiresAfterMonths: 3 },
  allowNegativeDays: 0,
  rounding: 'up_half_day',
};
const NO_HOLIDAYS: string[] = [];
const ENG_2027 = book.daysOff('GB', 2027, 'GB-ENG');

describe('leave years', () => {
  it.each([
    ['2027-03-31', '04-01', ['2026-04-01', '2027-04-01']],
    ['2027-04-01', '04-01', ['2027-04-01', '2028-04-01']],
    ['2028-02-29', '01-01', ['2028-01-01', '2029-01-01']],
  ])('%s with year start %s', (date, start, expected) => {
    expect(leaveYearFor(date, start)).toEqual(expected);
  });
});

describe('entitlement and pro rata', () => {
  it.each([
    // [description, policy overrides, employee, year, expected days]
    ['full year, full time', {}, { startDate: '2020-01-01', fte: 1 }, 2027, 28],
    ['part time 0.6 FTE', {}, { startDate: '2020-01-01', fte: 0.6 }, 2027, 17], // 16.8 → rounded up to half day
    ['mid-year joiner (1 July, non-leap)', {}, { startDate: '2027-07-01', fte: 1 }, 2027, 14.5], // 184/365 × 28 = 14.11 → 14.5
    ['mid-year joiner in a leap year', {}, { startDate: '2028-07-01', fte: 1 }, 2028, 14.5], // 184/366 × 28 = 14.08
    ['mid-year leaver (last day 30 June)', {}, { startDate: '2020-01-01', endDate: '2027-06-30', fte: 1 }, 2027, 14], // 181/365 × 28 = 13.88 → 14
    ['joiner (1 October) and part time 0.5 FTE', {}, { startDate: '2027-10-01', fte: 0.5 }, 2027, 4], // 92/365 × 28 × 0.5 = 3.53 → up to half day = 4
    ['no pro rata', { proRata: false }, { startDate: '2027-07-01', fte: 1 }, 2027, 28],
    ['no rounding', { rounding: 'none' }, { startDate: '2020-01-01', fte: 0.6 }, 2027, 16.8],
    ['policy valid from 1 July only', { rounding: 'none', effectiveFrom: '2027-07-01' }, { startDate: '2020-01-01', fte: 1 }, 2027, 14.1151], // 184/365 × 28
  ] as const)('%s', (_d, overrides, emp, year, expected) => {
    const p = { ...UK_POLICY, ...overrides } as LeavePolicy;
    expect(entitlementForYear(p, { ...emp } as never, year)).toBe(expected);
  });

  it('policy changes mid-year are pro-rated across the periods', () => {
    const p25: LeavePolicy = { ...UK_POLICY, accrual: { method: 'annual_upfront', days: 25 } };
    const p30: LeavePolicy = { ...UK_POLICY, accrual: { method: 'annual_upfront', days: 30 } };
    const periods = [
      { from: '2027-01-01', to: '2027-07-01', policy: p25 },
      { from: '2027-07-01', to: '2028-01-01', policy: p30 },
    ];
    // 25 × 181/365 + 30 × 184/365 = 27.5205
    expect(entitlementForPeriods(periods, { startDate: '2020-01-01', fte: 1 }, '2027-01-01', 'none')).toBe(27.5205);
    const bal = computeBalance({ policy: p30, periods, employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, asOf: '2027-08-01', pattern: FULL_TIME, holidays: NO_HOLIDAYS, requests: [], adjustments: [], carriedIn: 0 });
    expect(bal.entitlement).toBe(28); // rounded up to the half day by the policy in force on the balance date
  });

  it('a mid-year FTE change (full time → 0.5) is pro-rated per period', () => {
    const periods = [
      { from: '2027-01-01', to: '2027-07-01', policy: UK_POLICY, fte: 1 },
      { from: '2027-07-01', to: '2028-01-01', policy: UK_POLICY, fte: 0.5 },
    ];
    // 28 × 181/365 + 14 × 184/365 = 20.9425
    expect(entitlementForPeriods(periods, { startDate: '2020-01-01', fte: 0.5 }, '2027-01-01', 'none')).toBe(20.9425);
  });

  it('a mid-year joiner whose policy also changes is limited to employment in each period', () => {
    const p30: LeavePolicy = { ...UK_POLICY, accrual: { method: 'annual_upfront', days: 30 } };
    const periods = [
      { from: '2027-01-01', to: '2027-07-01', policy: UK_POLICY },
      { from: '2027-07-01', to: '2028-01-01', policy: p30 },
    ];
    // joined 1 October: only the second period counts → 30 × 92/365 = 7.5616
    expect(entitlementForPeriods(periods, { startDate: '2027-10-01', fte: 1 }, '2027-01-01', 'none')).toBe(7.5616);
  });

  it('monthly accrual accrues a twelfth per completed month', () => {
    const p: LeavePolicy = { ...UK_POLICY, accrual: { method: 'monthly', days: 24 }, rounding: 'none' };
    const bal = computeBalance({ policy: p, employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, asOf: '2027-04-15', pattern: FULL_TIME, holidays: NO_HOLIDAYS, requests: [], adjustments: [], carriedIn: 0 });
    expect(bal.accrued).toBe(6); // Jan, Feb, Mar completed
  });
});

describe('per-hour-worked accrual and hours-unit policies', () => {
  const hourly: LeavePolicy = { ...UK_POLICY, unit: 'hours', includesPublicHolidays: false, carryOver: undefined, accrual: { method: 'per_hour_worked', percent: 12.07 }, rounding: 'none' };
  const base = { employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, pattern: FULL_TIME, holidays: NO_HOLIDAYS, adjustments: [], carriedIn: 0 };

  it('accrues 12.07% of hours worked (UK irregular hours) and deducts requests in hours', () => {
    const bal = computeBalance({ ...base, policy: hourly, asOf: '2027-06-30', requests: [{ start: '2027-03-01', end: '2027-03-01', status: 'approved' }], hoursWorked: 400 });
    expect(bal).toMatchObject({ unit: 'hours', accrued: 48.28, taken: 7.5, available: 40.78 });
    expect(bal.canBook(40.78)).toBe(true);
    expect(bal.canBook(41)).toBe(false);
  });

  it('no recorded hours means nothing accrued', () => {
    expect(computeBalance({ ...base, policy: hourly, asOf: '2027-06-30', requests: [] }).accrued).toBe(0);
  });

  it('per-hour accrual on a days-unit policy converts hours earned to the employee’s days', () => {
    const bal = computeBalance({ ...base, policy: { ...hourly, unit: 'days' }, asOf: '2027-06-30', requests: [], hoursWorked: 400 });
    expect(bal.accrued).toBe(6.4373); // 48.28 h ÷ 7.5 h days
  });

  it('per-hour accrual for part of the year (policy period) only counts hours in that period', () => {
    const bal = computeBalance({ ...base, policy: hourly, asOf: '2027-12-31', requests: [], periods: [{ from: '2027-07-01', to: '2028-01-01', policy: hourly, hoursWorked: 100 }] });
    expect(bal.accrued).toBe(12.07);
  });

  it('an hours-unit annual policy converts full-time days with the full-time day length (5.6 weeks × weekly hours)', () => {
    const p: LeavePolicy = { ...UK_POLICY, unit: 'hours', rounding: 'none' };
    // 0.6 FTE either as three 7.5 h days or five 4.5 h days: 16.8 days × 7.5 h = 126 h (= 5.6 × 22.5 h)
    for (const pattern of [THREE_DAY, SHORT_DAYS]) {
      const bal = computeBalance({ ...base, policy: p, employee: { startDate: '2020-01-01', fte: 0.6 }, pattern, asOf: '2027-06-01', requests: [], holidays: ENG_2027 });
      expect(bal.entitlement).toBe(126);
    }
    // public holidays are deducted in the hours of the days they fall on
    const short = computeBalance({ ...base, policy: p, employee: { startDate: '2020-01-01', fte: 0.6 }, pattern: SHORT_DAYS, asOf: '2027-06-01', requests: [], holidays: ENG_2027 });
    expect(short.publicHolidays).toBe(36); // 8 weekday bank holidays × 4.5 h
  });
});

describe('request amounts with working patterns, holidays and DST', () => {
  it('counts working days only and skips public holidays', () => {
    // Mon 2027-12-20 → Fri 2027-12-31; 25 Dec is Sat; observed 27 + 28 Dec are holidays
    const amount = requestAmount({ start: '2027-12-20', end: '2027-12-31', pattern: FULL_TIME, holidays: ['2027-12-27', '2027-12-28'] });
    expect(amount.days).toBe(8);
    expect(amount.hours).toBe(60);
  });
  it('respects part-time patterns and half days', () => {
    expect(requestAmount({ start: '2027-03-01', end: '2027-03-07', pattern: THREE_DAY, holidays: [] }).days).toBe(3);
    expect(requestAmount({ start: '2027-03-01', end: '2027-03-01', pattern: FULL_TIME, holidays: [], startHalf: 'pm' }).days).toBe(0.5);
    expect(requestAmount({ start: '2027-03-01', end: '2027-03-02', pattern: FULL_TIME, holidays: [], startHalf: 'pm', endHalf: 'am' }).days).toBe(1);
  });
  it('a public holiday on a part-timer’s non-working day is not deducted from the request', () => {
    // Fri 26 Mar and Mon 29 Mar 2027 are bank holidays; the Mon–Wed worker loses only Monday
    expect(requestAmount({ start: '2027-03-22', end: '2027-04-02', pattern: THREE_DAY, holidays: ENG_2027 }).days).toBe(5);
  });
  it('explicit hours on a single day (hourly leave)', () => {
    expect(requestAmount({ start: '2027-03-01', end: '2027-03-01', pattern: FULL_TIME, holidays: [], hours: 3 })).toEqual({ days: 0.4, hours: 3 });
    expect(requestAmount({ start: '2027-03-06', end: '2027-03-06', pattern: FULL_TIME, holidays: [], hours: 3 })).toEqual({ days: 0, hours: 0 }); // Saturday
  });
  it('a leave week spanning the clock change is still 5 days / 37.5 hours (civil dates, not hours elapsed)', () => {
    const a = requestAmount({ start: '2027-03-22', end: '2027-03-28', pattern: FULL_TIME, holidays: [] }); // UK clocks change Sun 28 Mar 2027
    expect(a).toEqual({ days: 5, hours: 37.5 });
  });
  it('spans a leap day', () => {
    expect(requestAmount({ start: '2028-02-28', end: '2028-03-01', pattern: FULL_TIME, holidays: [] }).days).toBe(3);
  });
  it('derives a daily-hours pattern from weekly hours', () => {
    expect(dailyHours(22.5, 3)).toEqual({ 1: 7.5, 2: 7.5, 3: 7.5, 4: 0, 5: 0, 6: 0, 7: 0 });
  });
});

describe('balances', () => {
  const base = { policy: UK_POLICY, employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, pattern: FULL_TIME, adjustments: [] as Array<{ days: number; effectiveDate: string }> };

  it('public holidays are deducted from an inclusive entitlement; taken and booked are separated', () => {
    const bal = computeBalance({
      ...base,
      asOf: '2027-06-15',
      holidays: ENG_2027,
      carriedIn: 0,
      requests: [
        { start: '2027-03-01', end: '2027-03-05', status: 'approved' },
        { start: '2027-07-05', end: '2027-07-09', status: 'approved' },
        { start: '2027-09-06', end: '2027-09-06', status: 'pending' },
      ],
    });
    expect(bal).toMatchObject({ entitlement: 28, publicHolidays: 8, taken: 5, booked: 5, pending: 1, available: 9 });
  });

  it.each([
    // [description, pattern, employee, deducted bank holidays (England 2027)]
    ['full time', FULL_TIME, { startDate: '2020-01-01', fte: 1 }, 8],
    ['part time Mon–Wed: Fri 1 Jan and Fri 26 Mar fall on non-working days', THREE_DAY, { startDate: '2020-01-01', fte: 0.6 }, 6],
    ['joiner on 1 June: only holidays after the start', FULL_TIME, { startDate: '2027-06-01', fte: 1 }, 3],
    ['leaver on 30 June: no holidays after the end', FULL_TIME, { startDate: '2020-01-01', endDate: '2027-06-30', fte: 1 }, 5],
  ] as const)('public holiday deduction — %s', (_d, pattern, employee, expected) => {
    const bal = computeBalance({ ...base, employee, pattern, asOf: '2027-06-01', holidays: ENG_2027, requests: [], carriedIn: 0 });
    expect(bal.publicHolidays).toBe(expected);
    expect(ENG_2027.filter((d) => pattern[dayOfWeek(d) as 1] > 0).length).toBeGreaterThanOrEqual(expected);
  });

  it('carry-over is capped and expires after the configured months', () => {
    const before = computeBalance({ ...base, asOf: '2027-03-31', holidays: [], requests: [], carriedIn: 9 });
    expect(before.carriedOver).toBe(5);
    const after = computeBalance({ ...base, asOf: '2027-04-01', holidays: [], requests: [], carriedIn: 9 });
    expect(after.carriedOver).toBe(0);
    expect(after.carryOverExpired).toBe(5);
    // carried days used before expiry are not lost
    const used = computeBalance({ ...base, asOf: '2027-04-01', holidays: [], carriedIn: 5, requests: [{ start: '2027-02-01', end: '2027-02-03', status: 'approved' }] });
    expect(used.carryOverExpired).toBe(2);
  });

  it('caps and negative balances', () => {
    const capped = computeBalance({ ...base, policy: { ...UK_POLICY, capDays: 30 }, asOf: '2027-01-10', holidays: [], requests: [], carriedIn: 5, adjustments: [{ days: 5, effectiveDate: '2027-01-02' }] });
    expect(capped.available).toBe(30);
    const neg = computeBalance({ ...base, policy: { ...UK_POLICY, allowNegativeDays: 2 }, asOf: '2027-12-01', holidays: [], carriedIn: 0, requests: [{ start: '2027-01-04', end: '2027-02-12', status: 'approved' }] });
    expect(neg.available).toBe(-2);
    expect(neg.canBook(1)).toBe(false);
    expect(computeBalance({ ...base, policy: { ...UK_POLICY, allowNegativeDays: 3 }, asOf: '2027-12-01', holidays: [], carriedIn: 0, requests: [{ start: '2027-01-04', end: '2027-02-12', status: 'approved' }] }).canBook(1)).toBe(true);
  });

  it('waiting periods block booking until served', () => {
    const p = { ...UK_POLICY, waitingDays: 90 };
    const early = computeBalance({ ...base, policy: p, employee: { startDate: '2027-02-01', fte: 1 }, asOf: '2027-03-01', holidays: [], requests: [], carriedIn: 0 });
    expect(early.inWaitingPeriod).toBe(true);
    expect(early.canBook(1)).toBe(false);
    const later = computeBalance({ ...base, policy: p, employee: { startDate: '2027-02-01', fte: 1 }, asOf: '2027-05-02', holidays: [], requests: [], carriedIn: 0 });
    expect(later.inWaitingPeriod).toBe(false);
  });

  it('TOIL adjustments add to the balance', () => {
    const bal = computeBalance({ ...base, asOf: '2027-06-01', holidays: [], requests: [], carriedIn: 0, adjustments: [{ days: 1.5, effectiveDate: '2027-05-10' }] });
    expect(bal.adjustments).toBe(1.5);
    expect(bal.available).toBe(29.5);
  });
});

describe('UK statutory sick pay (golden vectors against the GB pack on both sides of 6 April 2026)', () => {
  const ruleOn = (d: string) => book.resolve<UkSspRule>('GB', 'sick_pay.statutory', d);
  const ssp = (nweMinor: number, spells: Array<{ start: string; end: string }>, pattern = FULL_TIME) => ukSsp({ rule: ruleOn, normalWeeklyEarningsMinor: nweMinor, spells, pattern });

  // 2025-26 (gov.uk rates and thresholds): £118.75 flat, 3 waiting days, PIW 4+ days, LEL £125. 5 QDs → £23.75/day.
  // From 6 April 2026 (SSCBA s.157 as amended): lower of £123.25 and 80% of NWE, no waiting days, PIW 1 day. 5 QDs → £24.65/day.
  it.each([
    ['2025-26: a Mon–Fri spell pays 2 days after 3 waiting days', 60000, [{ start: '2026-03-02', end: '2026-03-06' }], { payableMinor: 4750, daysPaid: 2, waitingDaysApplied: 3, weeklyRateMinor: 11875 }],
    ['2025-26: a 3-day spell is not a period of incapacity (needs 4 days)', 60000, [{ start: '2026-03-09', end: '2026-03-11' }], { payableMinor: 0, daysPaid: 0, waitingDaysApplied: 0, spellsNotPeriodsOfIncapacity: 1 }],
    ['2025-26: earnings below the £125 lower earnings limit → not eligible', 12000, [{ start: '2026-03-02', end: '2026-03-13' }], { payableMinor: 0, eligible: false, belowLowerEarningsLimitDays: 10 }],
    ['2025-26: earnings exactly at the lower earnings limit are eligible', 12500, [{ start: '2026-03-02', end: '2026-03-06' }], { payableMinor: 4750, eligible: true }],
    ['2025-26: linked PIWs serve waiting days once', 60000, [{ start: '2026-03-02', end: '2026-03-05' }, { start: '2026-03-16', end: '2026-03-19' }], { daysPaid: 5, payableMinor: 11875, waitingDaysApplied: 3 }],
    ['2026: a Mon–Fri spell pays from day 1', 60000, [{ start: '2026-04-13', end: '2026-04-17' }], { payableMinor: 12325, waitingDaysApplied: 0, weeklyRateMinor: 12325 }],
    ['2026: a one-day spell is paid', 60000, [{ start: '2026-04-13', end: '2026-04-13' }], { payableMinor: 2465, daysPaid: 1 }],
    ['2026: low earner gets 80% of NWE (£140 → £112)', 14000, [{ start: '2026-04-13', end: '2026-04-24' }], { payableMinor: 22400, weeklyRateMinor: 11200 }],
    ['spanning 6 April: 3 waiting days + 2 days at £118.75, then a week at £123.25', 60000, [{ start: '2026-03-30', end: '2026-04-10' }], { payableMinor: 4750 + 12325, daysPaid: 7, waitingDaysApplied: 3 }],
    ['spanning 6 April, NWE in the protected band (S.I. 2026/373 reg. 4): £123.25 not 80%', 14000, [{ start: '2026-03-30', end: '2026-04-10' }], { payableMinor: 4750 + 12325 }],
    ['waiting days spanning 6 April (reg. 3): post-6 April qualifying days are payable', 60000, [{ start: '2026-04-02', end: '2026-04-08' }], { waitingDaysApplied: 2, daysPaid: 3, payableMinor: 3 * 2465 }],
    ['below the old LEL, spell continuing past 6 April (reg. 5): paid from 6 April', 12000, [{ start: '2026-03-30', end: '2026-04-10' }], { daysPaid: 5, payableMinor: 9600, belowLowerEarningsLimitDays: 5 }],
  ] as const)('%s', (_d, nwe, spells, expected) => {
    const r = ssp(nwe, [...spells]);
    expect(r).toMatchObject(expected);
    expect(Number.isFinite(r.payableMinor)).toBe(true);
  });

  it('periods separated by not more than 8 weeks link (s.152(3)); 8 weeks + 1 day do not', () => {
    // PIW Mon 2 – Thu 5 June 2025: 3 waiting days, Thursday paid
    const first = { start: '2025-06-02', end: '2025-06-05' };
    const linked = ssp(60000, [first, { start: addDays(first.end, 57), end: addDays(first.end, 60) }]); // gap of exactly 56 days
    expect(linked).toMatchObject({ waitingDaysApplied: 3, daysPaid: 3, payableMinor: 3 * 2375 });
    const separate = ssp(60000, [first, { start: addDays(first.end, 58), end: addDays(first.end, 61) }]); // gap of 57 days
    expect(separate).toMatchObject({ waitingDaysApplied: 5, daysPaid: 1, payableMinor: 2375 });
  });

  it('stops after 28 weeks across linked spells (gap ≤ 8 weeks)', () => {
    const r = ssp(60000, [{ start: '2027-01-04', end: '2027-06-27' }, { start: '2027-07-12', end: '2027-08-29' }]);
    expect(r.weeksPaid).toBe(28);
    expect(r.exhaustedOn).not.toBeNull();
  });

  it('part-time (3 qualifying days): a full week of sickness pays one weekly rate', () => {
    expect(ssp(60000, [{ start: '2027-03-01', end: '2027-03-07' }], THREE_DAY).payableMinor).toBe(12325);
  });

  it('a single fixed rule object still works (daily rate rounded up to the penny)', () => {
    const rule = book.resolve<UkSspRule>('GB', 'sick_pay.statutory', '2027-03-01').value;
    expect(ukSsp({ rule, normalWeeklyEarningsMinor: 15406, pattern: FULL_TIME, spells: [{ start: '2027-03-01', end: '2027-03-05' }] }).payableMinor).toBe(12325); // £154.06 × 80% = £123.25 crossover
  });
});

describe('EU employer sick pay (golden vectors per held member state, pack rules)', () => {
  const rule = (j: string) => book.resolve<Record<string, unknown>>(j, 'sick_pay.statutory', '2026-06-01').value;
  const base = { weeklyPayMinor: 100_000, pattern: FULL_TIME };

  it('DE: 100% for the first 6 weeks of incapacity once 4 weeks of employment are served', () => {
    const r = employerContinuedPay(rule('DE'), { ...base, startDate: '2026-01-05', sickStart: '2026-03-02', sickEnd: '2026-05-29' });
    expect(r).toMatchObject({ scheme: 'continued_pay', eligible: true, percent: 100, paidCalendarDays: 42, paidDays: 30, dailyAmountMinor: 20_000, totalMinor: 600_000 });
    expect(employerContinuedPay(rule('DE'), { ...base, startDate: '2026-03-01', sickStart: '2026-03-10', sickEnd: '2026-03-20' })).toMatchObject({ eligible: false, paidDays: 0 });
  });

  it('NL: 70% for up to 104 weeks (minimum-wage floor and wage cap flagged, not applied)', () => {
    const r = employerContinuedPay(rule('NL'), { ...base, startDate: '2020-01-06', sickStart: '2026-01-05', sickEnd: '2026-01-30' });
    expect(r).toMatchObject({ scheme: 'continued_pay', percent: 70, paidCalendarDays: 26, paidDays: 20, dailyAmountMinor: 14_000, totalMinor: 280_000 });
    expect(r.notes).toEqual(expect.arrayContaining(['minimumWageFloorNotApplied', 'wageCapNotApplied']));
    expect(employerContinuedPay(rule('NL'), { ...base, startDate: '2020-01-06', sickStart: '2024-01-01', sickEnd: '2026-12-31' }).paidCalendarDays).toBe(104 * 7);
  });

  it('IE: 5 days a year at 70% capped at €110 a day, after 13 weeks of service; earlier days this year count', () => {
    const r = employerContinuedPay(rule('IE'), { ...base, startDate: '2025-06-02', sickStart: '2026-03-02', sickEnd: '2026-03-13', priorSpells: [{ start: '2026-02-02', end: '2026-02-03' }] });
    expect(r).toMatchObject({ scheme: 'paid_days_per_year', eligible: true, paidDays: 3, dailyAmountMinor: 11_000, totalMinor: 33_000 });
    expect(employerContinuedPay(rule('IE'), { ...base, weeklyPayMinor: 50_000, startDate: '2025-06-02', sickStart: '2026-03-02', sickEnd: '2026-03-04' })).toMatchObject({ paidDays: 3, dailyAmountMinor: 7_000, totalMinor: 21_000 });
    expect(employerContinuedPay(rule('IE'), { ...base, startDate: '2026-01-05', sickStart: '2026-03-02', sickEnd: '2026-03-13' })).toMatchObject({ eligible: false, paidDays: 0 });
  });

  it('ES: the employer pays days 4–15 of the incapacity; social security from day 16 (benefit % not modelled)', () => {
    const long = employerContinuedPay(rule('ES'), { ...base, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-31' });
    expect(long).toMatchObject({ scheme: 'employer_days_window', paidCalendarDays: 12, percent: null, totalMinor: null });
    expect(long.notes).toEqual(expect.arrayContaining(['benefitPercentNotModelled', 'socialSecurityFromDay:16']));
    expect(employerContinuedPay(rule('ES'), { ...base, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-04' }).paidCalendarDays).toBe(0); // 3 waiting days
    expect(employerContinuedPay(rule('ES'), { ...base, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-09' }).paidCalendarDays).toBe(5);
  });

  it('FR: employer complement after 1 year of service — 7 waiting days, then 30 days at 90% and 30 at 66.66% less the IJSS', () => {
    const fr = rule('FR');
    // €700/week → €100/calendar day; IJSS 50% from day 4. Band 1: 30 × (90 − 50) = €1,200; band 2: 30 × 66.66 − 30 × 50 = €499.80
    const r = employerContinuedPay(fr, { ...base, weeklyPayMinor: 70_000, startDate: '2023-01-02', sickStart: '2026-03-02', sickEnd: '2026-05-31' });
    expect(r.bands).toEqual([
      { percent: 90, from: '2026-03-09', to: '2026-04-07', days: 30, dailyAmountMinor: 9_000, totalMinor: 120_000 },
      { percent: 66.66, from: '2026-04-08', to: '2026-05-07', days: 30, dailyAmountMinor: 6_666, totalMinor: 49_980 },
    ]);
    expect(r.totalMinor).toBe(169_980);
    // 6 years of service → 40 + 40 days
    expect(employerContinuedPay(fr, { ...base, weeklyPayMinor: 70_000, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-06-30' }).bands.map((b) => b.days)).toEqual([40, 40]);
    // under a year of service → nothing
    expect(employerContinuedPay(fr, { ...base, startDate: '2025-06-02', sickStart: '2026-03-02', sickEnd: '2026-03-31' })).toMatchObject({ eligible: false, totalMinor: 0 });
    // days already paid in the previous 12 months are deducted (20-day stoppage: 13 days after its 7 waiting days)
    expect(employerContinuedPay(fr, { ...base, startDate: '2023-01-02', sickStart: '2026-03-02', sickEnd: '2026-05-31', priorSpells: [{ start: '2026-01-05', end: '2026-01-24' }] }).bands.map((b) => b.days)).toEqual([17, 30]);
    // no waiting days for a work accident
    expect(employerContinuedPay(fr, { ...base, startDate: '2023-01-02', sickStart: '2026-03-02', sickEnd: '2026-03-31', cause: 'work_accident' }).bands[0]!.from).toBe('2026-03-02');
  });

  it('PL: 80% for up to 33 calendar days a year (14 from age 50; 100% in listed cases)', () => {
    const pl = rule('PL');
    const prior = [{ start: '2026-01-12', end: '2026-01-16' }];
    const r = employerContinuedPay(pl, { ...base, weeklyPayMinor: 70_000, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-31', priorSpells: prior });
    expect(r).toMatchObject({ scheme: 'paid_days_per_year', dayBasis: 'calendar', paidDays: 28, percent: 80, dailyAmountMinor: 8_000, totalMinor: 224_000 });
    expect(r.notes).toContain('assumedUnder50');
    expect(employerContinuedPay(pl, { ...base, weeklyPayMinor: 70_000, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-31', priorSpells: prior, age50Plus: true }).paidDays).toBe(9);
    expect(employerContinuedPay(pl, { ...base, weeklyPayMinor: 70_000, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-05', cause: 'illness_during_pregnancy' })).toMatchObject({ percent: 100, totalMinor: 40_000 });
  });

  it('member states without a held sick-pay shape are reported as not modelled', () => {
    expect(employerContinuedPay({ payer: 'social_security' }, { ...base, startDate: '2020-01-06', sickStart: '2026-03-02', sickEnd: '2026-03-31' }).scheme).toBe('not_modelled');
  });
});

describe('US state paid sick leave (golden calculations per state pack)', () => {
  const rule = (j: string) => book.resolve<UsSickRule>(j, 'sick_pay.paid_sick_leave_accrual', '2026-06-01').value;
  const start = '2026-01-05';

  it.each([
    // [state, input, expected] — rates and caps from the state labour departments (pack sources)
    ['US-CA', { hoursWorked: 300, hoursPerDay: 8 }, { accruedHours: 10, capHours: 80, useCapHours: 40 }], // 1 h per 30 h
    ['US-CA', { hoursWorked: 3000, hoursPerDay: 8 }, { accruedHours: 80, capHours: 80 }], // cap: greater of 80 h / 10 days
    ['US-CA', { hoursWorked: 3000, hoursPerDay: 10 }, { accruedHours: 100, capHours: 100, useCapHours: 50 }], // 10-hour days
    ['US-CO', { hoursWorked: 2000 }, { earnedHours: 66, accruedHours: 48, capHours: 48 }], // up to 48 h a year
    ['US-IL', { hoursWorked: 1000 }, { accruedHours: 25 }], // 1 h per 40 h
    ['US-IL', { hoursWorked: 2080 }, { earnedHours: 52, accruedHours: 40, capHours: 40 }], // 40 h per 12 months
    ['US-MA', { hoursWorked: 1500, employerSize: 11 }, { accruedHours: 40, paid: true }], // 40 h a year
    ['US-MA', { hoursWorked: 1500, employerSize: 10 }, { accruedHours: 40, paid: false }], // under 11 employees: may be unpaid
    ['US-NY', { hoursWorked: 3000, employerSize: 150 }, { accruedHours: 56, paid: true }],
    ['US-NY', { hoursWorked: 3000, employerSize: 20 }, { accruedHours: 40, paid: true }],
    ['US-NY', { hoursWorked: 3000, employerSize: 3, employerNetIncomeMinor: 50_000_000 }, { accruedHours: 40, paid: false }],
    ['US-OR', { hoursWorked: 2000, stateEmployees: 10 }, { accruedHours: 40, paid: true }],
    ['US-OR', { hoursWorked: 2000, stateEmployees: 9 }, { accruedHours: 40, paid: false }],
    ['US-WA', { hoursWorked: 2080 }, { accruedHours: 52, capHours: null }], // 1 h per 40 h, no annual accrual cap
  ] as const)('%s %o', (state, input, expected) => {
    expect(usSickAccrual(rule(state), { ...input })).toMatchObject({ required: true, ...expected });
  });

  it.each([
    // Date use may begin (start 5 Jan 2026)
    ['US-CA', '2026-04-05'], // "satisfy a 90-day employment period before taking any sick leave"
    ['US-IL', '2026-04-05'], // "after 90 days"
    ['US-MA', '2026-04-05'],
    ['US-WA', '2026-04-05'], // "90 calendar days after your first day of work"
    ['US-OR', '2026-04-05'], // "until their 91st calendar day of employment"
    ['US-CO', start], // usable as accrued
  ] as const)('%s: usable from %s', (state, usableFrom) => {
    const r = usSickAccrual(rule(state), { hoursWorked: 600, startDate: start, asOf: '2026-04-04', employerSize: 50, stateEmployees: 50 });
    expect(r.usableFrom).toBe(usableFrom);
    expect(r.canUse).toBe(usableFrom === start);
  });

  it('California: under 30 days worked in the state within a year → not eligible', () => {
    expect(usSickAccrual(rule('US-CA'), { hoursWorked: 300, daysWorkedInStateWithinYear: 29 })).toMatchObject({ eligible: false, accruedHours: 0 });
    expect(usSickAccrual(rule('US-CA'), { hoursWorked: 300, daysWorkedInStateWithinYear: 30 })).toMatchObject({ eligible: true, accruedHours: 10 });
  });

  it('locality-dependent conditions are reported, not guessed, when no locality is known', () => {
    expect(usSickAccrual(rule('US-OR'), { hoursWorked: 100, stateEmployees: 7 }).notEvaluated).toContain('paidIfEmployeesAtLeastWithPortlandLocation');
    expect(usSickAccrual(rule('US-NY'), { hoursWorked: 100 }).notEvaluated).toContain('tiers');
  });

  it.each(['US-TX', 'US-FL', 'US-GA', 'US'])('%s: no statewide requirement', (j) => {
    expect(usSickAccrual(rule(j), { hoursWorked: 2000 })).toMatchObject({ required: false, accruedHours: 0 });
  });
});

describe('absence analytics', () => {
  it('Bradford factor S² × D over the rolling window', () => {
    const spells = [
      { start: '2027-01-04', end: '2027-01-04' },
      { start: '2027-03-01', end: '2027-03-03' },
      { start: '2027-06-07', end: '2027-06-07' },
      { start: '2025-06-01', end: '2025-06-10' }, // outside 52 weeks
    ];
    expect(bradfordFactor(spells, '2027-10-01', FULL_TIME)).toEqual({ spells: 3, days: 5, score: 45 });
  });
  it('honours a shorter trigger window', () => {
    const spells = [
      { start: '2027-09-06', end: '2027-09-06' },
      { start: '2027-09-20', end: '2027-09-21' },
      { start: '2027-06-07', end: '2027-06-07' }, // outside 30 days
    ];
    expect(bradfordFactor(spells, '2027-10-01', FULL_TIME, 30)).toEqual({ spells: 2, days: 3, score: 12 });
  });
});

describe('US FMLA (golden values from the US pack)', () => {
  const rule = book.resolve<FmlaRule>('US', 'family_leave.fmla', '2026-06-01').value;

  it.each([
    ['eligible', { serviceMonths: 13, hoursPrior12Months: 1300, employeesWithinRadius: 60, employerCovered: true }, true, []],
    ['too little service', { serviceMonths: 11, hoursPrior12Months: 1300, employeesWithinRadius: 60, employerCovered: true }, false, ['service']],
    ['too few hours', { serviceMonths: 24, hoursPrior12Months: 1249, employeesWithinRadius: 60, employerCovered: true }, false, ['hours']],
    ['exactly 1,250 hours', { serviceMonths: 24, hoursPrior12Months: 1250, employeesWithinRadius: 60, employerCovered: true }, true, []],
    ['small worksite', { serviceMonths: 24, hoursPrior12Months: 2000, employeesWithinRadius: 49, employerCovered: true }, false, ['worksite']],
    ['employer not covered', { serviceMonths: 24, hoursPrior12Months: 2000, employeesWithinRadius: 40, employerCovered: false }, false, ['employer', 'worksite']],
  ] as const)('eligibility: %s', (_d, input, eligible, reasons) => {
    const r = fmlaEligibility(rule, input);
    expect(r.eligible).toBe(eligible);
    expect(r.failed.sort()).toEqual([...reasons].sort());
  });

  it('employer coverage: 50+ employees in 20+ workweeks of the current or preceding calendar year', () => {
    const weeks = (year: number, n: number, big: number) => Array.from({ length: n }, (_, k) => ({ weekStart: addDays(`${year}-01-05`, k * 7), employees: k < big ? 60 : 40 }));
    expect(fmlaEmployerCoverage(rule, { asOf: '2027-03-01', weeklyHeadcounts: weeks(2026, 52, 20) })).toMatchObject({ covered: true, qualifyingWeeksPrecedingYear: 20 });
    expect(fmlaEmployerCoverage(rule, { asOf: '2027-03-01', weeklyHeadcounts: weeks(2026, 52, 19) })).toMatchObject({ covered: false, qualifyingWeeksPrecedingYear: 19 });
    expect(fmlaEmployerCoverage(rule, { asOf: '2027-12-31', weeklyHeadcounts: weeks(2027, 52, 20) })).toMatchObject({ covered: true, qualifyingWeeksCurrentYear: 20 });
    // weeks from two years ago do not count
    expect(fmlaEmployerCoverage(rule, { asOf: '2028-03-01', weeklyHeadcounts: weeks(2026, 52, 52) }).covered).toBe(false);
    // public agencies are covered regardless of size (pack)
    expect(fmlaEmployerCoverage(rule, { asOf: '2027-03-01', weeklyHeadcounts: [], publicAgency: true })).toMatchObject({ covered: true, basis: 'public_agency' });
  });

  it.each([
    // [method, asOf, usage, expected window] — DOL Fact Sheet #28H
    ['calendar_year', '2027-05-10', [], ['2027-01-01', '2028-01-01']],
    ['fixed_12_month_period', '2027-05-10', [], ['2026-10-01', '2027-10-01']], // fiscal year from 1 October
    ['forward_from_first_leave_date', '2027-05-10', ['2026-11-06'], ['2026-11-06', '2027-11-06']], // "begins November 6th and ends November 5th"
    ['rolling_backward_from_leave_date', '2027-11-01', ['2027-01-04'], ['2026-11-02', '2027-11-02']], // "prior November 2 through November 1"
  ] as const)('leave year: %s', (method, asOf, usage, expected) => {
    expect(fmlaLeaveYear({ method, asOf, usageDates: [...usage], fixedYearStart: '10-01', allowedMethods: rule.leaveYearMethods })).toEqual(expected);
  });

  it('every leave-year method in the pack is implemented', () => {
    for (const method of rule.leaveYearMethods!) expect(() => fmlaLeaveYear({ method, asOf: '2027-05-10', usageDates: [], allowedMethods: rule.leaveYearMethods })).not.toThrow();
    expect(() => fmlaLeaveYear({ method: 'rolling_backward', asOf: '2027-05-10', usageDates: [], allowedMethods: rule.leaveYearMethods })).toThrow();
  });

  it('forward-measured periods restart with the first leave after the previous period ends', () => {
    const usage = ['2026-11-06', '2028-01-10'];
    expect(fmlaLeaveYear({ method: 'forward_from_first_leave_date', asOf: '2027-12-01', usageDates: usage })).toEqual(['2027-12-01', '2028-12-01']);
    expect(fmlaLeaveYear({ method: 'forward_from_first_leave_date', asOf: '2028-02-01', usageDates: usage })).toEqual(['2028-01-10', '2029-01-10']);
  });

  it('military caregiver leave uses a single 12-month period from its first day', () => {
    expect(fmlaLeaveYear({ method: 'calendar_year', asOf: '2027-06-01', usageDates: ['2027-03-15'], reason: 'military_caregiver', militaryCaregiverPeriod: rule.militaryCaregiverPeriod })).toEqual(['2027-03-15', '2028-03-15']);
  });

  it('great-circle miles for the 75-mile worksite radius', () => {
    expect(milesBetween({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(69.09, 2); // 2πR/360, R = 3,958.8 mi
    expect(milesBetween({ lat: 37.33, lng: -121.89 }, { lat: 37.33, lng: -121.89 })).toBe(0);
    const a = { lat: 37.33, lng: -121.89 };
    const b = { lat: 38.4, lng: -122.5 };
    expect(milesBetween(a, b)).toBeCloseTo(milesBetween(b, a), 10);
    expect(milesBetween({ lat: 0, lng: 0 }, { lat: 1.08, lng: 0 })).toBeLessThan(rule.eligibility.radiusMiles!);
    expect(milesBetween({ lat: 0, lng: 0 }, { lat: 1.09, lng: 0 })).toBeGreaterThan(rule.eligibility.radiusMiles!);
  });
});

describe('statutory family leave (GB pack)', () => {
  const at = (key: string, d: string) => book.resolve<FamilyLeaveRule>('GB', key, d).value;
  it('maternity: 52 weeks of leave from day one; pay for 39 weeks needs 26 weeks of service', () => {
    expect(familyLeaveInfo(at('family_leave.maternity', '2026-10-18'), { startDate: '2026-09-07', asOf: '2026-10-18' })).toMatchObject({ leaveWeeks: 52, meetsLeaveService: true, payWeeks: 39, payServiceWeeksRequired: 26, meetsPayService: false, flatWeeklyRate: { amountMinor: 19432, currency: 'GBP' } });
  });
  it('paternity: day-one leave from 6 April 2026; 26 weeks of service before', () => {
    expect(familyLeaveInfo(at('family_leave.paternity', '2026-10-18'), { startDate: '2026-09-07', asOf: '2026-10-18' })).toMatchObject({ leaveWeeks: 2, leaveServiceWeeksRequired: 0, meetsLeaveService: true });
    expect(familyLeaveInfo(at('family_leave.paternity', '2026-03-01'), { startDate: '2025-12-01', asOf: '2026-03-01' })).toMatchObject({ leaveWeeks: 2, leaveServiceWeeksRequired: 26, meetsLeaveService: false });
  });
});
