import enGB from './messages/en-GB.json' with { type: 'json' };
import enUS from './messages/en-US.json' with { type: 'json' };
import type { Locale } from './index';
import { formatMessage, type MessageVars } from './format';

export type Messages = { [key: string]: string | Messages };

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

/** Server-side translation with {placeholder} interpolation and plural forms (`count`, ADR-0151). */
export function t(locale: Locale, key: string, vars: MessageVars = {}): string {
  let flat = flatCache.get(locale);
  if (!flat) {
    flat = flatten(CATALOGUES[locale]);
    flatCache.set(locale, flat);
  }
  return formatMessage(flat, key, vars, locale);
}
