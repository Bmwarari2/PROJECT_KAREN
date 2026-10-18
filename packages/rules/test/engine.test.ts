import { describe, expect, it } from 'vitest';
import { codeLineage, RuleBook, RuleNotFoundError, type RuleOverride } from '../src/engine';
import type { JurisdictionPack, RuleVersion } from '../src/schema';

/** Engine semantics on fictional packs (ADR-0021 locality layering, ADR-0022 subdivision extent). */
const src = { url: 'https://www.example.gov/fictional', title: 'Fictional source' };
const version = (value: unknown, extra: Partial<RuleVersion> = {}): RuleVersion => ({ effectiveFrom: '2020-01-01', effectiveTo: null, value, source: src, verifiedOn: '2026-10-18', reviewer: 'test', ...extra });
const pack = (jurisdiction: string, parent: string | null, rules: JurisdictionPack['rules'], extra: Partial<JurisdictionPack> = {}): JurisdictionPack => ({ jurisdiction, parent, name: jurisdiction, version: 1, updatedOn: '2026-10-18', rules, holidays: [], ...extra });

const book = new RuleBook([
  pack('ZC', null, [
    { key: 'minimum_wage.rates', description: '', versions: [version('federal')] },
    { key: 'overtime.weekly', description: '', versions: [version('federal-ot')] },
  ]),
  pack('ZC-ST', 'ZC', [{ key: 'minimum_wage.rates', description: '', versions: [version('state')] }]),
  pack('ZC-ST-CTY', 'ZC-ST', [{ key: 'sick_pay.paid_sick_leave_accrual', description: '', versions: [version('city-sick')] }]),
  pack(
    'ZK',
    null,
    [
      { key: 'leave.statutory_annual_minimum', description: '', versions: [version('north-and-south', { regions: ['ZK-NTH', 'ZK-STH'] })] },
      { key: 'minimum_wage.rates', description: '', versions: [version('kingdom-wide', { regions: ['ZK-NTH', 'ZK-STH', 'ZK-ISL'] })] },
      { key: 'reporting.gender_pay_gap', description: '', versions: [version('north-only', { regions: ['ZK-NTH'] })] },
    ],
    { subdivisions: ['ZK-NTH', 'ZK-STH', 'ZK-ISL'] },
  ),
  pack('ZK-ISL', 'ZK', [{ key: 'leave.statutory_annual_minimum', description: '', versions: [version('island-law')] }]),
]);

describe('codeLineage', () => {
  it('lists a code and its hyphen ancestors, most specific first', () => {
    expect(codeLineage('US-NY-NYC')).toEqual(['US-NY-NYC', 'US-NY', 'US']);
    expect(codeLineage('GB-NIR')).toEqual(['GB-NIR', 'GB']);
    expect(codeLineage('DE')).toEqual(['DE']);
  });
});

describe('locality layering', () => {
  it('walks locality → state → country', () => {
    expect(book.chain('ZC-ST-CTY')).toEqual(['ZC-ST-CTY', 'ZC-ST', 'ZC']);
    expect(book.resolve('ZC-ST-CTY', 'sick_pay.paid_sick_leave_accrual', '2026-06-01').jurisdiction).toBe('ZC-ST-CTY');
    expect(book.resolve('ZC-ST-CTY', 'minimum_wage.rates', '2026-06-01').value).toBe('state');
    expect(book.resolve('ZC-ST-CTY', 'overtime.weekly', '2026-06-01').jurisdiction).toBe('ZC');
  });
  it('reduces an unknown locality to its nearest ancestor with a pack, not straight to the country', () => {
    expect(book.chain('ZC-ST-XYZ')).toEqual(['ZC-ST', 'ZC']);
    expect(book.resolve('ZC-ST-XYZ', 'minimum_wage.rates', '2026-06-01').value).toBe('state');
    expect(book.chain('ZC-QQ-XYZ')).toEqual(['ZC']);
    expect(book.chain('QQ-XX')).toEqual([]);
  });
});

describe('subdivision extent', () => {
  it('answers a subdivision only with versions verified for it', () => {
    expect(book.resolve('ZK-NTH', 'leave.statutory_annual_minimum', '2026-06-01').value).toBe('north-and-south');
    expect(book.tryResolve('ZK-STH', 'reporting.gender_pay_gap', '2026-06-01')).toBeUndefined();
    expect(book.resolve('ZK-ISL', 'minimum_wage.rates', '2026-06-01')).toMatchObject({ jurisdiction: 'ZK', value: 'kingdom-wide', regions: ['ZK-NTH', 'ZK-STH', 'ZK-ISL'] });
  });
  it('prefers the subdivision pack and fails explicitly where neither layer is verified', () => {
    expect(book.resolve('ZK-ISL', 'leave.statutory_annual_minimum', '2026-06-01')).toMatchObject({ jurisdiction: 'ZK-ISL', value: 'island-law' });
    expect(() => book.resolve('ZK-ISL', 'reporting.gender_pay_gap', '2026-06-01')).toThrow(RuleNotFoundError);
  });
  it('the bare country code keeps answering with its default (region-scoped) law', () => {
    expect(book.resolve('ZK', 'reporting.gender_pay_gap', '2026-06-01').value).toBe('north-only');
  });
  it('back-office edits keep the scope of the pack version they amend', () => {
    const edit = (key: string): RuleOverride => ({ ...version(`edited ${key}`, { effectiveFrom: '2026-01-01' }), jurisdiction: 'ZK', key, createdAt: '2026-10-18T00:00:00Z' });
    const edited = book.withOverrides([edit('reporting.gender_pay_gap'), edit('working_time.max_weekly_hours'), edit('minimum_wage.rates')]);
    expect(edited.resolve('ZK-NTH', 'reporting.gender_pay_gap', '2026-06-01').value).toBe('edited reporting.gender_pay_gap');
    expect(edited.tryResolve('ZK-STH', 'reporting.gender_pay_gap', '2026-06-01')).toBeUndefined();
    expect(edited.resolve('ZK-ISL', 'minimum_wage.rates', '2026-06-01').value).toBe('edited minimum_wage.rates');
    // a rule added only by a back-office edit in a subdivided pack answers the bare code, not a subdivision
    expect(edited.resolve('ZK', 'working_time.max_weekly_hours', '2026-06-01').value).toBe('edited working_time.max_weekly_hours');
    expect(edited.tryResolve('ZK-NTH', 'working_time.max_weekly_hours', '2026-06-01')).toBeUndefined();
  });
});
