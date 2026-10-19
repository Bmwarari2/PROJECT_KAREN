import { describe, expect, it } from 'vitest';
import enGB from '../src/i18n/messages/en-GB.json';
import enUS from '../src/i18n/messages/en-US.json';
import { CATALOGUES, flatten, formatMessage, lookupMessage, pluralBase, t } from '../src/i18n';

/** Plural forms selected by `count` (ADR-0151). Fictional data only. */
describe('plural forms', () => {
  const messages = {
    'x.reports_one': '{count} report',
    'x.reports_other': '{count} reports',
    'x.plain': 'Plain {name}',
    'x.onlyOther_other': 'Due in {days} days',
    'x.both': 'Both',
    'x.both_one': 'One of both',
  };

  it('picks the form for the count with the locale plural rules', () => {
    expect(formatMessage(messages, 'x.reports', { count: 1 }, 'en-GB')).toBe('1 report');
    expect(formatMessage(messages, 'x.reports', { count: 0 }, 'en-GB')).toBe('0 reports');
    expect(formatMessage(messages, 'x.reports', { count: 2 }, 'en-US')).toBe('2 reports');
    expect(formatMessage(messages, 'x.reports', { count: 1.5 }, 'en-GB')).toBe('1.5 reports');
    expect(formatMessage(messages, 'x.reports', { count: '1' }, 'en-GB')).toBe('1 report');
  });

  it('falls back to the other form, then the plain key, and renders a missing key as itself', () => {
    expect(formatMessage(messages, 'x.onlyOther', { count: 1, days: 1 })).toBe('Due in 1 days');
    // stored notification params from before `count` existed still render
    expect(formatMessage(messages, 'x.onlyOther', { days: 30 })).toBe('Due in 30 days');
    expect(formatMessage(messages, 'x.reports', {})).toBe('{count} reports');
    expect(formatMessage(messages, 'x.plain', { count: 1, name: 'A' })).toBe('Plain A');
    expect(formatMessage(messages, 'x.both', { count: 1 })).toBe('One of both');
    expect(formatMessage(messages, 'x.both', { count: 3 })).toBe('Both');
    expect(formatMessage(messages, 'x.both')).toBe('Both');
    expect(formatMessage(messages, 'x.missing', { count: 1 })).toBe('x.missing');
    expect(lookupMessage(messages, 'x.missing', {}, 'en-GB')).toBeUndefined();
    // a count that is not a number does not pick a form
    expect(formatMessage(messages, 'x.reports', { count: 'many' })).toBe('many reports');
  });

  it('maps plural keys to their base key', () => {
    expect(pluralBase('org.reports_one')).toBe('org.reports');
    expect(pluralBase('org.reports_other')).toBe('org.reports');
    expect(pluralBase('auth.signIn.title')).toBe('auth.signIn.title');
    expect(pluralBase('privacy.ui.retention.on_hold')).toBe('privacy.ui.retention.on_hold');
  });

  it('the server translator uses them (en-GB and en-US)', () => {
    expect(t('en-GB', 'org.reports', { count: 1 })).toBe('1 report');
    expect(t('en-GB', 'org.reports', { count: 4 })).toBe('4 reports');
    expect(t('en-US', 'integrations.ruleLicences', { count: 1 })).toBe('1 license');
    expect(t('en-GB', 'integrations.ruleLicences', { count: 2 })).toBe('2 licences');
    expect(t('en-GB', 'notify.closureReminder', { count: 1, days: 1 })).toBe('Your account will be closed and deleted in 1 day');
    expect(t('en-GB', 'notify.closureReminder', { days: 7 })).toBe('Your account will be closed and deleted in 7 days');
  });

  it('every plural family has an _other form, in both catalogues', () => {
    for (const locale of ['en-GB', 'en-US'] as const) {
      const flat = flatten(CATALOGUES[locale]);
      const bases = new Set(Object.keys(flat).filter((k) => k !== pluralBase(k)).map(pluralBase));
      const incomplete = [...bases].filter((b) => flat[`${b}_other`] === undefined || flat[b] !== undefined);
      expect(incomplete, locale).toEqual([]);
    }
  });
});

/**
 * Plural sweep: a number interpolated next to an English plural noun ("{days} days", "{n} items",
 * "({count} device(s))") reads wrongly for 1 unless the message is a plural family. This fails when a
 * message has a {placeholder} immediately followed by a plural noun (optionally after one adjective:
 * "{count} US employees") or immediately preceded by one ("Shifts {n}") without plural forms.
 * A label ending in a colon ("Swap requests: {n}") reads correctly for every number and is allowed.
 */
