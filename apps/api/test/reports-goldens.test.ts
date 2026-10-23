import { describe, expect, it } from 'vitest';
import {
  computeHeadcount,
  computeHeadcountHistory,
  computeTurnover,
  monthEnds,
  RESTRICTED,
  turnoverTotal,
  type EmployeeFact,
} from '../src/modules/reports/calc/people';
import {
  computeAbsence,
  computeBradford,
  computeOvertime,
  type AbsenceFact,
  type TimesheetFact,
} from '../src/modules/reports/calc/absence';
import { computeLiability, type LiabilityInput } from '../src/modules/reports/calc/liability';
import { formatScaled, parseScaled, percent, roundDiv } from '../src/modules/reports/fixed';
import type { LeavePolicy, WorkPattern } from '../src/modules/leave/engine';

/**
 * PROGRESS 7.1 golden tests: every ready-made report calculation on a fictional dataset with explicit
 * as-of dates (never today's date). Expected values are worked out by hand in the comments.
 */

// ---- fictional company "Fictional Widgets": two entities, two departments --------------------------------
const GB = { entityId: 'ent-gb', country: 'GB' };
const US = { entityId: 'ent-us', country: 'US' };
const job = (
  validFrom: string,
  validTo: string | null,
  where: { entityId: string; country: string },
  departmentId: string,
  fte: string,
) => ({ validFrom, validTo, ...where, departmentId, locationId: `loc-${where.country.toLowerCase()}`, fte });

const PEOPLE: EmployeeFact[] = [
  // A transfers from the GB entity to the US entity on 2026-04-01
  {
    id: 'A',
    startDate: '2025-01-01',
    endDate: null,
    jobs: [
      job('2025-01-01', '2026-04-01', GB, 'dep-1', '1.0000'),
      job('2026-04-01', null, US, 'dep-2', '1.0000'),
    ],
  },
  {
    id: 'B',
    startDate: '2025-06-01',
    endDate: '2026-03-31',
    leaverType: 'voluntary',
    jobs: [job('2025-06-01', '2026-04-01', GB, 'dep-1', '0.5000')],
  },
  { id: 'C', startDate: '2026-02-01', endDate: null, jobs: [job('2026-02-01', null, GB, 'dep-2', '0.8000')] },
  { id: 'D', startDate: '2026-07-01', endDate: null, jobs: [job('2026-07-01', null, US, 'dep-2', '1.0000')] }, // future starter
  {
    id: 'E',
    startDate: '2024-01-01',
    endDate: '2026-06-30',
    leaverType: 'involuntary',
    jobs: [job('2024-01-01', '2026-07-01', US, 'dep-1', '1.0000')],
  },
  {
    id: 'F',
    startDate: '2024-03-01',
    endDate: '2026-01-15',
    leaverType: null,
    jobs: [job('2024-03-01', '2026-01-16', GB, 'dep-1', '1.0000')],
  },
  { id: 'G', startDate: '2025-01-01', endDate: null, jobs: [] }, // no job record → unassigned
];

describe('fixed-point helpers', () => {
  it('round half away from zero, once', () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(-1956n, 100n)).toBe(-20n);
    expect(formatScaled(-1956n, 4, 2)).toBe('-0.20');
    expect(formatScaled(163644n, 4, 2)).toBe('16.36');
    expect(parseScaled('0.8000', 4)).toBe(8000n);
    expect(parseScaled('37.5', 2)).toBe(3750n);
    expect(percent(2n, 3n)).toBe('66.67');
    expect(percent(1n, 0n)).toBeNull();
  });
});

