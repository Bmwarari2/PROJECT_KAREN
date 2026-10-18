import enGB from './messages/en-GB.json' with { type: 'json' };
import enUS from './messages/en-US.json' with { type: 'json' };
import { currencyExponent, type Money, toDecimalString } from '../money';

export const LOCALES = ['en-GB', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-GB';

type Messages = { [key: string]: string | Messages };

function deepMerge(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    out[k] = typeof v === 'object' && typeof b === 'object' ? deepMerge(b, v) : v;
  }
  return out;
}

/** en-US is stored as a set of overrides on top of en-GB (spelling and terminology differences). */
export const CATALOGUES: Record<Locale, Messages> = {
  'en-GB': enGB as Messages,
  'en-US': deepMerge(enGB as Messages, enUS as Messages),
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

export function resolveLocale(acceptLanguage: string | undefined | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]!.trim();
    if (isLocale(tag)) return tag;
    if (/^en-(US|PR|UM)$/i.test(tag)) return 'en-US';
    if (/^en/i.test(tag)) return 'en-GB';
  }
  return DEFAULT_LOCALE;
}

export function flatten(messages: Messages, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(messages)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

const flatCache = new Map<Locale, Record<string, string>>();

/** Server-side translation with {placeholder} interpolation. */
export function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  let flat = flatCache.get(locale);
  if (!flat) {
    flat = flatten(CATALOGUES[locale]);
    flatCache.set(locale, flat);
  }
  const template = flat[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

// Intl formatters are expensive to construct; long lists (e.g. a 10,000-row rota) reuse cached ones.
const dtfCache = new Map<string, Intl.DateTimeFormat>();
const nfCache = new Map<string, Intl.NumberFormat>();
export function dateTimeFormat(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) dtfCache.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}
export function numberFormat(locale: Locale, opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) nfCache.set(key, (f = new Intl.NumberFormat(locale, opts)));
  return f;
}

export function formatDate(date: string, locale: Locale, style: 'short' | 'medium' | 'long' = 'medium'): string {
  // Calendar dates are formatted in UTC so the civil date never shifts.
  const d = new Date(`${date}T00:00:00Z`);
  return dateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' }).format(d);
}

export function formatDateTime(instant: string, locale: Locale, timeZone: string): string {
  return dateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(instant));
}

/** Formats a wall-clock time 'HH:MM' for the locale (24-hour in en-GB, 12-hour in en-US). */
export function formatTimeOfDay(time: string, locale: Locale): string {
  const [h, m] = time.split(':').map(Number);
  return dateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)));
}

/** Formats an instant's local time of day in a zone. */
export function formatInstantTime(instant: string, locale: Locale, timeZone: string): string {
  return dateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(instant));
}

/** Integer minutes as hours with up to two decimals (display only). */
export function formatHours(minutes: number, locale: Locale): string {
  return numberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(minutes / 60);
}

export function formatNumber(value: number, locale: Locale, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, opts).format(value);
}

/** Formats integer minor units without converting to floating point. */
export function formatMoney(m: Money, locale: Locale): string {
  const digits = currencyExponent(m.currency);
  const nf = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return nf.format(toDecimalString(m) as unknown as number);
}
