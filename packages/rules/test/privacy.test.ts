import { describe, expect, it } from 'vitest';
import { RuleBook } from '../src/engine';
import {
  addPeriod,
  breachDeadlines,
  dsrDeadline,
  periodAtLeast,
  privacyJurisdiction,
  retentionDecision,
  retentionRules,
  retainUntil,
} from '../src/privacy';

/**
 * Golden tests for the privacy deadline and retention maths. Rule VALUES are covered by
 * goldens/privacy.json; these vectors check the dates computed from them (written first, from the
 * statutory wording quoted in each pack version's notes).
 */
const book = RuleBook.fromDirectory();

describe('periods', () => {
  it('adds calendar months to the corresponding date, clamped to month end', () => {
    expect(addPeriod('2026-01-31', 'P1M')).toBe('2026-02-28');
    expect(addPeriod('2028-01-31', 'P1M')).toBe('2028-02-29');
    expect(addPeriod('2026-03-10', 'P45D')).toBe('2026-04-24');
    expect(addPeriod('2026-03-10', 'P1Y2M3D')).toBe('2027-05-13');
    expect(() => addPeriod('2026-03-10', 'PT1H')).toThrow();
  });
  it('compares periods conservatively', () => {
    expect(periodAtLeast('P2Y', 'P24M')).toBe(true);
    expect(periodAtLeast('P1Y', 'P2Y')).toBe(false);
    expect(periodAtLeast('P30D', 'P1M')).toBe(false); // 30 days is shorter than a 31-day month
  });
});

describe('privacy jurisdiction', () => {
  it('uses the US state, else the country, else the home-region regime', () => {
    expect(privacyJurisdiction('US', 'US-CA', 'US')).toBe('US-CA');
    expect(privacyJurisdiction('US', null, 'US')).toBe('US');
    expect(privacyJurisdiction('DE', 'DE-BY', 'EU')).toBe('DE');
    expect(privacyJurisdiction('GB', 'GB-SCT', 'UK')).toBe('GB');
    expect(privacyJurisdiction(null, null, 'UK')).toBe('GB');
    expect(privacyJurisdiction(null, null, 'EU')).toBe('EU');
  });
});

