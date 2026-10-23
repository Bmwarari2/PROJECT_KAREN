import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PERMISSION_KEYS } from '../../../packages/core/src/access';
import { signUpAndEnrol } from './helpers';

/**
 * Per-route message scoping (ADR-0150): client components only receive the catalogue namespaces their
 * route's layouts provide, so a forgotten namespace shows up as a raw message key. This sweep opens
 * every static screen (and a person's profile) in a fresh fictional workspace and fails if any visible
 * text or accessible name is a catalogue key. `scripts/test/i18n-scopes.test.ts` checks the same
 * statically; this catches keys that only arrive at run time.
 */
const root = join(import.meta.dirname, '..');
const catalogue = JSON.parse(
  readFileSync(join(root, '..', '..', 'packages', 'core', 'src', 'i18n', 'messages', 'en-GB.json'), 'utf8'),
);
const keys = new Set<string>();
const flatten = (o: Record<string, unknown>, prefix = '') => {
  for (const [k, v] of Object.entries(o)) {
    // a missing plural family renders as its base key (org.reports for org.reports_one / _other)
    if (typeof v === 'string') keys.add((prefix + k).replace(/_(?:zero|one|two|few|many|other)$/, ''));
    else flatten(v as Record<string, unknown>, `${prefix}${k}.`);
  }
};
flatten(catalogue);
// permission names (documents.read) appear as text in the API reference; they are not messages
for (const p of PERMISSION_KEYS) keys.delete(p);

function staticRoutes(dir: string, under: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('[')) out.push(...staticRoutes(join(dir, e.name), under));
    else if (e.name === 'page.tsx')
      out.push(
        `/${relative(join(root, 'app'), dir)
          .split(sep)
          .filter((s) => !/^\(.*\)$/.test(s))
          .join('/')}`,
      );
  }
  return out.filter((r) => r.startsWith(under)).sort();
}

/** Raw catalogue keys in the page's text and in accessible names, labels and placeholders. */
async function rawKeys(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    // all text, including screen-reader-only text; code samples are not messages
    const parts = [document.title];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (!n.parentElement?.closest('code,pre,kbd,samp,script,style,noscript'))
        parts.push(n.textContent ?? '');
    for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) parts.push(el.getAttribute(a) ?? '');
    return parts.join('\n');
  });
  return [...new Set(text.match(/[a-zA-Z][\w-]*(?:\.[\w-]+)+/g) ?? [])].filter((w) => keys.has(w));
}

async function sweep(page: Page, routes: string[]) {
  const found: string[] = [];
  for (const path of routes) {
    await page.goto(path);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    for (const k of await rawKeys(page)) found.push(`${path}: ${k}`);
  }
  expect(found, found.join('\n')).toEqual([]);
}

test.use({ locale: 'en-GB' });

test('public screens show no raw message keys', async ({ page }) => {
  await sweep(page, [
    ...staticRoutes(join(root, 'app'), '/').filter(
      (r) => !r.startsWith('/app') && !(r.startsWith('/backoffice') && r !== '/backoffice/signin'),
    ),
  ]);
});

test('every app screen shows no raw message keys', async ({ page }) => {
  test.setTimeout(600_000);
  const { slug } = await signUpAndEnrol(page);
  const post = async (url: string, data: unknown) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const entity = (
    await post('/v1/org/legal-entities', {
      name: `Fictional ${slug} Ltd`,
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  const person = (
    await post('/v1/employees', {
      startDate: '2026-03-02',
      legalFirstName: 'Ada',
      legalLastName: 'Fictional',
      jobTitle: 'Analyst',
      entityId: entity,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
    })
  ).id;
  await sweep(page, [...staticRoutes(join(root, 'app'), '/app'), `/app/people/${person}`]);
});
