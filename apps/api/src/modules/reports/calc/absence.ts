import { compareDates, maxDate, minDate } from '@thapsus/core/time';
import { bradfordFactor, requestAmount, type WorkPattern } from '../../leave/engine';
import { e4, formatScaled, percent } from '../fixed';

/**
 * Absence and overtime (pure). Working days lost reuse the leave engine's own day counting
 * (work pattern, public holidays, half days), so the report always agrees with balances.
 *
 *  - An absence overlapping the period is clipped to [from, to]; a half day only applies on a day that is
 *    still the request's own first / last day after clipping.
 *  - Days are summed in ten-thousandths and hours in hundredths, then shown with 2 dp (one rounding).
 *  - Bradford factor (S² × D over the 52 weeks to `to`) is calculated only when the tenant enabled it.
 */
export interface AbsenceFact {
  employeeId: string;
  /** Grouping value for the requested dimension (already permission-checked by the loader). */
  group: string | null;
  leaveType: string;
  start: string;
  end: string;
  startHalf?: 'am' | 'pm' | null;
  endHalf?: 'am' | 'pm' | null;
  pattern: WorkPattern;
  holidays: string[];
}

export interface AbsenceRow {
  key: string | null;
  leaveType: string | null;
  spells: number;
  employees: number;
  daysLost: string;
  hoursLost: string;
}

export function clippedAmount(
  f: AbsenceFact,
  from: string,
  to: string,
): { daysE4: bigint; hoursE2: bigint } | null {
  if (compareDates(f.end, from) < 0 || compareDates(f.start, to) > 0) return null;
  const start = maxDate(f.start, from);
  const end = minDate(f.end, to);
  const a = requestAmount({
    start,
    end,
    pattern: f.pattern,
    holidays: f.holidays,
    startHalf: start === f.start ? (f.startHalf ?? undefined) : undefined,
    endHalf: end === f.end ? (f.endHalf ?? undefined) : undefined,
  });
  return { daysE4: e4(a.days), hoursE2: BigInt(Math.round(a.hours * 100)) };
}

/** Days/hours lost per group (and leave type when `byType`). */
export function computeAbsence(
  facts: AbsenceFact[],
  from: string,
  to: string,
  byType: boolean,
): AbsenceRow[] {
  const acc = new Map<
    string,
    { key: string | null; type: string | null; spells: number; emps: Set<string>; d: bigint; h: bigint }
  >();
  for (const f of facts) {
    const amount = clippedAmount(f, from, to);
    if (!amount) continue;
    const type = byType ? f.leaveType : null;
    const id = JSON.stringify([f.group, type]);
    const a = acc.get(id) ?? { key: f.group, type, spells: 0, emps: new Set<string>(), d: 0n, h: 0n };
    a.spells++;
    a.emps.add(f.employeeId);
    a.d += amount.daysE4;
    a.h += amount.hoursE2;
    acc.set(id, a);
  }
  return [...acc.values()]
    .sort(
      (x, y) =>
        String(x.key ?? '\uffff').localeCompare(String(y.key ?? '\uffff')) ||
        String(x.type).localeCompare(String(y.type)),
    )
    .map((a) => ({
      key: a.key,
      leaveType: a.type,
      spells: a.spells,
      employees: a.emps.size,
      daysLost: formatScaled(a.d, 4, 2),
      hoursLost: formatScaled(a.h, 2, 2),
    }));
}

export interface BradfordInput {
  employeeId: string;
  spells: Array<{ start: string; end: string | null }>;
  pattern: WorkPattern;
}

/** Bradford factor per employee as of `asOf` (open spells run to `asOf`). */
export function computeBradford(
  inputs: BradfordInput[],
  asOf: string,
): Map<string, { spells: number; days: string; score: string }> {
  const out = new Map<string, { spells: number; days: string; score: string }>();
  for (const i of inputs) {
    const bf = bradfordFactor(
      i.spells.map((s) => ({ start: s.start, end: s.end ?? asOf })),
      asOf,
      i.pattern,
    );
    // S² × D with D in ten-thousandths of a day, shown to 2 dp.
    out.set(i.employeeId, {
      spells: bf.spells,
      days: formatScaled(e4(bf.days), 4, 2),
      score: formatScaled(BigInt(bf.spells * bf.spells) * e4(bf.days), 4, 2),
    });
  }
  return out;
}

// ---- overtime ---------------------------------------------------------------------------------------

export interface TimesheetFact {
  employeeId: string;
  group: string | null;
  weekStart: string;
  workedMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  doubleMinutes: number;
  scheduledMinutes: number;
}

export interface OvertimeRow {
  key: string | null;
  timesheets: number;
  employees: number;
  workedMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  doubleMinutes: number;
  scheduledMinutes: number;
  /** (overtime + double) / worked, % 2 dp */
  overtimeShare: string | null;
}

/** Approved timesheets with week_start in [from, to], summed per group (integer minutes, no rounding). */
export function computeOvertime(facts: TimesheetFact[], from: string, to: string): OvertimeRow[] {
  const acc = new Map<string | null, OvertimeRow & { emps: Set<string> }>();
  for (const f of facts) {
    if (compareDates(f.weekStart, from) < 0 || compareDates(f.weekStart, to) > 0) continue;
    const a = acc.get(f.group) ?? {
      key: f.group,
      timesheets: 0,
      employees: 0,
      workedMinutes: 0,
      regularMinutes: 0,
      overtimeMinutes: 0,
      doubleMinutes: 0,
      scheduledMinutes: 0,
      overtimeShare: null,
      emps: new Set<string>(),
    };
    a.timesheets++;
    a.emps.add(f.employeeId);
    a.workedMinutes += f.workedMinutes;
    a.regularMinutes += f.regularMinutes;
    a.overtimeMinutes += f.overtimeMinutes;
    a.doubleMinutes += f.doubleMinutes;
    a.scheduledMinutes += f.scheduledMinutes;
    acc.set(f.group, a);
  }
  return [...acc.values()]
    .sort((x, y) => String(x.key ?? '\uffff').localeCompare(String(y.key ?? '\uffff')))
    .map(({ emps, ...a }) => ({
      ...a,
      employees: emps.size,
      overtimeShare: percent(BigInt(a.overtimeMinutes + a.doubleMinutes), BigInt(a.workedMinutes)),
    }));
}
