import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { apiCall, axeViolations, PASSWORD, totp } from './helpers';
import { createStaff, staffSignIn } from './phase10-helpers';
import { companyWithStaff, sql } from './time-helpers';

/**
 * WCAG 2.2 AA sweep (PROGRESS 12.5, docs/ACCESSIBILITY.md). Every page route in apps/web/app is opened
 * as the owner of a fictional workspace with representative fictional data (or signed out, or as
 * Thapsus staff for the back office) and checked with:
 *  - axe (WCAG 2.0/2.1/2.2 A and AA tags, including 2.5.8 target size) in light and dark mode;
 *  - 1.4.10 reflow: no horizontal page scroll at 320 CSS px (tables scroll inside their own region);
 *  - 2.1.1 / 2.4.3 / 2.4.7 / 2.4.11 keyboard: Tab reaches every visible control, each focused control
 *    shows a focus indicator and is not entirely hidden behind sticky bars;
 *  - 1.4.12 text spacing: the WCAG spacing overrides do not clip text in fixed-height boxes;
 *  - 2.3.3 / reduced motion: nothing animates when the user asks for reduced motion;
 *  - 3.2.6 consistent help: every app screen has the contextual help link in the same place;
 *  - 1.3.1 structure: headings do not skip levels, one h1, distinct landmark names.
 * Problems are collected per area and reported together, so one run lists everything to fix.
 */
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

const APP_DIR = join(import.meta.dirname, '..', 'app');
const DESKTOP = { width: 1280, height: 720 };

/** Every page route of the web app, from apps/web/app/**\/page.tsx with route groups removed. */
function allRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'page.tsx')
        out.push(
          '/' +
            relative(APP_DIR, dir)
              .split(sep)
              .filter((s) => s && !/^\(.*\)$/.test(s))
              .join('/'),
        );
    }
  };
  walk(APP_DIR);
  return out.sort();
}

const ROUTES = allRoutes();
const isBackoffice = (r: string) => r.startsWith('/backoffice') && r !== '/backoffice/signin';
const AREAS: Array<{ name: string; match: (r: string) => boolean; as: 'public' | 'owner' | 'staff' }> = [
  {
    name: 'public pages (marketing, trust, pricing, status, developers, auth, kiosk, back-office sign-in)',
    match: (r) => !r.startsWith('/app') && !isBackoffice(r),
    as: 'public',
  },
  {
    name: 'home, me, people and help',
    match: (r) =>
      /^\/app(\/(me|welcome|people|org-chart|tasks|approvals|notifications|security|help|support|ask)(\/|$)|$)/.test(
        r,
      ),
    as: 'owner',
  },
  {
    name: 'time off, rota, clock and timesheets',
    match: (r) => /^\/app\/(time|time-off|rota|clock|timesheets)(\/|$)/.test(r),
    as: 'owner',
  },
  {
    name: 'documents, pay, assets, billing and integrations',
    match: (r) =>
      /^\/app\/(documents|payslips|payroll|assets|billing|integrations|imports|automation)(\/|$)/.test(r),
    as: 'owner',
  },
  { name: 'reports', match: (r) => r.startsWith('/app/reports'), as: 'owner' },
  { name: 'compliance and privacy', match: (r) => /^\/app\/(compliance|privacy)(\/|$)/.test(r), as: 'owner' },
  { name: 'settings', match: (r) => r.startsWith('/app/settings'), as: 'owner' },
  { name: 'back office', match: isBackoffice, as: 'staff' },
];

/** Fictional records the dynamic routes open; filled in by the setup below. */
interface Fixture {
  employeeId: string;
  helpSlug: string;
  roleId: string;
  userId: string;
  ticketId: string;
  runId: string;
  tenantId: string;
  kioskToken: string;
  owner: { slug: string; email: string; secret: string; employeeNumber: string };
}

