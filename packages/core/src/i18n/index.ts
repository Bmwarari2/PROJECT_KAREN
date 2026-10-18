import { currencyExponent, type Money, toDecimalString } from '../money';

export const LOCALES = ['en-GB', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-GB';

// The catalogues live in their own module so client bundles that only format dates and money
// never include them (the package is side-effect free).
export { CATALOGUES, flatten, t, type Messages } from './catalogues';

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

export function formatDate(date: string, locale: Locale, style: 'short' | 'medium' | 'long' = 'medium'): string {
  // Calendar dates are formatted in UTC so the civil date never shifts.
  const d = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' }).format(d);
}

export function formatDateTime(instant: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(instant));
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
