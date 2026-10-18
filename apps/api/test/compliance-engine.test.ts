import { describe, expect, it } from 'vitest';
import { rules } from '@thapsus/rules';
import {
  classifyExemption,
  eeo1Aggregate,
  eeo1SnapshotWindow,
  exemptThresholds,
  genderPayGap,
  gpgDates,
  gpgHourlyRate,
  i9Deadlines,
  i9RetainUntil,
  i9Reverification,
  irregularHoursAccrual,
  irregularHoursPolicyCheck,
  matrixStatus,
  payTransparency,
  quartileBands,
  quartileSizes,
  RATE_SCALE,
  relevantJurisdictions,
  reminderOffsetToday,
  requirementApplies,
  rtwFollowUp,
  rtwRetainUntil,
  unfairDismissalQualifyingDate,
  type DutiesRule,
  type Eeo1Rule,
  type GpgEmployee,
  type GpgRule,
  type I9CompletionRule,
  type IrregularHoursRule,
  type PayTransparencyRule,
  type RtwDocumentRules,
} from '../src/modules/compliance/engine';

/**
 * Golden tests for the compliance calculators. Rule values come from the packs (resolved on explicit
 * dates); expected results are taken from official worked examples where they exist (each case cites
 * its source), otherwise derived from the statute and marked as such. Fictional data only.
 */
const book = rules();
const AS_OF = '2026-10-18';
const rtwRule = book.resolve<RtwDocumentRules>('GB', 'right_to_work.document_rules', AS_OF).value;
const rtwRetention = book.resolve<{ retainAfterEmploymentEnds: string }>('GB', 'right_to_work.retention', AS_OF).value;
const i9Completion = book.resolve<I9CompletionRule>('US', 'i9.completion_deadlines', AS_OF).value;
const i9RetentionRule = book.resolve<Parameters<typeof i9RetainUntil>[0]>('US', 'i9.retention', AS_OF).value;
const i9Reverif = book.resolve<{ suggestedAdvanceNoticeDays: number }>('US', 'i9.reverification', AS_OF).value;
const gpgRule = book.resolve<GpgRule & Parameters<typeof gpgDates>[0]>('GB', 'reporting.gender_pay_gap', '2027-04-05').value;
const ihRule = book.resolve<IrregularHoursRule>('GB', 'leave.irregular_hours_accrual', AS_OF).value;
const MON_TO_FRI = [1, 2, 3, 4, 5];

describe('UK right to work (Employer\'s guide, 1 October 2026)', () => {
  it('List A gives a continuous excuse with no follow-up', () => {
    expect(rtwFollowUp(rtwRule, { listType: 'list_a', checkedOn: '2026-10-01' })).toEqual({ excuse: 'continuous', excuseEndsOn: null, followUpDueOn: null });
    expect(rtwFollowUp(rtwRule, { listType: 'online_unlimited', checkedOn: '2026-10-01' }).followUpDueOn).toBeNull();
  });
  it('List B Group 1 / time-limited online check: follow-up on or before the date permission ends', () => {
    expect(rtwFollowUp(rtwRule, { listType: 'list_b_group_1', checkedOn: '2026-10-01', permissionExpiresOn: '2028-03-31' })).toEqual({ excuse: 'time_limited', excuseEndsOn: '2028-03-31', followUpDueOn: '2028-03-31' });
    expect(rtwFollowUp(rtwRule, { listType: 'online_time_limited', checkedOn: '2026-10-01', permissionExpiresOn: '2027-01-15' }).followUpDueOn).toBe('2027-01-15');
    expect(() => rtwFollowUp(rtwRule, { listType: 'list_b_group_1', checkedOn: '2026-10-01' })).toThrow(/permissionExpiresOn/);
  });
  it('List B Group 2: excuse for six months from the PVN date, follow-up before it expires', () => {
    // guide p. 35: "6 months from the date specified in the PVN"; p. 36: follow-up "before the six-month statutory excuse expires"
    expect(rtwFollowUp(rtwRule, { listType: 'list_b_group_2', checkedOn: '2026-10-05', pvnDate: '2026-10-02' })).toEqual({ excuse: 'time_limited', excuseEndsOn: '2027-04-02', followUpDueOn: '2027-04-01' });
    expect(rtwFollowUp(rtwRule, { listType: 'list_b_group_2', checkedOn: '2026-08-31', pvnDate: '2026-08-31' }).excuseEndsOn).toBe('2027-02-28'); // month-end clamps
  });
  it('records are kept during employment and for two years after it ends (GOV.UK)', () => {
    expect(rtwRetainUntil(rtwRetention, null)).toBeNull();
    expect(rtwRetainUntil(rtwRetention, '2026-11-30')).toBe('2028-11-30');
  });
  it('the document catalogue in the pack covers every list type with a follow-up rule', () => {
    for (const l of rtwRule.listTypes) expect(l in rtwRule.followUp).toBe(true);
    expect(rtwRule.documentCatalogue!.list_b_group_2).toContain('positive_verification_notice_from_ecs');
  });
});

