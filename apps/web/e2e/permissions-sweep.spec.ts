import { expect, test, type Browser, type Page, type Response } from '@playwright/test';
import { allows, hasFromGrants, pageFor } from '@thapsus/core/capabilities';
import { apiCall, lastMailTo, signUpAndEnrol, totp } from './helpers';
import { sql } from './time-helpers';

/**
 * What you cannot do, you do not see (PROGRESS 16.2, ADR-0188). One fictional workspace with a login for
 * every built-in role. Each role opens every page its navigation offers (the rail — the phone menu sheet
 * shows the same list — the module tabs, the settings side list and index, and the phone tab bar) and the
 * sweep fails on:
 *  - any API call answered 403 while the page loads, or "You do not have permission" on screen;
 *  - a settings page the role may open but not change that still shows a save control or a switch;
 *  - a tab-bar entry that is not in the role's navigation.
 * All people, names and addresses are fictional.
 */
const ROLES = [
  'owner',
  'hr_admin',
  'entity_hr_admin',
  'payroll_admin',
  'it_admin',
  'manager',
  'employee',
] as const;
type RoleKey = (typeof ROLES)[number];
const FORBIDDEN = 'You do not have permission';

test.use({ locale: 'en-GB', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });

const CONTEXT = {
  viewport: { width: 1280, height: 900 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  reducedMotion: 'reduce' as const,
};
const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

let pages: Partial<Record<RoleKey, Page>> = {};

/** An admin role needs a second factor before anything else; the shell sends them to set one up. */
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
  const link = magicLink((await lastMailTo(email)).text);
  const page = await (await browser.newContext(CONTEXT)).newPage();
  await page.goto(link);
  await page.waitForURL(/\/app(\/security.*)?$/);
  await ensureSecondFactor(page);
  return page;
}

