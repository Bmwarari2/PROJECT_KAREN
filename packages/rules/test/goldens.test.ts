import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuleBook } from '../src/engine';

/**
 * Golden tests: expected values were copied from official sources (gov.uk, OPM, BALM, Service-Public,
 * BOE, citizensinformation.ie, …) independently of the pack data, and every vector must still hold.
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
  expect?: unknown;
  expectPath?: Record<string, unknown>;
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
    .reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]), obj);
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
          expect(occ.flatMap((o) => (o.observed ? [o.observed] : [])).sort()).toEqual([...h.substituteNonWorkingDays].sort());
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
        if (r.expect !== undefined) {
          if (r.expect && typeof r.expect === 'object' && !Array.isArray(r.expect)) expect(resolved.value).toMatchObject(r.expect as object);
          else expect(resolved.value).toEqual(r.expect);
        }
        for (const [path, value] of Object.entries(r.expectPath ?? {})) expect(at(resolved.value, path), path).toEqual(value);
      });
    }
  });
}

describe('layered resolution', () => {
  it('US state falls back to federal; member state falls back to EU; nations resolve to GB', () => {
    expect(book.resolve('US-TX', 'overtime.weekly', '2026-06-01').jurisdiction).toBe('US');
    expect(book.resolve('US-CA', 'overtime.daily', '2026-06-01').jurisdiction).toBe('US-CA');
    expect(book.resolve('DE', 'working_time.daily_rest', '2026-06-01').jurisdiction).toBe('EU');
    expect(book.resolve('GB-SCT', 'leave.statutory_annual_minimum', '2026-06-01').jurisdiction).toBe('GB');
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
