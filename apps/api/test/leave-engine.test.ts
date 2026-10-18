import { describe, expect, it } from 'vitest';
import {
  bradfordFactor,
  computeBalance,
  dailyHours,
  entitlementForYear,
  fmlaEligibility,
  leaveYearFor,
  requestAmount,
  ukSsp,
  usSickAccrual,
  employerContinuedPay,
  type LeavePolicy,
  type WorkPattern,
} from '../src/modules/leave/engine';

const FULL_TIME: WorkPattern = { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 7.5, 6: 0, 7: 0 };
const THREE_DAY: WorkPattern = { 1: 7.5, 2: 7.5, 3: 7.5, 4: 0, 5: 0, 6: 0, 7: 0 };
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
    ['joiner and part time', {}, { startDate: '2027-10-01', fte: 0.5 }, 2027, 3.5], // 92/365 × 14 = 3.53 → 4? → up_half_day = 4
    ['no pro rata', { proRata: false }, { startDate: '2027-07-01', fte: 1 }, 2027, 28],
    ['no rounding', { rounding: 'none' }, { startDate: '2020-01-01', fte: 0.6 }, 2027, 16.8],
  ] as const)('%s', (_d, overrides, emp, year, expected) => {
    const p = { ...UK_POLICY, ...overrides } as LeavePolicy;
    const got = entitlementForYear(p, { ...emp } as never, year);
    if (_d === 'joiner and part time') expect(got).toBe(4);
    else expect(got).toBe(expected);
  });

  it('policy changes mid-year are pro-rated across the periods', () => {
    const p1 = { ...UK_POLICY, accrual: { method: 'annual_upfront' as const, days: 25 }, effectiveTo: '2027-07-01' };
    const p2 = { ...UK_POLICY, accrual: { method: 'annual_upfront' as const, days: 30 }, effectiveFrom: '2027-07-01' };
    const a = entitlementForYear({ ...p1, rounding: 'none' }, { startDate: '2020-01-01', fte: 1 }, 2027);
    const b = entitlementForYear({ ...p2, rounding: 'none' }, { startDate: '2020-01-01', fte: 1 }, 2027);
    expect(Math.round((a + b) * 100) / 100).toBe(Math.round(((25 * 181) / 365 + (30 * 184) / 365) * 100) / 100);
  });

  it('monthly accrual accrues a twelfth per completed month', () => {
    const p: LeavePolicy = { ...UK_POLICY, accrual: { method: 'monthly', days: 24 }, rounding: 'none' };
    const bal = computeBalance({ policy: p, employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, asOf: '2027-04-15', pattern: FULL_TIME, holidays: NO_HOLIDAYS, requests: [], adjustments: [], carriedIn: 0 });
    expect(bal.accrued).toBe(6); // Jan, Feb, Mar completed
  });

  it('per-hour-worked accrual (UK irregular hours 12.07%)', () => {
    const p: LeavePolicy = { ...UK_POLICY, unit: 'hours', accrual: { method: 'per_hour_worked', percent: 12.07 }, rounding: 'none' };
    const bal = computeBalance({ policy: p, employee: { startDate: '2020-01-01', fte: 1 }, year: 2027, asOf: '2027-06-30', pattern: FULL_TIME, holidays: NO_HOLIDAYS, requests: [], adjustments: [], carriedIn: 0, hoursWorked: 400 });
    expect(bal.accrued).toBe(48.28);
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
      holidays: ['2027-01-01', '2027-04-02', '2027-04-05', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28'],
      carriedIn: 0,
      requests: [
        { start: '2027-03-01', end: '2027-03-05', status: 'approved' },
        { start: '2027-07-05', end: '2027-07-09', status: 'approved' },
        { start: '2027-09-06', end: '2027-09-06', status: 'pending' },
      ],
    });
    expect(bal).toMatchObject({ entitlement: 28, publicHolidays: 8, taken: 5, booked: 5, pending: 1, available: 9 });
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

describe('statutory sick pay (golden values from the GB pack: £123.25 or 80% of NWE, from day 1, max 28 weeks)', () => {
  const rule = { weeklyRate: { amountMinor: 12325, currency: 'GBP' }, percentOfNormalWeeklyEarnings: 80, waitingDays: 0, maxWeeks: 28, linkingPeriodWeeks: 8 };
  it.each([
    ['high earner, 5 qualifying days', 60000, 5, FULL_TIME, 12325],
    ['low earner, 80% of NWE', 10000, 5, FULL_TIME, 8000],
    ['exactly at the crossover (£154.06 × 80% = £123.25)', 15406, 5, FULL_TIME, 12325],
    ['part-time (3 qualifying days), full week of sickness', 60000, 7, THREE_DAY, 12325],
  ])('%s', (_d, nweMinor, days, pattern, expectedMinor) => {
    const start = '2027-03-01';
    const end = days === 7 ? '2027-03-07' : '2027-03-05';
    const r = ukSsp({ rule, normalWeeklyEarningsMinor: nweMinor, spells: [{ start, end }], pattern });
    expect(r.payableMinor).toBe(expectedMinor);
    expect(r.waitingDaysApplied).toBe(0);
  });
  it('stops after 28 weeks across linked spells (gap ≤ 8 weeks)', () => {
    const r = ukSsp({ rule, normalWeeklyEarningsMinor: 60000, pattern: FULL_TIME, spells: [{ start: '2027-01-04', end: '2027-06-27' }, { start: '2027-07-12', end: '2027-08-29' }] });
    expect(r.weeksPaid).toBe(28);
    expect(r.exhaustedOn).not.toBeNull();
  });
  it('uses daily rate = weekly rate / qualifying days per week (rounded up to the penny per day)', () => {
    const r = ukSsp({ rule, normalWeeklyEarningsMinor: 60000, pattern: FULL_TIME, spells: [{ start: '2027-03-01', end: '2027-03-01' }] });
    expect(r.payableMinor).toBe(2465);
  });
});

describe('employer continued pay (EU packs)', () => {
  it('Germany: 100% for 6 weeks after 4 weeks of service', () => {
    const de = { continuedPayPercent: 100, maxWeeksPerIncapacity: 6, qualifyingServiceWeeks: 4 };
    expect(employerContinuedPay(de, { startDate: '2027-01-01', sickStart: '2027-01-20', sickEnd: '2027-01-25' }).paidDays).toBe(0);
    expect(employerContinuedPay(de, { startDate: '2026-01-01', sickStart: '2027-01-04', sickEnd: '2027-03-31' })).toMatchObject({ percent: 100, paidCalendarDays: 42 });
  });
  it('Ireland: 5 days per year at 70% with a €110 daily cap after 13 weeks', () => {
    const ie = { daysPerYear: 5, ratePercent: 70, dailyCap: { amountMinor: 11000, currency: 'EUR' }, qualifyingServiceWeeks: 13 };
    const r = employerContinuedPay(ie, { startDate: '2026-01-01', sickStart: '2027-02-01', sickEnd: '2027-02-12', dailyPayMinor: 20000, workingDays: 10, usedThisYear: 2 });
    expect(r).toMatchObject({ paidDays: 3, dailyAmountMinor: 11000, totalMinor: 33000 });
  });
});

describe('US paid sick leave accrual (state packs)', () => {
  const ca = { accrual: { hoursEarned: 1, perHoursWorked: 30 }, accrualCap: { hours: 80, days: 10, rule: 'greater_of' }, annualUseCap: { hours: 40, days: 5, rule: 'greater_of' } };
  it.each([
    [300, 8, 10],
    [3000, 8, 80],
    [3000, 10, 100], // 10-hour days: 10 days = 100h cap (greater of)
  ])('California: %i hours worked, %i-hour days → %i hours', (worked, dayLen, expected) => {
    expect(usSickAccrual(ca, { hoursWorked: worked, hoursPerDay: dayLen }).accruedHours).toBe(expected);
  });
  it('New York tiers by employer size', () => {
    const ny = { accrual: { hoursEarned: 1, perHoursWorked: 30 }, tiers: [{ minEmployees: 0, maxEmployees: 4, netIncomeMaxMinor: 100000000, hours: 40, paid: false }, { minEmployees: 0, maxEmployees: 4, netIncomeAboveMinor: 100000000, hours: 40, paid: true }, { minEmployees: 5, maxEmployees: 99, hours: 40, paid: true }, { minEmployees: 100, maxEmployees: null, hours: 56, paid: true }] };
    expect(usSickAccrual(ny, { hoursWorked: 3000, employerSize: 150 })).toMatchObject({ accruedHours: 56, paid: true });
    expect(usSickAccrual(ny, { hoursWorked: 3000, employerSize: 20 })).toMatchObject({ accruedHours: 40, paid: true });
    expect(usSickAccrual(ny, { hoursWorked: 3000, employerSize: 3, employerNetIncomeMinor: 50_000_000 })).toMatchObject({ accruedHours: 40, paid: false });
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
});

describe('FMLA eligibility (golden values from the US pack)', () => {
  const rule = { coveredEmployer: { privateSectorMinEmployees: 50 }, eligibility: { minMonthsOfService: 12, minHoursInPrior12Months: 1250, minEmployeesWithinRadius: 50, radiusMiles: 75 }, entitlementWorkweeks: 12 };
  it.each([
    ['eligible', { serviceMonths: 13, hoursPrior12Months: 1300, employeesWithin75Miles: 60, employerEmployees: 200 }, true, []],
    ['too little service', { serviceMonths: 11, hoursPrior12Months: 1300, employeesWithin75Miles: 60, employerEmployees: 200 }, false, ['service']],
    ['too few hours', { serviceMonths: 24, hoursPrior12Months: 1249, employeesWithin75Miles: 60, employerEmployees: 200 }, false, ['hours']],
    ['small worksite', { serviceMonths: 24, hoursPrior12Months: 2000, employeesWithin75Miles: 49, employerEmployees: 200 }, false, ['worksite']],
    ['employer not covered', { serviceMonths: 24, hoursPrior12Months: 2000, employeesWithin75Miles: 60, employerEmployees: 40 }, false, ['employer', 'worksite']],
  ])('%s', (_d, input, eligible, reasons) => {
    const r = fmlaEligibility(rule, input as never);
    expect(r.eligible).toBe(eligible);
    expect(r.failed.sort()).toEqual([...reasons].sort());
  });
});
