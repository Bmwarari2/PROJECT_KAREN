import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiCall, lastMailTo, signUpAndEnrol, totp } from './helpers';
import { sql } from './time-helpers';

/**
 * Role views (Playwright project `role-views`, not part of `functional` or `pnpm verify`): the app as
 * each built-in role sees it, for the product owner. One fictional workspace with two departments;
 * people sign in as the owner, an HR admin, the manager of Engineering (their line manager, so the
 * manager role's own-team scope covers the department) and an employee. For each role it saves
 * 1440×900 screenshots of Home, People, one colleague's profile (the same person for everyone), Time
 * off, Reports, Settings, global search with a query and the account menu (and, for the owner, the
 * role comparison and the preview of the manager role), to ROLE_VIEWS_DIR
 * (default apps/web/e2e/.role-views/, git-ignored). All names and addresses are fictional.
 *
 *   pnpm --filter @thapsus/web exec playwright test --project=role-views
 */
const OUT = process.env.ROLE_VIEWS_DIR ?? join(import.meta.dirname, '.role-views');
const ROLES = ['owner', 'hr_admin', 'manager', 'employee'] as const;
type RoleKey = (typeof ROLES)[number];

test.use({ locale: 'en-GB', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });

/** Contexts made here do not inherit test.use(), so they get the same options explicitly. */
const CONTEXT = {
  viewport: { width: 1440, height: 900 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  colorScheme: 'light' as const,
  reducedMotion: 'reduce' as const,
};

const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

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

interface Workspace {
  slug: string;
  pages: Partial<Record<RoleKey, Page>>;
  names: Record<RoleKey, string>;
  /** The colleague whose profile every role opens. */
  profileId: string;
  managerRoleId: string;
}
let ws: Workspace;

/** Signs in from an invitation link; admins then set up their authenticator app as the app asks. */
async function signInFromInvite(browser: Browser, email: string): Promise<Page> {
  const link = magicLink((await lastMailTo(email)).text);
  const page = await (await browser.newContext(CONTEXT)).newPage();
  await page.goto(link);
  await page.waitForURL(/\/app(\/security.*)?$/);
  await ensureSecondFactor(page);
  return page;
}

async function ensureSecondFactor(page: Page) {
  await page.goto('/app');
  // an admin role needs a second factor before anything else; the shell sends them to set one up
  const setup = page.getByRole('button', { name: 'Set up authenticator app' });
  await expect(setup.or(page.locator('main h1, main h2')).first()).toBeVisible({ timeout: 30_000 });
  // the redirect to the security page can follow the first paint of the home page
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (page.url().includes('/app/security') || (await setup.isVisible())) {
    await expect(setup).toBeVisible();
    await setup.click();
    const secret = (await page.locator('code').first().textContent())!.trim();
    await page.getByLabel('Six-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(/\/app$/);
  }
}

/** Waits until the page has its data: no skeletons, no requests in flight, fonts and animations done. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('main .animate-pulse'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
}

async function shot(page: Page, role: RoleKey, name: string) {
  await settle(page);
  await page.screenshot({ path: join(OUT, role, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const owner = await (await browser.newContext(CONTEXT)).newPage();
  const { slug, email } = await signUpAndEnrol(owner);
  const post = <T = { id: string }>(url: string, data: unknown) =>
    apiCall<T>(owner.request, 'POST', url, data);
  const entity = (
    await post('/v1/org/legal-entities', {
      name: 'Fictional Northwind Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  const location = (
    await post('/v1/org/locations', {
      name: 'Fictional Studio Leeds',
      country: 'GB',
      regionCode: 'GB-ENG',
      timeZone: 'Europe/London',
      entityId: entity,
    })
  ).id;
  const engineering = (await post('/v1/org/departments', { name: 'Engineering' })).id;
  const operations = (await post('/v1/org/departments', { name: 'Operations' })).id;
  const hire = async (
    first: string,
    last: string,
    jobTitle: string,
    departmentId: string,
    extra: Record<string, unknown> = {},
  ) =>
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
  const mira = await hire('Mira', 'Marsh', 'Engineering manager', engineering, { managerId: olive });
  const eli = await hire('Eli', 'Evans', 'Software engineer', engineering, { managerId: mira });
  const dev = await hire('Dev', 'Dale', 'Platform engineer', engineering, { managerId: mira });
  await hire('Omar', 'Osei', 'Operations analyst', operations, { managerId: harper });
  await hire('Priya', 'Patel', 'Product designer', engineering, { managerId: mira });

  // sign-ins: an HR admin for everyone, the manager of Engineering and an employee
  const roles = await apiCall<Array<{ id: string; key: string }>>(owner.request, 'GET', '/v1/roles');
  const invited = await post<{ userId: string }>(`/v1/employees/${harper}/invite`, {});
  await post(`/v1/users/${invited.userId}/role-assignments`, {
    roleId: roles.find((r) => r.key === 'hr_admin')!.id,
    scope: { type: 'all' },
  });
  await post(`/v1/employees/${mira}/invite`, { roles: ['manager'] });
  await post(`/v1/employees/${eli}/invite`, {});

  // Eli's pending day off, waiting for Mira
  const types = await apiCall<Array<{ id: string; key: string }>>(owner.request, 'GET', '/v1/leave/types');
  const annual = types.find((t) => t.key === 'annual') ?? types[0];
  const day = futureWorkingDay();
  if (annual) {
    const r = await owner.request.post('/v1/leave/requests', {
      data: {
        employeeId: eli,
        leaveTypeId: annual.id,
        startDate: day,
        endDate: day,
        note: 'Fictional day out',
      },
    });
    if (!r.ok()) console.warn(`role-views: leave request not created (${r.status()})`);
  }

  const domain = `${slug}.example.test`;
  ws = {
    slug,
    pages: {
      owner,
      hr_admin: await signInFromInvite(browser, `harper.hughes@${domain}`),
      manager: await signInFromInvite(browser, `mira.marsh@${domain}`),
      employee: await signInFromInvite(browser, `eli.evans@${domain}`),
    },
    names: { owner: 'Olive Owner', hr_admin: 'Harper Hughes', manager: 'Mira Marsh', employee: 'Eli Evans' },
    profileId: dev,
    managerRoleId: roles.find((r) => r.key === 'manager')!.id,
  };
  for (const r of ROLES) mkdirSync(join(OUT, r), { recursive: true });
});

test.afterAll(async () => {
  for (const p of Object.values(ws?.pages ?? {})) await p.context().close();
});

for (const role of ROLES) {
  test(`the app as ${role}`, async () => {
    test.setTimeout(300_000);
    const page = ws.pages[role]!;
    const session = await (await page.request.get('/v1/auth/session')).json();
    expect(session.roles).toContain(role);

    await page.goto('/app');
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    await shot(page, role, 'home');

    // the directory, or what someone without it is shown
    await page.goto('/app/people');
    await shot(page, role, 'people');

    await page.goto(`/app/people/${ws.profileId}`);
    await shot(page, role, 'profile');

    await page.goto('/app/time-off');
    await shot(page, role, 'time-off');

    await page.goto('/app/reports');
    await shot(page, role, 'reports');

    await page.goto('/app/settings');
    await shot(page, role, 'settings');

    // global search with a query: pages, actions and people the role may open
    await page.goto('/app');
    await settle(page);
    await page.keyboard.press('Control+K');
    const search = page.getByRole('dialog');
    await expect(search).toBeVisible();
    await page.keyboard.type('time');
    await expect(search.getByRole('option').first()).toBeVisible();
    await shot(page, role, 'search');
    await page.keyboard.press('Escape');

    // the account menu, with the role names
    await page
      .locator('header')
      .getByRole('button', { name: new RegExp(`^${ws.names[role]}`) })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await shot(page, role, 'account-menu');
    await page.keyboard.press('Escape');

    // for the owner: the role comparison, and the preview of what the manager role is shown
    if (role === 'owner') {
      await page.goto('/app/settings/roles/compare');
      await expect(page.getByRole('region', { name: 'Permissions' })).toBeVisible();
      await shot(page, role, 'roles-compare');
      await page.goto(`/app/settings/roles/compare?role=${ws.managerRoleId}#compare-preview`);
      await expect(page.locator('#compare-preview').getByRole('status')).toContainText('Manager');
      await page.locator('#compare-preview').scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        document.getElementById('compare-preview')?.scrollIntoView({ block: 'start' }),
      );
      await shot(page, role, 'roles-preview');
    }
  });
}
