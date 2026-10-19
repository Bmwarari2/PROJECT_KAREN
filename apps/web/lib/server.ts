import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, THEME_COOKIE, messagesFor, pickLocale, pickTheme, translate } from './i18n';

/** Locale, theme and a translator (whole catalogue) for server components. */
export async function serverContext() {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const locale = pickLocale(c.get(LOCALE_COOKIE)?.value, h.get('accept-language'));
  const theme = pickTheme(c.get(THEME_COOKIE)?.value);
  const messages = messagesFor(locale);
  return { locale, theme, t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars) };
}
