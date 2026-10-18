import { CATALOGUES, DEFAULT_LOCALE, flatten, isLocale, resolveLocale, type Locale } from '@thapsus/core/i18n';

export const LOCALE_COOKIE = 'thr_locale';
export const THEME_COOKIE = 'thr_theme';
export type ThemeChoice = 'system' | 'light' | 'dark';

const flat = new Map<Locale, Record<string, string>>();
export function messagesFor(locale: Locale): Record<string, string> {
  let m = flat.get(locale);
  if (!m) {
    m = flatten(CATALOGUES[locale]);
    flat.set(locale, m);
  }
  return m;
}

export function translate(messages: Record<string, string>, key: string, vars: Record<string, string | number> = {}) {
  const template = messages[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? `{${n}}`));
}

export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  return acceptLanguage ? resolveLocale(acceptLanguage) : DEFAULT_LOCALE;
}

export function pickTheme(cookie: string | undefined): ThemeChoice {
  return cookie === 'light' || cookie === 'dark' ? cookie : 'system';
}
