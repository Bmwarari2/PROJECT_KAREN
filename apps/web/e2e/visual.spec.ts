import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiCall, signUpAndEnrol } from './helpers';

/**
 * Visual regression baselines for every screen (PROGRESS 12.6): light/dark × phone/desktop (projects).
 * One fictional workspace per project (deterministic name), mostly empty, plus one fictional employee
 * and one report run so the profile and run screens have content. The browser clock is fixed so weeks
 * and calendars are the same every day; anything else that depends on the real date or on random ids
 * (timestamps, relative times, ticket references, URLs) is masked.
 */
const APP_DIR = join(import.meta.dirname, '..', 'app');
const FIXED_NOW = new Date('2026-03-04T10:00:00Z'); // a Wednesday outside UK bank holidays

function allRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'page.tsx') out.push('/' + relative(APP_DIR, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s)).join('/'));
    }
  };
  walk(APP_DIR);
  return out.sort();
}

/** Screens with no baseline, and why (the functional a11y sweep still opens every one of them). */
const NOT_CAPTURED: Array<[match: (r: string) => boolean, reason: string]> = [
  [(r) => r === '/app/support/[id]', 'SLA deadlines and the ticket reference come from the real clock and random bytes'],
  [(r) => r.startsWith('/backoffice') && r !== '/backoffice/signin', 'staff-only screens list every tenant the run creates (random slugs); covered by the a11y sweep'],
];
const skipped = (r: string) => NOT_CAPTURED.some(([m]) => m(r));

const ROUTES = allRoutes().filter((r) => !skipped(r));
const PUBLIC = ROUTES.filter((r) => !r.startsWith('/app'));
const APP = ROUTES.filter((r) => r.startsWith('/app'));

/** Baseline file name; earlier phases' names are kept so their history continues. */
function shotName(route: string) {
  const legacy: Record<string, string> = { '/': 'home', '/app': 'app-home', '/app/reports/builder': 'app-report-builder' };
  return `${legacy[route] ?? route.slice(1).replace(/[[\]]/g, '').replace(/\//g, '-')}.png`;
}

/**
 * Marks text that changes with the real date, random ids or the host (timestamps, relative times,
 * UUIDs, references, URLs) so it is masked; the masks keep the layout under test.
 */
async function markVolatile(page: Page, app: boolean) {
  await page.evaluate((app) => {
    const months = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*';
    const patterns = [
      new RegExp(`\\b\\d{1,2} ${months}\\b`),
      new RegExp(`\\b${months} \\d{1,2}\\b`),
      /\b\d{1,2}:\d{2}\b/,
      /\b(19|20)\d{2}\b/,
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
      // durations and relative times only change in the app (marketing copy such as "30 days" is fixed)
      ...(app ? [/\b\d+ (second|minute|hour|day|week|month|year)s?\b/i, /\b(ago|yesterday|today|tomorrow)\b/i] : []),
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      /\bT-[0-9A-F]{8}\b/,
      /https?:\/\//,
      /\bkio_/,
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      if (text.trim() && patterns.some((p) => p.test(text))) n.parentElement?.setAttribute('data-visual-mask', '');
    }
  }, app);
}

/** Waits for the heading, data, fonts and any finite animation, then compares a full-page screenshot. */
async function capture(page: Page, route: string, path = route) {
  await page.goto(path);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => undefined)));
  });
  await markVolatile(page, route.startsWith('/app'));
  await expect.soft(page).toHaveScreenshot(shotName(route), {
    fullPage: true,
    timeout: 300_000,
    mask: [
      page.locator('footer p'),
      page.locator('[data-volatile]'),
      page.locator('[data-visual-mask]'),
      page.locator('header span[title]'),
      page.locator('input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"], input[type="week"]'),
    ],
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

test('every page route has a baseline or a recorded reason', () => {
  expect(allRoutes().filter((r) => !ROUTES.includes(r) && !skipped(r))).toEqual([]);
  for (const r of ['/', '/pricing', '/trust', '/status', '/developers', '/signin', '/signup', '/app', '/app/people', '/app/time-off', '/app/rota', '/app/timesheets', '/app/settings']) expect(ROUTES).toContain(r);
});

test('public screens', async ({ page }) => {
  // The long marketing page takes well over a minute to capture full-page in the container on slow hosts.
  test.setTimeout(1_800_000);
  for (const route of PUBLIC) await capture(page, route);
});

test('app screens', async ({ page }, testInfo) => {
  test.setTimeout(3_600_000);
  // a deterministic workspace per project (the database is fresh for every run)
  await signUpAndEnrol(page, testInfo.project.name);
  const entity = await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', { name: 'Fictional Visual Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });
  const employee = await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', { startDate: '2025-01-06', legalFirstName: 'Ada', legalLastName: 'Fictional', jobTitle: 'Store associate', entityId: entity.id, weeklyHours: 37.5, payAmountMinor: 2_600_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent' });
  const run = await apiCall<{ id: string }>(page.request, 'POST', '/v1/reports/runs', { source: { kind: 'ready', reportId: 'headcount', params: { asOf: '2026-03-02' } }, format: 'csv' });
  const roles = await apiCall<Array<{ id: string }>>(page.request, 'GET', '/v1/roles');
  const session = await apiCall<{ userId: string }>(page.request, 'GET', '/v1/auth/session');
  await page.goto('/app/help');
  const help = (await page.locator('main a[href^="/app/help/"]').first().getAttribute('href'))!;
  const concrete: Record<string, string> = {
    '/app/help/[slug]': help,
    '/app/people/[id]': `/app/people/${employee.id}`,
    '/app/reports/ready/[id]': '/app/reports/ready/headcount',
    '/app/reports/runs/[id]': `/app/reports/runs/${run.id}`,
    '/app/settings/roles/[id]': `/app/settings/roles/${roles[0]!.id}`,
    '/app/settings/users/[id]': `/app/settings/users/${session.userId}`,
  };
  for (const route of APP) {
    const path = route.includes('[') ? concrete[route] : route;
    expect(path, `no fictional record opens ${route}`).toBeTruthy();
    await capture(page, route, path);
  }
});
