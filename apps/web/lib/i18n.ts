import { CATALOGUES, DEFAULT_LOCALE, flatten, isLocale, resolveLocale, type Locale } from '@thapsus/core/i18n';

export { LOCALE_COOKIE, THEME_COOKIE, pickTheme, translate, type ThemeChoice } from './i18n-shared';

const flat = new Map<Locale, Record<string, string>>();
export function messagesFor(locale: Locale): Record<string, string> {
  let m = flat.get(locale);
  if (!m) {
    m = flatten(CATALOGUES[locale]);
    flat.set(locale, m);
  }
  return m;
}

export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  return acceptLanguage ? resolveLocale(acceptLanguage) : DEFAULT_LOCALE;
}