function concrete(route: string, f: Fixture): string {
  const map: Record<string, string> = {
    '/app/people/[id]': `/app/people/${f.employeeId}`,
    '/app/help/[slug]': `/app/help/${f.helpSlug}`,
    '/app/reports/ready/[id]': '/app/reports/ready/headcount',
    '/app/reports/runs/[id]': `/app/reports/runs/${f.runId}`,
    '/app/settings/roles/[id]': `/app/settings/roles/${f.roleId}`,
    '/app/settings/users/[id]': `/app/settings/users/${f.userId}`,
    '/app/support/[id]': `/app/support/${f.ticketId}`,
    '/backoffice/tenants/[id]': `/backoffice/tenants/${f.tenantId}`,
    '/backoffice/support/[tenantId]/[ticketId]': `/backoffice/support/${f.tenantId}/${f.ticketId}`,
  };
  if (!route.includes('[')) return route;
  const path = map[route];
  if (!path)
    throw new Error(`a11y sweep: no fictional record opens the dynamic route ${route}; add it to concrete()`);
  return path;
}

/** A Wednesday about five weeks ahead, away from the Christmas and New Year bank holidays. */
function futureWorkingDay() {
  const d = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 35),
  );
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  if (md >= 1220 || md <= 105) d.setUTCDate(d.getUTCDate() + 21);
  return d.toISOString().slice(0, 10);
}

/** Monday of the current week (UTC calendar date), for a published rota. */
function thisMonday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** A fictional UK workspace: three staff and an invited manager, pending leave, a published day of shifts, a paired kiosk, a support ticket and a report run. */
async function seedWorkspace(page: Page): Promise<Fixture> {
  const co = await companyWithStaff(page, 3);
  // a second sign-in user: a store manager invited from her employee record
  const dara = `dara@${co.slug}.example.test`;
  const manager = await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', {
    startDate: '2025-01-06',
    legalFirstName: 'Dara',
    legalLastName: 'Fictional',
    jobTitle: 'Store manager',
    entityId: co.entity,
    locationId: co.location,
    weeklyHours: 40,
    payAmountMinor: 3_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    workEmail: dara,
  });
  await apiCall(page.request, 'POST', `/v1/employees/${manager.id}/invite`, { roles: ['manager'] });

  // leave: the owner's own pending request, and Ben's, which the owner approves (Ben reports to Ada, the owner's record)
  const types = await apiCall<Array<{ id: string; key: string }>>(page.request, 'GET', '/v1/leave/types');
  const annual = types.find((t) => t.key === 'annual') ?? types[0]!;
  const day = futureWorkingDay();
  await apiCall(page.request, 'POST', '/v1/leave/requests', {
    leaveTypeId: annual.id,
    startDate: day,
    endDate: day,
    note: 'Fictional day out',
  });
  await sql('UPDATE app.employees SET manager_id = $1 WHERE id = $2', [co.staff[0], co.staff[1]]);
  await apiCall(page.request, 'POST', '/v1/leave/requests', {
    employeeId: co.staff[1],
    leaveTypeId: annual.id,
    startDate: day,
    endDate: day,
    note: 'Fictional dentist visit',
  });
  // as if Dara had entered Ben's request for him: nobody may approve a request they made themselves
  await sql(
    'UPDATE app.approval_requests SET requested_by = (SELECT id FROM app.users WHERE lower(email) = lower($1)) WHERE subject_employee_id = $2',
    [dara, co.staff[1]],
  );
  await sql(
    'UPDATE app.leave_requests SET requested_by = (SELECT id FROM app.users WHERE lower(email) = lower($1)) WHERE employee_id = $2',
    [dara, co.staff[1]],
  );

  // rota: a published day of shifts this week; clock: a kiosk and Ada's PIN
  const monday = thisMonday();
  for (const [i, employeeId] of co.staff.entries()) {
    await apiCall(page.request, 'POST', '/v1/shifts', {
      employeeId,
      date: monday,
      start: i ? '12:00' : '09:00',
      end: i ? '20:00' : '17:00',
      breakMinutes: 30,
    });
  }
  await apiCall(page.request, 'POST', '/v1/rota/publish', { from: monday, to: monday });
  const kiosk = await apiCall<{ token: string }>(page.request, 'POST', '/v1/kiosks', {
    name: 'Front desk',
    locationId: co.location,
  });
  await apiCall(page.request, 'PUT', `/v1/kiosk-pins/${co.staff[0]}`, { pin: '4826' });

  const ticket = await apiCall<{ id: string }>(page.request, 'POST', '/v1/support/tickets', {
    subject: 'Fictional question about leave balances',
    body: 'Fictional details only.',
    category: 'question',
    priority: 'normal',
  });
  const run = await apiCall<{ id: string }>(page.request, 'POST', '/v1/reports/runs', {
    source: { kind: 'ready', reportId: 'headcount', params: { asOf: monday } },
    format: 'csv',
  });
  const roles = await apiCall<Array<{ id: string }>>(page.request, 'GET', '/v1/roles');
  const users = (await apiCall<{ data: Array<{ id: string }> }>(page.request, 'GET', '/v1/users')).data;
  const session = await apiCall<{ tenantId: string; userId: string }>(
    page.request,
    'GET',
    '/v1/auth/session',
  );
  await page.goto('/app/help');
  const helpHref = await page.locator('main a[href^="/app/help/"]').first().getAttribute('href');
  return {
    employeeId: co.staff[1]!,
    helpSlug: helpHref!.split('/').pop()!,
    roleId: roles[0]!.id,
    userId: users.find((u) => u.id !== session.userId)?.id ?? users[0]!.id,
    ticketId: ticket.id,
    runId: run.id,
    tenantId: session.tenantId,
    kioskToken: kiosk.token,
    owner: { slug: co.slug, email: co.email, secret: co.secret, employeeNumber: co.employeeNumber },
  };
}

