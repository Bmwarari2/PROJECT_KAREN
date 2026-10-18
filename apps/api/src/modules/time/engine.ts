import { addDays, addMinutes, assertCivilDate, compareInstants, dayOfWeek, instantToDate, minutesBetween, startOfDayInstant, zonedToInstant } from '@thapsus/core/time';

/**
 * Pure working-time calculations. Intervals are local wall-clock times in an IANA zone, so DST and
 * overnight shifts are handled by converting to instants. Rule values always come from the packs.
 */
export interface Interval {
  start: string; // YYYY-MM-DDTHH:MM (local)
  end: string;
  breakMinutes: number;
  zone: string;
}

const instant = (local: string, zone: string) => zonedToInstant(local.slice(0, 10), local.slice(11, 16), zone);

export function workedMinutes(i: Interval): number {
  return Math.max(0, minutesBetween(instant(i.start, i.zone), instant(i.end, i.zone)) - i.breakMinutes);
}

/** Minutes worked per local calendar day; the break is deducted from the longest part. */
export function splitByLocalDay(i: Interval): Array<{ date: string; minutes: number }> {
  const s = instant(i.start, i.zone);
  const e = instant(i.end, i.zone);
  const parts: Array<{ date: string; minutes: number }> = [];
  let cur = s;
  while (compareInstants(cur, e) < 0) {
    const date = instantToDate(cur, i.zone);
    const nextMidnight = startOfDayInstant(addDays(date, 1), i.zone);
    const segEnd = compareInstants(nextMidnight, e) < 0 ? nextMidnight : e;
    parts.push({ date, minutes: minutesBetween(cur, segEnd) });
    cur = segEnd;
  }
  if (parts.length && i.breakMinutes) {
    const longest = parts.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    longest.minutes = Math.max(0, longest.minutes - i.breakMinutes);
  }
  return parts;
}

export interface Tier {
  afterHours: number;
  multiplier: number;
}
export interface OvertimeRules {
  weekly?: { thresholdHours: number; multiplier: number };
  daily?: Tier[];
  seventhDay?: Tier[];
  /** ISO weekday the workweek starts on (7 = Sunday). */
  workweekStartsOn: number;
}

/** Splits a day's minutes into regular / overtime (1.5×) / double (2×) by tiers. */
function applyTiers(minutes: number, tiers: Tier[], regularBelowFirst: boolean) {
  const out = { regular: 0, overtime: 0, double: 0 };
  const sorted = [...tiers].sort((a, b) => a.afterHours - b.afterHours);
  let remaining = minutes;
  let floor = 0;
  if (regularBelowFirst) {
    const first = (sorted[0]?.afterHours ?? Infinity) * 60;
    out.regular = Math.min(remaining, first);
    remaining -= out.regular;
    floor = first;
  }
  for (let t = 0; t < sorted.length && remaining > 0; t++) {
    const tier = sorted[t]!;
    const start = Math.max(floor, tier.afterHours * 60);
    const nextStart = sorted[t + 1] ? sorted[t + 1]!.afterHours * 60 : Infinity;
    const take = Math.min(remaining, nextStart - start);
    if (tier.multiplier >= 2) out.double += take;
    else out.overtime += take;
    remaining -= take;
    floor = nextStart;
  }
  out.regular += remaining;
  return out;
}

/** Overtime for one workweek: state daily/seventh-day tiers first, then federal weekly overflow on regular hours. */
export function calculateOvertime(intervals: Interval[], r: OvertimeRules) {
  const perDay = new Map<string, number>();
  for (const i of intervals) for (const p of splitByLocalDay(i)) perDay.set(p.date, (perDay.get(p.date) ?? 0) + p.minutes);
  const days = [...perDay.keys()].sort();
  let regular = 0;
  let overtime = 0;
  let double = 0;
  const weekStart = days.length ? addDays(days[0]!, -((dayOfWeek(days[0]!) - r.workweekStartsOn + 7) % 7)) : '';
  const workedAll = (d: string) => Array.from({ length: 6 }, (_, k) => addDays(weekStart, k)).every((x) => (perDay.get(x) ?? 0) > 0) && d === addDays(weekStart, 6);
  for (const d of days) {
    const m = perDay.get(d)!;
    let split = { regular: m, overtime: 0, double: 0 };
    if (r.seventhDay && workedAll(d)) split = applyTiers(m, r.seventhDay, false);
    else if (r.daily?.length) split = applyTiers(m, r.daily, true);
    // weekly overflow: regular minutes beyond the weekly threshold become overtime (no double counting)
    if (r.weekly) {
      const limit = r.weekly.thresholdHours * 60;
      const room = Math.max(0, limit - regular);
      const overflow = Math.max(0, split.regular - room);
      split.regular -= overflow;
      split.overtime += overflow;
    }
    regular += split.regular;
    overtime += split.overtime;
    double += split.double;
  }
  return { regularMinutes: regular, overtimeMinutes: overtime, doubleMinutes: double, days: days.length };
}