describe('US Form I-9 (USCIS M-274)', () => {
  it('Section 2 within three business days: employment begins Monday → Thursday (M-274 4.0 example)', () => {
    expect(i9Deadlines(i9Completion, { firstDay: '2026-10-19', businessWeekdays: MON_TO_FRI })).toEqual({ section1DueOn: '2026-10-19', section2DueOn: '2026-10-22' });
  });
  it('a Thursday start skips the weekend; closed days are not business days (derived)', () => {
    expect(i9Deadlines(i9Completion, { firstDay: '2026-10-22', businessWeekdays: MON_TO_FRI }).section2DueOn).toBe('2026-10-27');
    expect(i9Deadlines(i9Completion, { firstDay: '2026-11-23', businessWeekdays: MON_TO_FRI, closedDates: ['2026-11-26'] }).section2DueOn).toBe('2026-11-27');
  });
  it('hired for less than three business days: Section 2 by the first day of employment', () => {
    expect(i9Deadlines(i9Completion, { firstDay: '2026-10-19', lastDay: '2026-10-20', businessWeekdays: MON_TO_FRI }).section2DueOn).toBe('2026-10-19');
    expect(i9Deadlines(i9Completion, { firstDay: '2026-10-19', lastDay: '2026-10-21', businessWeekdays: MON_TO_FRI }).section2DueOn).toBe('2026-10-22');
  });
  it('retention: the later of three years after hire or one year after employment ends', () => {
    // USCIS Form I-9 executive summary (13 Sep 2017): completed 1 Jan 2000, last termination 1 Jan 2004 → retain until 1 Jan 2005
    expect(i9RetainUntil(i9RetentionRule, { hireDate: '2000-01-01', terminationDate: '2004-01-01' }).retainUntil).toBe('2005-01-01');
    // derived (M-274 10.0): worked less than two years → three years after the first day of employment
    expect(i9RetainUntil(i9RetentionRule, { hireDate: '2025-03-03', terminationDate: '2026-01-09' }).retainUntil).toBe('2028-03-03');
    expect(i9RetainUntil(i9RetentionRule, { hireDate: '2025-03-03', terminationDate: null })).toEqual({ retainUntil: null, atLeastUntil: '2028-03-03' });
  });
  it('reverification is due when employment authorization expires, with the pack\'s advance notice', () => {
    expect(i9Reverification(i9Reverif, '2027-06-30')).toEqual({ dueOn: '2027-06-30', remindFrom: '2027-04-01' });
    expect(i9Reverification(i9Reverif, null)).toEqual({ dueOn: null, remindFrom: null });
  });
});

describe('UK unfair dismissal qualifying period (ERA 1996 s.108 as amended by ERA 2025 s.25 from 1 January 2027)', () => {
  it('two years until 31 December 2026, measured to the effective date of termination', () => {
    const r = unfairDismissalQualifyingDate(book, 'GB-ENG', '2024-01-15');
    expect(r).toMatchObject({ date: '2026-01-14', qualifyingPeriod: 'P2Y' });
  });
  it('an employee short of two years on 31 December 2026 but with six months qualifies on 1 January 2027 (S.I. 2026/559 reg. 4)', () => {
    expect(unfairDismissalQualifyingDate(book, 'GB', '2025-06-01')).toMatchObject({ date: '2027-01-01', qualifyingPeriod: 'P6M' });
    expect(unfairDismissalQualifyingDate(book, 'GB-SCT', '2025-01-02')).toMatchObject({ date: '2027-01-01', qualifyingPeriod: 'P6M' });
  });
  it('six months from 1 January 2027', () => {
    expect(unfairDismissalQualifyingDate(book, 'GB-WLS', '2026-09-01')).toMatchObject({ date: '2027-02-28', qualifyingPeriod: 'P6M' });
    expect(unfairDismissalQualifyingDate(book, 'GB', '2027-03-15')).toMatchObject({ date: '2027-09-14' });
  });
  it('Northern Ireland keeps one year (ERO 1996 art. 140) and no rule means no alert', () => {
    expect(unfairDismissalQualifyingDate(book, 'GB-NIR', '2026-03-01')).toMatchObject({ date: '2027-02-28', qualifyingPeriod: 'P1Y', jurisdiction: 'GB-NIR' });
    expect(unfairDismissalQualifyingDate(book, 'DE', '2026-03-01')).toBeNull();
  });
});

