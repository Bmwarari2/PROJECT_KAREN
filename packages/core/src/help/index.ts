import data from './articles.json' with { type: 'json' };
import { PERMISSION_KEYS } from '../access';
import {
  allows,
  CAPABILITIES,
  isCapabilityKey,
  namedPermissions,
  type CapabilityKey,
  type CapabilityViewer,
} from '../capabilities';
import { LOCALES, type Locale } from '../i18n';

/**
 * In-app help centre (ADR-0108). Articles are versioned, localised content in the repo
 * (`articles.json`) and are searched with a small in-memory inverted index (no third party, no
 * personal data). Contextual links map app paths to articles.
 *
 * Help by feature (ADR-0190): every article declares the features (capabilities of the permission
 * map) and the permissions it covers, and optionally the countries it applies to. A reader sees it only
 * when they can see all of those features (each on for the workspace) and hold all of those
 * permissions, and the workspace has a legal entity in one of its countries. Only a small general set
 * (signing in, accounts) has no feature. The same filter serves the help centre, search, Ask HR's
 * suggestions and the in-page help links.
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
  /** Capabilities of the permission map the article describes: the reader must be able to see them all. */
  features: string[];
  /** Permissions the article describes, each named by one of its features: the reader must hold them all. */
  permissions: string[];
  /** ISO 3166-1 alpha-2 countries the article applies to (a legal entity in one of them); absent: any. */
  countries?: string[];
  /** One of the general articles (signing in, accounts), the only ones without a feature. */
  general?: boolean;
  locales: Record<Locale, HelpArticleText>;
}

/** The general articles: about signing in and the reader's own account, for everyone. */
export const GENERAL_HELP_SLUGS: readonly string[] = ['resetting-sign-in', 'signing-in'];

/** A test of the reader's permissions (wildcards included), as the workspace map and the API use. */
export type CanRead = (permission: string) => boolean;

/**
 * Who is reading: their permissions, the capabilities they can see (with the workspace's features and
 * Ask HR applied) and the countries of the workspace's legal entities. Unknown countries (undefined)
 * show no country-specific article.
 */
export interface HelpReader {
  can: CanRead;
  capability: (key: CapabilityKey) => boolean;
  countries?: readonly string[];
}

/** A reader from what the permission map knows about the viewer, and the workspace's entity countries. */
export function helpReader(viewer: CapabilityViewer, countries?: readonly string[]): HelpReader {
  return { can: viewer.has, capability: (k) => allows(viewer, k), countries };
}

/** Whether this reader may read the article (no reader: everyone, for tooling). */
export function canReadArticle(
  a: Pick<HelpArticle, 'features' | 'permissions' | 'countries'>,
  reader?: HelpReader,
): boolean {
  if (!reader) return true;
  return (
    a.features.every((f) => isCapabilityKey(f) && reader.capability(f)) &&
    a.permissions.every((p) => reader.can(p)) &&
    (!a.countries?.length || a.countries.some((c) => reader.countries?.includes(c)))
  );
}
export interface HelpArticleView extends HelpArticleText {
  slug: string;
  version: number;
  updatedOn: string;
  contexts: string[];
}

export const HELP_ARTICLES: readonly HelpArticle[] = (data as { articles: HelpArticle[] }).articles;

const KNOWN_FIELDS = new Set([
  'slug',
  'version',
  'updatedOn',
  'contexts',
  'features',
  'permissions',
  'countries',
  'general',
  'locales',
]);

export function validateHelpArticles(articles: readonly HelpArticle[] = HELP_ARTICLES): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const a of articles) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug)) problems.push(`${a.slug}: invalid slug`);
    if (slugs.has(a.slug)) problems.push(`${a.slug}: duplicate slug`);
    slugs.add(a.slug);
    for (const k of Object.keys(a))
      if (!KNOWN_FIELDS.has(k))
        problems.push(
          `${a.slug}: unknown field ${k} (declare features and permissions instead of an audience)`,
        );
    if (!Number.isSafeInteger(a.version) || a.version < 1)
      problems.push(`${a.slug}: version must be a positive integer`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.updatedOn)) problems.push(`${a.slug}: updatedOn must be a date`);
    if (!a.contexts.length || !a.contexts.every((c) => c.startsWith('/app')))
      problems.push(`${a.slug}: contexts must be app paths`);
    if (!Array.isArray(a.features)) problems.push(`${a.slug}: features must be a list of capabilities`);
    else
      for (const f of a.features)
        if (!isCapabilityKey(f))
          problems.push(`${a.slug}: unknown feature ${f} (a capability of the permission map)`);
    if (!Array.isArray(a.permissions)) problems.push(`${a.slug}: permissions must be a list`);
    else {
      const named = new Set(
        (a.features ?? []).filter(isCapabilityKey).flatMap((f) => namedPermissions(CAPABILITIES[f])),
      );
      for (const perm of a.permissions) {
        if (!PERMISSION_KEYS.includes(perm)) problems.push(`${a.slug}: unknown permission ${perm}`);
        else if (!named.has(perm))
          problems.push(`${a.slug}: permission ${perm} is not named by any of its features`);
      }
    }
    // only the small general set (signing in, accounts) has no feature
    const general = GENERAL_HELP_SLUGS.includes(a.slug);
    if (a.general && !general) problems.push(`${a.slug}: only ${GENERAL_HELP_SLUGS.join(', ')} are general`);
    if (general && !a.general) problems.push(`${a.slug}: a general article is marked general`);
    if (a.general && (a.features?.length || a.permissions?.length))
      problems.push(`${a.slug}: a general article has no features or permissions`);
    if (!a.general && !a.features?.length)
      problems.push(`${a.slug}: every article but the general ones has a feature`);
    if (a.countries !== undefined && (!a.countries.length || !a.countries.every((c) => /^[A-Z]{2}$/.test(c))))
      problems.push(`${a.slug}: countries must be ISO 3166-1 alpha-2 codes`);
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

/** One article, or undefined when it does not exist or is not for this reader. */
export function helpArticle(slug: string, locale: Locale, reader?: HelpReader): HelpArticleView | undefined {
  const a = HELP_ARTICLES.find((x) => x.slug === slug);
  return a && canReadArticle(a, reader) ? view(a, locale) : undefined;
}

/** Every article this reader may read. */
export function helpArticles(locale: Locale, reader?: HelpReader): HelpArticleView[] {
  return HELP_ARTICLES.filter((a) => canReadArticle(a, reader)).map((a) => view(a, locale));
}

/**
 * Articles linked from an app path that this reader may read: exact path first, then the closest
 * parent path with an article for them.
 */
export function articlesForContext(path: string, locale: Locale, reader?: HelpReader): HelpArticleView[] {
  const clean = path.split('?')[0]!.replace(/\/+$/, '') || '/app';
  const parts = clean.split('/');
  for (let i = parts.length; i >= 2; i--) {
    const prefix = parts.slice(0, i).join('/');
    const hits = HELP_ARTICLES.filter((a) => a.contexts.includes(prefix) && canReadArticle(a, reader));
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
export function searchHelp(
  query: string,
  locale: Locale,
  limit = 10,
  reader?: HelpReader,
): HelpArticleView[] {
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
  const readable = new Set(HELP_ARTICLES.filter((a) => canReadArticle(a, reader)).map((a) => a.slug));
  return [...(scores ?? new Map<string, number>())]
    .filter(([slug]) => readable.has(slug))
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, limit)
    .map(([slug]) => helpArticle(slug, locale)!);
}
