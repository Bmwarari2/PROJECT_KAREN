import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, dayOfWeek, easterSunday, makeDate, nthWeekdayOfMonth, orthodoxEasterSunday } from '@thapsus/core/time';
import type { HolidayDefinition, JurisdictionPack, Rule, RuleKey, RuleVersion } from './schema';

/**
 * Rule engine over the jurisdiction packs. Values are looked up by (jurisdiction, key, date) with
 * layered resolution — US state → US; EU member state → EU; UK nation → GB — and every answer
 * carries its source and verification date.
 */
export const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

export class RuleNotFoundError extends Error {
  constructor(
    readonly jurisdiction: string,
    readonly key: string,
    readonly date: string,
  ) {
    super(`No rule ${key} for ${jurisdiction} on ${date}`);
  }
}

export interface ResolvedRule<V = unknown> {
  jurisdiction: string;
  key: string;
  value: V;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: { url: string; title: string };
  verifiedOn: string;
  packVersion: number;
}

export interface HolidayOccurrence {
  id: string;
  name: string;
  /** The holiday's own calendar date. */
  date: string;
  /** The day off when the holiday is moved by an observance rule (substitute/observed day). */
  observed: string | null;
  jurisdiction: string;
}

/** A back-office edit: a new version layered over the pack data (never overwrites). */
export interface RuleOverride extends RuleVersion {
  jurisdiction: string;
  key: string;
  createdAt: string;
}

export class RuleBook {
  private packs = new Map<string, JurisdictionPack>();
  private overrides: RuleOverride[] = [];