describe('UK irregular-hours and part-year accrual (WTR reg. 15B)', () => {
  it('12.07% of hours worked, rounded per reg. 15B(5): 68 hours → 8.2076 → 8 hours (GOV.UK worked example)', () => {
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 68 * 60 })).toEqual({ exactHours: 8.2076, accruedHours: 8 });
  });
  it('a fraction of 30 minutes or more counts as one hour (derived from reg. 15B(5))', () => {
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 100 * 60 }).accruedHours).toBe(12); // 12.07 h = 12 h 4.2 min
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 120 * 60 }).accruedHours).toBe(14); // 14.484 h = 14 h 29.04 min
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 125 * 60 }).accruedHours).toBe(15); // 15.0875 h
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 37 * 60 }).accruedHours).toBe(4); // 4.4659 h = 4 h 27.95 min
    expect(irregularHoursAccrual(ihRule, { minutesWorked: 4 * 60 + 9 }).accruedHours).toBe(1); // 30.05 min
  });
  it('flags leave policies that do not accrue per hour worked at the statutory percentage', () => {
    expect(irregularHoursPolicyCheck(ihRule, { accrual: { method: 'per_hour_worked', percent: 12.07 } }).ok).toBe(true);
    expect(irregularHoursPolicyCheck(ihRule, { accrual: { method: 'per_hour_worked', percent: 10 } }).issue).toBe('below_statutory_percent');
    expect(irregularHoursPolicyCheck(ihRule, { accrual: { method: 'annual_upfront', days: 28 } }).issue).toBe('not_accrued_per_hour_worked');
    expect(irregularHoursPolicyCheck(ihRule, null).issue).toBe('no_policy');
  });
});

/** Fictional employees: `count` people of one sex at an hourly rate given in pence. */
const people = (count: number, sex: 'male' | 'female', pence: number, extra: Partial<GpgEmployee> = {}): GpgEmployee[] => Array.from({ length: count }, () => ({ sex, fullPay: true, hourlyRate: pence * RATE_SCALE, bonus12MonthsMinor: 0, ...extra }));

