import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiCall, lastMailTo, signUpAndEnrol, totp } from './helpers';
import { sql } from './time-helpers';

/**
 * Everything that names a thing takes you to it (ADR-0160, ADR-0161). One fictional UK workspace, signed
 * in as each built-in role (owner, HR admin, payroll admin, manager and employee) with real items to act
 * on: a leave request waiting for the manager and one already decided, a request to HR, a personal-detail
 * change waiting for HR, a pay change waiting for payroll, a right-to-work check and a laptop issued to the
 * employee. For each role the spec checks that
 *  - notifications (the page and the bell's panel), inbox tasks, approvals, person names and the rows of
 *    the main list pages are links;
 *  - following a sample of each kind of link reaches a page that renders without an error;
 *  - no link in those places leads to a page the role cannot open.
 * All people, names and addresses are fictional.
 */
test.use({ locale: 'en-GB', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });

const ROLES = ['owner', 'hr_admin', 'payroll_admin', 'manager', 'employee'] as const;
type Role = (typeof ROLES)[number];
const CONTEXT = { viewport: { width: 1280, height: 800 }, locale: 'en-GB', reducedMotion: 'reduce' as const };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** What a page says when the viewer may not see it, or it is missing. */
const REFUSED = [
  'You do not have permission to do that.',
  'We could not find that.',
  'You do not have access to this compliance information.',
  'The directory isn’t part of your access',
  'Something went wrong on our side. Please try again.',
];

const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

