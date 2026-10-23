import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { E2E_DB } from './env';
import { expectAccessible, PASSWORD, signUpAndEnrol } from './helpers';
import { expectModulePage, moduleTabs, openModule } from './module-helpers';

/**
 * Phase 6 flows in the browser (functional project, axe on every screen): a payroll admin exports a
 * pay period and downloads the file; an employee finds and downloads their own payslip; an employee
 * acknowledges the handover of an asset. All data is fictional.
 */
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
/** Argon2id hash of the shared fictional e2e PASSWORD (precomputed so the spec needs no native module). */
const PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$LY2ACSeLwNUvhHDFBQyj/g$b4doX/i3NvlC83OTdo8OolsXpPNcDkj3PmDAndThna0';
const PDF = Buffer.from(
  '%PDF-1.4\n% fictional payslip for an e2e test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
);

test.describe.configure({ mode: 'serial' });
// UK English (en-US spellings and terms such as “pay stubs” are covered by the catalogue tests)
test.use({ locale: 'en-GB' });

let ws: { slug: string; secret: string; email: string };
let tenantId: string;
const person = { id: '', number: 'E2E-001', email: '' };
/**
 * The admin's session from sign-up. Signing the admin in again needs a fresh TOTP code, and a code is
 * accepted once per 30-second step, so each re-sign-in waited up to 30 s; the tests reuse this session
 * instead (and never sign it out), and the employee signs in after the admin's cookies are cleared.
 */
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>>;