describe('UK gender pay gap (S.I. 2017/172; GOV.UK "Making your calculations", Acme Ltd examples)', () => {
  it('snapshot date and deadline per sector from the pack', () => {
    expect(gpgDates(gpgRule, 2027, 'privateAndVoluntary')).toEqual({ snapshotDate: '2027-04-05', deadline: '2028-04-04' });
    expect(gpgDates(gpgRule, 2027, 'publicAuthority')).toEqual({ snapshotDate: '2027-03-31', deadline: '2028-03-30' });
  });
  it('hourly rate (reg. 6): monthly pay × 7 / 30.44 ÷ weekly hours (derived)', () => {
    // £2,000 a month, 37.5 hours a week → £2,000 × 7 / 30.44 / 37.5 = £12.2645... an hour
    expect(gpgHourlyRate(gpgRule, { ordinaryPayMinor: 200_000, period: 'monthly', weeklyHours: 37.5 })).toBe(1_226_456);
    expect(gpgHourlyRate(gpgRule, { ordinaryPayMinor: 50_000, bonusInPeriodMinor: 5_000, period: 'weekly', weeklyHours: 40 })).toBe(1_375_000);
  });
  it('mean hourly pay gap 13.59% (1,345 men, total £23,550; 3,100 women, total £46,900)', () => {
    const data = [...people(1250, 'male', 1751), ...people(95, 'male', 1750), ...people(2800, 'female', 1513), ...people(300, 'female', 1512)];
    const r = genderPayGap(gpgRule, data);
    expect(r.meanHourlyPayGap!.toFixed(2)).toBe('13.59');
    expect(r.rounded.meanHourlyPayGap).toBe(13.6);
  });
  it('median hourly pay gap 6.67% (middle man £15; middle women £13 and £15 → £14)', () => {
    const data = [...people(672, 'male', 1000), ...people(1, 'male', 1500), ...people(672, 'male', 2000), ...people(1549, 'female', 1000), ...people(1, 'female', 1300), ...people(1, 'female', 1500), ...people(1549, 'female', 2000)];
    expect(genderPayGap(gpgRule, data).medianHourlyPayGap!.toFixed(2)).toBe('6.67');
  });
  it('bonus figures: 94.5% of men and 64.0% of women paid a bonus; mean bonus gap 9.7%; median bonus gap 3.3%', () => {
    const bonus = (n: number, sex: 'male' | 'female', b: number) => people(n, sex, 1500, { bonus12MonthsMinor: b });
    const proportions = genderPayGap(gpgRule, [...bonus(1300, 'male', 100), ...bonus(75, 'male', 0), ...bonus(2000, 'female', 100), ...bonus(1125, 'female', 0)]);
    expect(proportions.rounded.bonusProportions).toEqual({ male: 94.5, female: 64 });
    const meanGap = genderPayGap(gpgRule, [...bonus(10, 'male', 165_000), ...bonus(10, 'female', 149_000)]);
    expect(meanGap.rounded.meanBonusGap).toBe(9.7);
    const medianGap = genderPayGap(gpgRule, [...bonus(2, 'male', 100_000), ...bonus(1, 'male', 230_000), ...bonus(2, 'male', 400_000), ...bonus(1, 'female', 100_000), ...bonus(1, 'female', 222_500), ...bonus(1, 'female', 400_000)]);
    expect(medianGap.rounded.medianBonusGap).toBe(3.3);
  });
  it('quartile pay bands: 4,445 employees → 1,112 / 1,111 / 1,111 / 1,111 with 16.8/9.9/26.8/67.5% men', () => {
    const data = [...people(187, 'male', 1000), ...people(925, 'female', 1000), ...people(110, 'male', 2000), ...people(1001, 'female', 2000), ...people(298, 'male', 3000), ...people(813, 'female', 3000), ...people(750, 'male', 4000), ...people(361, 'female', 4000)];
    const r = genderPayGap(gpgRule, data);
    expect(r.quartiles.map((q) => q.total)).toEqual([1112, 1111, 1111, 1111]);
    expect(r.rounded.quartiles).toEqual([
      { band: 'lower', malePercent: 16.8, femalePercent: 83.2 },
      { band: 'lower_middle', malePercent: 9.9, femalePercent: 90.1 },
      { band: 'upper_middle', malePercent: 26.8, femalePercent: 73.2 },
      { band: 'upper', malePercent: 67.5, femalePercent: 32.5 },
    ]);
  });
  it('people on the same rate spanning bands are split in the same male/female proportion (40 people: 36 women, 4 men; 10 in the lower band, 30 in the lower middle)', () => {
    const rows = [...Array.from({ length: 30 }, () => ({ sex: 'female' as const, rate: 900 })), ...Array.from({ length: 36 }, () => ({ sex: 'female' as const, rate: 1000 })), ...Array.from({ length: 4 }, () => ({ sex: 'male' as const, rate: 1000 })), ...Array.from({ length: 90 }, (_, i) => ({ sex: i % 2 ? ('male' as const) : ('female' as const), rate: 2000 + i }))];
    const q = quartileBands(rows, gpgRule.quartiles.remainderAllocation);
    expect(q[0]).toMatchObject({ total: 40, male: 1, female: 39 }); // 30 below the tie + 9 women and 1 man from it
    expect(q[1]!.male - rows.slice(70, 80).filter((r) => r.sex === 'male').length).toBe(3); // 27 women and 3 men from the tie
  });
  it('remainder employees are allocated as the guidance says (1 → lower; 2 → lower, upper middle; 3 → lower, lower middle, upper middle)', () => {
    expect(quartileSizes(5, gpgRule.quartiles.remainderAllocation)).toEqual([2, 1, 1, 1]);
    expect(quartileSizes(6, gpgRule.quartiles.remainderAllocation)).toEqual([2, 1, 2, 1]);
    expect(quartileSizes(7, gpgRule.quartiles.remainderAllocation)).toEqual([2, 2, 2, 1]);
    expect(quartileSizes(8, gpgRule.quartiles.remainderAllocation)).toEqual([2, 2, 2, 2]);
  });
  it('employees without a recorded sex are excluded and counted; leave on reduced pay excludes from hourly figures only', () => {
    const r = genderPayGap(gpgRule, [...people(2, 'male', 2000), ...people(1, 'female', 1000), { sex: null, fullPay: true, hourlyRate: 5, bonus12MonthsMinor: 0 }, ...people(1, 'female', 1, { fullPay: false, bonus12MonthsMinor: 100 })]);
    expect(r.population).toMatchObject({ relevantEmployees: 4, fullPayRelevantEmployees: 3, excludedNoSexRecorded: 1, female: 2 });
    expect(r.meanHourlyPayGap).toBe(50);
    expect(r.bonusProportions.female).toBe(50);
  });
});

