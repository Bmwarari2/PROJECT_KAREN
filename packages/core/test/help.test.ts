import { describe, expect, it } from 'vitest';
import { articlesForContext, HELP_ARTICLES, helpArticle, searchHelp, stem, tokenize, validateHelpArticles } from '../src/help';

describe('help centre content', () => {
  it('every article is versioned, linked from app pages and localised in en-GB and en-US', () => {
    expect(validateHelpArticles()).toEqual([]);
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(6);
    expect(validateHelpArticles([{ ...HELP_ARTICLES[0]!, version: 0, locales: { 'en-GB': HELP_ARTICLES[0]!.locales['en-GB'] } as never }])).toEqual(
      expect.arrayContaining([expect.stringMatching(/version/), expect.stringMatching(/missing en-US/)]),
    );
  });

  it('serves the locale variant', () => {
    expect(helpArticle('plans-and-billing', 'en-GB')!.title).toMatch(/cancelling/);
    expect(helpArticle('plans-and-billing', 'en-US')!.title).toMatch(/canceling/);
    expect(helpArticle('nope', 'en-GB')).toBeUndefined();
  });

  it('links articles to the page they help with (closest parent path)', () => {
    expect(articlesForContext('/app/time-off', 'en-GB').map((a) => a.slug)).toContain('requesting-time-off');
    expect(articlesForContext('/app/people/123?tab=job', 'en-GB').map((a) => a.slug)).toEqual(['adding-people']);
    expect(articlesForContext('/app/unknown-page', 'en-GB').map((a) => a.slug)).toEqual(['getting-started']);
  });
});

describe('help search (local index)', () => {
  it('tokenises with light stemming and UK/US spelling folding', () => {
    expect(stem('cancelling')).toBe(stem('canceling'));
    expect(stem('organisation')).toBe(stem('organization'));
    expect(tokenize('How do I request time off?')).toEqual(['request', 'time', 'off']);
  });

  it('ranks title matches first and requires every term', () => {
    expect(searchHelp('time off', 'en-GB')[0]!.slug).toBe('requesting-time-off');
    expect(searchHelp('cancel plan', 'en-US')[0]!.slug).toBe('plans-and-billing');
    expect(searchHelp('passkey', 'en-GB')[0]!.slug).toBe('security-and-sign-in');
    expect(searchHelp('support access revoke', 'en-GB').map((a) => a.slug)).toEqual(['support-access']);
    expect(searchHelp('zzzz nothing', 'en-GB')).toEqual([]);
    expect(searchHelp('   ', 'en-GB')).toEqual([]);
  });

  it('matches the last term as a prefix while typing', () => {
    expect(searchHelp('timesh', 'en-GB').map((a) => a.slug)).toContain('rotas-and-clocking-in');
  });
});