async function asAdmin(page: Page) {
  await page.context().addCookies(adminCookies);
}
async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`/signin?workspace=${ws.slug}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/app$/);
}

/** Gives the fictional employee a self-service login (an invite flow is outside Phase 6). */
async function employeeLogin() {
  const db = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const u = await db.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES ($1, $2, 'Emma Fictional', $3) RETURNING id`,
      [tenantId, person.email, person.id],
    );
    await db.query(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)',
      [tenantId, u.rows[0]!.id, PASSWORD_HASH],
    );
    await db.query(
      `INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type, scope_values) SELECT $1, $2, r.id, 'self', '{}' FROM app.roles r WHERE r.tenant_id = $1 AND r.key = 'employee'`,
      [tenantId, u.rows[0]!.id],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

test('a payroll admin exports a pay period and downloads the file', async ({ page }) => {
  ws = await signUpAndEnrol(page);
  adminCookies = await page.context().cookies();
  person.email = `emma@${ws.slug}.example.test`;
  const post = async (url: string, data: unknown) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  tenantId = (await (await page.request.get('/v1/auth/session')).json()).tenantId;
  const entity = (
    await post('/v1/org/legal-entities', {
      name: 'Fictional E2E Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  person.id = (
    await post('/v1/employees', {
      startDate: '2026-03-02',
      employeeNumber: person.number,
      legalFirstName: 'Emma',
      legalLastName: 'Fictional',
      jobTitle: 'Analyst',
      entityId: entity,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
    })
  ).id;
  await post('/v1/payroll/periods', {
    name: 'March 2026',
    frequency: 'monthly',
    startDate: '2026-03-01',
    endDate: '2026-03-31',
  });

  await page.goto('/app/payroll');
  await expectModulePage(page, 'Pay', 'Payroll');
  await page.getByLabel('Connector name').fill('Bureau CSV');
  await page.getByLabel('Payroll system or format').selectOption('csv');
  await page.getByRole('button', { name: 'Add connector' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Bureau CSV' })).toBeVisible();
  await page.getByRole('button', { name: 'Close period: March 2026' }).click();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export: March 2026' }).click();
  const file = 'bureau-csv-2026-03-01_2026-03-31.zip';
  await expect(page.getByText(file)).toBeVisible();
  await expect(page.getByText('Closed period')).toBeVisible();
  await expectAccessible(page);

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: `Download: ${file}` }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(file);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  const exported = (await (await page.request.get('/v1/payroll/exports')).json())[0];
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(exported.sha256);
  // the download is in the delivery log
  await page.reload();
  await expect(page.getByText('Delivered')).toBeVisible();
});

test('an employee sees and downloads only their own payslip', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/app/payslips');
  await page.getByLabel('Label', { exact: true }).fill('March 2026');
  await page.getByLabel('Files', { exact: true }).setInputFiles([
    { name: `${person.number}_2026-03.pdf`, mimeType: 'application/pdf', buffer: PDF },
    {
      name: 'someone-else_2026-03.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.concat([PDF, Buffer.from('% other\n')]),
    },
  ]);
  await page.getByRole('button', { name: 'Upload and match' }).click();
  await expect(page.getByText('1 of 2 matched')).toBeVisible();
  await expect(page.getByText('Not matched')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Publish matched' }).click();
  await expect(page.getByText('Documents published: 1. People notified: 0.', { exact: true })).toBeVisible(); // the employee has no login yet

  await employeeLogin();
  await signIn(page, person.email);
  // an employee's Pay module has one tab, so the rail opens their payslips (no payroll tab)
  await openModule(page, 'Pay');
  await page.waitForURL(/\/app\/payslips$/);
  await expect(moduleTabs(page, 'Pay')).toHaveCount(0);
  await expect(page.getByText('March 2026')).toBeVisible();
  await expect(page.getByText('New', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upload payslips or year-end documents' })).toHaveCount(0);
  await expectAccessible(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download: March 2026' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${person.number}_2026-03.pdf`);
  expect((await readFile((await download.path())!)).equals(PDF)).toBe(true);
  // the payroll screens are not available to employees
  expect((await page.request.get('/v1/payroll/connectors')).status()).toBe(403);
});

test('an employee acknowledges the handover of an asset', async ({ page }) => {
  await asAdmin(page);
  await page.goto('/app/assets');
  await expectModulePage(page, 'IT', 'Equipment');
  // the register's toolbar opens the form in a dialog
  await page.getByRole('button', { name: 'Add asset' }).click();
  const add = page.getByRole('dialog', { name: 'Add an asset' });
  await add.getByLabel('Asset tag').fill('LT-E2E-1');
  await add.getByLabel('Name', { exact: true }).fill('Fictional Laptop 13');
  await add.getByLabel('Type').selectOption('laptop');
  await add.getByLabel('Serial number').fill('FL13-0001');
  await add.getByLabel('Cost (GBP)').fill('999.00');
  await add.getByRole('button', { name: 'Add asset' }).click();
  await expect(add).toBeHidden();
  const register = page.getByRole('region', { name: 'Asset register' });
  await expect(register.getByRole('cell', { name: 'Fictional Laptop 13', exact: true })).toBeVisible();
  await expect(page.getByText('1 asset', { exact: true })).toBeVisible();
  // the search in the toolbar narrows the register
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('no such laptop');
  await expect(page.getByText('Nothing matches these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(register.getByRole('cell', { name: 'Fictional Laptop 13', exact: true })).toBeVisible();
  await expect(page.getByText('£999.00')).toBeVisible();
  await page.getByRole('button', { name: 'Issue: Fictional Laptop 13' }).click();
  await page.getByLabel('Employee').selectOption({ label: 'Emma Fictional' });
  await page.getByRole('dialog').getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Awaiting confirmation')).toBeVisible();
  await expectAccessible(page);

  await signIn(page, person.email);
  await page.goto('/app/assets');
  await expect(page.getByText('Fictional Laptop 13')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm receipt: Fictional Laptop 13' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('FL13-0001')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm receipt' })).toBeDisabled();
  await expectAccessible(page);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByText(/^Confirmed /)).toBeVisible();
  await expectAccessible(page);
  const mine = await (await page.request.get('/v1/me/assets')).json();
  expect(mine[0].acknowledgedAt).toBeTruthy();
  expect(mine[0].acknowledgementStatement).toBe('assets.ackStatement.v1');
});

test('the integrations dry run shows the exact calls; every Phase 6 screen passes axe in light and dark', async ({
  page,
}) => {
  await asAdmin(page);
  await page.goto('/app/integrations');
  const domain = page.locator('#microsoft365-domain'); // both provider cards have a "Domain for new accounts" field
  await domain.fill('fictional-e2e.example');
  await domain.locator('xpath=ancestor::form').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Waiting for consent')).toBeVisible();
  await page.getByLabel('Employee').selectOption({ label: 'Emma Fictional' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Account emma.fictional@fictional-e2e.example')).toBeVisible();
  await expect(page.getByText('POST https://graph.microsoft.com/v1.0/users', { exact: true })).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const path of ['/app/payroll', '/app/payslips', '/app/integrations', '/app/assets']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }
  }
});