describe('EU Pay Transparency Directive (EU) 2023/970 art. 9 indicators (fictional dataset, derived)', () => {
  const ptRule = book.resolve<PayTransparencyRule>('EU', 'reporting.pay_transparency', '2027-06-07').value;
  const w = (sex: 'male' | 'female', basic: number, variable: number, category: string) => ({ sex, annualBasicMinor: basic, annualVariableMinor: variable, annualHours: 1000, category });
  const workers = [w('male', 5_000_000, 500_000, 'engineering'), w('male', 4_000_000, 0, 'engineering'), w('female', 4_500_000, 300_000, 'engineering'), w('female', 3_000_000, 0, 'support'), w('male', 3_000_000, 0, 'support'), w('female', 2_000_000, 100_000, 'support')];
  it('gaps as a percentage of the male figure, quartiles, proportions and the joint pay assessment trigger (≥ 5% in a category)', () => {
    const r = payTransparency(ptRule, workers, 2027);
    // mean total pay: men (5.5m + 4m + 3m)/3 = 4.1667m; women (4.8m + 3m + 2.1m)/3 = 3.3m → 20.8%
    expect(r.genderPayGap!.toFixed(1)).toBe('20.8');
    expect(r.medianGenderPayGap!.toFixed(1)).toBe('25.0'); // medians 4.0m vs 3.0m
    expect(r.genderPayGapVariable!.toFixed(1)).toBe('60.0'); // recipients: men 500k; women (300k + 100k)/2 = 200k
    expect(r.proportionReceivingVariable.male!.toFixed(1)).toBe('33.3');
    expect(r.proportionReceivingVariable.female!.toFixed(1)).toBe('66.7');
    expect(r.population.payLevelBasis).toBe('hourly');
    expect(r.quartiles.map((q) => q.total)).toEqual([2, 2, 1, 1]);
    expect(r.byCategory.find((c) => c.category === 'engineering')!.totalPayGap!.toFixed(1)).toBe('-1.1'); // men 4.75m vs women 4.8m
    expect(r.byCategory.find((c) => c.category === 'support')!.totalPayGap!.toFixed(1)).toBe('15.0'); // men 3.0m vs women 2.55m
    expect(r.jointPayAssessment.categoriesIndicated).toEqual(['support']);
  });
  it('reporting obligation by workforce size from the EU pack (250+ annual, 150-249 and 100-149 every three years)', () => {
    expect(payTransparency(ptRule, Array.from({ length: 260 }, (_, i) => w(i % 2 ? 'male' : 'female', 3_000_000, 0, 'all')), 2027).obligation).toMatchObject({ reportingRequired: true, firstReportBy: '2027-06-07', frequencyYears: 1 });
    expect(payTransparency(ptRule, Array.from({ length: 120 }, (_, i) => w(i % 2 ? 'male' : 'female', 3_000_000, 0, 'all')), 2027).obligation).toMatchObject({ reportingRequired: true, firstReportBy: '2031-06-07', frequencyYears: 3 });
    expect(payTransparency(ptRule, workers, 2027).obligation.reportingRequired).toBe(false);
  });
});

