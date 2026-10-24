import { expect, test, type Page } from '@playwright/test';
import { apiCall } from './helpers';
import { axeBoth } from './settings-helpers';
import { companyWithStaff } from './time-helpers';

/**
 * Phase 16 part B (ADR-0191 to ADR-0193): a task explains itself, its main button opens the work with the
 * person already chosen, it closes itself when the work is recorded, and Mark as done is a fallback that
 * asks for a note. One fictional UK workspace; the owner's account is linked to Ada (companyWithStaff).
 */
test.use({ locale: 'en-GB', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });

let page: Page;
let staff: string[];

async function settle(p: Page) {
  await expect(p.locator('h1').first()).toBeVisible({ timeout: 30_000 });
  await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(p.locator('main .animate-pulse'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  page = await (await browser.newContext()).newPage();
  const co = await companyWithStaff(page, 2);
  staff = co.staff;
  // a laptop issued to Ada (the owner's own record): a task to confirm receipt, from the asset register
  const laptop = await apiCall<{ id: string }>(page.request, 'POST', '/v1/assets', {
    assetTag: 'FICT-E2E-1',
    type: 'laptop',
    name: 'Fictional Book 14',
  });
  await apiCall(page.request, 'POST', `/v1/assets/${laptop.id}/assign`, {
    employeeId: staff[0],
    assignedOn: '2026-10-01',
  });
  // a checklist task for Ben in the HR queue (the owner works it), which opens his compliance record
  const tpl = await apiCall<{ id: string }>(page.request, 'POST', '/v1/workflow-templates', {
    kind: 'custom',
    name: 'Fictional review',
    tasks: [
      {
        key: 'records',
        title: 'Check the compliance record',
        description: 'Look over the compliance record before the review meeting. Fictional.',
        assignee: { type: 'role', value: 'hr_admin' },
        dueOffsetDays: 5,
        action: { kind: 'open_person', params: { tab: 'compliance' } },
      },
    ],
  });
  await apiCall(page.request, 'POST', '/v1/workflows', {
    templateId: tpl.id,
    employeeId: staff[1],
    anchorDate: '2026-11-02',
  });
});

test.afterAll(async () => {
  await page.context().close();
});

test('a task explains itself, opens the work and closes itself when the work is recorded', async () => {
  await page.goto('/app/tasks');
  await settle(page);
  const row = page
    .getByTestId('task-list')
    .getByRole('listitem')
    .filter({ hasText: 'Confirm you received Fictional Book 14' });
  // the row says where it comes from, and carries the main button
  await expect(row).toContainText('Asset register');
  await expect(
    row.getByRole('link', { name: 'Confirm you received it: Confirm you received Fictional Book 14' }),
  ).toBeVisible();
  await row.getByRole('link', { name: 'Confirm you received Fictional Book 14', exact: true }).click();
  await expect(page.getByTestId('task-detail')).toBeVisible();
  await expect(page.getByTestId('task-description')).toContainText('You have been given Fictional Book 14');
  await expect(page.getByTestId('task-record-status')).toContainText('Not confirmed yet');
  await expect(page.getByText('This task closes by itself when the work is recorded.')).toBeVisible();
  await expect(page.getByTestId('task-origin')).toHaveText('Asset register');
  await axeBoth(page);
  // the main button opens the handover, already chosen
  const taskUrl = page.url();
  await page.getByTestId('task-main-action').click();
  await page.waitForURL(/\/app\/assets\?ack=/);
  const dialog = page.getByRole('dialog', { name: 'Confirm you received Fictional Book 14' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByText('Thank you. Your confirmation is recorded.').first()).toBeVisible();
  // back on the task: it closed itself
  await page.goto(taskUrl);
  await settle(page);
  await expect(page.getByTestId('task-detail').getByText('Done', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('By itself, when the work was recorded')).toBeVisible();
  await expect(page.getByTestId('task-main-action')).toHaveCount(0);
  await expect(page.getByTestId('task-record-status')).toContainText('Confirmed on');
});

test('Mark as done is the fallback: it asks for a short note, which is kept with the task', async () => {
  await page.goto('/app/tasks');
  await settle(page);
  await page.getByRole('link', { name: 'Check the compliance record', exact: true }).click();
  await expect(page.getByTestId('task-description')).toHaveText(
    'Look over the compliance record before the review meeting. Fictional.',
  );
  const main = page.getByTestId('task-main-action');
  await expect(main).toHaveText(/Open their compliance record/);
  await expect(main).toHaveAttribute('href', `/app/people/${staff[1]}?tab=compliance`);
  await expect(page.getByTestId('task-origin')).toHaveText('Workflow: Fictional review');
  await page.getByRole('button', { name: 'Mark as done instead' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark this task as done' });
  await expect(dialog).toBeVisible();
  // the note is required
  await expect(dialog.getByRole('button', { name: 'Mark as done' })).toBeDisabled();
  await dialog.getByLabel('What was done').fill('Checked with Ben in person. Fictional.');
  await axeBoth(page);
  await dialog.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByText('Task marked as done').first()).toBeVisible();
  await expect(page.getByText('Marked as done by hand')).toBeVisible();
  await expect(page.getByText('Checked with Ben in person. Fictional.')).toBeVisible();
  await expect(page.getByTestId('task-main-action')).toHaveCount(0);
});

test('on a phone the task page fits the screen and stays accessible', async () => {
  const phone = await (
    await page
      .context()
      .browser()!
      .newContext({
        viewport: { width: 390, height: 844 },
        storageState: await page.context().storageState(),
      })
  ).newPage();
  const tasks = await apiCall<Array<{ id: string; title: string }>>(
    phone.request,
    'GET',
    '/v1/tasks?status=all',
  );
  const done = tasks.find((x) => x.title === 'Check the compliance record')!;
  await phone.goto(`/app/tasks/${done.id}`);
  await settle(phone);
  await expect(phone.getByTestId('task-detail')).toBeVisible();
  const width = await phone.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await axeBoth(phone);
  await phone.context().close();
});

test('the workflow editor picks what a task opens and when it is due', async () => {
  await page.goto('/app/settings/workflows');
  await settle(page);
  await page.getByRole('button', { name: 'Edit Fictional review' }).click();
  const editor = page.getByRole('region', { name: 'Edit Fictional review' });
  await expect(editor).toBeVisible();
  const task = editor
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Task 1', exact: true }) });
  await expect(task.getByLabel('What the task opens')).toHaveValue('open_person');
  await task.getByLabel('What the task opens').selectOption({ label: 'Prepare and send a document' });
  await expect(task.getByLabel('Document template')).toHaveValue('');
  await task
    .getByLabel('Due date counted from')
    .selectOption({ label: 'Days from their probation end date' });
  await task.getByLabel('Due (days from their probation end date)').fill('-7');
  await axeBoth(page);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workflow template saved.', { exact: true })).toBeVisible();
  const card = page.getByRole('region', { name: 'Fictional review', exact: true });
  const row = card.getByRole('row', { name: /Check the compliance record/ });
  await expect(row).toContainText('Prepare and send a document');
  await expect(row).toContainText('7 days before their probation end date');
  const [tpl] = await apiCall<Array<{ tasks: unknown[] }>>(page.request, 'GET', '/v1/workflow-templates');
  expect(tpl!.tasks).toEqual([
    expect.objectContaining({
      key: 'records',
      action: { kind: 'send_document', params: {} },
      due: { anchor: 'probation_end', offsetDays: -7 },
    }),
  ]);
});