function futureWorkingDay(offset: number) {
  const d = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset),
  );
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  if (md >= 1220 || md <= 105) d.setUTCDate(d.getUTCDate() + 21);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function ensureSecondFactor(page: Page) {
  await page.goto('/app');
  const setup = page.getByRole('button', { name: 'Set up authenticator app' });
  await expect(setup.or(page.locator('main h1, main h2')).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (page.url().includes('/app/security') || (await setup.isVisible())) {
    await setup.click();
    const secret = (await page.locator('code').first().textContent())!.trim();
    await page.getByLabel('Six-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(/\/app$/);
  }
}

async function signInFromInvite(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext(CONTEXT)).newPage();
  await page.goto(magicLink((await lastMailTo(email)).text));
  await page.waitForURL(/\/app(\/security.*)?$/);
  await ensureSecondFactor(page);
  return page;
}

/** Waits for a page's heading and for its data (no skeletons, no requests in flight). */
async function settle(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('main .animate-pulse'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
}

/** The app links inside `main` (rail and top bar excluded), as paths. */
async function mainLinks(page: Page, scope = 'main'): Promise<string[]> {
  return page
    .locator(`${scope} a[href^="/app"]`)
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
}

/** The shape of a path, ids replaced, so one sample per kind of page is followed. */
const kind = (href: string) => href.replace(UUID, ':id').replace(/\?.*$/, '').replace(/#.*$/, '');

/** Opens a page and fails on an HTTP error, an uncaught error or a refusal message. */
async function opens(page: Page, href: string) {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  try {
    const res = await page.goto(href);
    expect(res?.status() ?? 0, href).toBeLessThan(400);
    await settle(page);
    for (const text of REFUSED)
      await expect(page.getByText(text, { exact: false }), `${href} says “${text}”`).toHaveCount(0);
    expect(errors, `${href}: uncaught errors`).toEqual([]);
  } finally {
    page.off('pageerror', onError);
  }
}

interface Workspace {
  pages: Record<Role, Page>;
  ids: Record<'olive' | 'harper' | 'pat' | 'mira' | 'eli' | 'dev' | 'omar', string>;
}
let ws: Workspace;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const owner = await (await browser.newContext(CONTEXT)).newPage();
  const { slug, email } = await signUpAndEnrol(owner);
  const post = <T = { id: string }>(url: string, data: unknown) =>
    apiCall<T>(owner.request, 'POST', url, data);
  const entity = (
    await post('/v1/org/legal-entities', {
      name: 'Fictional Lantern Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  const location = (
    await post('/v1/org/locations', {
      name: 'Fictional Studio York',
      country: 'GB',
      regionCode: 'GB-ENG',
      timeZone: 'Europe/London',
      entityId: entity,
    })
  ).id;
  const engineering = (await post('/v1/org/departments', { name: 'Engineering' })).id;
  const operations = (await post('/v1/org/departments', { name: 'Operations' })).id;
  const hire = async (first: string, last: string, jobTitle: string, departmentId: string, extra = {}) =>
    (
      await post('/v1/employees', {
        startDate: '2025-02-03',
        legalFirstName: first,
        legalLastName: last,
        jobTitle,
        departmentId,
        entityId: entity,
        locationId: location,
        weeklyHours: 37.5,
        payAmountMinor: 4_200_000,
        payCurrency: 'GBP',
        payFrequency: 'annual',
        contractType: 'permanent',
        workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.test`,
        ...extra,
      })
    ).id;
  const olive = await hire('Olive', 'Owner', 'Managing director', operations, { workEmail: undefined });
  await sql('UPDATE app.users SET employee_id = $1 WHERE lower(email) = lower($2)', [olive, email]);
  const harper = await hire('Harper', 'Hughes', 'People partner', operations, { managerId: olive });
  const pat = await hire('Pat', 'Penn', 'Payroll lead', operations, { managerId: olive });
  const mira = await hire('Mira', 'Marsh', 'Engineering manager', engineering, { managerId: olive });
  const eli = await hire('Eli', 'Evans', 'Software engineer', engineering, { managerId: mira });
  const dev = await hire('Dev', 'Dale', 'Platform engineer', engineering, { managerId: mira });
  const omar = await hire('Omar', 'Osei', 'Operations analyst', operations, { managerId: harper });

  const roles = await apiCall<Array<{ id: string; key: string }>>(owner.request, 'GET', '/v1/roles');
  const grant = async (employeeId: string, role: string) => {
    const u = await post<{ userId: string }>(`/v1/employees/${employeeId}/invite`, {});
    await post(`/v1/users/${u.userId}/role-assignments`, {
      roleId: roles.find((r) => r.key === role)!.id,
      scope: { type: 'all' },
    });
  };
  await grant(harper, 'hr_admin');
  await grant(pat, 'payroll_admin');
  await post(`/v1/employees/${mira}/invite`, { roles: ['manager'] });
  await post(`/v1/employees/${eli}/invite`, {});

  // a pay change waits for payroll; a right-to-work check on file; a laptop issued to Eli
  await post('/v1/approval-policies', {
    subject: 'employee.change',
    name: 'Pay change approval',
    condition: { field: 'payAmountMinor', op: 'present' },
    steps: [{ approver: { type: 'role', value: 'payroll_admin' } }],
  });
  const change = await owner.request.post(`/v1/employees/${dev}/changes`, {
    data: { effectiveDate: futureWorkingDay(30), payAmountMinor: 4_500_000 },
  });
  expect(change.status(), await change.text()).toBe(202);
  await post('/v1/compliance/right-to-work/checks', {
    employeeId: dev,
    checkMethod: 'manual_document_check',
    listType: 'list_a',
    checkedOn: futureWorkingDay(-20),
  });
  const laptop = await post('/v1/assets', {
    assetTag: 'FICT-0001',
    name: 'Fictional laptop',
    type: 'laptop',
  });
  await post(`/v1/assets/${laptop.id}/assign`, { employeeId: eli, assignedOn: futureWorkingDay(-5) });

  const domain = `${slug}.example.test`;
  const pages = {
    owner,
    hr_admin: await signInFromInvite(browser, `harper.hughes@${domain}`),
    payroll_admin: await signInFromInvite(browser, `pat.penn@${domain}`),
    manager: await signInFromInvite(browser, `mira.marsh@${domain}`),
    employee: await signInFromInvite(browser, `eli.evans@${domain}`),
  } as Record<Role, Page>;

  // Eli asks for two days off (Mira approves one), asks HR a question and asks to correct their legal name
  const e = pages.employee.request;
  const types = await apiCall<Array<{ id: string; key: string }>>(e, 'GET', '/v1/leave/types');
  const annual = types.find((t) => t.key === 'annual')!.id;
  for (const offset of [36, 43]) {
    const d = futureWorkingDay(offset);
    await apiCall(e, 'POST', '/v1/leave/requests', { leaveTypeId: annual, startDate: d, endDate: d });
  }
  const waiting = await apiCall<Array<{ id: string }>>(
    pages.manager.request,
    'GET',
    '/v1/approvals?view=mine',
  );
  expect(waiting.length).toBeGreaterThanOrEqual(2);
  await apiCall(pages.manager.request, 'POST', `/v1/approvals/${waiting[0]!.id}/decide`, {
    decision: 'approve',
  });
  await apiCall(e, 'POST', '/v1/hr-requests', {
    subject: 'Fictional question about my notice period',
    message: 'Fictional details only.',
  });
  const self = await e.post('/v1/me/change-requests', {
    data: { legalLastName: 'Evans-Fictional', reason: 'Fictional correction' },
  });
  expect(self.status(), await self.text()).toBe(202);

  ws = { pages, ids: { olive, harper, pat, mira, eli, dev, omar } };
});

test.afterAll(async () => {
  for (const p of Object.values(ws?.pages ?? {})) await p.context().close();
});

/** The list pages each role works from, and what their rows must link to. */
const LISTS: Record<Role, Array<{ path: string; rows: string; link: RegExp }>> = {
  owner: [
    { path: '/app/people', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ },
    { path: '/app/compliance/right-to-work', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ },
    { path: '/app/assets', rows: 'main tbody tr', link: /^\/app\/assets\/[0-9a-f-]{36}/ },
  ],
  hr_admin: [
    { path: '/app/people', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ },
    { path: '/app/compliance/right-to-work', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ },
  ],
  payroll_admin: [{ path: '/app/people', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ }],
  manager: [{ path: '/app/people', rows: 'main tbody tr', link: /^\/app\/people\/[0-9a-f-]{36}/ }],
  employee: [
    { path: '/app/time-off', rows: 'main tbody tr', link: /^\/app\/time-off\/[0-9a-f-]{36}/ },
    { path: '/app/contact-hr', rows: '#hr-requests li', link: /^\/app\/contact-hr\/[0-9a-f-]{36}/ },
  ],
};

/** What each role must find to act on (at least one item each). */
const EXPECT: Record<Role, { notes: boolean; tasks: boolean; approvals: boolean }> = {
  // the owner did the setting up: nothing notified them, but they work the HR queue
  owner: { notes: false, tasks: true, approvals: false },
  hr_admin: { notes: true, tasks: true, approvals: true },
  payroll_admin: { notes: true, tasks: true, approvals: true },
  manager: { notes: true, tasks: true, approvals: true },
  employee: { notes: true, tasks: true, approvals: false },
};

for (const role of ROLES) {
  test(`as ${role}, everything that names a thing is a link that opens`, async () => {
    test.setTimeout(600_000);
    const page = ws.pages[role];
    const followed = new Map<string, string>();
    const collect = (hrefs: string[]) => {
      for (const h of hrefs) if (!followed.has(kind(h))) followed.set(kind(h), h);
    };

    // notifications: every row is a link
    await page.goto('/app/notifications');
    await settle(page);
    const notes = page.getByTestId('notification-list').getByRole('listitem');
    if (EXPECT[role].notes) await expect(notes.first()).toBeVisible();
    for (const row of await notes.all()) await expect(row.locator('a[href^="/app"]').first()).toBeVisible();
    collect(await mainLinks(page, '[data-testid="notification-list"]'));

    // the bell's panel lists the same items as links
    await page
      .locator('header')
      .getByRole('button', { name: /^Notifications/ })
      .click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    if (EXPECT[role].notes) await expect(panel.getByRole('listitem').first().locator('a')).toBeVisible();
    const fromBell = await panel
      .locator('li a[href^="/app"]')
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
    expect(fromBell.length).toBeGreaterThan(EXPECT[role].notes ? 0 : -1);
    collect(fromBell);
    await page.keyboard.press('Escape');

    // inbox tasks open what they are about
    await page.goto('/app/tasks');
    await settle(page);
    const tasks = page.getByTestId('task-list').getByRole('listitem');
    if (EXPECT[role].tasks) await expect(tasks.first()).toBeVisible();
    for (const row of await tasks.all()) await expect(row.locator('a[href^="/app"]').first()).toBeVisible();
    collect(await mainLinks(page, '[data-testid="task-list"]'));

    // approvals open the request, and name the person
    await page.goto('/app/approvals');
    await settle(page);
    const approvals = page.getByTestId('approval-list').getByRole('listitem');
    if (EXPECT[role].approvals) await expect(approvals.first()).toBeVisible();
    for (const row of await approvals.all())
      await expect(row.locator('a[href^="/app/approvals/"]')).toHaveCount(1);
    collect(await mainLinks(page, '[data-testid="approval-list"]'));

    // the main list pages: each row links to its record, names link to profiles
    for (const list of LISTS[role]) {
      await page.goto(list.path);
      await settle(page);
      const rows = page.locator(list.rows);
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) {
        const hrefs = await row
          .locator('a[href^="/app"]')
          .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
        expect(
          hrefs.some((h) => list.link.test(h)),
          `${list.path}: a row without a link to its record`,
        ).toBe(true);
      }
      collect(await mainLinks(page));
    }

    // the org chart: names link only to the profiles this role may open
    await page.goto('/app/org-chart');
    await settle(page);
    const profiles = (await mainLinks(page)).filter((h) => h.startsWith('/app/people/'));
    if (role === 'employee') expect(profiles.map(kind)).toEqual(profiles.length ? ['/app/people/:id'] : []);
    if (role === 'employee') for (const h of profiles) expect(h).toContain(ws.ids.eli);
    if (role === 'manager')
      for (const h of profiles)
        expect(
          [ws.ids.mira, ws.ids.eli, ws.ids.dev].some((id) => h.includes(id)),
          h,
        ).toBe(true);
    for (const h of profiles) followed.set(`profile:${h}`, h);

    // home: the attention items open what they name
    await page.goto('/app');
    await settle(page);
    collect(await mainLinks(page, '#home-attention'));

    // follow one link of each kind: it opens, without an error or a refusal
    expect(followed.size).toBeGreaterThan(1);
    for (const href of followed.values()) await opens(page, href);
  });
}

test('opening a notification marks it read and opens what it is about', async () => {
  const page = ws.pages.manager;
  await page.goto('/app/notifications');
  await settle(page);
  const unread = page
    .getByTestId('notification-list')
    .getByRole('listitem')
    .filter({ has: page.getByText('New', { exact: true }) });
  const before = await unread.count();
  expect(before).toBeGreaterThan(0);
  const link = unread.first().locator('a[href^="/app"]').first();
  const href = (await link.getAttribute('href'))!;
  await link.click();
  await page.waitForURL((u) => u.pathname === href.split('?')[0]!.split('#')[0]);
  await settle(page);
  await page.goto('/app/notifications');
  await settle(page);
  await expect(
    page
      .getByTestId('notification-list')
      .getByRole('listitem')
      .filter({ has: page.getByText('New', { exact: true }) }),
  ).toHaveCount(before - 1);
});

test('a task without a screen of its own opens its page, and HR marks it done there', async () => {
  const hr = ws.pages.hr_admin;
  await hr.goto('/app/tasks');
  await settle(hr);
  await hr.getByRole('link', { name: 'Fictional question about my notice period' }).click();
  await expect(hr.getByTestId('task-detail')).toBeVisible();
  await expect(hr.getByTestId('task-detail').getByRole('link', { name: 'Eli Evans' })).toBeVisible();
  await expect(
    hr.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Tasks' }),
  ).toBeVisible();
  await hr.getByRole('button', { name: 'Mark as done' }).click();
  await expect(hr.getByText('Task marked as done').first()).toBeVisible();
  // the employee sees the request done on Contact HR
  const e = ws.pages.employee;
  await e.goto('/app/contact-hr');
  await settle(e);
  await expect(
    e
      .getByRole('listitem')
      .filter({ hasText: 'Fictional question about my notice period' })
      .getByText('Done', { exact: true }),
  ).toBeVisible();
  // and opens it: what they asked, done
  await e
    .locator('#hr-requests')
    .getByRole('link', { name: 'Fictional question about my notice period' })
    .click();
  await expect(e.getByTestId('hr-request-detail')).toBeVisible();
  await expect(e.getByTestId('hr-request-detail').getByText('Fictional details only.')).toBeVisible();
  await expect(e.getByTestId('hr-request-detail').getByText('Done', { exact: true }).first()).toBeVisible();
});

test('an approver decides on the request’s own page', async () => {
  const m = ws.pages.manager;
  await m.goto('/app/approvals');
  await settle(m);
  await m
    .getByTestId('approval-list')
    .getByRole('listitem')
    .first()
    .locator('a[href^="/app/approvals/"]')
    .click();
  await expect(m.getByTestId('approval-detail')).toBeVisible();
  await expect(m.getByRole('link', { name: 'Open the leave request' })).toBeVisible();
  await m.getByRole('button', { name: 'Approve' }).click();
  await expect(m.getByText('Request approved').first()).toBeVisible();
  await expect(m.getByTestId('approval-decide')).toHaveCount(0);
});

test('a name on the right-to-work list opens the profile on its compliance tab', async () => {
  const hr = ws.pages.hr_admin;
  await hr.goto('/app/compliance/right-to-work');
  await settle(hr);
  await hr.getByRole('link', { name: 'Dev Dale' }).first().click();
  await hr.waitForURL(/\/app\/people\/[0-9a-f-]{36}\?tab=compliance$/);
  await expect(hr.getByRole('tab', { name: 'Compliance', selected: true })).toBeVisible();
  await expect(hr.getByTestId('profile-compliance')).toBeVisible();
  await hr
    .getByTestId('profile-compliance')
    .locator('a[href^="/app/compliance/right-to-work/"]')
    .first()
    .click();
  await expect(hr.getByTestId('rtw-check')).toBeVisible();
});