// ---- working-time limits (UK / EU) ------------------------------------------------------------------

export interface WorkingTimeRules {
  maxWeekly?: { maxAverageHours?: number; maxAverageWeeklyHours?: number; referencePeriodWeeks?: number; referencePeriodMaxMonths?: number; optOutAvailable?: boolean };
  dailyRest?: { minConsecutiveHours?: number; adult?: { consecutiveHours: number } };
  weeklyRest?: { minUninterruptedHours?: number; plusDailyRestHours?: number; perDays?: number; adult?: { uninterruptedHours: number; perDays: number } };
  restBreak?: { triggerWorkingDayHoursOver?: number; adult?: { whenDailyWorkingTimeExceedsHours: number; minUninterruptedMinutes: number } };
  timeRecording?: { required: boolean };
}

export interface Violation {
  rule: string;
  date?: string;
  detail: Record<string, number | string>;
}

export function checkWorkingTime(intervals: Interval[], r: WorkingTimeRules, opts: { asOf: string; optedOut?: boolean }): Violation[] {
  const v: Violation[] = [];
  const shifts = intervals
    .map((i) => ({ i, s: instant(i.start, i.zone), e: instant(i.end, i.zone), worked: workedMinutes(i), date: i.start.slice(0, 10) }))
    .sort((a, b) => compareInstants(a.s, b.s));

  const dailyRestHours = r.dailyRest?.adult?.consecutiveHours ?? r.dailyRest?.minConsecutiveHours;
  if (dailyRestHours !== undefined) {
    for (let k = 1; k < shifts.length; k++) {
      const gap = minutesBetween(shifts[k - 1]!.e, shifts[k]!.s) / 60;
      if (gap >= 0 && gap < dailyRestHours) v.push({ rule: 'working_time.daily_rest', date: shifts[k]!.date, detail: { restHours: Math.round(gap * 10) / 10, minHours: dailyRestHours } });
    }
  }

  const weeklyRestHours = r.weeklyRest?.adult?.uninterruptedHours ?? (r.weeklyRest?.minUninterruptedHours !== undefined ? r.weeklyRest.minUninterruptedHours + (r.weeklyRest.plusDailyRestHours ?? 0) : undefined);
  const perDays = r.weeklyRest?.adult?.perDays ?? r.weeklyRest?.perDays ?? 7;
  if (weeklyRestHours !== undefined) {
    const reported = new Set<string>();
    for (const first of shifts) {
      const windowEnd = addMinutes(first.s, perDays * 24 * 60);
      if (instantToDate(windowEnd, first.i.zone) > addDays(opts.asOf, 1)) continue; // only complete windows
      const inWindow = shifts.filter((x) => compareInstants(x.s, first.s) >= 0 && compareInstants(x.s, windowEnd) < 0);
      let maxGap = 0;
      for (let k = 0; k < inWindow.length; k++) {
        const nextStart = inWindow[k + 1]?.s ?? windowEnd;
        maxGap = Math.max(maxGap, minutesBetween(inWindow[k]!.e, nextStart) / 60);
      }
      if (maxGap < weeklyRestHours && !reported.has(first.date)) {
        reported.add(first.date);
        v.push({ rule: 'working_time.weekly_rest', date: first.date, detail: { longestRestHours: Math.round(maxGap * 10) / 10, minHours: weeklyRestHours } });
        break;
      }
    }
  }

  const breakAfter = r.restBreak?.adult?.whenDailyWorkingTimeExceedsHours;
  const breakMin = r.restBreak?.adult?.minUninterruptedMinutes;
  if (breakAfter !== undefined && breakMin !== undefined) {
    for (const s of shifts) if (s.worked > breakAfter * 60 && s.i.breakMinutes < breakMin) v.push({ rule: 'working_time.rest_break', date: s.date, detail: { breakMinutes: s.i.breakMinutes, minMinutes: breakMin } });
  }

  const maxAvg = r.maxWeekly?.maxAverageHours ?? r.maxWeekly?.maxAverageWeeklyHours;
  if (maxAvg !== undefined && !(opts.optedOut && r.maxWeekly?.optOutAvailable)) {
    const weeks = r.maxWeekly?.referencePeriodWeeks ?? (r.maxWeekly?.referencePeriodMaxMonths ? (r.maxWeekly.referencePeriodMaxMonths * 365.25) / 12 / 7 : 17);
    const from = addDays(opts.asOf, -Math.round(weeks * 7) + 1);
    const total = shifts.filter((s) => s.date >= from && s.date <= opts.asOf).reduce((a, s) => a + s.worked, 0);
    const average = total / 60 / weeks;
    if (average > maxAvg) v.push({ rule: 'working_time.max_weekly_hours', date: opts.asOf, detail: { averageHours: Math.round(average * 10) / 10, maxHours: maxAvg, referenceWeeks: Math.round(weeks * 10) / 10 } });
  }
  return v;
}

