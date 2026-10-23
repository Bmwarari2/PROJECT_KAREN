import type { RuleBook } from '@thapsus/rules';
import {
  addDays,
  dayOfWeek,
  eachDay,
  instantToDate,
  instantToLocalTime,
  isValidTimeZone,
  minutesBetween,
} from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import {
  calculateOvertime,
  checkWorkingTime,
  missingTimeRecords,
  newFindings,
  splitByLocalDay,
  unavailableReason,
  type AvailabilityRow,
  type ClockKind,
  type Interval,
  type OvertimeRules,
  type Violation,
  type WorkingTimeRules,
} from './engine';

export { metresBetween } from './engine';

/**
 * Tenant time settings (company policy, not law — statutory values always come from the packs).
 * Stored in app.tenants.features->'time'.
 */
export interface TimeSettings {
  /** What happens when a shift breaks a working-time rule: warn (201 + warnings) or block (422). */
  enforcement: 'warn' | 'block';
  /** ISO weekday (7 = Sunday) the payroll workweek starts on. */
  workweekStartsOn: number;
  /** Geofencing is off by default and enabled per country; each enabled country needs a notice for workers. */
  geofence: { countries: string[]; notice: Record<string, Record<string, string>> };
  /** Shared kiosk PIN lockout and throttling. */
  kiosk: { maxFailedAttempts: number; lockoutMinutes: number; attemptsPerMinute: number };
  /** How old an offline-queued clock event may be when it is synced. */
  clock: { maxOfflineHours: number };
  /** Timesheet day variances beyond this many minutes are highlighted. */
  timesheets: { varianceToleranceMinutes: number };
}

export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  enforcement: 'warn',
  workweekStartsOn: 1,
  geofence: { countries: [], notice: {} },
  kiosk: { maxFailedAttempts: 5, lockoutMinutes: 15, attemptsPerMinute: 30 },
  clock: { maxOfflineHours: 72 },
  timesheets: { varianceToleranceMinutes: 15 },
};

export interface TimeSettingsPatch {
  enforcement?: TimeSettings['enforcement'];
  workweekStartsOn?: number;
  geofence?: Partial<TimeSettings['geofence']>;
  kiosk?: Partial<TimeSettings['kiosk']>;
  clock?: Partial<TimeSettings['clock']>;
  timesheets?: Partial<TimeSettings['timesheets']>;
}

export function mergeTimeSettings(base: TimeSettings, p: TimeSettingsPatch | null | undefined): TimeSettings {
  return {
    enforcement: p?.enforcement ?? base.enforcement,
    workweekStartsOn: p?.workweekStartsOn ?? base.workweekStartsOn,
    geofence: {
      countries: p?.geofence?.countries ?? base.geofence.countries,
      notice: p?.geofence?.notice ?? base.geofence.notice,
    },
    kiosk: { ...base.kiosk, ...(p?.kiosk ?? {}) },
    clock: { ...base.clock, ...(p?.clock ?? {}) },
    timesheets: { ...base.timesheets, ...(p?.timesheets ?? {}) },
  };
}

export async function timeSettings(tx: Tx): Promise<TimeSettings> {
  const row = await tx.one<{ time: TimeSettingsPatch | null }>(
    `SELECT features->'time' AS time FROM app.tenants`,
  );
  return mergeTimeSettings(DEFAULT_TIME_SETTINGS, row.time);
}

export interface JurisdictionTimeRules {
  overtime?: OvertimeRules;
  workingTime: WorkingTimeRules;
  sources: string[];
  /** Source URL per rule key used (findings cite the rule they come from). */
  sourceByKey: Record<string, string>;
  /** Jurisdiction each rule key resolved to (e.g. ES for a national rule, EU for the baseline). */
  jurisdictionByKey: Record<string, string>;
}