describe('headcount (effective-dated)', () => {
  it('by entity on 2026-03-31: A, B (last day) and C in GB; E in US; G unassigned', () => {
    // GB FTE = 1.0 + 0.5 + 0.8 = 2.30
    expect(computeHeadcount(PEOPLE, '2026-03-31', 'entity')).toEqual([
      { key: 'ent-gb', headcount: 3, fte: '2.30' },
      { key: 'ent-us', headcount: 1, fte: '1.00' },
      { key: null, headcount: 1, fte: '0.00' },
    ]);
  });
  it('by entity on 2026-06-30: A has transferred to US; B has left; D has not started; E counts on their last day', () => {
    expect(computeHeadcount(PEOPLE, '2026-06-30', 'entity')).toEqual([
      { key: 'ent-gb', headcount: 1, fte: '0.80' },
      { key: 'ent-us', headcount: 2, fte: '2.00' },
      { key: null, headcount: 1, fte: '0.00' },
    ]);
  });
  it('by department and by country', () => {
    expect(computeHeadcount(PEOPLE, '2026-03-31', 'department')).toEqual([
      { key: 'dep-1', headcount: 3, fte: '2.50' }, // A 1.0, B 0.5, E 1.0
      { key: 'dep-2', headcount: 1, fte: '0.80' },
      { key: null, headcount: 1, fte: '0.00' },
    ]);
    expect(computeHeadcount(PEOPLE, '2026-06-30', 'country').map((r) => [r.key, r.headcount])).toEqual([
      ['GB', 1],
      ['US', 2],
      [null, 1],
    ]);
  });
  it('rows whose grouping field is hidden by field permissions are counted in a restricted group', () => {
    const hidden: EmployeeFact = {
      id: 'H',
      startDate: '2023-05-01',
      endDate: null,
      groupReadable: false,
      jobs: [job('2023-05-01', null, GB, 'dep-1', '0.6000')],
    };
    expect(computeHeadcount([...PEOPLE, hidden], '2026-03-31', 'entity')).toEqual([
      { key: RESTRICTED, headcount: 1, fte: '0.60' },
      { key: 'ent-gb', headcount: 3, fte: '2.30' },
      { key: 'ent-us', headcount: 1, fte: '1.00' },
      { key: null, headcount: 1, fte: '0.00' },
    ]);
  });
  it('history at month ends: 4, 5, 5, 4, 4, 4', () => {
    expect(monthEnds('2026-01-01', '2026-06-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    expect(monthEnds('2026-01-10', '2026-03-15')).toEqual(['2026-01-31', '2026-02-28', '2026-03-15']);
    expect(computeHeadcountHistory(PEOPLE, '2026-01-01', '2026-06-30', 'none')).toEqual([
      { date: '2026-01-31', key: 'all', headcount: 4, fte: '2.50' }, // A, B, E, G (F left 15 Jan; C starts 1 Feb)
      { date: '2026-02-28', key: 'all', headcount: 5, fte: '3.30' },
      { date: '2026-03-31', key: 'all', headcount: 5, fte: '3.30' },
      { date: '2026-04-30', key: 'all', headcount: 4, fte: '2.80' }, // B left 31 Mar
      { date: '2026-05-31', key: 'all', headcount: 4, fte: '2.80' },
      { date: '2026-06-30', key: 'all', headcount: 4, fte: '2.80' },
    ]);
  });
});

describe('turnover', () => {
  it('2026-01-01 to 2026-06-30, whole company: 3 leavers / average 4.5 = 66.67 %', () => {
    // start (1 Jan): A, B, E, F, G = 5; end (30 Jun): A, C, E, G = 4; leavers: B (vol), E (invol), F (unknown)
    const [all] = computeTurnover(PEOPLE, '2026-01-01', '2026-06-30', 'none');
    expect(all).toEqual({
      key: 'all',
      headcountStart: 5,
      headcountEnd: 4,
      averageHeadcount: '4.5',
      leavers: 3,
      voluntary: 1,
      involuntary: 1,
      otherOrUnknown: 1,
      turnoverRate: '66.67',
      voluntaryRate: '22.22',
    });
  });
  it('by entity: a leaver belongs to the entity of their job on their last day', () => {
    const rows = computeTurnover(PEOPLE, '2026-01-01', '2026-06-30', 'entity');
    expect(rows).toEqual([
      // GB: start A, B, F = 3; end C = 1; leavers B, F → 2 × 200 / 4 = 100 %
      {
        key: 'ent-gb',
        headcountStart: 3,
        headcountEnd: 1,
        averageHeadcount: '2.0',
        leavers: 2,
        voluntary: 1,
        involuntary: 0,
        otherOrUnknown: 1,
        turnoverRate: '100.00',
        voluntaryRate: '50.00',
      },
      // US: start E = 1; end A, E = 2; leaver E → 200 / 3 = 66.67 %
      {
        key: 'ent-us',
        headcountStart: 1,
        headcountEnd: 2,
        averageHeadcount: '1.5',
        leavers: 1,
        voluntary: 0,
        involuntary: 1,
        otherOrUnknown: 0,
        turnoverRate: '66.67',
        voluntaryRate: '0.00',
      },
      {
        key: null,
        headcountStart: 1,
        headcountEnd: 1,
        averageHeadcount: '1.0',
        leavers: 0,
        voluntary: 0,
        involuntary: 0,
        otherOrUnknown: 0,
        turnoverRate: '0.00',
        voluntaryRate: '0.00',
      },
    ]);
    // totals recompute the rate from the summed counts (never an average of rates)
    expect(turnoverTotal(rows)).toMatchObject({
      headcountStart: 5,
      headcountEnd: 4,
      leavers: 3,
      turnoverRate: '66.67',
    });
  });
  it('refuses an inverted period and returns null rates for an empty population', () => {
    expect(() => computeTurnover(PEOPLE, '2026-02-01', '2026-01-01', 'none')).toThrow();
    expect(computeTurnover([], '2026-01-01', '2026-06-30', 'none')).toEqual([]);
    expect(turnoverTotal([]).turnoverRate).toBeNull();
  });
});

// ---- absence --------------------------------------------------------------------------------------------
const MON_FRI: WorkPattern = { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 7.5, 6: 0, 7: 0 };
const BANK = ['2026-05-04', '2026-05-25']; // fictional calendar: two Monday holidays in May 2026
const absence = (
  employeeId: string,
  leaveType: string,
  start: string,
  end: string,
  extra: Partial<AbsenceFact> = {},
): AbsenceFact => ({
  employeeId,
  group: 'all',
  leaveType,
  start,
  end,
  pattern: MON_FRI,
  holidays: BANK,
  ...extra,
});
const ABSENCES = [
  absence('A', 'sickness', '2026-04-29', '2026-05-05'), // clipped to Fri 1 + Tue 5 (Mon 4 is a holiday) = 2 days
  absence('A', 'sickness', '2026-05-20', '2026-05-20', { startHalf: 'pm' }), // half day
  absence('B', 'unpaid', '2026-05-25', '2026-05-29'), // Tue–Fri = 4 days (Mon 25 is a holiday)
  absence('C', 'sickness', '2026-05-29', '2026-06-02', { endHalf: 'am' }), // clipped to Fri 29: 1 day, the half day is outside
  absence('C', 'family', '2026-06-01', '2026-06-05'), // outside May
];

describe('absence: days and hours lost', () => {
  it('May 2026 by type', () => {
    expect(computeAbsence(ABSENCES, '2026-05-01', '2026-05-31', true)).toEqual([
      { key: 'all', leaveType: 'sickness', spells: 3, employees: 2, daysLost: '3.50', hoursLost: '26.25' },
      { key: 'all', leaveType: 'unpaid', spells: 1, employees: 1, daysLost: '4.00', hoursLost: '30.00' },
    ]);
  });
  it('May 2026 by employee', () => {
    const byEmployee = ABSENCES.map((a) => ({ ...a, group: a.employeeId }));
    expect(computeAbsence(byEmployee, '2026-05-01', '2026-05-31', false)).toEqual([
      { key: 'A', leaveType: null, spells: 2, employees: 1, daysLost: '2.50', hoursLost: '18.75' },
      { key: 'B', leaveType: null, spells: 1, employees: 1, daysLost: '4.00', hoursLost: '30.00' },
      { key: 'C', leaveType: null, spells: 1, employees: 1, daysLost: '1.00', hoursLost: '7.50' },
    ]);
  });
  it('Bradford factor S² × D over the 52 weeks to the end of the period', () => {
    const bf = computeBradford(
      [
        // window starts 2025-06-01: the March 2025 spell is outside; 29 Apr – 5 May counts 5 working days (Bradford ignores holidays)
        {
          employeeId: 'A',
          pattern: MON_FRI,
          spells: [
            { start: '2025-03-10', end: '2025-03-11' },
            { start: '2026-04-29', end: '2026-05-05' },
            { start: '2026-05-20', end: '2026-05-20' },
          ],
        },
        { employeeId: 'C', pattern: MON_FRI, spells: [{ start: '2026-05-29', end: null }] }, // open spell runs to the as-of date
      ],
      '2026-05-31',
    );
    expect(bf.get('A')).toEqual({ spells: 2, days: '6.00', score: '24.00' });
    expect(bf.get('C')).toEqual({ spells: 1, days: '1.00', score: '1.00' });
  });
});

describe('overtime from approved timesheets', () => {
  const ts = (
    employeeId: string,
    group: string,
    weekStart: string,
    w: number,
    r: number,
    o: number,
    d: number,
    s: number,
  ): TimesheetFact => ({
    employeeId,
    group,
    weekStart,
    workedMinutes: w,
    regularMinutes: r,
    overtimeMinutes: o,
    doubleMinutes: d,
    scheduledMinutes: s,
  });
  it('1–14 June 2026 by department', () => {
    const rows = computeOvertime(
      [
        ts('A', 'dep-1', '2026-06-01', 2700, 2400, 300, 0, 2400),
        ts('A', 'dep-1', '2026-06-08', 2520, 2400, 60, 60, 2400),
        ts('B', 'dep-2', '2026-06-01', 2400, 2400, 0, 0, 2250),
        ts('B', 'dep-2', '2026-05-25', 3000, 2400, 600, 0, 2400),
      ],
      '2026-06-01',
      '2026-06-14',
    );
    expect(rows).toEqual([
      // (360 + 60) / 5220 = 8.0459… %
      {
        key: 'dep-1',
        timesheets: 2,
        employees: 1,
        workedMinutes: 5220,
        regularMinutes: 4800,
        overtimeMinutes: 360,
        doubleMinutes: 60,
        scheduledMinutes: 4800,
        overtimeShare: '8.05',
      },
      {
        key: 'dep-2',
        timesheets: 1,
        employees: 1,
        workedMinutes: 2400,
        regularMinutes: 2400,
        overtimeMinutes: 0,
        doubleMinutes: 0,
        scheduledMinutes: 2250,
        overtimeShare: '0.00',
      },
    ]);
  });
});

// ---- holiday liability ---------------------------------------------------------------------------------
const UK_LIKE: LeavePolicy = {
  accrual: { method: 'annual_upfront', days: 33 },
  unit: 'days',
  yearStart: '01-01',
  proRata: true,
  includesPublicHolidays: true,
  waitingDays: 0,
  carryOver: { maxDays: 5 },
  allowNegativeDays: 0,
  rounding: 'none',
};
const BANK_2026 = [
  '2026-01-01',
  '2026-04-03',
  '2026-04-06',
  '2026-05-04',
  '2026-05-25',
  '2026-08-31',
  '2026-12-25',
  '2026-12-28',
];
const base = (over: Partial<LiabilityInput>): LiabilityInput => ({
  policy: UK_LIKE,
  employee: { startDate: '2024-01-01', endDate: null, fte: 1 },
  asOf: '2026-06-30',
  yearStart: '2026-01-01',
  pattern: MON_FRI,
  holidays: BANK_2026,
  requests: [],
  adjustments: [],
  carriedIn: 0,
  pay: null,
  ...over,
});

describe('holiday liability (integer minor units, one rounding)', () => {
  it('salaried full-year employee: 10.3644 days × £140/day = £1,451.02', () => {
    const r = computeLiability(
      base({
        carriedIn: 3,
        adjustments: [{ days: 1, effectiveDate: '2026-03-01' }],
        requests: [
          { start: '2026-02-09', end: '2026-02-13', status: 'approved' }, // 5 days taken
          { start: '2026-07-13', end: '2026-07-17', status: 'approved' }, // booked, not yet taken
          { start: '2026-06-29', end: '2026-06-30', status: 'pending' }, // pending, not taken
        ],
        pay: { amountMinor: '3640000', currency: 'GBP', frequency: 'annual' },
      }),
    );
    // accrued 33 × 181/365 = 16.3644; + carried 3 + adjustment 1; taken 5 + 5 bank holidays to 30 Jun
    expect(r).toMatchObject({
      unit: 'days',
      accrued: '20.36',
      taken: '10.00',
      untaken: '10.36',
      untakenE4: 103644n,
      liabilityMinor: 145102n,
      currency: 'GBP',
    });
  });
  it('part-year, part-time hourly starter who has over-taken: negative liability −£18.34', () => {
    const r = computeLiability(
      base({
        employee: { startDate: '2026-03-16', endDate: null, fte: 0.6 },
        pattern: { 1: 7.5, 2: 7.5, 3: 7.5, 4: 0, 5: 0, 6: 0, 7: 0 },
        requests: [{ start: '2026-05-11', end: '2026-05-13', status: 'approved' }],
        pay: { amountMinor: '1250', currency: 'GBP', frequency: 'hourly' },
      }),
    );
    // entitlement 33 × 0.6 × 291/365 = 15.7858; accrued 15.7858 × 107/291 = 5.8044; taken 3 + 3 bank holidays (Mondays) = 6
    expect(r).toMatchObject({ untakenE4: -1956n, untaken: '-0.20', liabilityMinor: -1834n });
  });
  it('monthly accrual, April leave year, expired carry-over, monthly salary in EUR: €553.85', () => {
    const r = computeLiability(
      base({
        policy: {
          accrual: { method: 'monthly', days: 24 },
          unit: 'days',
          yearStart: '04-01',
          proRata: true,
          includesPublicHolidays: false,
          waitingDays: 0,
          carryOver: { maxDays: 5, expiresAfterMonths: 3 },
          allowNegativeDays: 0,
          rounding: 'none',
        },
        employee: { startDate: '2020-01-01', endDate: null, fte: 1 },
        asOf: '2026-08-15',
        yearStart: '2026-04-01',
        pattern: { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 0, 7: 0 },
        holidays: [],
        carriedIn: 6,
        requests: [
          { start: '2026-05-04', end: '2026-05-06', status: 'approved' },
          { start: '2026-07-20', end: '2026-07-24', status: 'approved' },
        ],
        pay: { amountMinor: '400000', currency: 'EUR', frequency: 'monthly' },
      }),
    );
    // accrued 24/12 × 4 months = 8; carried min(6, 5) − expired (5 − 3 used before 1 Jul) = 3; taken 8 → 3 days × €184.615…
    expect(r).toMatchObject({
      accrued: '11.00',
      taken: '8.00',
      untaken: '3.00',
      liabilityMinor: 55385n,
      currency: 'EUR',
    });
  });
  it('hours-based entitlement with weekly pay: 6.9863 h × £15/h = £104.79', () => {
    const r = computeLiability(
      base({
        policy: {
          accrual: { method: 'annual_upfront', days: 150 },
          unit: 'hours',
          yearStart: '01-01',
          proRata: false,
          includesPublicHolidays: false,
          waitingDays: 0,
          allowNegativeDays: 0,
          rounding: 'none',
        },
        asOf: '2026-03-31',
        pattern: { 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 0, 6: 0, 7: 0 },
        holidays: [],
        requests: [{ start: '2026-02-02', end: '2026-02-05', status: 'approved' }],
        pay: { amountMinor: '45000', currency: 'GBP', frequency: 'weekly' },
      }),
    );
    // accrued 150 × 90/365 = 36.9863 h; taken 4 × 7.5 = 30 h
    expect(r).toMatchObject({ unit: 'hours', untakenE4: 69863n, untaken: '6.99', liabilityMinor: 10479n });
  });
  it('no pay record (or pay hidden by field permissions) gives untaken days without a money value', () => {
    const r = computeLiability(base({ pay: null }));
    expect(r.liabilityMinor).toBeNull();
    expect(r.currency).toBeNull();
  });
});