// ---- checks ---------------------------------------------------------------------------------------------

/** Waits for the page heading and for loading skeletons to give way to data. */
async function ready(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await expect(page.locator('main .animate-pulse'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
}

/** Tabs through the whole page. Returns problems: missing focus indicator, focus hidden, unreachable controls. */
async function keyboardProblems(page: Page, max = 400): Promise<string[]> {
  const problems: string[] = [];
  let wrapped = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return { done: true as const };
      // Tab moves between the day, month and year of a date input without leaving it
      if (el.hasAttribute('data-a11y-last')) return { done: false as const, same: true as const };
      if (el.hasAttribute('data-a11y-reached')) return { done: true as const };
      document.querySelector('[data-a11y-last]')?.removeAttribute('data-a11y-last');
      el.setAttribute('data-a11y-reached', '');
      el.setAttribute('data-a11y-last', '');
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
      const cs = getComputedStyle(el);
      const indicator =
        (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ];
      const owns = (hit: Element | null) =>
        !!hit &&
        (hit === el ||
          el.contains(hit) ||
          (el instanceof HTMLInputElement && [...(el.labels ?? [])].some((l) => l.contains(hit))));
      const visible = points.some(([x, y]) => owns(document.elementFromPoint(x!, y!)));
      return { done: false as const, same: false as const, name, indicator, visible };
    });
    if (step.done) {
      wrapped = i > 0;
      break;
    }
    if (step.same) continue;
    // 2.4.1: on pages with a skip link, the first Tab reaches it
    if (i === 0 && (await page.locator('a[href="#main"]').count()) && !/skip|main/i.test(step.name))
      problems.push(`2.4.1 the first Tab reaches ${step.name}, not the skip link`);
    if (!step.indicator) problems.push(`2.4.7 no visible focus indicator on ${step.name}`);
    if (!step.visible) problems.push(`2.4.11 focused control hidden by other content: ${step.name}`);
  }
  if (!wrapped) problems.push(`keyboard walk did not finish within ${max} tab stops`);
  const unreached = await page.evaluate(() => {
    const controls = document.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]',
    );
    const out: string[] = [];
    const reachedRadioGroups = new Set(
      [...document.querySelectorAll<HTMLInputElement>('input[type="radio"][data-a11y-reached]')].map(
        (r) => r.name,
      ),
    );
    for (const el of controls) {
      if (el.hasAttribute('data-a11y-reached')) continue;
      if (el.matches(':disabled, [tabindex="-1"], [aria-hidden="true"] *, [inert] *') || el.tabIndex < 0)
        continue;
      if (el instanceof HTMLInputElement && el.type === 'radio' && reachedRadioGroups.has(el.name)) continue;
      // composite widgets (tabs, toolbars, radio groups) move focus from the container to their active item
      if (
        el.matches(
          '[role="tablist"], [role="toolbar"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="grid"]',
        ) &&
        el.querySelector('[data-a11y-reached]')
      )
        continue;
      if (
        !el.getClientRects().length ||
        getComputedStyle(el).visibility === 'hidden' ||
        (el.closest('details:not([open])') && el.tagName !== 'SUMMARY')
      )
        continue;
      out.push(
        `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
      );
    }
    document
      .querySelectorAll('[data-a11y-reached], [data-a11y-last]')
      .forEach((e) => (e.removeAttribute('data-a11y-reached'), e.removeAttribute('data-a11y-last')));
    return out.slice(0, 5);
  });
  if (wrapped) for (const u of unreached) problems.push(`2.1.1 not reachable with Tab: ${u}`);
  return problems;
}

/**
 * 1.4.10: at 320 CSS px wide the page must not scroll sideways; names the outermost elements that stick
 * out. axe runs again at this width (e.g. tables that only overflow, and so must be scrollable by
 * keyboard, on a phone).
 */
async function reflowProblems(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 320, height: 640 });
  const phoneAxe = (await axeViolations(page)).map((v) => `axe (320px) ${v}`);
  const out = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth + 1) return [];
    const clips = (e: Element) => /auto|scroll|hidden|clip/.test(getComputedStyle(e).overflowX);
    const offenders = [...document.body.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.right <= doc.clientWidth + 1 || r.width === 0) return false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
        if (clips(a)) return false;
      return true;
    });
    const outermost = offenders.filter((el) => !offenders.some((o) => o !== el && o.contains(el)));
    return [
      `page is ${doc.scrollWidth}px wide`,
      ...outermost.slice(0, 3).map(
        (el) =>
          `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '')
            .split(' ')
            .slice(0, 4)
            .join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`,
      ),
    ];
  });
  await page.setViewportSize(DESKTOP);
  return [...phoneAxe, ...(out.length ? [`1.4.10 horizontal scroll at 320px: ${out.join('; ')}`] : [])];
}

/** 1.4.12: with WCAG text-spacing overrides, no fixed-height box may cut text off. */
async function textSpacingProblems(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const style = document.createElement('style');
    style.textContent =
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
    document.head.append(style);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const cs = getComputedStyle(el);
      if (!/hidden|clip/.test(cs.overflowY) || cs.position === 'absolute' || !el.getClientRects().length)
        continue;
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      if (el.scrollHeight > el.clientHeight + 1)
        out.push(
          `1.4.12 text clipped with increased spacing: ${el.tagName.toLowerCase()} "${el.textContent!.trim().slice(0, 30)}"`,
        );
    }
    style.remove();
    return out.slice(0, 3);
  });
}

/** 2.3.3: with prefers-reduced-motion nothing moves and scroll reveals are already visible. */
async function motionProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const moving = document
      .getAnimations()
      .filter((a) => a.playState === 'running' && Number(a.effect?.getComputedTiming().duration) > 0)
      .map(
        (a) =>
          `${(a.effect as KeyframeEffect | null)?.target?.tagName.toLowerCase()} ${(a as CSSAnimation).animationName ?? 'transition'}`,
      );
    const hidden = [...document.querySelectorAll<HTMLElement>('[data-reveal]')].filter(
      (e) => getComputedStyle(e).opacity !== '1',
    ).length;
    return [
      ...moving.slice(0, 3).map((m) => `2.3.3 animation runs under reduced motion: ${m}`),
      ...(hidden ? [`2.3.3 ${hidden} scroll reveals hidden under reduced motion`] : []),
    ];
  });
}

/** Opens one route and runs every check on it. */
async function sweep(page: Page, path: string, app: boolean): Promise<string[]> {
  const crashes: string[] = [];
  const onError = (e: Error) => crashes.push(`uncaught error: ${e.message.slice(0, 200)}`);
  page.on('pageerror', onError);
  try {
    return [...(await checks(page, path, app)), ...crashes];
  } finally {
    page.off('pageerror', onError);
  }
}

async function checks(page: Page, path: string, app: boolean): Promise<string[]> {
  const res = await page.goto(path);
  if (!res || res.status() >= 400) return [`HTTP ${res?.status()}`];
  try {
    await ready(page);
  } catch {
    return ['no visible h1 page heading'];
  }
  const problems = await keyboardProblems(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const v of await axeViolations(page)) problems.push(`axe (${colorScheme}) ${v}`);
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  // 1.3.1: headings do not skip levels and landmarks have distinct names (axe best-practice rules, which Lighthouse scores)
  const structure = await new AxeBuilder({ page })
    .withRules(['heading-order', 'page-has-heading-one', 'landmark-unique'])
    .analyze();
  for (const v of structure.violations)
    problems.push(
      `1.3.1 ${v.id}: ${v.help} (${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 2)
        .join(', ')})`,
    );
  problems.push(
    ...(await motionProblems(page)),
    ...(await textSpacingProblems(page)),
    ...(await reflowProblems(page)),
  );
  // 3.2.6: the help mechanism sits in the same place (the top bar) on every app screen.
  if (app && (await page.locator('header a[href^="/app/help?context="]').count()) !== 1)
    problems.push('3.2.6 contextual help link missing from the top bar');
  return problems;
}

/** Presses Tab (or Shift+Tab) until the focused element matches the selector and contains the text (keyboard-only flows). */
async function tabTo(page: Page, selector: string, opts: { text?: string; back?: boolean } = {}) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(opts.back ? 'Shift+Tab' : 'Tab');
    const hit = await page.evaluate(
      ({ sel, text }) => {
        const el = document.activeElement;
        return !!el?.matches(sel) && (!text || (el.textContent ?? '').includes(text));
      },
      { sel: selector, text: opts.text },
    );
    if (hit) return;
  }
  throw new Error(`Tab never reached ${selector} ${opts.text ?? ''}`);
}

/** 3.3.8: credential fields can be filled by password managers and accept paste. */
async function authenticationProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const i of document.querySelectorAll('input')) {
      const ac = i.getAttribute('autocomplete') ?? '';
      const name = i.labels?.[0]?.textContent?.trim() || i.name;
      if (i.type === 'password' && !['current-password', 'new-password'].includes(ac))
        out.push(`password field "${name}" has autocomplete="${ac}"`);
      if (i.type === 'email' && !['username', 'email'].includes(ac))
        out.push(`email field "${name}" has autocomplete="${ac}"`);
      if (i.getAttribute('inputmode') === 'numeric' && i.maxLength === 6 && ac !== 'one-time-code')
        out.push(`code field "${name}" has autocomplete="${ac}"`);
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      i.dispatchEvent(paste);
      if (paste.defaultPrevented) out.push(`paste is blocked in "${name}"`);
    }
    return out;
  });
}

// ---- tests ----------------------------------------------------------------------------------------------

let fixture: Fixture | undefined;
let ownerPage: Page | undefined;

test.describe('accessibility sweep (WCAG 2.2 AA)', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    // axe needs pages from browser.newContext() (not browser.newPage())
    ownerPage = await (await browser.newContext({ viewport: DESKTOP })).newPage();
    fixture = await seedWorkspace(ownerPage);
  });
  test.afterAll(async () => {
    await ownerPage?.context().close();
  });

  test('every page route belongs to a swept area and can be opened with fictional data', () => {
    const unassigned = ROUTES.filter((r) => !AREAS.some((a) => a.match(r)));
    expect(unassigned).toEqual([]);
    for (const r of ROUTES) expect(() => concrete(r, fixture!)).not.toThrow();
    // the key public pages named in PROGRESS 12.5 are part of the sweep
    for (const r of [
      '/',
      '/pricing',
      '/trust',
      '/status',
      '/developers',
      '/signin',
      '/signup',
      '/backoffice/signin',
    ])
      expect(ROUTES).toContain(r);
  });

  test('3.3.8 accessible authentication, and sign-in with the keyboard alone', async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    const problems: string[] = [];
    for (const path of ['/signin', '/signup', '/find-workspace', '/backoffice/signin']) {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      for (const p of await authenticationProblems(page)) problems.push(`${path}: ${p}`);
    }
    const { slug, email, secret } = fixture!.owner;
    await page.goto('/signin');
    await expect(page.locator('h1').first()).toBeVisible();
    await tabTo(page, '#workspace');
    await page.keyboard.type(slug);
    await page.keyboard.press('Tab');
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.locator('#code')).toBeVisible();
    for (const p of await authenticationProblems(page)) problems.push(`/signin (authenticator step): ${p}`);
    await tabTo(page, '#code');
    // sign-up already used the current step for enrolment, so use the next one
    await page.keyboard.type(totp(secret, 1));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/app$/);
    await context.close();
    expect(problems).toEqual([]);
  });

  test('approve leave and clock in at the kiosk with the keyboard alone', async ({ browser }) => {
    // approvals: tick the request with Space, then press "Approve selected" with Enter
    const page = ownerPage!;
    await page.goto('/app/approvals');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Ben Fictional' }).first();
    await expect(row).toBeVisible();
    await tabTo(page, 'main tbody input[type="checkbox"]');
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Approve selected' })).toBeEnabled();
    await tabTo(page, 'main button', { text: 'Approve selected', back: true });
    await page.keyboard.press('Enter');
    await expect(row).toBeHidden();

    // kiosk: type the employee number and PIN, then press "Clock in" with Enter
    const device = await browser.newContext({ viewport: DESKTOP });
    const kiosk = await device.newPage();
    await kiosk.goto(`/kiosk#pair=${fixture!.kioskToken}`);
    await expect(kiosk.getByRole('heading', { name: 'Kiosk: Front desk' })).toBeVisible();
    await tabTo(kiosk, '#kiosk-number');
    await kiosk.keyboard.type(fixture!.owner.employeeNumber);
    await kiosk.keyboard.press('Tab');
    await kiosk.keyboard.type('4826');
    await tabTo(kiosk, 'button', { text: 'Clock in' });
    await Promise.all([
      kiosk.waitForResponse((r) => r.url().includes('/v1/kiosk/clock')),
      kiosk.keyboard.press('Enter'),
    ]);
    await expect(kiosk.getByTestId('kiosk-message')).toHaveText('Clocked in. Thank you, Ada.');
    await device.close();
  });

  for (const area of AREAS) {
    test(`${area.name}`, async ({ browser }) => {
      test.setTimeout(1_200_000);
      const routes = ROUTES.filter(area.match);
      let page: Page;
      let close = async () => undefined as void;
      if (area.as === 'owner') page = ownerPage!;
      else {
        const context = await browser.newContext({ viewport: DESKTOP });
        page = await context.newPage();
        close = () => context.close();
        if (area.as === 'staff') await staffSignIn(page, createStaff('super_admin'));
      }
      const report: string[] = [];
      try {
        // the kiosk is also swept once paired (number + PIN keypad), on its own signed-out device
        const paths = [
          ...routes.map((r) => concrete(r, fixture!)),
          ...(area.as === 'public' ? [`/kiosk#pair=${fixture!.kioskToken}`] : []),
        ];
        for (const path of paths) {
          await page.setViewportSize(DESKTOP);
          for (const p of await sweep(page, path, area.as === 'owner'))
            report.push(`${path.replace(/#pair=.*/, ' (paired)')}: ${p}`);
        }
      } finally {
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
        await close();
      }
      expect(report, `${routes.length} routes swept\n${report.join('\n')}`).toEqual([]);
    });
  }
});