/** Collects the overtime and working-time rules that apply in a country/region on a date — all from the packs. */
export function timeRulesFor(
  book: RuleBook,
  country: string | null,
  region: string | null,
  date: string,
  workweekStartsOn: number,
): JurisdictionTimeRules {
  const sources: string[] = [];
  const sourceByKey: Record<string, string> = {};
  const jurisdictionByKey: Record<string, string> = {};
  const get = <V>(j: string, key: string) => {
    const r = book.tryResolve<V>(j, key, date);
    if (r) {
      sources.push(r.source.url);
      sourceByKey[key] = r.source.url;
      jurisdictionByKey[key] = r.jurisdiction;
    }
    return r?.value;
  };
  if (!country) return { workingTime: {}, sources, sourceByKey, jurisdictionByKey };
  if (country === 'US') {
    const weekly = get<{ thresholdHours: number; multiplier: number }>('US', 'overtime.weekly');
    const local = region && region !== 'US' ? region : undefined;
    const daily = local ? get<{ tiers: OvertimeRules['daily'] }>(local, 'overtime.daily') : undefined;
    const seventh = local
      ? get<{ tiers: OvertimeRules['seventhDay'] }>(local, 'overtime.seventh_day')
      : undefined;
    return {
      overtime: weekly
        ? { weekly, daily: daily?.tiers, seventhDay: seventh?.tiers, workweekStartsOn }
        : undefined,
      workingTime: {},
      sources,
      sourceByKey,
      jurisdictionByKey,
    };
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
    sourceByKey,
    jurisdictionByKey,
  };
}

/** Days of history a working-time check needs (the averaging reference period; at least two weeks for rest checks). */
export function referenceDays(r: WorkingTimeRules): number {
  const weeks =
    r.maxWeekly?.referencePeriodWeeks ??
    (r.maxWeekly?.referencePeriodMaxMonths ? (r.maxWeekly.referencePeriodMaxMonths * 365.25) / 12 / 7 : 2);
  return Math.max(14, Math.ceil(weeks * 7));
}

export interface ClockRow {
  kind: ClockKind;
  occurred_at: string;
  zone: string;
}

/** Pairs clock events into worked intervals (local wall-clock), deducting breaks. Open intervals are ignored. */
export function intervalsFromClock(events: ClockRow[]): {
  intervals: Interval[];
  open: boolean;
  anomalies: number;
} {
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
      const local = (i: string, zone: string) => `${instantToDate(i, zone)}T${instantToLocalTime(i, zone)}`;
      intervals.push({
        start: local(start.occurred_at, start.zone),
        end: local(e.occurred_at, start.zone),
        breakMinutes,
        zone: start.zone,
      });
      start = undefined;
    } else anomalies++;
  }
  return { intervals, open: !!start, anomalies };
}

/** Clock events in force between two dates (events superseded by a manager correction are excluded). */
export async function clockEvents(
  tx: Tx,
  employeeId: string,
  fromDate: string,
  toDate: string,
): Promise<Array<ClockRow & { within_geofence: boolean | null }>> {
  return tx.query(
    `SELECT c.kind, c.occurred_at, c.zone, c.within_geofence FROM app.clock_events c
      WHERE c.employee_id = $1 AND c.occurred_at >= $2::date AND c.occurred_at < $3::date
        AND NOT EXISTS (SELECT 1 FROM app.clock_events r WHERE r.tenant_id = c.tenant_id AND r.replaces_event_id = c.id)
      ORDER BY c.occurred_at`,
    [employeeId, fromDate, toDate],
  );
}

export function weekStartFor(date: string, workweekStartsOn: number): string {
  return addDays(date, -((dayOfWeek(date) - workweekStartsOn + 7) % 7));
}

export interface EmployeeTimeContext {
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  country: string | null;
  region: string | null;
  zone: string;
  locationId: string | null;
  departmentId: string | null;
  geofence: { lat: number; lng: number; radiusMetres: number } | null;
}

export async function employeeTimeContext(tx: Tx, employeeId: string): Promise<EmployeeTimeContext> {
  const e = await tx.maybe<{
    employee_number: string;
    display_name: string;
    country: string | null;
    region: string | null;
    zone: string | null;
    location_id: string | null;
    department_id: string | null;
    geofence: EmployeeTimeContext['geofence'];
  }>(
    `SELECT e.employee_number, e.display_name, coalesce(e.country, l.country, le.country) AS country, coalesce(e.region_code, l.region_code, le.region_code) AS region,
            coalesce(e.time_zone, l.time_zone, le.time_zone) AS zone, e.location_id, e.department_id, l.geofence
       FROM app.employees e LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = e.location_id
       LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.entity_id
      WHERE e.id = $1`,
    [employeeId],
  );
  if (!e) throw new ApiError('notFound');
  return {
    employeeId,
    employeeNumber: e.employee_number,
    displayName: e.display_name,
    country: e.country?.trim() ?? null,
    region: e.region,
    zone: e.zone && isValidTimeZone(e.zone) ? e.zone : 'UTC',
    locationId: e.location_id,
    departmentId: e.department_id,
    geofence: e.geofence && typeof e.geofence.lat === 'number' ? e.geofence : null,
  };
}

