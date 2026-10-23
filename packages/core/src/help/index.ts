import data from './articles.json' with { type: 'json' };
import { LOCALES, type Locale } from '../i18n';

/**
 * In-app help centre (ADR-0108). Articles are versioned, localised content in the repo
 * (`articles.json`) and are searched with a small in-memory inverted index (no third party, no
 * personal data). Contextual links map app paths to articles.
 */
export interface HelpArticleText {
  title: string;
  summary: string;
  body: string[];
}
export interface HelpArticle {
  slug: string;
  version: number;
  updatedOn: string;
  contexts: string[];
  locales: Record<Locale, HelpArticleText>;
}
export interface HelpArticleView extends HelpArticleText {
  slug: string;
  version: number;
  updatedOn: string;
  contexts: string[];
}

export const HELP_ARTICLES: readonly HelpArticle[] = (data as { articles: HelpArticle[] }).articles;

export function validateHelpArticles(articles: readonly HelpArticle[] = HELP_ARTICLES): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const a of articles) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug)) problems.push(`${a.slug}: invalid slug`);
    if (slugs.has(a.slug)) problems.push(`${a.slug}: duplicate slug`);
    slugs.add(a.slug);
    if (!Number.isSafeInteger(a.version) || a.version < 1)
      problems.push(`${a.slug}: version must be a positive integer`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.updatedOn)) problems.push(`${a.slug}: updatedOn must be a date`);
    if (!a.contexts.length || !a.contexts.every((c) => c.startsWith('/app')))
      problems.push(`${a.slug}: contexts must be app paths`);
    for (const l of LOCALES) {
      const t = a.locales[l];
      if (!t?.title || !t.summary || !t.body?.length) problems.push(`${a.slug}: missing ${l} text`);
    }
  }
  return problems;
}

const view = (a: HelpArticle, locale: Locale): HelpArticleView => ({
  slug: a.slug,
  version: a.version,
  updatedOn: a.updatedOn,
  contexts: a.contexts,
  ...a.locales[locale],
});

export function helpArticle(slug: string, locale: Locale): HelpArticleView | undefined {
  const a = HELP_ARTICLES.find((x) => x.slug === slug);
  return a ? view(a, locale) : undefined;
}

export function helpArticles(locale: Locale): HelpArticleView[] {
  return HELP_ARTICLES.map((a) => view(a, locale));
}

/** Articles linked from an app path: exact path first, then the closest parent path. */
export function articlesForContext(path: string, locale: Locale): HelpArticleView[] {
  const clean = path.split('?')[0]!.replace(/\/+$/, '') || '/app';
  const parts = clean.split('/');
  for (let i = parts.length; i >= 2; i--) {
    const prefix = parts.slice(0, i).join('/');
    const hits = HELP_ARTICLES.filter((a) => a.contexts.includes(prefix));
    if (hits.length) return hits.map((a) => view(a, locale));
  }
  return [];
}

// ---- search: tokenise, light stemming, weighted inverted index per locale ---------------------------
const STOP = new Set([
  'a',
  'an',
  'and',
  'the',
  'to',
  'of',
  'in',
  'on',
  'for',
  'or',
  'is',
  'it',
  'my',
  'how',
  'do',
  'i',
  'you',
  'your',
  'can',
  'what',
  'with',
  'from',
  'at',
  'be',
  'by',
]);

export function stem(word: string): string {
  let w = word;
  for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = suffix === 'ies' ? `${w.slice(0, -3)}y` : w.slice(0, -suffix.length);
      break;
    }
  }
  // fold common UK/US spelling pairs so either finds both
  return w
    .replace(/isation$|ization$/, 'ize')
    .replace(/ise$/, 'ize')
    .replace(/our$/, 'or')
    .replace(/ll$/, 'l');
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

type Index = Map<string, Map<string, number>>;
const indexes = new Map<Locale, Index>();
const WEIGHTS = { title: 5, summary: 3, body: 1 } as const;

function indexFor(locale: Locale): Index {
  let idx = indexes.get(locale);
  if (idx) return idx;
  idx = new Map();
  for (const a of HELP_ARTICLES) {
    const t = a.locales[locale];
    const add = (text: string, weight: number) => {
      for (const tok of tokenize(text)) {
        const postings = idx!.get(tok) ?? new Map<string, number>();
        postings.set(a.slug, (postings.get(a.slug) ?? 0) + weight);
        idx!.set(tok, postings);
      }
    };
    add(t.title, WEIGHTS.title);
    add(t.summary, WEIGHTS.summary);
    for (const p of t.body) add(p, WEIGHTS.body);
  }
  indexes.set(locale, idx);
  return idx;
}

/**
 * Ranked search. Every query term must match (exactly, or as a prefix for the last term so results
 * appear while typing); ties keep the article order.
 */
export function searchHelp(query: string, locale: Locale, limit = 10): HelpArticleView[] {
  const terms = tokenize(query.slice(0, 200));
  if (!terms.length) return [];
  const idx = indexFor(locale);
  let scores: Map<string, number> | null = null;
  terms.forEach((term, i) => {
    const matched = new Map<string, number>();
    for (const [tok, postings] of idx) {
      const hit = tok === term || (i === terms.length - 1 && term.length >= 2 && tok.startsWith(term));
      if (!hit) continue;
      for (const [slug, w] of postings)
        matched.set(slug, Math.max(matched.get(slug) ?? 0, tok === term ? w * 2 : w));
    }
    if (scores === null) scores = matched;
    else {
      const prev: Map<string, number> = scores;
      scores = new Map(
        [...prev].filter(([slug]) => matched.has(slug)).map(([slug, s]) => [slug, s + matched.get(slug)!]),
      );
    }
  });
  const order = HELP_ARTICLES.map((a) => a.slug);
  return [...(scores ?? new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, limit)
    .map(([slug]) => helpArticle(slug, locale)!);
}
