import { Temporal } from '@js-temporal/polyfill';

/**
 * Shared time utilities. Rules:
 *  - Instants are ISO-8601 UTC strings / timestamptz in the database.
 *  - Calendar dates are 'YYYY-MM-DD' strings interpreted in an explicit IANA zone.
 *  - Never do ad-hoc Date arithmetic elsewhere; use these helpers.
 */
export { Temporal };
export type CivilDate = string; // YYYY-MM-DD
export type Instant = string; // ISO-8601 with Z

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCivilDate(v: unknown): v is CivilDate {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  try {
    Temporal.PlainDate.from(v, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

export function assertCivilDate(v: string): CivilDate {
  if (!isCivilDate(v)) throw new RangeError(`Invalid calendar date: ${v}`);
  return v;
}

const pd = (d: CivilDate) => Temporal.PlainDate.from(assertCivilDate(d));

export function addDays(d: CivilDate, n: number): CivilDate {
  return pd(d).add({ days: n }).toString();
}
export function addMonths(d: CivilDate, n: number): CivilDate {
  return pd(d).add({ months: n }, { overflow: 'constrain' }).toString();
}
export function addYears(d: CivilDate, n: number): CivilDate {
  return pd(d).add({ years: n }, { overflow: 'constrain' }).toString();
}
/** Number of days from a to b (b - a). */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return pd(a).until(pd(b), { largestUnit: 'days' }).days;
}
/** Whole months completed from a to b. */
export function monthsBetween(a: CivilDate, b: CivilDate): number {
  const diff = pd(a).until(pd(b), { largestUnit: 'months' });
  return diff.months + diff.years * 12;
}
export function compareDates(a: CivilDate, b: CivilDate): number {
  return Temporal.PlainDate.compare(pd(a), pd(b));
}
export const minDate = (a: CivilDate, b: CivilDate) => (compareDates(a, b) <= 0 ? a : b);
export const maxDate = (a: CivilDate, b: CivilDate) => (compareDates(a, b) >= 0 ? a : b);
/** ISO day of week: 1 = Monday … 7 = Sunday. */
export function dayOfWeek(d: CivilDate): number {
  return pd(d).dayOfWeek;
}
export function isLeapYear(year: number): boolean {
  return Temporal.PlainDate.from({ year, month: 1, day: 1 }).inLeapYear;
}
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}
export function daysInMonth(year: number, month: number): number {
  return Temporal.PlainDate.from({ year, month, day: 1 }).daysInMonth;
}
export function dateParts(d: CivilDate) {
  const p = pd(d);
  return { year: p.year, month: p.month, day: p.day };
}
export function makeDate(year: number, month: number, day: number): CivilDate {
  return Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' }).toString();
}
/** Inclusive list of dates from start to end. */
export function eachDay(start: CivilDate, end: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  let cur = pd(start);
  const last = pd(end);
  while (Temporal.PlainDate.compare(cur, last) <= 0) {
    out.push(cur.toString());
    cur = cur.add({ days: 1 });
  }
  return out;
}
/** Half-open range overlap test for [aFrom, aTo) and [bFrom, bTo); null `to` means open-ended. */
export function rangesOverlap(aFrom: CivilDate, aTo: CivilDate | null, bFrom: CivilDate, bTo: CivilDate | null): boolean {
  const aEndsAfterBStarts = aTo === null || compareDates(aTo, bFrom) > 0;
  const bEndsAfterAStarts = bTo === null || compareDates(bTo, aFrom) > 0;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

export function nowInstant(): Instant {
  return Temporal.Now.instant().toString();
}

/** Calendar date of an instant in the given zone. */
export function instantToDate(instant: Instant, zone: string): CivilDate {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate().toString();
}

/** Local wall time (HH:MM) of an instant in a zone. */
export function instantToLocalTime(instant: Instant, zone: string): string {
  const z = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

/**
 * Converts a local wall-clock time to a UTC instant. During DST gaps the time is moved forward
 * ('compatible'); during overlaps the earlier offset is used.
 */
export function zonedToInstant(date: CivilDate, time: string, zone: string): Instant {
  const [h, m] = time.split(':').map(Number);
  const zdt = Temporal.ZonedDateTime.from(
    { ...dateParts(date), hour: h ?? 0, minute: m ?? 0, timeZone: zone },
    { disambiguation: 'compatible' },
  );
  return zdt.toInstant().toString();
}

/** Start of the calendar day in the zone as a UTC instant (handles days that do not start at 00:00). */
export function startOfDayInstant(date: CivilDate, zone: string): Instant {
  return pd(date).toZonedDateTime({ timeZone: zone }).toInstant().toString();
}

/** Length of a calendar day in hours in a zone (23, 24 or 25 around DST). */
export function hoursInDay(date: CivilDate, zone: string): number {
  return pd(date).toZonedDateTime({ timeZone: zone }).hoursInDay;
}

export function minutesBetween(a: Instant, b: Instant): number {
  return Temporal.Instant.from(a).until(Temporal.Instant.from(b), { largestUnit: 'minutes' }).minutes;
}

export function addMinutes(i: Instant, n: number): Instant {
  return Temporal.Instant.from(i).add({ minutes: n }).toString();
}

export function compareInstants(a: Instant, b: Instant): number {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b));
}

/** Today's calendar date in a zone. */
export function today(zone: string): CivilDate {
  return Temporal.Now.plainDateISO(zone).toString();
}

/** ISO week (Monday-start) containing a date: returns the Monday. */
export function startOfIsoWeek(d: CivilDate): CivilDate {
  return addDays(d, 1 - dayOfWeek(d));
}

/** Western (Gregorian) Easter Sunday, anonymous Gregorian algorithm. */
export function easterSunday(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeDate(year, month, day);
}

/** Orthodox Easter Sunday expressed in the Gregorian calendar (valid 1900–2099). */
export function orthodoxEasterSunday(year: number): CivilDate {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addDays(makeDate(year, month, day), 13);
}

/** nth (1-based; -1 = last) ISO weekday (1=Mon) of a month. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): CivilDate {
  if (n > 0) {
    const first = makeDate(year, month, 1);
    const offset = (weekday - dayOfWeek(first) + 7) % 7;
    return addDays(first, offset + (n - 1) * 7);
  }
  const last = makeDate(year, month, daysInMonth(year, month));
  const offset = (dayOfWeek(last) - weekday + 7) % 7;
  return addDays(last, -offset + (n + 1) * 7);
}