describe('data subject request deadlines', () => {
  it('UK before Article 12A: one month from receipt, extension by two further months', () => {
    const d = dsrDeadline(book, 'GB', 'access', { receivedOn: '2026-01-31' })!;
    expect(d.dueOn).toBe('2026-02-28');
    expect(d.extendedDueOn).toBe('2026-04-28'); // the earlier of due+2M (28 Apr) and start+3M (30 Apr)
    expect(d.extensionNoticeBy).toBe('2026-02-28');
    expect(d.rule.effectiveTo).toBe('2026-02-05');
    expect(d.rule.source.url).toMatch(/^https:\/\/www\.legislation\.gov\.uk\//);
  });
  it('UK from 5 February 2026: the clock starts when identity information arrives and stops for access clarification', () => {
    const access = dsrDeadline(book, 'GB', 'access', {
      receivedOn: '2026-03-10',
      informationReceivedOn: '2026-03-15',
      pausedDays: 5,
    })!;
    expect(access.startsOn).toBe('2026-03-15');
    expect(access.dueOn).toBe('2026-04-20');
    expect(access.extendedDueOn).toBe('2026-06-20');
    const deletion = dsrDeadline(book, 'GB', 'deletion', {
      receivedOn: '2026-03-10',
      informationReceivedOn: '2026-03-15',
      pausedDays: 5,
    })!;
    expect(deletion.dueOn).toBe('2026-04-15'); // the clock stop applies to Article 15 requests only
    // before 12A the identity date did not move the clock
    expect(
      dsrDeadline(book, 'GB', 'access', { receivedOn: '2026-01-10', informationReceivedOn: '2026-01-20' })!
        .dueOn,
    ).toBe('2026-02-10');
  });
  it('EU member states use the GDPR baseline', () => {
    const d = dsrDeadline(book, 'DE', 'correction', { receivedOn: '2026-03-10' })!;
    expect(d.rule.jurisdiction).toBe('EU');
    expect([d.dueOn, d.extendedDueOn]).toEqual(['2026-04-10', '2026-06-10']);
  });
  it('California: 45 days, extendable once by 45 days (90 in total)', () => {
    const d = dsrDeadline(book, 'US-CA', 'deletion', {
      receivedOn: '2026-03-10',
      informationReceivedOn: '2026-03-20',
    })!;
    expect(d.startsOn).toBe('2026-03-10'); // verification does not extend the CCPA clock
    expect(d.dueOn).toBe('2026-04-24');
    expect(d.extendedDueOn).toBe('2026-06-08');
  });
  it('returns no deadline where no law gives employees these rights', () => {
    expect(dsrDeadline(book, 'US-TX', 'access', { receivedOn: '2026-03-10' })).toBeUndefined();
    expect(dsrDeadline(book, 'US-CA', 'access', { receivedOn: '2022-06-01' })).toBeUndefined();
  });
});

describe('breach notification deadlines', () => {
  it('72 hours from awareness under UK GDPR and GDPR; processor without undue delay', () => {
    const d = breachDeadlines(book, '2026-10-01T09:30:00Z', { GB: 12, DE: 3 });
    const reg = d.filter((x) => x.audience === 'regulator');
    expect(reg.map((x) => [x.jurisdiction, x.dueAt, x.body])).toEqual([
      ['GB', '2026-10-04T09:30:00Z', 'Information Commission'],
      ['DE', '2026-10-04T09:30:00Z', 'competent supervisory authority'],
    ]);
    expect(d.find((x) => x.jurisdiction === 'GB' && x.audience === 'processorToController')).toMatchObject({
      dueAt: null,
      standard: expect.stringMatching(/without undue delay/),
    });
  });
  it('US state day limits and thresholds', () => {
    const d = breachDeadlines(book, '2026-10-01T00:00:00Z', { 'US-TX': 100, 'US-WA': 600, 'US-OR': 10 });
    const tx = d.filter((x) => x.jurisdiction === 'US-TX');
    expect(tx.find((x) => x.audience === 'individuals')?.dueAt).toBe('2026-11-30T00:00:00Z');
    expect(tx.find((x) => x.audience === 'regulator')).toMatchObject({ required: false, minAffected: 250 });
    expect(d.find((x) => x.jurisdiction === 'US-WA' && x.audience === 'regulator')).toMatchObject({
      required: true,
      dueAt: '2026-10-31T00:00:00Z',
    });
    expect(d.find((x) => x.jurisdiction === 'US-OR' && x.audience === 'processorToController')?.dueAt).toBe(
      '2026-10-11T00:00:00Z',
    );
    expect(breachDeadlines(book, '2026-10-01T00:00:00Z', { 'US-GA': 50 })).toEqual([]); // not modelled: flagged as a coverage to-do
  });
});

describe('retention', () => {
  it('UK working-time records: two years from the date made', () => {
    const [r] = retentionRules(book, 'GB', 'time_records', '2026-06-01');
    expect(retainUntil(r!.value, { recordDate: '2024-03-01' })).toBe('2026-03-01');
  });
  it('UK payroll records: the later of PAYE (3 years after the tax year) and NMW (6 years after the next pay period)', () => {
    const rules = retentionRules(book, 'GB', 'payroll_records', '2026-06-01');
    expect(rules.map((r) => r.key).sort()).toEqual([
      'retention.minimum_wage_records',
      'retention.payroll_records',
    ]);
    const paye = rules.find((r) => r.key === 'retention.payroll_records')!;
    expect(retainUntil(paye.value, { recordDate: '2025-05-01' })).toBe('2029-04-05');
    expect(retainUntil(paye.value, { recordDate: '2025-04-05' })).toBe('2028-04-05');
    expect(retentionDecision(rules, { recordDate: '2025-05-01' }).deletableFrom).toBe('2031-06-01');
  });
  it('immigration records: UK two years after employment ends; US I-9 later of 3 years after hire or 1 year after leaving', () => {
    const gb = retentionRules(book, 'GB', 'immigration_records', '2026-10-18');
    expect(
      retentionDecision(gb, { recordDate: '2020-01-06', employmentEnd: '2025-03-01' }).deletableFrom,
    ).toBe('2027-03-01');
    expect(retentionDecision(gb, { recordDate: '2020-01-06', employmentEnd: null }).deletableFrom).toBeNull();
    const us = retentionRules(book, 'US-CA', 'immigration_records', '2026-06-01');
    expect(
      retentionDecision(us, { recordDate: '2020-01-06', employmentEnd: '2021-03-01' }).deletableFrom,
    ).toBe('2023-01-06');
    expect(
      retentionDecision(us, { recordDate: '2020-01-06', employmentEnd: '2024-03-01' }).deletableFrom,
    ).toBe('2025-03-01');
  });
  it('a tenant period can lengthen but never shorten a statutory minimum', () => {
    const rules = retentionRules(book, 'GB', 'time_records', '2026-06-01');
    expect(
      retentionDecision(rules, { recordDate: '2024-03-01' }, { period: 'P1Y', from: 'record_date' })
        .deletableFrom,
    ).toBe('2026-03-01');
    expect(
      retentionDecision(rules, { recordDate: '2024-03-01' }, { period: 'P3Y', from: 'record_date' })
        .deletableFrom,
    ).toBe('2027-03-01');
  });
  it('a suggested default (not statutory) yields to the tenant period', () => {
    const rules = retentionRules(book, 'GB', 'personnel_records', '2026-06-01');
    expect(rules[0]!.value.statutoryMinimum).toBe(false);
    expect(
      retentionDecision(rules, { recordDate: '2019-01-01', employmentEnd: '2020-01-31' }).deletableFrom,
    ).toBe('2026-01-31');
    expect(
      retentionDecision(
        rules,
        { recordDate: '2019-01-01', employmentEnd: '2020-01-31' },
        { period: 'P2Y', from: 'employment_end' },
      ).deletableFrom,
    ).toBe('2022-01-31');
  });
  it('keeps records when no rule and no tenant policy exists', () => {
    expect(retentionDecision([], { recordDate: '2001-01-01' }).deletableFrom).toBeNull();
    expect(retentionRules(book, 'EU', 'time_records', '2026-06-01')).toEqual([]);
  });
});
