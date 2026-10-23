import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuleBook, RuleNotFoundError } from '../src/engine';

/**
 * Golden tests: expected values were copied from official sources (gov.uk, OPM, BALM, Service-Public,
 * BOE, citizensinformation.ie, …) independently of the pack data where possible (a vector's `notes`
 * says when it is derived from the same statute as the pack), and every vector must still hold.
 * `golden coverage` below fails when any pack rule version has no vector dated inside it (ADR-0020).
 */
interface HolidayVector {
  jurisdiction?: string;
  region: string;
  year: number;
  dates: string[];
  packGaps?: string[];
  substituteNonWorkingDays?: string[];
}
interface RuleVector {
  jurisdiction?: string;
  key: string;
  date: string;
  /** Full value (objects: subset match); null = no rule may be in force on that date. */
  expect?: unknown;
  expectPath?: Record<string, unknown>;
  /** Pack that must answer (proves layering, e.g. GB-NIR answered by GB-NIR, US-NY-BUF by US-NY). */
  expectJurisdiction?: string;
  source?: string;
  notes?: string;
}
interface GoldenFile {
  jurisdiction?: string;
  holidays?: HolidayVector[];
  rules?: RuleVector[];
}

const book = RuleBook.fromDirectory();
const dir = join(__dirname, '..', 'goldens');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

function at(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce<unknown>(
      (o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]),
      obj,
    );
}

for (const file of files) {
  const g = JSON.parse(readFileSync(join(dir, file), 'utf8')) as GoldenFile;
  describe(`goldens ${file}`, () => {
    for (const h of g.holidays ?? []) {
      const country = h.jurisdiction ?? g.jurisdiction!;
      const region = h.region === '*' ? undefined : h.region;
      it(`holidays ${country} ${h.region} ${h.year}`, () => {
        const gaps = new Set(h.packGaps ?? []); // dates the official list has but the pack does not model yet (tracked in COVERAGE.md)
        const expected = h.dates.filter((d) => !gaps.has(d)).sort();
        if (h.substituteNonWorkingDays) {
          const occ = book.holidays(country, h.year, region);
          expect(occ.map((o) => o.date).sort()).toEqual(expected);
          expect(occ.flatMap((o) => (o.observed ? [o.observed] : [])).sort()).toEqual(
            [...h.substituteNonWorkingDays].sort(),
          );
        } else {
          expect(book.daysOff(country, h.year, region)).toEqual(expected);
        }
      });
    }
    for (const r of g.rules ?? []) {
      const j = r.jurisdiction ?? g.jurisdiction!;
      it(`rule ${j} ${r.key} @ ${r.date}`, () => {
        if (r.expect === null) {
          // vector asserts that no rule was in force on that date
          expect(book.tryResolve(j, r.key, r.date)).toBeUndefined();
          return;
        }
        const resolved = book.resolve(j, r.key, r.date);
        expect(resolved.source.url).toMatch(/^https:\/\//);
        if (r.expectJurisdiction) expect(resolved.jurisdiction).toBe(r.expectJurisdiction);
        if (r.expect !== undefined) {
          if (r.expect && typeof r.expect === 'object' && !Array.isArray(r.expect))
            expect(resolved.value).toMatchObject(r.expect as object);
          else expect(resolved.value).toEqual(r.expect);
        }
        for (const [path, value] of Object.entries(r.expectPath ?? {}))
          expect(at(resolved.value, path), path).toEqual(value);
      });
    }
  });
}

const goldenFiles = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as GoldenFile);
const ruleVectors = goldenFiles.flatMap((g) =>
  (g.rules ?? []).map((r) => ({ ...r, jurisdiction: r.jurisdiction ?? g.jurisdiction! })),
);
const holidayVectors = goldenFiles.flatMap((g) =>
  (g.holidays ?? []).map((h) => ({ ...h, jurisdiction: h.jurisdiction ?? g.jurisdiction! })),
);

