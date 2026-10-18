import { addDays, dayOfWeek, today } from '@thapsus/core/time';
import { dateTimeFormat, type Locale } from '@thapsus/core/i18n';

/** The viewer's IANA zone (account setting, else the device). */
export function viewerZone(sessionZone: string | null | undefined): string {
  return sessionZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Start of the workweek containing `date` (ISO weekday, 7 = Sunday). */
export function weekStartOf(date: string, workweekStartsOn = 1): string {
  return addDays(date, -((dayOfWeek(date) - workweekStartsOn + 7) % 7));
}

export function thisWeek(zone: string, workweekStartsOn = 1): string {
  return weekStartOf(today(zone), workweekStartsOn);
}

export const weekDays = (weekStart: string) => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

/** "Mon 15" style column header (formatting only; the civil date never shifts). */
export function dayLabel(date: string, locale: Locale): string {
  return dateTimeFormat(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
export function dayLong(date: string, locale: Locale): string {
  return dateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
