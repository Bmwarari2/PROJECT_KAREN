import type { Locale } from './index';

/**
 * Message lookup and {placeholder} interpolation, shared by the server `t()` and the web client's
 * translator (this module holds no catalogue, so client bundles stay small).
 *
 * Plurals (ADR-0151): a message whose wording depends on a number is stored as plural forms with
 * ICU/CLDR category suffixes, `key_one` and `key_other` (and `_zero`, `_two`, `_few`, `_many` for
 * locales that have them). Call `t('org.reports', { count: n })`: the `count` variable picks the form
 * with `Intl.PluralRules` for the locale and falls back to `_other`. Without a numeric `count` the
 * plain key is used, or the `_other` form when only plural forms exist (so a stored notification
 * whose params predate `count` still renders its old, plural wording).
 */
export type MessageVars = Record<string, string | number>;

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_SUFFIX = new RegExp(`_(?:${PLURAL_CATEGORIES.join('|')})$`);

/** `org.reports_one` → `org.reports`; any other key unchanged. */
export const pluralBase = (key: string) => key.replace(PLURAL_SUFFIX, '');

const rulesCache = new Map<string, Intl.PluralRules>();
function pluralRules(locale: Locale): Intl.PluralRules {
  let r = rulesCache.get(locale);
  if (!r) rulesCache.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

function countOf(vars: MessageVars): number | null {
  const c = vars.count;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) return Number(c);
  return null;
}

/** The template for a key (choosing the plural form when the key has them), or undefined when missing. */
export function lookupMessage(
  messages: Readonly<Record<string, string>>,
  key: string,
  vars: MessageVars,
  locale: Locale,
): string | undefined {
  const count = countOf(vars);
  if (count !== null) {
    const form = messages[`${key}_${pluralRules(locale).select(count)}`] ?? messages[`${key}_other`];
    if (form !== undefined) return form;
  }
  return messages[key] ?? messages[`${key}_other`];
}

export function interpolate(template: string, vars: MessageVars): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/** Translates a key from a flat catalogue; a missing key renders as the key itself. */
export function formatMessage(
  messages: Readonly<Record<string, string>>,
  key: string,
  vars: MessageVars = {},
  locale: Locale = 'en-GB',
): string {
  const template = lookupMessage(messages, key, vars, locale);
  return template === undefined ? key : interpolate(template, vars);
}