describe('golden coverage', () => {
  it('every pack rule version has a golden vector dated inside its effective period that resolves to it', () => {
    // a vector counts only if it asserts a value (expect or expectPath) and the engine answers it from that exact version
    const answered = new Set<string>();
    for (const r of ruleVectors) {
      if (r.expect === null || (r.expect === undefined && !r.expectPath)) continue;
      const res = book.tryResolve(r.jurisdiction, r.key, r.date);
      if (res) answered.add(`${res.jurisdiction} ${r.key} ${res.effectiveFrom}`);
    }
    const missing = book
      .jurisdictions()
      .flatMap((p) =>
        p.rules.flatMap((rule) =>
          rule.versions
            .map((v) => `${p.jurisdiction} ${rule.key} ${v.effectiveFrom}`)
            .filter((id) => !answered.has(id)),
        ),
      );
    expect(
      missing,
      'add a vector to packages/rules/goldens for each (jurisdiction key effectiveFrom)',
    ).toEqual([]);
  });
  it('every pack with holidays has a holiday vector, and so does every declared subdivision', () => {
    const missing: string[] = [];
    for (const p of book.jurisdictions()) {
      if (p.holidays.length && !holidayVectors.some((h) => h.jurisdiction === p.jurisdiction))
        missing.push(p.jurisdiction);
      for (const sub of p.subdivisions ?? [])
        if (!holidayVectors.some((h) => h.jurisdiction === p.jurisdiction && h.region === sub))
          missing.push(sub);
    }
    expect(missing).toEqual([]);
  });
});

describe('layered resolution', () => {
  it('US state falls back to federal; member state falls back to EU; nations resolve to GB', () => {
    expect(book.resolve('US-TX', 'overtime.weekly', '2026-06-01').jurisdiction).toBe('US');
    expect(book.resolve('US-CA', 'overtime.daily', '2026-06-01').jurisdiction).toBe('US-CA');
    expect(book.resolve('DE', 'working_time.daily_rest', '2026-06-01').jurisdiction).toBe('EU');
    expect(book.resolve('GB-SCT', 'leave.statutory_annual_minimum', '2026-06-01').jurisdiction).toBe('GB');
  });
  it('US localities walk locality -> state -> federal; unknown localities stop at their state', () => {
    expect(book.chain('US-NY-NYC')).toEqual(['US-NY-NYC', 'US-NY', 'US']);
    expect(book.chain('US-CA-SF')).toEqual(['US-CA', 'US']);
    expect(book.resolve('US-NY-NYC', 'sick_pay.paid_sick_leave_accrual', '2026-06-01').jurisdiction).toBe(
      'US-NY-NYC',
    );
    expect(book.resolve('US-NY-NYC', 'minimum_wage.rates', '2026-06-01').jurisdiction).toBe('US-NY');
    expect(book.resolve('US-CA-SF', 'overtime.daily', '2026-06-01').jurisdiction).toBe('US-CA');
    expect(book.tryResolve('US-TX-AUS', 'overtime.daily', '2026-06-01')).toBeUndefined();
  });
  it('UK nations: Scotland, Wales and England get GB law; Northern Ireland never inherits a GB rule not verified for it', () => {
    for (const nation of ['GB-SCT', 'GB-WLS', 'GB-ENG']) {
      expect(book.resolve(nation, 'leave.statutory_annual_minimum', '2026-06-01').jurisdiction).toBe('GB');
      expect(
        book.resolve(nation, 'employment.unfair_dismissal_qualifying_period', '2027-01-01').value,
      ).toMatchObject({ qualifyingPeriod: 'P6M' });
    }
    expect(book.chain('GB-NIR')).toEqual(['GB-NIR', 'GB']);
    expect(
      book.resolve('GB-NIR', 'employment.unfair_dismissal_qualifying_period', '2027-01-01'),
    ).toMatchObject({ jurisdiction: 'GB-NIR', value: { qualifyingPeriod: 'P1Y' } });
    expect(book.resolve('GB-NIR', 'minimum_wage.rates', '2026-06-01')).toMatchObject({
      jurisdiction: 'GB',
      regions: expect.arrayContaining(['GB-NIR']),
    });
    expect(() => book.resolve('GB-NIR', 'reporting.gender_pay_gap', '2026-06-01')).toThrow(RuleNotFoundError);
    // every GB rule answered for GB-NIR comes from the NI pack or from a GB version that lists GB-NIR
    const gb = book.pack('GB')!;
    for (const rule of gb.rules) {
      for (const v of rule.versions) {
        const r = book.tryResolve('GB-NIR', rule.key, v.effectiveFrom);
        if (r?.jurisdiction === 'GB')
          expect(r.regions, `${rule.key} @ ${v.effectiveFrom}`).toContain('GB-NIR');
      }
    }
  });
  it('is effective-dated: the UK unfair dismissal period changes on 1 January 2027', () => {
    const before = book.resolve('GB', 'employment.unfair_dismissal_qualifying_period', '2026-12-31');
    const after = book.resolve('GB', 'employment.unfair_dismissal_qualifying_period', '2027-01-01');
    expect(before.value).not.toEqual(after.value);
  });
  it('reports missing rules instead of guessing', () => {
    expect(book.tryResolve('US-TX', 'overtime.daily', '2026-06-01')).toBeUndefined();
  });
});