/** Waits until the page has its data: no requests in flight and no skeletons. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('main .animate-pulse'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
}

const appLinks = async (page: Page, selector: string) =>
  (
    await page
      .locator(selector)
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''))
  )
    .map((h) => h.split('?')[0]!.split('#')[0]!)
    .filter((h) => h === '/app' || h.startsWith('/app/'));

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
      name: 'Fictional Works Bristol',
      country: 'GB',
      regionCode: 'GB-ENG',
      timeZone: 'Europe/London',
      entityId: entity,
    })
  ).id;
  const department = (await post('/v1/org/departments', { name: 'Fictional Operations' })).id;
  const hire = async (first: string, last: string, jobTitle: string, extra: Record<string, unknown> = {}) =>
    (
      await post('/v1/employees', {
        startDate: '2025-03-03',
        legalFirstName: first,
        legalLastName: last,
        jobTitle,
        departmentId: department,
        entityId: entity,
        locationId: location,
        weeklyHours: 37.5,
        payAmountMinor: 3_600_000,
        payCurrency: 'GBP',
        payFrequency: 'annual',
        contractType: 'permanent',
        workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.test`,
        ...extra,
      })
    ).id;
  const olive = await hire('Olive', 'Owner', 'Managing director', { workEmail: undefined });
  await sql('UPDATE app.users SET employee_id = $1 WHERE lower(email) = lower($2)', [olive, email]);
  const people = {
    hr_admin: await hire('Hana', 'Harbour', 'People partner', { managerId: olive }),
    entity_hr_admin: await hire('Ezra', 'Elm', 'HR advisor', { managerId: olive }),
    payroll_admin: await hire('Pia', 'Penn', 'Payroll lead', { managerId: olive }),
    it_admin: await hire('Ivo', 'Iris', 'IT support lead', { managerId: olive }),
    manager: await hire('Mina', 'Moss', 'Operations manager', { managerId: olive }),
  };
  const employee = await hire('Eden', 'Ember', 'Operations associate', { managerId: people.manager });
  const roles = await apiCall<Array<{ id: string; key: string }>>(owner.request, 'GET', '/v1/roles');
  const roleId = (key: string) => roles.find((r) => r.key === key)!.id;
  for (const key of ['hr_admin', 'entity_hr_admin', 'payroll_admin', 'it_admin'] as const) {
    const invited = await post<{ userId: string }>(`/v1/employees/${people[key]}/invite`, {});
    await post(`/v1/users/${invited.userId}/role-assignments`, {
      roleId: roleId(key),
      scope: key === 'entity_hr_admin' ? { type: 'entity', values: [entity] } : { type: 'all' },
    });
  }
  await post(`/v1/employees/${people.manager}/invite`, { roles: ['manager'] });
  await post(`/v1/employees/${employee}/invite`, {});

  const domain = `${slug}.example.test`;
  pages = {
    owner,
    hr_admin: await signInFromInvite(browser, `hana.harbour@${domain}`),
    entity_hr_admin: await signInFromInvite(browser, `ezra.elm@${domain}`),
    payroll_admin: await signInFromInvite(browser, `pia.penn@${domain}`),
    it_admin: await signInFromInvite(browser, `ivo.iris@${domain}`),
    manager: await signInFromInvite(browser, `mina.moss@${domain}`),
    employee: await signInFromInvite(browser, `eden.ember@${domain}`),
  };
});

test.afterAll(async () => {
  for (const p of Object.values(pages)) await p?.context().close();
});

for (const role of ROLES) {
  test(`${role}: every page in the navigation opens without a refused call or a control it cannot use`, async () => {
    test.setTimeout(900_000);
    const page = pages[role]!;
    const session = (await (await page.request.get('/v1/auth/session')).json()) as {
      roles: string[];
      permissions: string[];
      employeeId: string | null;
    };
    expect(session.roles).toContain(role);
    const viewer = { has: hasFromGrants(session.permissions), employeeId: session.employeeId };

    const refused: string[] = [];
    const onResponse = (r: Response) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith('/v1/') && r.status() === 403)
        refused.push(`${r.request().method()} ${url.pathname}`);
    };
    page.on('response', onResponse);
    const problems: string[] = [];
    try {
      await page.goto('/app');
      await settle(page);
      const rail = await appLinks(page, '#app-rail a');
      expect(rail.length, `${role} has a navigation`).toBeGreaterThan(1);
      const dock = await appLinks(page, 'nav[aria-label="Main sections"] a');
      const queue = [...rail];
      const seen = new Set<string>();
      while (queue.length) {
        const href = queue.shift()!;
        if (seen.has(href)) continue;
        seen.add(href);
        refused.length = 0;
        await page.goto(href);
        await settle(page);
        // the module's tabs, the settings side list and the settings index are navigation too
        for (const l of [
          ...(await appLinks(page, '[data-tab-nav] a')),
          ...(await appLinks(page, '#settings-sections a')),
          ...(href === '/app/settings' ? await appLinks(page, 'main a[href^="/app/settings/"]') : []),
        ])
          if (!seen.has(l) && !queue.includes(l)) queue.push(l);
        if (refused.length) problems.push(`${href}: refused ${[...new Set(refused)].join(', ')}`);
        if ((await page.locator('body').innerText()).includes(FORBIDDEN))
          problems.push(`${href}: shows "${FORBIDDEN}"`);
        // a settings page the role may open but not change is read-only: no save controls, no switches
        const entry = pageFor(href);
        if (href.startsWith('/app/settings/') && entry?.manage && !allows(viewer, entry.manage)) {
          const saves = page.locator('main form:not([role="search"]) button[type="submit"]:visible');
          const switches = page.locator('main input[role="switch"]:visible:enabled');
          const n = (await saves.count()) + (await switches.count());
          if (n) problems.push(`${href}: read-only for ${role} but shows ${n} save control(s)`);
        }
      }
      for (const d of dock) if (!seen.has(d)) problems.push(`tab bar: ${d} is not in the navigation`);
      // the sweep followed the tabs and settings lists beyond the rail (the owner sees nearly every page)
      test.info().annotations.push({ type: 'pages opened', description: `${role}: ${seen.size}` });
      expect(seen.size, role).toBeGreaterThan(rail.length);
      if (role === 'owner') expect(seen.size).toBeGreaterThanOrEqual(60);
      // the rail never offers a page the role may not open (it would show the not-allowed state)
      for (const href of seen) {
        const entry = pageFor(href);
        if (entry && !allows({ ...viewer, askHr: true }, entry.view))
          problems.push(`${href}: in the navigation but not allowed by the permission map`);
      }
    } finally {
      page.off('response', onResponse);
    }
    expect(problems, `${role}: pages that refuse or show controls the role cannot use`).toEqual([]);
  });
}

test('a page the role may not open is not in its navigation and shows the not-allowed state', async () => {
  const page = pages.employee!;
  await page.goto('/app');
  await settle(page);
  expect(await appLinks(page, '#app-rail a')).not.toContain('/app/settings');
  await page.goto('/app/settings/branding');
  await expect(page.locator('main')).toContainText(FORBIDDEN);
  // the HR admin opens Settings → Branding read-only: the colours, no Save colour (the reported bug)
  const hr = pages.hr_admin!;
  await hr.goto('/app/settings/branding');
  await settle(hr);
  await expect(hr.getByText('You can view these settings.')).toBeVisible();
  await expect(hr.getByRole('button', { name: 'Save colour' })).toHaveCount(0);
  await expect(hr.getByRole('button', { name: 'Upload logo' })).toHaveCount(0);
  const owner = pages.owner!;
  await owner.goto('/app/settings/branding');
  await settle(owner);
  await expect(owner.getByRole('button', { name: 'Save colour' })).toBeVisible();
});
