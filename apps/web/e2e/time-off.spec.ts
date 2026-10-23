import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { E2E_DB } from './env';
import { expectAccessible, signUpAndEnrol } from './helpers';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';

/** Links the signed-in user to a fictional employee record (user invitations arrive in a later phase). */
async function linkUserToEmployee(email: string, employeeId: string) {
  const c = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await c.connect();
  try {
    await c.query('UPDATE app.users SET employee_id = $2 WHERE email = $1', [email, employeeId]);
  } finally {
    await c.end();
  }
}

async function post(request: APIRequestContext, url: string, data: unknown) {
  const res = await request.post(url, { data });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()) as { id: string };
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

test.describe('time off', () => {
  test('an employee requests leave, sees it waiting for approval, and the page passes axe (light and dark)', async ({
    page,
  }) => {
    const { email } = await signUpAndEnrol(page);
    await page
      .context()
      .addCookies([{ name: 'thr_locale', value: 'en-GB', url: new URL(page.url()).origin }]);
    const entity = await post(page.request, '/v1/org/legal-entities', {
      name: 'Fictional Leave Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    });
    const person = {
      startDate: '2025-01-06',
      jobTitle: 'Analyst',
      entityId: entity.id,
      weeklyHours: 37.5,
      payAmountMinor: 3_120_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
    };
    const manager = await post(page.request, '/v1/employees', {
      ...person,
      legalFirstName: 'Mina',
      legalLastName: 'Manager',
    });
    const me = await post(page.request, '/v1/employees', {
      ...person,
      legalFirstName: 'Olive',
      legalLastName: 'Owner',
      managerId: manager.id,
    });
    await linkUserToEmployee(email, me.id);

    await page.goto('/app/time-off');
    await expect(page.getByRole('heading', { name: 'Time off', level: 1 })).toBeVisible();
    await expect(page.getByText('days available').first()).toBeVisible();
    await expect(page.getByText('No requests yet.')).toBeVisible();

    const day = futureWorkingDay();
    await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Annual leave' });
    await page.getByLabel('From', { exact: true }).fill(day);
    await page.getByLabel('To', { exact: true }).fill(day);
    await page.getByLabel('Note (optional)').fill('Fictional day out');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Request sent for approval (1 day).', { exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Annual leave' });
    await expect(row).toContainText('Waiting');
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // HR (here the owner) can record sickness for someone else; no medical detail is shown.
    await expect(page.getByRole('heading', { name: 'Record sickness' })).toBeVisible();

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await expectAccessible(page);
    }
  });
});
