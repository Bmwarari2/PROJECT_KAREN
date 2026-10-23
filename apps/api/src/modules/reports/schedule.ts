import {
  addDays,
  addMonths,
  compareDates,
  compareInstants,
  dateParts,
  dayOfWeek,
  instantToDate,
  makeDate,
  zonedToInstant,
} from '@thapsus/core/time';

/**
 * Schedule arithmetic for report delivery and data exports (pure). A schedule fires at a local wall-clock
 * time in an IANA zone; its period key is the local date of the occurrence, which makes every enqueue
 * idempotent per schedule + period. Local times that do not exist (spring-forward gap) resolve to the
 * next valid instant, as zonedToInstant does.
 */
export interface ScheduleSpec {
  frequency: 'daily' | 'weekly' | 'monthly';
  timeOfDay: string; // HH:MM
  weekday?: number | null; // 1 = Monday … 7 = Sunday (weekly)
  dayOfMonth?: number | null; // 1–28 (monthly)
  timeZone: string;
}

/** The most recent occurrence at or before `now` (instant), or null if none in the last two periods. */
export function latestOccurrence(now: string, s: ScheduleSpec): { periodKey: string; at: string } | null {
  const today = instantToDate(now, s.timeZone);
  const candidates: string[] = [];
  if (s.frequency === 'daily') candidates.push(today, addDays(today, -1));
  else if (s.frequency === 'weekly') {
    const back = (dayOfWeek(today) - (s.weekday ?? 1) + 7) % 7;
    const latest = addDays(today, -back);
    candidates.push(latest, addDays(latest, -7));
  } else {
    const { year, month } = dateParts(today);
    const thisMonth = makeDate(year, month, s.dayOfMonth ?? 1);
    candidates.push(thisMonth, addMonths(thisMonth, -1));
  }
  for (const date of candidates) {
    if (compareDates(date, today) > 0) continue;
    const at = zonedToInstant(date, s.timeOfDay, s.timeZone);
    if (compareInstants(at, now) <= 0) return { periodKey: date, at };
  }
  return null;
}

export type Relative =
  'today' | 'yesterday' | 'previousWeek' | 'previousMonth' | 'monthToDate' | 'yearToDate' | 'previousYear';

/** Resolves a relative period against a reference local date: asOf is the period's last day. */
export function resolveRelative(r: Relative, date: string): { from: string; to: string; asOf: string } {
  const { year, month } = dateParts(date);
  switch (r) {
    case 'today':
      return { from: date, to: date, asOf: date };
    case 'yesterday': {
      const d = addDays(date, -1);
      return { from: d, to: d, asOf: d };
    }
    case 'previousWeek': {
      const monday = addDays(date, 1 - dayOfWeek(date) - 7);
      return { from: monday, to: addDays(monday, 6), asOf: addDays(monday, 6) };
    }
    case 'previousMonth': {
      const first = addMonths(makeDate(year, month, 1), -1);
      const last = addDays(makeDate(year, month, 1), -1);
      return { from: first, to: last, asOf: last };
    }
    case 'monthToDate':
      return { from: makeDate(year, month, 1), to: date, asOf: date };
    case 'yearToDate':
      return { from: makeDate(year, 1, 1), to: date, asOf: date };
    case 'previousYear':
      return {
        from: makeDate(year - 1, 1, 1),
        to: makeDate(year - 1, 12, 31),
        asOf: makeDate(year - 1, 12, 31),
      };
  }
}
