import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_DB } from './env';
import { expectAccessible, PASSWORD } from './helpers';
import { companyWithStaff, sql } from './time-helpers';

/**
 * Documents people read, sign and receive in the app (ADR-0165 to ADR-0169), in the browser:
 *  - an employee opens a document waiting for their signature, reads it in the in-app PDF viewer (PDF.js, text
 *    layer), signs it in the review-and-sign panel and downloads the signed copy, with no CSP violation;
 *  - a contract needs the company's countersignature: HR reviews it in the same viewer and countersigns;
 *  - HR attaches right-to-work evidence (kept in the vault) and a driving licence (shared) to the person, and the
 *    person sees only what was shared with them.
 * All people, documents and files are fictional.
 */
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
/** Argon2id hash of the shared fictional e2e PASSWORD (as in reports-ess.spec.ts). */
const PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$LY2ACSeLwNUvhHDFBQyj/g$b4doX/i3NvlC83OTdo8OolsXpPNcDkj3PmDAndThna0';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from(
  '%PDF-1.4\n% fictional right-to-work evidence\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
);

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

let co: Awaited<ReturnType<typeof companyWithStaff>>;
let ben: { id: string; email: string };
let tenantId: string;
/** The owner (who has every permission, HR included) stays signed in across the tests. */
let page: Page;

test.beforeAll(async ({ browser, baseURL }) => {
  page = await (await browser.newContext({ baseURL, locale: 'en-GB' })).newPage();
  co = await companyWithStaff(page, 2);
  tenantId = (await (await page.request.get('/v1/auth/session')).json()).tenantId;
  ben = { id: co.staff[1]!, email: `ben@${co.slug}.example.test` };
  await employeeLogin(tenantId, ben.id, ben.email);
});
test.afterAll(async () => page.context().close());