  constructor(packs: JurisdictionPack[], overrides: RuleOverride[] = []) {
    for (const p of packs) this.packs.set(p.jurisdiction, p);
    // newest edit wins where periods overlap
    this.overrides = [...overrides].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  withOverrides(overrides: RuleOverride[]): RuleBook {
    return new RuleBook([...this.packs.values()], overrides);
  }

  /** All versions of a rule for a jurisdiction: pack versions plus back-office edits (audit history). */
  versions(jurisdiction: string, key: string): Array<RuleVersion & { origin: 'pack' | 'backoffice' }> {
    const pack = this.packs.get(jurisdiction)?.rules.find((r) => r.key === key)?.versions ?? [];
    return [
      ...pack.map((v) => ({ ...v, origin: 'pack' as const })),
      ...this.overrides.filter((o) => o.jurisdiction === jurisdiction && o.key === key).map((o) => ({ ...o, origin: 'backoffice' as const })),
    ];
  }

  static fromDirectory(dir = PACKS_DIR): RuleBook {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.json')) files.push(p);
      }
    };
    walk(dir);
    return new RuleBook(files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as JurisdictionPack));
  }

  jurisdictions(): JurisdictionPack[] {
    return [...this.packs.values()];
  }

  pack(code: string): JurisdictionPack | undefined {
    return this.packs.get(code);
  }

  /** Resolution chain: e.g. "US-CA" → ["US-CA", "US"]; "GB-SCT" → ["GB"]; "DE" → ["DE", "EU"]. */
  chain(jurisdiction: string): string[] {
    const out: string[] = [];
    let cur: string | null | undefined = jurisdiction;
    if (!this.packs.has(jurisdiction) && jurisdiction.includes('-')) cur = jurisdiction.split('-')[0]; // nation/state without its own pack
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (this.packs.has(cur)) out.push(cur);
      cur = this.packs.get(cur)?.parent ?? null;
    }
    return out;
  }

  /** Most specific rule version in force on `date` (layered). */
  resolve<V = unknown>(jurisdiction: string, key: RuleKey | string, date: string): ResolvedRule<V> {
    for (const j of this.chain(jurisdiction)) {
      const pack = this.packs.get(j)!;
      const o = this.overrides.find((x) => x.jurisdiction === j && x.key === key && x.effectiveFrom <= date && (x.effectiveTo === null || x.effectiveTo > date));
      if (o) return { jurisdiction: j, key, value: o.value as V, effectiveFrom: o.effectiveFrom, effectiveTo: o.effectiveTo, source: o.source, verifiedOn: o.verifiedOn, packVersion: pack.version };
      const rule = pack.rules.find((r) => r.key === key) as Rule<V> | undefined;
      const v = rule?.versions.find((x: RuleVersion<V>) => x.effectiveFrom <= date && (x.effectiveTo === null || x.effectiveTo > date));
      if (v) return { jurisdiction: j, key, value: v.value, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo, source: v.source, verifiedOn: v.verifiedOn, packVersion: pack.version };
    }
    throw new RuleNotFoundError(jurisdiction, key, date);
  }

  tryResolve<V = unknown>(jurisdiction: string, key: RuleKey | string, date: string): ResolvedRule<V> | undefined {
    try {
      return this.resolve<V>(jurisdiction, key, date);
    } catch (e) {
      if (e instanceof RuleNotFoundError) return undefined;
      throw e;
    }
  }

  /**
   * Public holidays for a country (and optional subdivision, e.g. "GB-SCT", "DE-BY", "ES-MD") in a
   * year. Observance rules move weekend holidays to the observed day; occurrences belong to the
   * holiday's own year even when observed in the previous one (US New Year on 31 Dec).
   */
  holidays(country: string, year: number, region?: string): HolidayOccurrence[] {
    const pack = this.packs.get(country);
    if (!pack) return [];
    const applies = (h: HolidayDefinition) => h.regions.includes('*') || (region ? h.regions.includes(region) : false);
    const nominal: Array<{ h: HolidayDefinition; date: string }> = [];
    for (const h of pack.holidays) {
      if (!applies(h)) continue;
      const date = holidayDate(h, year);
      if (!date) continue;
      if (date < h.effectiveFrom || (h.effectiveTo !== null && date >= h.effectiveTo)) continue;
      nominal.push({ h, date });
    }
    nominal.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // de-duplicate the same holiday defined for overlapping regions
    const unique = nominal.filter((n, i) => nominal.findIndex((m) => m.h.id === n.h.id && m.date === n.date) === i);
    const taken = new Set(unique.map((n) => n.date));
    const out: HolidayOccurrence[] = [];
    for (const n of unique) {
      let observed: string | null = null;
      const dow = dayOfWeek(n.date);
      if (dow >= 6) {
        if (n.h.observance === 'us_federal') observed = addDays(n.date, dow === 6 ? -1 : 1);
        if (n.h.observance === 'next_monday') observed = addDays(n.date, 8 - dow);
        if (n.h.observance === 'uk_substitute') {
          // next weekday that is not already a holiday, allocated in date order
          let d = addDays(n.date, 8 - dow);
          while (taken.has(d) || dayOfWeek(d) >= 6) d = addDays(d, 1);
          observed = d;
        }
        if (observed) taken.add(observed);
      }
      out.push({ id: n.h.id, name: n.h.name, date: n.date, observed, jurisdiction: country });
    }
    return out;
  }

  /** Days off in a year (observed dates where moved, otherwise the holiday date). */
  daysOff(country: string, year: number, region?: string): string[] {
    return [...new Set(this.holidays(country, year, region).map((h) => h.observed ?? h.date))].sort();
  }
}

export function holidayDate(h: HolidayDefinition, year: number): string | null {
  const r = h.rule;
  switch (r.type) {
    case 'fixed':
      return makeDate(year, r.month, r.day);
    case 'easter':
      return addDays(r.calendar === 'orthodox' ? orthodoxEasterSunday(year) : easterSunday(year), r.offset);
    case 'nth_weekday':
      return nthWeekdayOfMonth(year, r.month, r.weekday, r.n);
    case 'weekday_on_or_after': {
      const start = makeDate(year, r.month, r.day);
      return addDays(start, (r.weekday - dayOfWeek(start) + 7) % 7);
    }
    case 'one_off':
      return r.date.startsWith(`${year}-`) ? r.date : null;
  }
}

let defaultBook: RuleBook | undefined;
/** Shared rule book loaded from packages/rules/packs (cached). */
export function rules(): RuleBook {
  defaultBook ??= RuleBook.fromDirectory();
  return defaultBook;
}