describe('US exempt / non-exempt classification (FLSA and state thresholds from the packs)', () => {
  const duties = book.resolve<DutiesRule>('US', 'overtime.exempt_duties_tests', AS_OF).value;
  const admin = duties.categories.find((c) => c.id === 'administrative')!;
  it('federal salary level $684 a week; California two times the state minimum wage; Colorado annual; Washington by employer size', () => {
    expect(exemptThresholds(book, 'US-TX', '2026-06-01', 10)).toMatchObject({ federalAnnualMinor: 3_556_800, stateAnnualMinor: null, applicableAnnualMinor: 3_556_800, hceAnnualMinor: 10_743_200 });
    expect(exemptThresholds(book, 'US-CA', '2026-06-01', 10)).toMatchObject({ stateAnnualMinor: 7_030_400, applicableAnnualMinor: 7_030_400 }); // 2 × $16.90 × 40 × 52 = $70,304
    expect(exemptThresholds(book, 'US-CO', '2026-06-01', 10).applicableAnnualMinor).toBe(5_778_400);
    expect(exemptThresholds(book, 'US-WA', '2027-06-01', 10).stateAnnualMinor).toBe(159_570 * 52);
    expect(exemptThresholds(book, 'US-WA', '2027-06-01', 500).stateAnnualMinor).toBe(177_300 * 52);
  });
  it('exempt only with a complete duties attestation and the salary test met; otherwise overtime-eligible', () => {
    const ca = exemptThresholds(book, 'US-CA', '2026-06-01', 10);
    const ok = { exemption: 'administrative', duties: admin.duties };
    expect(classifyExemption(duties, ca, { flsaStatus: 'exempt', pay: { amountMinor: 8_000_000, frequency: 'annual' }, weeklyHours: 40, attestation: ok })).toEqual({ status: 'exempt', overtimeEligible: false, issues: [] });
    expect(classifyExemption(duties, ca, { flsaStatus: 'exempt', pay: { amountMinor: 6_000_000, frequency: 'annual' }, weeklyHours: 40, attestation: ok }).issues).toEqual(['below_salary_threshold']);
    expect(classifyExemption(duties, ca, { flsaStatus: 'exempt', pay: { amountMinor: 8_000_000, frequency: 'annual' }, weeklyHours: 40, attestation: { exemption: 'administrative', duties: admin.duties.slice(0, 1) } }).issues).toEqual(['duties_incomplete']);
    expect(classifyExemption(duties, ca, { flsaStatus: 'exempt', pay: { amountMinor: 4000, frequency: 'hourly' }, weeklyHours: 40, attestation: ok }).issues).toEqual(['not_salary_basis']);
    expect(classifyExemption(duties, ca, { flsaStatus: 'exempt', pay: null, weeklyHours: 40, attestation: null }).issues).toEqual(['no_duties_attestation', 'no_pay_record']);
    expect(classifyExemption(duties, ca, { flsaStatus: 'non_exempt', pay: null, weeklyHours: 40, attestation: null })).toMatchObject({ status: 'non_exempt', overtimeEligible: true });
    expect(classifyExemption(duties, ca, { flsaStatus: null, pay: null, weeklyHours: 40, attestation: null }).issues).toEqual(['no_classification']);
  });
  it('computer employees may be paid hourly at the pack rate ($27.63); outside sales has no salary test', () => {
    const fed = exemptThresholds(book, 'US-TX', '2026-06-01', 10);
    const computer = duties.categories.find((c) => c.id === 'computer')!;
    expect(classifyExemption(duties, fed, { flsaStatus: 'exempt', pay: { amountMinor: 2763, frequency: 'hourly' }, weeklyHours: 40, attestation: { exemption: 'computer', duties: computer.duties } }).status).toBe('exempt');
    expect(classifyExemption(duties, fed, { flsaStatus: 'exempt', pay: { amountMinor: 2762, frequency: 'hourly' }, weeklyHours: 40, attestation: { exemption: 'computer', duties: computer.duties } }).issues).toEqual(['below_computer_hourly_rate']);
    const sales = duties.categories.find((c) => c.id === 'outside_sales')!;
    expect(classifyExemption(duties, fed, { flsaStatus: 'exempt', pay: { amountMinor: 100, frequency: 'hourly' }, weeklyHours: 40, attestation: { exemption: 'outside_sales', duties: sales.duties } }).status).toBe('exempt');
  });
});

