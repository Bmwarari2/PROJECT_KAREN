import type { RuleBook } from '@thapsus/rules';
import { addDays, dayOfWeek, instantToDate, instantToLocalTime, minutesBetween } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { calculateOvertime, checkWorkingTime, splitByLocalDay, type Interval, type OvertimeRules, type Violation, type WorkingTimeRules } from './engine';

export interface TimeSettings {
  /** What happens when a shift or timesheet breaks a working-time rule. */
  enforcement: 'warn' | 'block';
  /** ISO weekday (7 = Sunday) the payroll workweek starts on. */
  workweekStartsOn: number;
  /** Geofencing is off by default and enabled per country. */
  geofence: { countries: string[]; notice?: Record<string, string> };
}

export const DEFAULT_TIME_SETTINGS: TimeSettings = { enforcement: 'warn', workweekStartsOn: 1, geofence: { countries: [] } };

export async function timeSettings(tx: Tx): Promise<TimeSettings> {
  const row = await tx.one<{ time: Partial<TimeSettings> | null }>(`SELECT features->'time' AS time FROM app.tenants`);
  return { ...DEFAULT_TIME_SETTINGS, ...(row.time ?? {}), geofence: { ...DEFAULT_TIME_SETTINGS.geofence, ...(row.time?.geofence ?? {}) } };
}

export interface JurisdictionTimeRules {
  overtime?: OvertimeRules;
  workingTime: WorkingTimeRules;
  sources: string[];
}

/** Collects the overtime and working-time rules that apply in a country/region on a date — all from the packs. */
export function timeRulesFor(book: RuleBook, country: string | null, region: string | null, date: string, workweekStartsOn: number): JurisdictionTimeRules {
  const sources: string[] = [];
  const get = <V>(j: string, key: string) => {
    const r = book.tryResolve<V>(j, key, date);
    if (r) sources.push(r.source.url);
    return r?.value;
  };
  if (!country) return { workingTime: {}, sources };
  if (country === 'US') {
    const weekly = get<{ thresholdHours: number; multiplier: number }>('US', 'overtime.weekly');
    const local = region && region !== 'US' ? region : undefined;
    const daily = local ? get<{ tiers: OvertimeRules['daily'] }>(local, 'overtime.daily') : undefined;
    const seventh = local ? get<{ tiers: OvertimeRules['seventhDay'] }>(local, 'overtime.seventh_day') : undefined;
    return { overtime: { weekly, daily: daily?.tiers, seventhDay: seventh?.tiers, workweekStartsOn }, workingTime: {}, sources };
  }
  return {
    workingTime: {
      maxWeekly: get(country, 'working_time.max_weekly_hours'),
      dailyRest: get(country, 'working_time.daily_rest'),
      weeklyRest: get(country, 'working_time.weekly_rest'),
      restBreak: get(country, 'working_time.rest_break'),
      timeRecording: get(country, 'working_time.time_recording'),
    },
    sources,
  };
}

interface ClockRow {
  kind: 'in' | 'out' | 'break_start' | 'break_end';
  occurred_at: string;
  zone: string;
}

/** Pairs clock events into worked intervals (local wall-clock), deducting breaks. Open intervals are ignored. */
export function intervalsFromClock(events: ClockRow[]): { intervals: Interval[]; open: boolean; anomalies: number } {
  const intervals: Interval[] = [];
  let anomalies = 0;
  let start: ClockRow | undefined;
  let breakStart: string | undefined;
  let breakMinutes = 0;
  for (const e of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    if (e.kind === 'in') {
      if (start) anomalies++;
      start = e;
      breakMinutes = 0;
      breakStart = undefined;
    } else if (e.kind === 'break_start' && start) breakStart = e.occurred_at;
    else if (e.kind === 'break_end' && start && breakStart) {
      breakMinutes += minutesBetween(breakStart, e.occurred_at);
      breakStart = undefined;
    } else if (e.kind === 'out' && start) {
      const local = (i: string, zone: string) => `${instantToDate(i, zone)}T${instantToLocalTime(i, zone).slice(0, 5)}`;
      intervals.push({ start: local(start.occurred_at, start.zone), end: local(e.occurred_at, start.zone), breakMinutes, zone: start.zone });
      start = undefined;
    } else anomalies++;
  }
  return { intervals, open: !!start, anomalies };
}

