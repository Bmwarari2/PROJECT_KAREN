import {
  CATALOGUES,
  DEFAULT_LOCALE,
  flatten,
  isLocale,
  pluralBase,
  resolveLocale,
  type Locale,
} from '@thapsus/core/i18n';

export { LOCALE_COOKIE, THEME_COOKIE, pickTheme, translate, type ThemeChoice } from './i18n-shared';

const flat = new Map<Locale, Record<string, string>>();
/** The whole flattened catalogue, for translating on the server. Never pass it to a client component (ADR-0150). */
export function messagesFor(locale: Locale): Record<string, string> {
  let m = flat.get(locale);
  if (!m) {
    m = flatten(CATALOGUES[locale]);
    flat.set(locale, m);
  }
  return m;
}

/**
 * Whether a key belongs to one of the namespaces: `ns` selects every key under it, `ns.*` only the
 * messages directly in `ns` (not its groups), and a full key selects itself and its plural forms.
 */
export function inNamespaces(key: string, namespaces: readonly string[]): boolean {
  const k = pluralBase(key); // `org.reports_one` belongs wherever `org.reports` does
  return namespaces.some((ns) =>
    ns.endsWith('.*')
      ? k.startsWith(ns.slice(0, -1)) && !k.slice(ns.length - 1).includes('.')
      : k === ns || k.startsWith(`${ns}.`),
  );
}

const scoped = new Map<string, Record<string, string>>();
/** The part of the catalogue a route segment sends to client components (cached per locale and namespace list). */
export function scopedMessages(locale: Locale, namespaces: readonly string[]): Record<string, string> {
  const id = `${locale}|${namespaces.join(',')}`;
  let m = scoped.get(id);
  if (!m) {
    m = Object.fromEntries(Object.entries(messagesFor(locale)).filter(([k]) => inNamespaces(k, namespaces)));
    scoped.set(id, m);
  }
  return m;
}

export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  return acceptLanguage ? resolveLocale(acceptLanguage) : DEFAULT_LOCALE;
}