describe('EEO-1 Component 1 aggregation', () => {
  const eeo = book.resolve<Eeo1Rule>('US', 'reporting.eeo1', AS_OF).value;
  const rows = [
    ...Array.from({ length: 6 }, () => ({ jobCategory: 'professionals', raceEthnicity: 'asian', sex: 'female' })),
    ...Array.from({ length: 7 }, () => ({ jobCategory: 'professionals', raceEthnicity: 'white', sex: 'male' })),
    ...Array.from({ length: 2 }, () => ({ jobCategory: 'professionals', raceEthnicity: 'hispanic_or_latino', sex: 'male' })),
    { jobCategory: 'professionals', raceEthnicity: 'declined', sex: 'female' },
    { jobCategory: null, raceEthnicity: 'white', sex: 'male' },
  ];
  it('workforce snapshot window is one pay period in October–December of the reporting year', () => {
    expect(eeo1SnapshotWindow(eeo, 2026)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });
  it('withholds small cells and one complementary cell per job category; exact mode shows true counts', () => {
    const r = eeo1Aggregate(eeo, rows, { k: 5 });
    const prof = r.table.find((t) => t.jobCategory === 'professionals')!;
    const cell = (race: string, sex: string) => prof.cells.find((c) => c.raceEthnicity === race && c.sex === sex)!;
    expect(cell('hispanic_or_latino', 'male')).toMatchObject({ count: null, suppressed: true });
    expect(cell('asian', 'female')).toMatchObject({ count: null, suppressed: true }); // complementary: smallest remaining cell
    expect(cell('white', 'male')).toMatchObject({ count: 7, suppressed: false });
    expect(prof.total).toBe(15);
    expect(r).toMatchObject({ notReported: 1, unmappedJobs: 1, totalEmployees: 17, required: false, threshold: 100 });
    const exact = eeo1Aggregate(eeo, rows, { k: 5, exact: true });
    expect(exact.table.find((t) => t.jobCategory === 'professionals')!.cells.find((c) => c.raceEthnicity === 'hispanic_or_latino' && c.sex === 'male')!.count).toBe(2);
  });
});

describe('compliance matrix', () => {
  const req = { validityMonths: 12, reminderDays: [60, 30, 7] };
  it('missing / expired / expiring / compliant on an explicit date', () => {
    expect(matrixStatus(req, null, AS_OF).status).toBe('missing');
    expect(matrixStatus(req, { issuedOn: '2025-10-17', expiresOn: null }, AS_OF)).toMatchObject({ status: 'expired', expiresOn: '2026-10-16' });
    expect(matrixStatus(req, { issuedOn: '2025-11-01', expiresOn: null }, AS_OF)).toMatchObject({ status: 'expiring', expiresOn: '2026-10-31', daysLeft: 13 });
    expect(matrixStatus(req, { issuedOn: '2026-10-01', expiresOn: null }, AS_OF).status).toBe('compliant');
    expect(matrixStatus({ validityMonths: null, reminderDays: [] }, { issuedOn: '2020-01-01', expiresOn: null }, AS_OF).status).toBe('compliant');
    expect(matrixStatus(req, { issuedOn: '2026-01-01', expiresOn: '2026-10-18' }, AS_OF)).toMatchObject({ status: 'expiring', daysLeft: 0 });
  });
  it('applies by job title, location, entity, department and country (all named dimensions must match)', () => {
    const e = { jobTitle: 'Forklift Operator', locationId: 'loc-1', entityId: 'ent-1', departmentId: null, country: 'GB' };
    expect(requirementApplies({}, e)).toBe(true);
    expect(requirementApplies({ jobTitles: ['Forklift Operator'], countries: ['GB', 'IE'] }, e)).toBe(true);
    expect(requirementApplies({ jobTitles: ['Forklift Operator'], locationIds: ['loc-2'] }, e)).toBe(false);
    expect(requirementApplies({ departmentIds: ['d'] }, e)).toBe(false);
  });
  it('reminders fire only on the configured offsets (idempotent per offset)', () => {
    expect(reminderOffsetToday('2026-11-17', AS_OF, [60, 30, 7])).toBe(30);
    expect(reminderOffsetToday('2026-11-18', AS_OF, [60, 30, 7])).toBeNull();
  });
});

describe('law-changes feed relevance', () => {
  it('a tenant in England, New York City and Germany sees GB, GB-ENG, US, US-NY, US-NY-NYC, DE and EU entries only', () => {
    const set = relevantJurisdictions(book, ['GB-ENG', 'US-NY-NYC', 'DE', null]);
    for (const c of ['GB', 'GB-ENG', 'US', 'US-NY', 'US-NY-NYC', 'DE', 'EU']) expect(set.has(c), c).toBe(true);
    for (const c of ['GB-NIR', 'GB-SCT', 'US-CA', 'FR']) expect(set.has(c), c).toBe(false);
  });
});