/** Gives Ben (an employee in the fictional workspace) a self-service login. */
async function employeeLogin(tenantId: string, employeeId: string, email: string) {
  const db = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const u = await db.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES ($1, $2, 'Ben Fictional', $3) RETURNING id`,
      [tenantId, email, employeeId],
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

async function asEmployee(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(`/signin?workspace=${co.slug}`);
  await page.getByLabel('Email').fill(ben.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/app$/);
  return { context, page };
}

const cspViolations = (page: Page) => {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (execute|load|compile|create)/i.test(m.text()))
      seen.push(m.text());
  });
  return seen;
};

async function template(page: Page, name: string, category: string, body: string) {
  const r = await page.request.post('/v1/document-templates', { data: { name, category, body } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as string;
}
async function sendForSignature(page: Page, templateId: string) {
  const r = await page.request.post(`/v1/document-templates/${templateId}/generate`, {
    data: { employeeId: ben.id, requireSignature: true },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).documentId as string;
}

test('the employee opens a document to sign, reads it in the app, signs it and downloads the signed copy', async ({
  browser,
  baseURL,
}) => {
  // a letter long enough for two pages
  const paragraphs = Array.from(
    { length: 20 },
    (_, i) =>
      `${i + 1}. Fictional clause ${i + 1}: your new shift pattern applies from next month, with the same hours and the same pay. This sample text only fills the page.`,
  ).join('\n\n');
  const letter = await template(
    page,
    'Change of shift pattern',
    'letter',
    `Dear {{employee.firstName}},\n\n${paragraphs}`,
  );
  const doc = await sendForSignature(page, letter);

  const { context, page: emp } = await asEmployee(browser, baseURL);
  const csp = cspViolations(emp);
  await emp.goto('/app/documents');
  const toSign = emp.getByRole('region', { name: 'Waiting for your signature' });
  await toSign.getByRole('link', { name: 'Change of shift pattern' }).click();
  await emp.waitForURL(new RegExp(`/app/documents/${doc}$`));
  // the PDF is drawn in the page, with its text selectable and readable
  const page1 = emp.getByRole('region', { name: 'Change of shift pattern, page 1 of 2' });
  await expect(page1).toContainText('Dear Ben,', { timeout: 30_000 });
  await emp.getByRole('button', { name: 'Next page' }).click();
  await expect(emp.getByRole('region', { name: 'Change of shift pattern, page 2 of 2' })).toContainText(
    '20.',
  );
  await emp.getByRole('button', { name: 'Zoom in' }).click();
  await emp.getByRole('button', { name: 'Fit to width' }).click();
  const panel = emp.getByRole('region', { name: 'Review and sign' });
  await expect(panel).toContainText('You have looked at 2 of 2 pages.');
  await expectAccessible(emp);
  await panel.getByRole('button', { name: 'I have read it' }).click();
  await panel.getByLabel('I have read this document and agree to sign it electronically.').check();
  await panel.getByRole('button', { name: 'Continue' }).click();
  await panel.getByLabel('Type your full name').fill('Ben Fictional');
  await panel.getByRole('button', { name: 'Sign document' }).click();
  // the signed copy opens in the viewer, ready to download
  await emp.waitForURL(/\/app\/documents\/[0-9a-f-]{36}\?signed=1$/);
  await expect(emp.getByText('You signed the document.')).toBeVisible();
  await expect(emp.getByRole('heading', { name: 'Change of shift pattern (signed)' })).toBeVisible();
  const downloading = emp.waitForEvent('download');
  await emp.getByRole('link', { name: 'Download Change of shift pattern (signed)' }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('Change_of_shift_pattern_signed.pdf');
  expect(
    readFileSync((await file.path())!)
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
  // the view and the download are in the audit log
  const actions = await sql<{ action: string }>(
    `SELECT action FROM audit.events WHERE tenant_id = $1 AND action IN ('document.viewed', 'document.downloaded', 'document.signed') ORDER BY id`,
    [tenantId],
  );
  expect(actions.map((a) => a.action)).toEqual(
    expect.arrayContaining(['document.viewed', 'document.signed', 'document.downloaded']),
  );
  expect(csp).toEqual([]);
  await context.close();
});

test('a contract waits for the company: HR reviews it in the viewer and countersigns, then it is complete', async ({
  browser,
  baseURL,
}) => {
  const contract = await template(
    page,
    'Statement of terms',
    'contract',
    'Employee: {{employee.displayName}}\nFictional sample contract.',
  );
  const doc = await sendForSignature(page, contract);
  const { context, page: emp } = await asEmployee(browser, baseURL);
  await emp.goto(`/app/documents/${doc}`);
  const panel = emp.getByRole('region', { name: 'Review and sign' });
  await panel.getByRole('button', { name: 'I have read it' }).click();
  await panel.getByLabel('I have read this document and agree to sign it electronically.').check();
  await panel.getByRole('button', { name: 'Continue' }).click();
  await panel.getByLabel('Type your full name').fill('Ben Fictional');
  await panel.getByRole('button', { name: 'Sign document' }).click();
  await expect(panel).toContainText('It now goes to the company for its countersignature.');

  // HR (the owner here) has it to countersign, in the documents list and in the viewer
  await page.goto('/app/documents');
  await page
    .getByRole('region', { name: 'Waiting for your countersignature' })
    .getByRole('link', { name: 'Statement of terms' })
    .click();
  const cs = page.getByRole('region', { name: 'Countersign' });
  await expect(cs).toContainText('Ben Fictional signed this on');
  await expectAccessible(page);
  await cs.getByRole('button', { name: 'I have read it' }).click();
  await cs.getByLabel(/I countersign it electronically for the company/).check();
  await cs.getByLabel('Type your full name').fill('Olive Owner');
  await cs.getByRole('button', { name: 'Countersign document' }).click();
  await page.waitForURL(/\/app\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Statement of terms (signed)' })).toBeVisible();

  await emp.goto(`/app/documents/${doc}`);
  await expect(emp.getByRole('region', { name: 'Review and sign' })).toContainText('Signed and complete on');
  await context.close();
});

test('HR attaches right-to-work evidence and a driving licence; the employee sees only what was shared with them', async ({
  browser,
  baseURL,
}) => {
  await page.goto(`/app/people/${ben.id}`);
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Attach document' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Attach a document to Ben Fictional' });
  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: 'Right-to-work evidence' });
  await dialog.getByLabel('Kind of evidence').selectOption({ label: 'Passport' });
  await expect(dialog.getByLabel('HR only')).toBeChecked();
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles({ name: 'ben-passport.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(dialog.getByText('ben-passport.pdf')).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.getByText('Attached: Right-to-work evidence', { exact: true })).toBeVisible();
  const docs = page.getByRole('region', { name: 'Documents', exact: true });
  await expect(docs.getByRole('link', { name: 'Right-to-work evidence' })).toBeVisible();

  await page.getByRole('button', { name: 'Attach document' }).first().click();
  dialog = page.getByRole('dialog', { name: 'Attach a document to Ben Fictional' });
  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: 'Driving licence' });
  await dialog.getByLabel('Title', { exact: true }).fill('Driving licence (copy)');
  await dialog.getByLabel('Expiry date').fill('2034-06-30');
  await expect(dialog.getByLabel('HR and Ben Fictional')).toBeChecked();
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles({ name: 'licence.png', mimeType: 'image/png', buffer: PNG });
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(docs.getByRole('link', { name: 'Driving licence (copy)' })).toBeVisible();
  const rtwId = (
    await sql<{ id: string }>(
      `SELECT id FROM app.documents WHERE employee_id = $1 AND attachment_type = 'right_to_work'`,
      [ben.id],
    )
  )[0]!.id;

  const { context, page: emp } = await asEmployee(browser, baseURL);
  await emp.goto('/app/documents');
  await expect(emp.getByRole('link', { name: 'Driving licence (copy)' })).toBeVisible();
  await expect(emp.getByRole('link', { name: 'Right-to-work evidence' })).toHaveCount(0);
  await emp.getByRole('link', { name: 'Driving licence (copy)' }).click();
  await expect(emp.getByRole('img', { name: 'Driving licence (copy)' })).toBeVisible();
  await expect(emp.getByText('Expires', { exact: true })).toBeVisible();
  await expect(emp.getByText('HR note')).toHaveCount(0);
  await expectAccessible(emp);
  // the evidence HR kept to itself does not open for them
  await emp.goto(`/app/documents/${rtwId}`);
  await expect(
    emp.getByRole('heading', { name: 'This document does not exist or you cannot open it' }),
  ).toBeVisible();
  await context.close();
});
