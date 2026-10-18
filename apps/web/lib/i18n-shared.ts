// Client-safe i18n helpers: no message catalogues are imported here, so client bundles stay small.
export const LOCALE_COOKIE = 'thr_locale';
export const THEME_COOKIE = 'thr_theme';
export type ThemeChoice = 'system' | 'light' | 'dark';

export function translate(messages: Record<string, string>, key: string, vars: Record<string, string | number> = {}) {
  const template = messages[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? `{${n}}`));
}

export function pickTheme(cookie: string | undefined): ThemeChoice {
  return cookie === 'light' || cookie === 'dark' ? cookie : 'system';
}