export async function isOptedOut(tx: Tx, employeeId: string, date: string): Promise<boolean> {
  return !!(await tx.maybe(
    `SELECT 1 FROM app.working_time_opt_outs WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
    [employeeId, date],
  ));
}

export interface Finding extends Violation {
  /** Official source of the rule the finding comes from (absent for company-policy findings such as availability). */
  source?: string;
}

export interface ShiftRow {
  id: string;
  start_local: string;
  end_local: string;
  break_minutes: number;
  zone: string;
}
export const toInterval = (
  s: Pick<ShiftRow, 'start_local' | 'end_local' | 'break_minutes' | 'zone'>,
): Interval => ({ start: s.start_local, end: s.end_local, breakMinutes: s.break_minutes, zone: s.zone });

/**
 * Working-time check for putting `candidate` on an employee's rota. Statutory limits (rest, breaks,
 * average weekly hours with the UK opt-out) come back as `violations` — only those this shift adds — and
 * cost or company-policy signals (projected overtime, availability) as `warnings`.
 */
export async function assignmentCheck(
  tx: Tx,
  book: RuleBook,
  settings: TimeSettings,
  employeeId: string,
  candidate: Interval,
  opts: { excludeShiftIds?: string[] } = {},
): Promise<{ violations: Finding[]; warnings: Finding[] }> {
  const date = candidate.start.slice(0, 10);
  const ctx = await employeeTimeContext(tx, employeeId);
  const rules = timeRulesFor(book, ctx.country, ctx.region, date, settings.workweekStartsOn);
  const weekStart = weekStartFor(date, settings.workweekStartsOn);
  const asOf = addDays(weekStart, 6);
  const existing = (
    await tx.query<ShiftRow>(
      `SELECT id, start_local, end_local, break_minutes, zone FROM app.shifts
        WHERE employee_id = $1 AND status <> 'cancelled' AND shift_date >= $2 AND shift_date <= $3 AND NOT (id = ANY($4::uuid[]))`,
      [
        employeeId,
        addDays(weekStart, -referenceDays(rules.workingTime)),
        addDays(asOf, 1),
        opts.excludeShiftIds ?? [],
      ],
    )
  ).map(toInterval);
  const optedOut = await isOptedOut(tx, employeeId, date);
  const before = checkWorkingTime(existing, rules.workingTime, { asOf, optedOut });
  const after = checkWorkingTime([...existing, candidate], rules.workingTime, { asOf, optedOut });
  const added = newFindings(before, after);
  // The candidate always lies inside the averaging window, so it adds to an average that is already over the limit.
  const overAverage = after.find((v) => v.rule === 'working_time.max_weekly_hours');
  if (overAverage && !added.includes(overAverage)) added.push(overAverage);
  const violations: Finding[] = added.map((v) => ({ ...v, source: rules.sourceByKey[v.rule] }));

  const warnings: Finding[] = [];
  if (rules.overtime) {
    const inWeek = existing.filter((i) => i.start.slice(0, 10) >= weekStart && i.start.slice(0, 10) <= asOf);
    const b = calculateOvertime(inWeek, rules.overtime);
    const a = calculateOvertime([...inWeek, candidate], rules.overtime);
    const added = a.overtimeMinutes + a.doubleMinutes - b.overtimeMinutes - b.doubleMinutes;
    if (added > 0) {
      const daily = calculateOvertime([candidate], { ...rules.overtime, weekly: undefined });
      const key = daily.overtimeMinutes + daily.doubleMinutes > 0 ? 'overtime.daily' : 'overtime.weekly';
      warnings.push({
        rule: 'overtime.projected',
        date,
        detail: { overtimeMinutes: a.overtimeMinutes, doubleMinutes: a.doubleMinutes, addedMinutes: added },
        source: rules.sourceByKey[key] ?? rules.sourceByKey['overtime.weekly'],
      });
    }
  }
  const avail = await tx.query<AvailabilityRow>(
    `SELECT weekday, on_date, available, from_time, to_time FROM app.availability WHERE employee_id = $1 AND (on_date = $2 OR weekday = $3)`,
    [employeeId, date, dayOfWeek(date)],
  );
  const reason = unavailableReason(candidate, avail);
  if (reason) warnings.push({ rule: `availability.${reason}`, date, detail: {} });
  return { violations, warnings };
}

export interface TimesheetDay {
  date: string;
  workedMinutes: number;
  scheduledMinutes: number;
  varianceMinutes: number;
  flagged: boolean;
}

/** Builds a weekly timesheet: worked vs scheduled per day, overtime and working-time findings — rules from the packs. */
export async function buildTimesheet(
  tx: Tx,
  book: RuleBook,
  employeeId: string,
  weekStart: string,
  settings: TimeSettings,
) {
  const ctx = await employeeTimeContext(tx, employeeId);
  const weekEnd = addDays(weekStart, 7);
  const events = await clockEvents(tx, employeeId, addDays(weekStart, -1), addDays(weekEnd, 1));
  const { intervals, open, anomalies } = intervalsFromClock(events);
  const inWeek = intervals.filter((i) => i.start.slice(0, 10) >= weekStart && i.start.slice(0, 10) < weekEnd);
  const shifts = await tx.query<ShiftRow>(
    `SELECT id, start_local, end_local, break_minutes, zone FROM app.shifts WHERE employee_id = $1 AND status = 'published' AND shift_date >= $2 AND shift_date < $3`,
    [employeeId, weekStart, weekEnd],
  );
  const blank = (d: string): TimesheetDay => ({
    date: d,
    workedMinutes: 0,
    scheduledMinutes: 0,
    varianceMinutes: 0,
    flagged: false,
  });
  const perDay = new Map<string, TimesheetDay>(
    eachDay(weekStart, addDays(weekEnd, -1)).map((d) => [d, blank(d)]),
  );
  const day = (d: string) => perDay.get(d) ?? perDay.set(d, blank(d)).get(d)!;
  for (const i of inWeek) for (const p of splitByLocalDay(i)) day(p.date).workedMinutes += p.minutes;
  for (const s of shifts)
    for (const p of splitByLocalDay(toInterval(s))) day(p.date).scheduledMinutes += p.minutes;
  for (const d of perDay.values()) {
    d.varianceMinutes = d.workedMinutes - d.scheduledMinutes;
    d.flagged = Math.abs(d.varianceMinutes) > settings.timesheets.varianceToleranceMinutes;
  }
  const days = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  const rules = timeRulesFor(book, ctx.country, ctx.region, weekStart, settings.workweekStartsOn);
  const workedMinutes = days.reduce((a, d) => a + d.workedMinutes, 0);
  const ot = rules.overtime
    ? calculateOvertime(inWeek, rules.overtime)
    : { regularMinutes: workedMinutes, overtimeMinutes: 0, doubleMinutes: 0 };
  // Working-time checks look back over the reference period, so include earlier recorded time too.
  const history = intervalsFromClock(
    await clockEvents(tx, employeeId, addDays(weekStart, -referenceDays(rules.workingTime) - 1), weekStart),
  ).intervals.filter((i) => i.start.slice(0, 10) < weekStart);
  const optedOut = await isOptedOut(tx, employeeId, addDays(weekEnd, -1));
  const timeRecordingRequired = !!rules.workingTime.timeRecording?.required;
  const violations: Finding[] = [
    ...checkWorkingTime([...history, ...inWeek], rules.workingTime, {
      asOf: addDays(weekEnd, -1),
      optedOut,
    }).filter((v) => !v.date || v.date >= weekStart),
    ...missingTimeRecords(days, timeRecordingRequired),
  ].map((v) => ({ ...v, source: rules.sourceByKey[v.rule] }));
  return {
    employeeId,
    employeeNumber: ctx.employeeNumber,
    employeeName: ctx.displayName,
    weekStart,
    days,
    workedMinutes,
    scheduledMinutes: days.reduce((a, d) => a + d.scheduledMinutes, 0),
    regularMinutes: ot.regularMinutes,
    overtimeMinutes: ot.overtimeMinutes,
    doubleMinutes: ot.doubleMinutes,
    violations,
    timeRecordingRequired,
    timeRecordingJurisdiction: rules.jurisdictionByKey['working_time.time_recording'] ?? null,
    optedOut,
    openClock: open,
    anomalies,
    outsideGeofence: events.filter(
      (e) =>
        e.within_geofence === false &&
        instantToDate(e.occurred_at, ctx.zone) >= weekStart &&
        instantToDate(e.occurred_at, ctx.zone) < weekEnd,
    ).length,
    sources: [...new Set(rules.sources)],
  };
}
export type Timesheet = Awaited<ReturnType<typeof buildTimesheet>>;
