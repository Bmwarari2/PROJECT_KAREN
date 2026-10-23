import { compareDates, dateParts, daysInMonth, makeDate } from '@thapsus/core/time';
import { formatScaled, parseScaled, percent, roundDiv } from '../fixed';
import type { GroupBy } from '../types';

/**
 * Headcount and turnover (pure, effective-dated). Inputs are calendar dates (YYYY-MM-DD); nothing here
 * reads the clock, so every result is reproducible for an explicit as-of date.
 *
 * Definitions (docs/DECISIONS.md ADR-0072):
 *  - Employed on date D: start_date <= D and (end_date is null or end_date >= D). end_date is the last
 *    working day, so a leaver still counts on their last day.
 *  - Group of an employee on D: the job record in force on D ([valid_from, valid_to)); country is the job
 *    location's country, else the legal entity's country. No job record on D → group "unassigned" (null).
 *  - Turnover for [from, to] (both inclusive): leavers = end_date in [from, to]; average headcount =
 *    (headcount on from + headcount on to) / 2; rate = leavers / average × 100 = leavers × 200 / (start + end),
 *    rounded once to 2 dp. A leaver's group is their job on their last day.
 */
export interface JobFact {
  validFrom: string;
  validTo: string | null;
  entityId: string | null;
  departmentId: string | null;
  locationId: string | null;
  country: string | null;
  /** numeric(5,4) as text, e.g. "0.8000" */
  fte: string;
}

export interface EmployeeFact {
  id: string;
  startDate: string;
  endDate: string | null;
  leaverType?: 'voluntary' | 'involuntary' | 'other' | null;
  jobs: JobFact[];
  /** False when field permissions hide the grouping dimension for this employee. */
  groupReadable?: boolean;
}

export const RESTRICTED = '__restricted__';

export function employedOn(e: Pick<EmployeeFact, 'startDate' | 'endDate'>, date: string): boolean {
  return compareDates(e.startDate, date) <= 0 && (e.endDate === null || compareDates(e.endDate, date) >= 0);
}

export function jobOn(e: EmployeeFact, date: string): JobFact | undefined {
  return e.jobs.find(
    (j) => compareDates(j.validFrom, date) <= 0 && (j.validTo === null || compareDates(j.validTo, date) > 0),
  );
}

export function groupKey(e: EmployeeFact, date: string, groupBy: GroupBy): string | null {
  if (groupBy === 'none') return 'all';
  if (e.groupReadable === false) return RESTRICTED;
  const j = jobOn(e, date);
  if (!j) return null;
  switch (groupBy) {
    case 'entity':
      return j.entityId;
    case 'department':
      return j.departmentId;
    case 'location':
      return j.locationId;
    case 'country':
      return j.country;
  }
}

export interface HeadcountRow {
  key: string | null;
  headcount: number;
  /** Sum of FTE, 2 dp. */
  fte: string;
}

const sortRows = <T extends { key: string | null }>(rows: T[]) =>
  rows.sort((a, b) =>
    a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1,
  );

/** Headcount and FTE on `asOf`, grouped. */
export function computeHeadcount(emps: EmployeeFact[], asOf: string, groupBy: GroupBy): HeadcountRow[] {
  const acc = new Map<string | null, { n: number; fte: bigint }>();
  for (const e of emps) {
    if (!employedOn(e, asOf)) continue;
    const key = groupKey(e, asOf, groupBy);
    const a = acc.get(key) ?? { n: 0, fte: 0n };
    a.n++;
    a.fte += parseScaled(jobOn(e, asOf)?.fte ?? '0', 4);
    acc.set(key, a);
  }
  return sortRows(
    [...acc.entries()].map(([key, a]) => ({ key, headcount: a.n, fte: formatScaled(a.fte, 4, 2) })),
  );
}