export function weekStartFor(date: string, workweekStartsOn: number): string {
  return addDays(date, -((dayOfWeek(date) - workweekStartsOn + 7) % 7));
}

export interface TimesheetDay {
  date: string;
  workedMinutes: number;
  scheduledMinutes: number;
  varianceMinutes: number;
}

/** Builds a weekly timesheet: worked vs scheduled per day, overtime and working-time violations. */
export async function buildTimesheet(tx: Tx, book: RuleBook, employeeId: string, weekStart: string, settings: TimeSettings, ctx: { country: string | null; region: string | null; optedOut: boolean }) {
  const weekEnd = addDays(weekStart, 7);
  const events = await tx.query<ClockRow>(
    `SELECT kind, occurred_at, zone FROM app.clock_events WHERE employee_id = $1 AND occurred_at >= ($2::date - 1) AND occurred_at < ($3::date + 1) ORDER BY occurred_at`,
    [employeeId, weekStart, weekEnd],
  );
  const { intervals, open, anomalies } = intervalsFromClock(events.map((e) => ({ ...e, occurred_at: new Date(e.occurred_at).toISOString() })));
  const inWeek = intervals.filter((i) => i.start.slice(0, 10) >= weekStart && i.start.slice(0, 10) < weekEnd);
  const shifts = await tx.query<{ start_local: string; end_local: string; break_minutes: number; zone: string }>(
    `SELECT start_local, end_local, break_minutes, zone FROM app.shifts WHERE employee_id = $1 AND status = 'published' AND shift_date >= $2 AND shift_date < $3`,
    [employeeId, weekStart, weekEnd],
  );
  const perDay = new Map<string, TimesheetDay>();
  const day = (d: string) => perDay.get(d) ?? perDay.set(d, { date: d, workedMinutes: 0, scheduledMinutes: 0, varianceMinutes: 0 }).get(d)!;
  for (const i of inWeek) for (const p of splitByLocalDay(i)) day(p.date).workedMinutes += p.minutes;
  for (const s of shifts) for (const p of splitByLocalDay({ start: s.start_local, end: s.end_local, breakMinutes: s.break_minutes, zone: s.zone })) day(p.date).scheduledMinutes += p.minutes;
  for (const d of perDay.values()) d.varianceMinutes = d.workedMinutes - d.scheduledMinutes;

  const rules = timeRulesFor(book, ctx.country, ctx.region, weekStart, settings.workweekStartsOn);
  const ot = rules.overtime?.weekly ? calculateOvertime(inWeek, rules.overtime) : { regularMinutes: inWeek.reduce((a, i) => a + splitByLocalDay(i).reduce((s, p) => s + p.minutes, 0), 0), overtimeMinutes: 0, doubleMinutes: 0 };
  // Working-time checks look back over the reference period, so include earlier intervals too.
  const history = await tx.query<ClockRow>(`SELECT kind, occurred_at, zone FROM app.clock_events WHERE employee_id = $1 AND occurred_at >= ($2::date - 190) AND occurred_at < $2::date ORDER BY occurred_at`, [employeeId, weekStart]);
  const all = [...intervalsFromClock(history.map((e) => ({ ...e, occurred_at: new Date(e.occurred_at).toISOString() }))).intervals, ...inWeek];
  const violations: Violation[] = checkWorkingTime(all, rules.workingTime, { asOf: addDays(weekEnd, -1), optedOut: ctx.optedOut }).filter((v) => !v.date || v.date >= weekStart);
  return {
    weekStart,
    days: [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    regularMinutes: ot.regularMinutes,
    overtimeMinutes: ot.overtimeMinutes,
    doubleMinutes: ot.doubleMinutes,
    scheduledMinutes: [...perDay.values()].reduce((a, d) => a + d.scheduledMinutes, 0),
    violations,
    timeRecordingRequired: !!rules.workingTime.timeRecording?.required,
    openClock: open,
    anomalies,
    sources: [...new Set(rules.sources)],
  };
}

export async function isOptedOut(tx: Tx, employeeId: string, date: string): Promise<boolean> {
  return !!(await tx.maybe(`SELECT 1 FROM app.working_time_opt_outs WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`, [employeeId, date]));
}

/** Haversine distance in metres (geofence check). */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R = 6_371_000;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
