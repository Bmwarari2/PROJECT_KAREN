import { describe, expect, it } from 'vitest';
import {
  articlesForContext,
  GENERAL_HELP_SLUGS,
  HELP_ARTICLES,
  helpArticle,
  helpArticles,
  helpReader,
  searchHelp,
  stem,
  tokenize,
  validateHelpArticles,
} from '../src/help';
import { allows, hasFromGrants, PAGES, type CapabilityKey } from '../src/capabilities';
import { FEATURE_KEYS, type FeatureKey } from '../src/features';
import { BUILT_IN_ROLES } from '../src/roles';

describe('help centre content', () => {
  it('every article is versioned, linked from app pages and localised in en-GB and en-US', () => {
    expect(validateHelpArticles()).toEqual([]);
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(6);
    expect(
      validateHelpArticles([
        {
          ...HELP_ARTICLES[0]!,
          version: 0,
          locales: { 'en-GB': HELP_ARTICLES[0]!.locales['en-GB'] } as never,
        },
      ]),
    ).toEqual(
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
    expect(articlesForContext('/app/people/123?tab=job', 'en-GB').map((a) => a.slug)).toEqual([
      'adding-people',
    ]);
    expect(articlesForContext('/app/unknown-page', 'en-GB').map((a) => a.slug)).toEqual([
      'getting-started',
      'signing-in',
    ]);
  });
});

/**
 * Help by feature (PROGRESS 16.4, ADR-0190): every article declares the features and permissions it
 * covers; a reader sees it only when they can see all of them, each feature is on for the workspace and
 * the country applies. The same reader filters the help centre, search, Ask HR's suggestions and the
 * in-page help links (all of them go through helpArticles, searchHelp and articlesForContext).
 */
const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<FeatureKey, boolean>;
function readerFor(
  roleKey: string,
  opts: { features?: Partial<Record<FeatureKey, boolean>>; countries?: string[]; askHr?: boolean } = {},
) {
  const role = BUILT_IN_ROLES.find((r) => r.key === roleKey)!;
  const viewer = {
    has: hasFromGrants(role.permissions),
    employeeId: 'e-1',
    features: opts.features ?? ALL_ON,
    askHr: opts.askHr ?? true,
  };
  return { viewer, reader: helpReader(viewer, opts.countries ?? ['GB', 'US']) };
}
const slugs = (xs: Array<{ slug: string }>) => xs.map((a) => a.slug);

describe('help by feature (ADR-0190)', () => {
  it('every article declares features and permissions; only the general set has no feature', () => {
    for (const a of HELP_ARTICLES) {
      expect(Array.isArray(a.features), a.slug).toBe(true);
      expect(Array.isArray(a.permissions), a.slug).toBe(true);
      if (GENERAL_HELP_SLUGS.includes(a.slug)) expect(a.features, a.slug).toEqual([]);
      else expect(a.features.length, a.slug).toBeGreaterThan(0);
    }
    expect(GENERAL_HELP_SLUGS).toEqual(['resetting-sign-in', 'signing-in']);
    const base = HELP_ARTICLES.find((a) => a.slug === 'plans-and-billing')!;
    const problems = validateHelpArticles([
      { ...base, slug: 'no-feature', features: [], permissions: [] },
      { ...base, slug: 'fake-general', general: true, features: [], permissions: [] },
      { ...base, slug: 'unknown-feature', features: ['billing.everything'] },
      { ...base, slug: 'stray-permission', permissions: ['payroll.read'] },
      { ...base, slug: 'bad-country', countries: ['usa'] },
      { ...base, slug: 'old-audience', audience: ['billing.manage'] } as never,
    ]);
    expect(problems).toEqual(
      expect.arrayContaining([
        'no-feature: every article but the general ones has a feature',
        'fake-general: only resetting-sign-in, signing-in are general',
        expect.stringMatching(/^unknown-feature: unknown feature billing\.everything/),
        'stray-permission: permission payroll.read is not named by any of its features',
        'bad-country: countries must be ISO 3166-1 alpha-2 codes',
        expect.stringMatching(/^old-audience: unknown field audience/),
      ]),
    );
  });

  it('for every role, every article shown describes features that role can see in its navigation', () => {
    for (const role of BUILT_IN_ROLES) {
      const { viewer, reader } = readerFor(role.key);
      const shown = helpArticles('en-GB', reader);
      expect(shown.length, role.key).toBeGreaterThanOrEqual(GENERAL_HELP_SLUGS.length);
      for (const view of shown) {
        const a = HELP_ARTICLES.find((x) => x.slug === view.slug)!;
        for (const f of a.features) {
          // the feature is the role's: allowed by the map, and some page the role may open is about it
          expect(allows(viewer, f as CapabilityKey), `${role.key} ${a.slug} ${f}`).toBe(true);
          const pages = PAGES.filter((p) => p.view === f || p.manage === f);
          expect(pages.length, `${a.slug}: ${f} is no page's capability`).toBeGreaterThan(0);
          expect(
            pages.some((p) => allows(viewer, p.view)),
            `${role.key} cannot open a page for ${a.slug} (${f})`,
          ).toBe(true);
        }
        for (const p of a.permissions) expect(viewer.has(p), `${role.key} ${a.slug} ${p}`).toBe(true);
      }
      // and the general articles are for everyone
      for (const g of GENERAL_HELP_SLUGS) expect(slugs(shown), role.key).toContain(g);
    }
  });

  it('shows admin articles to admins only, and IT articles to IT admins', () => {
    const employee = slugs(helpArticles('en-GB', readerFor('employee').reader));
    expect(employee).toEqual(
      expect.arrayContaining(['requesting-time-off', 'notifications', 'contacting-hr', 'signing-in']),
    );
    for (const s of [
      'getting-started',
      'adding-people',
      'plans-and-billing',
      'security-and-sign-in',
      'devices-and-access',
    ])
      expect(employee, s).not.toContain(s);
    expect(slugs(helpArticles('en-GB', readerFor('it_admin').reader))).toContain('devices-and-access');
    expect(slugs(helpArticles('en-GB', readerFor('hr_admin').reader))).not.toContain('devices-and-access');
    expect(slugs(helpArticles('en-GB', readerFor('hr_admin').reader))).not.toContain('custom-branding');
    expect(slugs(helpArticles('en-GB', readerFor('owner').reader))).toContain('custom-branding');
  });

  it('hides articles whose feature is off for the workspace', () => {
    const owner = (features: Partial<Record<FeatureKey, boolean>>, askHr = true) =>
      slugs(
        helpArticles('en-GB', readerFor('owner', { features: { ...ALL_ON, ...features }, askHr }).reader),
      );
    expect(owner({})).toEqual(expect.arrayContaining(['ask-hr', 'custom-branding']));
    expect(owner({ customBranding: false })).not.toContain('custom-branding');
    expect(owner({ aiAssistant: false })).not.toContain('ask-hr');
    // Ask HR also needs the customer's own opt-in, which the API resolves into askHr
    expect(owner({}, false)).not.toContain('ask-hr');
  });

  it('shows country articles only where the workspace has a legal entity in that country', () => {
    const hr = (countries: string[]) =>
      slugs(helpArticles('en-GB', readerFor('hr_admin', { countries }).reader));
    expect(hr(['GB'])).toContain('right-to-work-checks');
    expect(hr(['GB'])).not.toContain('form-i9');
    expect(hr(['US'])).toContain('form-i9');
    expect(hr(['US'])).not.toContain('right-to-work-checks');
    expect(hr(['GB', 'US'])).toEqual(expect.arrayContaining(['form-i9', 'right-to-work-checks']));
  });

  it('applies the same filter to search and to the in-page help links', () => {
    const { reader } = readerFor('employee');
    expect(slugs(searchHelp('cancel plan', 'en-GB', 10, reader))).toEqual([]);
    expect(helpArticle('plans-and-billing', 'en-GB', reader)).toBeUndefined();
    // the in-page link on a page the employee cannot use falls back to a general article
    expect(slugs(articlesForContext('/app/billing', 'en-GB', reader))).toEqual(['signing-in']);
    expect(
      slugs(
        articlesForContext(
          '/app/compliance/i9',
          'en-GB',
          readerFor('hr_admin', { countries: ['GB'] }).reader,
        ),
      ),
    ).not.toContain('form-i9');
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
