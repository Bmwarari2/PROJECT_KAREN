import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { E2E_DB } from './env';
import { expectAccessible, PASSWORD, signUpAndEnrol } from './helpers';

/**
 * Phase 7 in the browser (functional project, axe on every screen): an admin runs a ready-made report
 * for an explicit date, builds and saves a report with a chart, opens schedules and adds a home-region
 * S3 export destination (never contacting AWS); an employee uses the Me hub, views their details and asks
 * HR to change their legal name, and sets notification preferences. All data is fictional.
 */
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
/** Argon2id hash of the shared fictional e2e PASSWORD (precomputed so the spec needs no native module). */
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$LY2ACSeLwNUvhHDFBQyj/g$b4doX/i3NvlC83OTdo8OolsXpPNcDkj3PmDAndThna0';

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

let ws: { slug: string; secret: string; email: string };
let tenantId: string;
const person = { id: '', email: '' };

async function signIn(page: Page, email: string) {
  await page.goto(`/signin?workspace=${ws.slug}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/app$/);
}

/** Gives the fictional employee a self-service login (invitations are outside this phase). */
async function employeeLogin() {
  const db = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const u = await db.query<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES ($1, $2, 'Rhea Fictional', $3) RETURNING id`, [tenantId, person.email, person.id]);
    await db.query('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)', [tenantId, u.rows[0]!.id, PASSWORD_HASH]);
    await db.query(`INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type, scope_values) SELECT $1, $2, r.id, 'self', '{}' FROM app.roles r WHERE r.tenant_id = $1 AND r.key = 'employee'`, [tenantId, u.rows[0]!.id]);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

test('an admin runs a ready-made report, builds and saves a report with a chart, and manages delivery', async ({ page }) => {
  ws = await signUpAndEnrol(page);
  person.email = `rhea@${ws.slug}.example.test`;
  const post = async (url: string, data: unknown) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  tenantId = (await (await page.request.get('/v1/auth/session')).json()).tenantId;
  const entity = (await post('/v1/org/legal-entities', { name: 'Fictional Reports Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' })).id;
  person.id = (await post('/v1/employees', { startDate: '2026-03-02', employeeNumber: 'RPT-001', legalFirstName: 'Rhea', legalLastName: 'Fictional', jobTitle: 'Analyst', entityId: entity, payAmountMinor: 3_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent' })).id;
  await post('/v1/employees', { startDate: '2026-07-01', employeeNumber: 'RPT-002', legalFirstName: 'Sol', legalLastName: 'Fictional', jobTitle: 'Engineer', entityId: entity, payAmountMinor: 4_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent' });

  // catalogue
  await page.getByRole('navigation', { name: 'App' }).first().getByRole('link', { name: 'Reports' }).click();
  await page.waitForURL(/\/app\/reports$/);
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Gender pay gap' })).toBeVisible();
  await expectAccessible(page);

  // a ready-made report for an explicit date (Sol starts after it)
  await page.getByRole('link', { name: 'Headcount', exact: true }).click();
  await page.waitForURL(/\/app\/reports\/ready\/headcount/);
  await page.getByLabel('As of').fill('2026-06-30');
  await page.getByRole('button', { name: 'Run report' }).click();
  const table = page.getByRole('table', { name: 'Headcount' });
  await expect(table.getByRole('cell', { name: 'Fictional Reports Ltd' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'Fictional Reports Ltd' }).getByRole('cell').nth(1)).toHaveText('1');
  await expect(page.getByRole('group', { name: 'Export' }).getByRole('button', { name: 'Excel' })).toBeVisible();
  await expectAccessible(page);

  // the report builder: a list, then a grouped summary with an accessible chart
  await page.goto('/app/reports/builder');
  await expect(page.getByRole('heading', { name: 'Report builder', level: 1 })).toBeVisible();
  await page.getByLabel('As of').fill('2026-07-31');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('cell', { name: 'RPT-002' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Summarise').check();
  await page.getByLabel('Group by, level 1').selectOption({ label: 'Legal entity' });
  await page.getByLabel('Chart', { exact: true }).selectOption({ label: 'Bar chart' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('img', { name: /by Legal entity/ })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Fictional Reports Ltd' }).getByRole('cell').nth(1)).toHaveText('2');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Save report' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('People by entity');
  await page.getByRole('dialog').getByLabel('Dates when run later').selectOption({ label: 'Today' });
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Report saved.', { exact: true })).toBeVisible();

  // saved reports and schedules
  await page.goto('/app/reports');
  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByRole('link', { name: 'People by entity' })).toBeVisible();
  await page.goto('/app/reports/schedules');
  await expect(page.getByRole('heading', { name: 'Scheduled reports', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Schedule a report' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Saved report').selectOption({ label: 'People by entity' });
  await dialog.getByRole('button', { name: /Olive Owner/ }).click();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'People by entity', exact: true })).toBeVisible();
  await expectAccessible(page);

  // a home-region S3 destination (created without contacting AWS; "Test connection" is not pressed)
  await page.goto('/app/reports/exports');
  await expect(page.getByRole('heading', { name: 'Data exports', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add a destination' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name').fill('Fictional data lake');
  await d.getByLabel('Bucket', { exact: true }).fill('fictional-e2e-exports');
  await d.getByLabel('IAM role ARN').fill('arn:aws:iam::123456789012:role/thapsus-hr-export-e2e');
  await d.getByLabel('Bucket region').fill('us-east-2');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('The bucket must be in your home region.', { exact: true })).toBeVisible();
  await d.getByLabel('Bucket region').fill('eu-west-2');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^thr-[0-9a-f]{32}$/)).toBeVisible();
  await expectAccessible(page);

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  for (const path of ['/app/reports', '/app/reports/builder', '/app/reports/schedules', '/app/reports/exports']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page);
  }
  await page.goto('/app/reports/ready/headcount');
  await page.getByLabel('As of').fill('2026-06-30');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByRole('table', { name: 'Headcount' })).toBeVisible();
  await expectAccessible(page);
});

test('an employee uses the Me hub, views their details, asks HR for a change and sets notification preferences', async ({ page }) => {
  await employeeLogin();
  await signIn(page, person.email);
  await page.getByRole('navigation', { name: 'App' }).first().getByRole('link', { name: 'Me', exact: true }).click();
  await page.waitForURL(/\/app\/me$/);
  await expect(page.getByRole('heading', { name: 'Me', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /My details/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Notifications/ }).last()).toBeVisible();
  // reports are not offered to employees
  await expect(page.getByRole('navigation', { name: 'App' }).first().getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole('link', { name: /My details/ }).click();
  await page.waitForURL(/\/app\/me\/details$/);
  await expect(page.getByText('Analyst', { exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Request a change' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Legal last name').fill('Fictional-Jones');
  await dialog.getByLabel('Reason (optional)').fill('Fictional name change');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Waiting for HR', { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.goto('/app/notifications');
  await expect(page.getByRole('heading', { name: 'How you are notified' })).toBeVisible();
  const email = page.getByLabel('Email for Time off');
  await expect(email).toBeChecked();
  await email.uncheck();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Email for Time off')).not.toBeChecked();
  await expect(page.getByLabel('Email for Tasks')).toBeChecked();
  await expectAccessible(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const path of ['/app/me', '/app/me/details', '/app/notifications']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }
  }
});