// ---- shifts, clock state and timesheet helpers ------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Local wall-clock shift times in an IANA zone → stored local strings and UTC instants. An end at or
 * before the start is on the next calendar day (overnight shift); DST gaps and overlaps are resolved by
 * the shared time utilities.
 */
export function shiftTimes(date: string, start: string, end: string, zone: string) {
  assertCivilDate(date);
  if (!HHMM.test(start) || !HHMM.test(end)) throw new RangeError('Times must be HH:MM');
  const endDate = end <= start ? addDays(date, 1) : date;
  return { startLocal: `${date}T${start}`, endLocal: `${endDate}T${end}`, startsAt: zonedToInstant(date, start, zone), endsAt: zonedToInstant(endDate, end, zone) };
}

export type ClockKind = 'in' | 'out' | 'break_start' | 'break_end';

/** Current state from clock events (ordered by when they happened, not when they were synced). */
export function clockState(events: Array<{ kind: ClockKind; occurred_at: string }>): { state: 'out' | 'in' | 'break'; since: string | null } {
  let state: 'out' | 'in' | 'break' = 'out';
  let since: string | null = null;
  for (const e of [...events].sort((a, b) => compareInstants(a.occurred_at, b.occurred_at))) {
    if (e.kind === 'in') [state, since] = ['in', e.occurred_at];
    else if (e.kind === 'out') [state, since] = ['out', e.occurred_at];
    else if (e.kind === 'break_start' && state === 'in') [state, since] = ['break', e.occurred_at];
    else if (e.kind === 'break_end' && state === 'break') [state, since] = ['in', e.occurred_at];
  }
  return { state, since: state === 'out' && since === null ? null : since };
}

/** Days with scheduled work but no recorded time, where the jurisdiction requires daily time recording. */
export function missingTimeRecords(days: Array<{ date: string; scheduledMinutes: number; workedMinutes: number }>, required: boolean): Violation[] {
  if (!required) return [];
  return days.filter((d) => d.scheduledMinutes > 0 && d.workedMinutes === 0).map((d) => ({ rule: 'working_time.time_recording', date: d.date, detail: { scheduledMinutes: d.scheduledMinutes } }));
}

/** Findings in `after` that were not already present in `before` (so a change is judged on what it adds). */
export function newFindings(before: Violation[], after: Violation[]): Violation[] {
  const key = (v: Violation) => `${v.rule}|${v.date ?? ''}`;
  const seen = new Set(before.map(key));
  return after.filter((v) => !seen.has(key(v)));
}

export interface AvailabilityRow {
  weekday: number | null;
  on_date: string | null;
  available: boolean;
  from_time: string | null;
  to_time: string | null;
}

/** Why a shift conflicts with the employee's stated availability (date entries override the weekday pattern). */
export function unavailableReason(shift: Interval, rows: AvailabilityRow[]): 'unavailable' | 'outside_window' | null {
  const date = shift.start.slice(0, 10);
  const dated = rows.filter((r) => r.on_date === date);
  const applicable = dated.length ? dated : rows.filter((r) => r.weekday === dayOfWeek(date));
  if (!applicable.length) return null;
  if (applicable.every((r) => !r.available)) return 'unavailable';
  const start = shift.start.slice(11, 16);
  const end = shift.end.slice(0, 10) > date ? '24:00' : shift.end.slice(11, 16);
  const fits = applicable.some((r) => r.available && (r.from_time ?? '00:00') <= start && (r.to_time ?? '24:00') >= end);
  return fits ? null : 'outside_window';
}

export interface TimesheetCsvRow {
  employeeNumber: string;
  name: string;
  weekStart: string;
  worked: number;
  scheduled: number;
  regular: number;
  overtime: number;
  double: number;
  violations: number;
  approvedAt: string | null;
}

const hours = (minutes: number) => `${Math.trunc(minutes / 60)}.${String(Math.round(((minutes % 60) * 100) / 60)).padStart(2, '0')}`;
function csvField(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // spreadsheet formula injection
  return /[",\r\n]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Payroll export feed: one row per approved timesheet, ordered by employee number (byte-for-byte reproducible). */
export function timesheetCsv(rows: TimesheetCsvRow[]): string {
  const header = 'employee_number,employee_name,week_start,worked_hours,scheduled_hours,regular_hours,overtime_hours,double_time_hours,violations,approved_at';
  const body = [...rows]
    .sort((a, b) => (a.employeeNumber < b.employeeNumber ? -1 : a.employeeNumber > b.employeeNumber ? 1 : 0))
    .map((r) => [csvField(r.employeeNumber), csvField(r.name), r.weekStart, hours(r.worked), hours(r.scheduled), hours(r.regular), hours(r.overtime), hours(r.double), String(r.violations), r.approvedAt ?? ''].join(','));
  return [header, ...body, ''].join('\r\n');
}

/** Haversine distance in metres (geofence check). */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R = 6_371_000;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
