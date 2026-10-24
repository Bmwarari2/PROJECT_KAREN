import pg from 'pg';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_DB } from './env';
import { expectAccessible, PASSWORD } from './helpers';
import { companyWithStaff, sql } from './time-helpers';

/**
 * Phase 16 part C (16.11–16.14) in the browser, end to end: an onboarding step "Send the statement of main terms"
 * carries the send_document action. HR opens the task, goes on to prepare and send the statement (the template is
 * already chosen, a missing value blocks sending until it is typed in, the filled PDF is previewed in the viewer),
 * the employee signs in the viewer, HR signs for the company after a step-up re-authentication, the task closes
 * and the completed PDF shows both signatures. All people, companies and documents are fictional.
 */
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
/** Argon2id hash of the shared fictional e2e PASSWORD (as in documents-sign.spec.ts). */
const PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$LY2ACSeLwNUvhHDFBQyj/g$b4doX/i3NvlC83OTdo8OolsXpPNcDkj3PmDAndThna0';

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

let co: Awaited<ReturnType<typeof companyWithStaff>>;
let ben: { id: string; email: string };
let tenantId: string;
let page: Page;
let templateId: string;
let taskId: string;
let documentId: string;

async function employeeLogin(employeeId: string, email: string) {
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
  const p = await context.newPage();
  await p.goto(`/signin?workspace=${co.slug}`);
  await p.getByLabel('Email').fill(ben.email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await p.waitForURL(/\/app$/);
  return { context, page: p };
}

test.beforeAll(async ({ browser, baseURL }) => {
  page = await (await browser.newContext({ baseURL, locale: 'en-GB' })).newPage();
  co = await companyWithStaff(page, 2);
  tenantId = (await (await page.request.get('/v1/auth/session')).json()).tenantId;
  ben = { id: co.staff[1]!, email: `ben@${co.slug}.example.test` };
  await employeeLogin(ben.id, ben.email);
  // the statement of terms: a contract the company signs too, with one value typed in when sending
  const tpl = await page.request.post('/v1/document-templates', {
    data: {
      name: 'Statement of main terms',
      category: 'contract',
      body: '# Your employment\n\nEmployee: **{{employee.displayName}}**\nJob title: {{employee.jobTitle}}\nStart date: {{employee.startDate}}\nPay: {{pay.rate}}\n\nYour continuous employment began on {{ask.continuousEmployment}}.\n\nA fictional sample statement for the end-to-end test.',
      askFields: [{ key: 'continuousEmployment', label: 'Date continuous employment began', required: true }],
    },
  });
  expect(tpl.status(), await tpl.text()).toBe(201);
  templateId = (await tpl.json()).id;
  // an onboarding workflow whose step carries the send_document action (16.14)
  const wf = await sql<{ id: string }>(
    `INSERT INTO app.workflow_templates (tenant_id, kind, name, tasks, auto_start) VALUES ($1, 'onboarding', 'Fictional onboarding (UK)', $2, false) RETURNING id`,
    [
      tenantId,
      JSON.stringify([
        {
          key: 'contract',
          title: 'Send the statement of main terms',
          assignee: { type: 'role', value: 'owner' },
          dueOffsetDays: -7,
          action: { kind: 'send_document', params: { templateId } },
        },
      ]),
    ],
  );
  const started = await page.request.post('/v1/workflows', {
    data: { templateId: wf[0]!.id, employeeId: ben.id, anchorDate: '2025-01-06' },
  });
  expect(started.status(), await started.text()).toBe(201);
  taskId = (
    await sql<{ id: string }>(`SELECT id FROM app.tasks WHERE source = 'workflow' AND source_id = $1`, [
      (await started.json()).id,
    ])
  )[0]!.id;
});
test.afterAll(async () => page.context().close());

test('HR opens the task and prepares and sends the statement: missing values block sending until filled in', async () => {
  await page.goto(`/app/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: 'Send the statement of main terms' })).toBeVisible();
  // the task's main button opens the send page with the person, template and task chosen (Prepare and send)
  const go = page.locator(
    `a[href="/app/people/${ben.id}/documents/new?template=${templateId}&task=${taskId}"]`,
  );
  await expect(go).toBeVisible();
  await go.click();
  await page.waitForURL(new RegExp(`/app/people/${ben.id}/documents/new\\?template=`));
  await expect(page.getByRole('heading', { name: 'New document for Ben Fictional' })).toBeVisible();
  await expect(page.getByLabel('Template', { exact: true })).toHaveValue(templateId);
  // the value the template asks for is missing, so sending is blocked
  const missing = page.getByRole('region', { name: '1 value is missing' });
  await expect(missing).toContainText('Date continuous employment began: type it in above');
  const send = page.getByRole('button', { name: 'Send for signature' });
  await expect(send).toBeDisabled();
  await page.getByLabel('Date continuous employment began').fill('6 January 2025');
  await expect(missing).toHaveCount(0);
  await expect(send).toBeEnabled();
  // the filled PDF in the viewer
  const preview = page.getByRole('region', { name: /Preview of Statement of main terms, page 1 of 1/ });
  await expect(preview).toContainText('Ben Fictional', { timeout: 30_000 });
  await expect(preview).toContainText('Your continuous employment began on 6 January 2025.');
  await expect(preview).toContainText('Signatures');
  // the company signs too (the template's default), after Ben
  await expect(page.getByLabel('Ask Ben Fictional to sign')).toBeChecked();
  await expect(page.getByLabel('The company signs')).toBeChecked();
  await expect(page.getByLabel('Ben Fictional first')).toBeChecked();
  await page.getByLabel(/^Message/).fill('Please read and sign your statement (fictional).');
  await expectAccessible(page);
  await send.click();
  await page.waitForURL(/\/app\/documents\/[0-9a-f-]{36}$/);
  documentId = page.url().split('/').pop()!;
  const status = page.getByRole('region', { name: 'Signing', exact: true });
  await expect(status).toContainText('Waiting for Ben Fictional to sign');
  await expect(status).toContainText('Sent for signature by Olive Owner');
  await expect(status.getByRole('button', { name: 'Send a reminder' })).toBeVisible();
  await expectAccessible(page);
});

test('the employee signs in the viewer; HR signs for the company after step-up; the task closes', async ({
  browser,
  baseURL,
}) => {
  const { context, page: emp } = await asEmployee(browser, baseURL);
  await emp.goto('/app/documents');
  await emp
    .getByRole('region', { name: 'Waiting for your signature' })
    .getByRole('link', { name: 'Statement of main terms' })
    .click();
  await emp.waitForURL(new RegExp(`/app/documents/${documentId}$`));
  const panel = emp.getByRole('region', { name: 'Review and sign' });
  await expect(panel).toContainText('Please read and sign your statement (fictional).');
  await panel.getByRole('button', { name: 'I have read it' }).click();
  await panel.getByLabel('I have read this document and agree to sign it electronically.').check();
  await panel.getByRole('button', { name: 'Continue' }).click();
  await panel.getByLabel('Type your full name').fill('Ben Fictional');
  // the typed name is the signature, shown in the handwriting font; drawing is the other option
  await expect(panel.getByLabel('Use my typed name')).toBeChecked();
  await expect(panel.getByText('How your signature will look')).toBeVisible();
  await expectAccessible(emp);
  await panel.getByRole('button', { name: 'Sign document' }).click();
  await expect(panel).toContainText('It now goes to the company for its countersignature.');
  await context.close();

  // the owner's sign-in is no longer recent: signing for the company asks them to confirm it is them
  await sql(
    `UPDATE app.sessions SET created_at = now() - interval '11 minutes', reauthenticated_at = NULL WHERE tenant_id = $1 AND user_id = (SELECT id FROM app.users WHERE tenant_id = $1 AND lower(email) = lower($2))`,
    [tenantId, co.email],
  );
  await page.goto(`/app/documents/${documentId}`);
  await expect(page.getByRole('region', { name: 'Signing', exact: true })).toContainText(
    'Waiting for the company',
  );
  const cs = page.getByRole('region', { name: 'Countersign' });
  await expect(cs).toContainText('Ben Fictional signed this on');
  await cs.getByRole('button', { name: 'I have read it' }).click();
  await cs.getByLabel(/I countersign it electronically for the company/).check();
  await cs.getByLabel('Type your full name').fill('Olive Owner');
  await cs.getByRole('button', { name: 'Countersign document' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel('Password').fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  // complete: the signed copy opens, with both signatures in its signature block
  await page.waitForURL(/\/app\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Statement of main terms (signed)' })).toBeVisible();
  const signedPage = page.getByRole('region', { name: /Statement of main terms \(signed\), page 1 of/ });
  await expect(signedPage).toContainText('Ben Fictional', { timeout: 30_000 });
  await expect(signedPage).toContainText('Olive Owner');
  await expect(signedPage).toContainText('For and on behalf of Fictional Shops Ltd');

  // the task the statement was sent from is done, and the original's timeline shows every step
  const task = await sql<{ status: string }>('SELECT status FROM app.tasks WHERE id = $1', [taskId]);
  expect(task[0]!.status).toBe('done');
  await page.goto(`/app/tasks/${taskId}`);
  await expect(page.getByTestId('task-detail')).toContainText('Done');
  await page.goto(`/app/documents/${documentId}`);
  const status = page.getByRole('region', { name: 'Signing', exact: true });
  await expect(status).toContainText('Signed and complete');
  await expect(status).toContainText('Ben Fictional signed (typed name)');
  await expect(status).toContainText('Signed for the company by Olive Owner');
  await expectAccessible(page);
  const audit = await sql<{ action: string }>(
    `SELECT action FROM audit.events WHERE tenant_id = $1 AND action IN ('document.sent', 'document.signed', 'document.countersigned', 'document.completed', 'task.completed', 'auth.reauthenticated') ORDER BY id`,
    [tenantId],
  );
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining([
      'document.sent',
      'document.signed',
      'auth.reauthenticated',
      'document.countersigned',
      'document.completed',
      'task.completed',
    ]),
  );
});

test('Settings → Documents: the template editor flags unknown fields, previews a sample person and saves versions', async () => {
  await page.goto('/app/settings');
  const group = page.getByRole('region', { name: 'Documents', exact: true });
  await group.getByRole('link', { name: /Document templates/ }).click();
  await page.waitForURL(/\/app\/settings\/documents\/templates$/);
  // the starter samples, labelled as samples
  const samples = page.getByRole('region', { name: 'Starter templates' });
  await expect(samples).toContainText('Statement of main terms (UK)');
  await expect(samples).toContainText('Written statement of terms (Ireland)');
  await expect(samples).toContainText('Offer letter (US)');
  await expectAccessible(page);
  await page.getByRole('link', { name: 'New template' }).click();
  await page.waitForURL(/\/templates\/new$/);
  await page.getByLabel('Name', { exact: true }).fill('Fictional welcome letter');
  const body = page.getByLabel('Text', { exact: true });
  await body.fill('Welcome');
  await page.getByRole('button', { name: 'Heading', exact: true }).click();
  await body.press('End');
  await body.pressSequentially('\n\nDear ');
  await page.getByLabel('Field', { exact: true }).selectOption({ label: 'Legal first name' });
  await page.getByRole('button', { name: 'Insert field' }).click();
  await body.press('End');
  await body.pressSequentially(', your manager is {{employee.boss}}.');
  // an unknown field is flagged and the template cannot be saved
  await expect(
    page.getByRole('alert').filter({ hasText: '1 field is not one Thapsus-HR knows' }),
  ).toContainText('{{employee.boss}}');
  const create = page.getByRole('button', { name: 'Create template' });
  await expect(create).toBeDisabled();
  await body.fill(
    '# Welcome\n\nDear {{employee.firstName}}, your manager is {{manager.name}}.\n\n- **Start:** {{employee.startDate}}',
  );
  // the live preview fills it in for a fictional sample person
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText('Dear Alex, your manager is Sam Sample.');
  await expect(preview).toContainText('Start: 2 November 2026');
  await expectAccessible(page);
  await create.click();
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Version 1', { exact: true }).first()).toBeVisible();
  await page
    .getByLabel('Text', { exact: true })
    .fill('# Welcome\n\nDear {{employee.firstName}}, welcome aboard.');
  await page.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Versions' })).toContainText('Version 2');
  // on a phone the editor stacks and nothing scrolls sideways
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel('Text', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('This template is archived.')).toBeVisible();

  // authorised signatories: HR admins and owners until a list is saved
  await page.goto('/app/settings/documents/signatories');
  await expect(page.getByRole('note')).toContainText('HR admins and owners sign for the company');
  await expect(page.getByLabel('Company owner')).toBeChecked();
  await expect(page.getByRole('region', { name: 'Who can sign now' })).toContainText('Olive Owner');
  await expectAccessible(page);

  // bulk send: count first, then send with progress
  await page.goto('/app/documents/bulk-send');
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'Statement of main terms' });
  await page.getByLabel('Date continuous employment began').fill('6 January 2025');
  await page.getByRole('button', { name: 'Count people' }).click();
  await expect(page.getByText(/\d+ (people match|person matches)/)).toBeVisible();
  await expectAccessible(page);
});