/** Month-end dates from the month of `from` to `to` (the last point is `to` itself). */
export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let { year, month } = dateParts(from);
  for (;;) {
    const end = makeDate(year, month, daysInMonth(year, month));
    if (compareDates(end, to) >= 0) {
      out.push(to);
      break;
    }
    if (compareDates(end, from) >= 0) out.push(end);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return out;
}

export interface HeadcountPoint extends HeadcountRow {
  date: string;
}

/** Effective-dated headcount history: headcount per group at each month end in [from, to]. */
export function computeHeadcountHistory(
  emps: EmployeeFact[],
  from: string,
  to: string,
  groupBy: GroupBy,
): HeadcountPoint[] {
  return monthEnds(from, to).flatMap((date) =>
    computeHeadcount(emps, date, groupBy).map((r) => ({ date, ...r })),
  );
}

export interface TurnoverRow {
  key: string | null;
  headcountStart: number;
  headcountEnd: number;
  /** (start + end) / 2, 1 dp */
  averageHeadcount: string;
  leavers: number;
  voluntary: number;
  involuntary: number;
  otherOrUnknown: number;
  /** % (2 dp) or null when the average headcount is 0 */
  turnoverRate: string | null;
  voluntaryRate: string | null;
}

export function computeTurnover(
  emps: EmployeeFact[],
  from: string,
  to: string,
  groupBy: GroupBy,
): TurnoverRow[] {
  if (compareDates(from, to) > 0) throw new RangeError('from must not be after to');
  const acc = new Map<string | null, { s: number; e: number; l: number; v: number; i: number; o: number }>();
  const get = (k: string | null) =>
    acc.get(k) ?? (acc.set(k, { s: 0, e: 0, l: 0, v: 0, i: 0, o: 0 }), acc.get(k)!);
  for (const e of emps) {
    if (employedOn(e, from)) get(groupKey(e, from, groupBy)).s++;
    if (employedOn(e, to)) get(groupKey(e, to, groupBy)).e++;
    if (e.endDate && compareDates(e.endDate, from) >= 0 && compareDates(e.endDate, to) <= 0) {
      const a = get(groupKey(e, e.endDate, groupBy));
      a.l++;
      if (e.leaverType === 'voluntary') a.v++;
      else if (e.leaverType === 'involuntary') a.i++;
      else a.o++;
    }
  }
  return sortRows(
    [...acc.entries()].map(([key, a]) => {
      const sum = BigInt(a.s + a.e);
      return {
        key,
        headcountStart: a.s,
        headcountEnd: a.e,
        averageHeadcount: formatScaled(roundDiv(sum * 10n, 2n), 1, 1),
        leavers: a.l,
        voluntary: a.v,
        involuntary: a.i,
        otherOrUnknown: a.o,
        // leavers / ((s + e) / 2) × 100  ==  2 × leavers / (s + e) × 100
        turnoverRate: percent(BigInt(a.l) * 2n, sum),
        voluntaryRate: percent(BigInt(a.v) * 2n, sum),
      };
    }),
  );
}

/** Totals row for a turnover table (sums of the integer columns; rates recomputed, never averaged). */
export function turnoverTotal(rows: TurnoverRow[]): TurnoverRow {
  const s = rows.reduce((n, r) => n + r.headcountStart, 0);
  const e = rows.reduce((n, r) => n + r.headcountEnd, 0);
  const l = rows.reduce((n, r) => n + r.leavers, 0);
  const v = rows.reduce((n, r) => n + r.voluntary, 0);
  return {
    key: 'total',
    headcountStart: s,
    headcountEnd: e,
    averageHeadcount: formatScaled(roundDiv(BigInt(s + e) * 10n, 2n), 1, 1),
    leavers: l,
    voluntary: v,
    involuntary: rows.reduce((n, r) => n + r.involuntary, 0),
    otherOrUnknown: rows.reduce((n, r) => n + r.otherOrUnknown, 0),
    turnoverRate: percent(BigInt(l) * 2n, BigInt(s + e)),
    voluntaryRate: percent(BigInt(v) * 2n, BigInt(s + e)),
  };
}
