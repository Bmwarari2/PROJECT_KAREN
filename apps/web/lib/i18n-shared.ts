// Client-safe i18n helpers: no message catalogues are imported here, so client bundles stay small.
import { DEFAULT_LOCALE, formatMessage, type Locale } from '@thapsus/core/i18n';

export const LOCALE_COOKIE = 'thr_locale';
export const THEME_COOKIE = 'thr_theme';
export type ThemeChoice = 'system' | 'light' | 'dark';

/** Translates from a flat catalogue slice; `count` selects the plural form (`key_one`, `key_other`, ADR-0151). */
export function translate(
  messages: Record<string, string>,
  key: string,
  vars: Record<string, string | number> = {},
  locale: Locale = DEFAULT_LOCALE,
) {
  return formatMessage(messages, key, vars, locale);
}

export function pickTheme(cookie: string | undefined): ThemeChoice {
  return cookie === 'light' || cookie === 'dark' ? cookie : 'system';
}