const IRREGULAR = new Set(['people', 'children', 'men', 'women', 'data']);
/** Words ending in -s after a placeholder that are verbs or not nouns: "{title} expires", "{name} gains". */
const NOT_PLURAL_NOUNS = new Set(['expires', 'gains', 'ends', 'transfers', 'applies', 'starts', 'needs', 'takes', 'uses', 'means', 'does', 'goes', 'runs', 'always', 'perhaps', 'unless', 'across', 'towards', 'afterwards', 'serves', 'covers', 'ms', 'mins', 'hrs', 'yes']);
/** After a placeholder these words end the noun phrase ("{open} of {total}", "{n} or more"). */
const STOP = new Set(['of', 'to', 'or', 'and', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'for', 'on', 'in', 'by', 'at', 'with', 'within', 'from', 'could', 'would', 'will', 'can', 'the', 'a', 'an', 'per', 'as', 'than', ...NOT_PLURAL_NOUNS]);
const isPluralNoun = (w: string) => {
  const word = w.toLowerCase();
  if (/\(s\)$/.test(word)) return true;
  if (IRREGULAR.has(word)) return true;
  return /^[a-z]{3,}s$/.test(word) && !/(ss|us|is|ous)$/.test(word) && !NOT_PLURAL_NOUNS.has(word);
};

/**
 * Messages the check flags that are not a count next to a noun. Each needs a reason.
 */
const ALLOWLIST: Record<string, string> = {
  'compliance.coverage.psl': '{answeredBy} is a jurisdiction name ("California rules apply"), not a number',
  'access.editor.allInArea': '{area} is a permission area name ("All Leave permissions")',
  'access.editor.allInGroup': '{group} is a field group name ("All Pay fields")',
  'developers.params': '{params} is a list of parameter names',
  'developers.responses': '{codes} is a list of status codes',
  'privacy.ui.incidents.audience.individuals': '{jurisdiction} is a place name ("California affected people")',
};

export function pluralProblems(messages: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, text] of Object.entries(messages)) {
    if (key !== pluralBase(key) || ALLOWLIST[key]) continue;
    for (const m of text.matchAll(/\{(\w+)\}/g)) {
      const after = text.slice(m.index + m[0].length).match(/^\s*\(?([A-Za-z']+(?:\(s\))?)(?:\s+([A-Za-z']+(?:\(s\))?))?/);
      const before = text.slice(0, m.index).match(/([A-Za-z']+(?:\(s\))?)\s+$/);
      const w1 = after?.[1]?.replace(/'$/, '');
      const w2 = after?.[2]?.replace(/'$/, '');
      const near = (w1 && isPluralNoun(w1) && w1) || (w1 && w2 && !STOP.has(w1.toLowerCase()) && isPluralNoun(w2) && w2) || (before && isPluralNoun(before[1]!) && before[1]);
      if (near) out.push(`${key}: "${text.replace(/\s+/g, ' ').slice(0, 100)}" ({${m[1]}} next to "${near}")`);
    }
  }
  return out;
}

describe('plural sweep', () => {
  it('flags a count next to a plural noun', () => {
    expect(pluralProblems({ a: '{n} days left', b: 'Sent to {count} device(s).', c: '{count} US employees', d: 'Shifts {n}', e: '{people} fictional people' })).toHaveLength(5);
    expect(pluralProblems({ a: '{days}-day trial', b: 'Swap requests: {n}', c: '{title} expires on {date}', d: '{n} or more spells', e_one: '{n} day', f: 'Past 30 days ({count})', g: '{open} of {total}' })).toEqual([]);
  });

  it.each([
    ['en-GB', enGB],
    ['en-US', enUS],
  ])('no %s message puts a count next to a plural noun without plural forms', (_locale, catalogue) => {
    const problems = pluralProblems(flatten(catalogue));
    expect(problems, `Use plural forms (key_one / key_other selected by count) or formatUnit:\n${problems.join('\n')}`).toEqual([]);
  });

  it('every allowlisted message still exists', () => {
    const gb = flatten(enGB);
    expect(Object.keys(ALLOWLIST).filter((k) => gb[k] === undefined)).toEqual([]);
  });
});
