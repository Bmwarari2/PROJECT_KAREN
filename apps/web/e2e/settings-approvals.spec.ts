import { expect, test, type Page } from '@playwright/test';
import { addDays, today } from '../../../packages/core/src/time';
import { apiCall, lastMailTo, signUpAndEnrol } from './helpers';
import { axeBoth } from './settings-helpers';
import { expectPageTitle } from './module-helpers';

// UK English labels; fictional data only.
test.use({ locale: 'en-GB' });

const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

async function company(page: Page) {
  const owner = await signUpAndEnrol(page);
  const entity = (
    await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', {
      name: 'Fictional UK Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  const hire = async (first: string, values: Record<string, unknown> = {}) =>
    (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', {
        startDate: '2025-01-06',
        legalFirstName: first,
        legalLastName: 'Fictional',
        jobTitle: 'Analyst',
        entityId: entity,
        payAmountMinor: 3_000_000,
        payCurrency: 'GBP',
        payFrequency: 'annual',
        contractType: 'permanent',
        ...values,
      })
    ).id;
  return { ...owner, entity, hire };
}

test.describe('approvals and workflows settings', () => {
  test('create an approval chain with a condition, two steps and escalation, then edit it', async ({
    page,
  }) => {
    await company(page);
    await page.goto('/app/settings/approval-chains');
    await expect(page.getByText('No approval chains yet')).toBeVisible();
    await page.getByRole('button', { name: 'New approval chain' }).click();
    const editor = page.getByRole('region', { name: 'New approval chain', exact: true });
    await expect(editor.getByRole('heading', { name: 'New approval chain' })).toBeFocused();
    await editor.getByLabel('Name', { exact: true }).fill('Long time off');
    await editor.getByLabel('Request type').selectOption({ label: 'Time off requests' });
    await editor.getByLabel('Only use this chain when a condition is met').check();
    await editor.getByLabel('Detail', { exact: true }).fill('amountDays');
    await editor.getByLabel('Test', { exact: true }).selectOption({ label: 'is at least' });
    await editor.getByLabel('Value', { exact: true }).fill('10');

    const step = (n: number) =>
      editor
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: `Step ${n}`, exact: true }) });
    await step(1)
      .getByRole('group', { name: 'Approver' })
      .getByLabel('Who')
      .selectOption({ label: 'Their manager' });
    await step(1).getByLabel('Escalate after (hours)').fill('48');
    await expect(step(1).getByRole('group', { name: 'Escalate to' }).getByLabel('Role')).toHaveValue(
      'hr_admin',
    );
    await editor.getByRole('button', { name: 'Add a step' }).click();
    await step(2)
      .getByRole('group', { name: 'Approver' })
      .getByLabel('Who')
      .selectOption({ label: 'Anyone with a role' });
    await step(2)
      .getByRole('group', { name: 'Approver' })
      .getByLabel('Role')
      .selectOption({ label: 'Company owner' });
    // a person approver needs a person: the browser's required check stops the form and nothing is saved
    await editor.getByRole('button', { name: 'Add a step' }).click();
    await step(3)
      .getByRole('group', { name: 'Approver' })
      .getByLabel('Who')
      .selectOption({ label: 'A specific person' });
    const person = step(3).getByLabel('Choose Person');
    await expect(person).toBeVisible();
    await editor.getByRole('button', { name: 'Save' }).click();
    expect(await person.evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
    expect(await (await page.request.get('/v1/approval-policies')).json()).toEqual([]);
    await step(3).getByRole('button', { name: 'Remove step 3' }).click();
    await axeBoth(page);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Approval chain saved.', { exact: true })).toBeVisible();

    const card = page.getByRole('region', { name: 'Time off requests', exact: true });
    await expect(card).toContainText('Long time off');
    await expect(card).toContainText('Used when Days requested is at least 10.');
    await expect(card).toContainText(
      'Step 1: their manager · escalates after 48 hours to anyone who is HR admin',
    );
    await expect(card).toContainText('Step 2: anyone who is Company owner');
    await axeBoth(page);

    await card.getByRole('button', { name: 'Edit Long time off' }).click();
    const edit = page.getByRole('region', { name: 'Edit Long time off', exact: true });
    await edit.getByLabel('Name', { exact: true }).fill('Long time off (two steps)');
    await edit.getByLabel('This chain is in use').uncheck();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText('Long time off (two steps)');
    await expect(card.getByText('Off', { exact: true })).toBeVisible();
    const [policy] = await (await page.request.get('/v1/approval-policies')).json();
    expect(policy).toMatchObject({
      subject: 'leave.request',
      name: 'Long time off (two steps)',
      enabled: false,
      condition: { field: 'amountDays', op: 'gte', value: 10 },
    });
    expect(policy.steps).toEqual([
      { approver: { type: 'manager' }, timeoutHours: 48, escalateTo: { type: 'role', value: 'hr_admin' } },
      { approver: { type: 'role', value: 'owner' } },
    ]);
  });

  test('create an offboarding template with tasks, assignees, relative due dates and reminders', async ({
    page,
  }) => {
    await company(page);
    await page.goto('/app/settings/workflows');
    await page.getByRole('button', { name: 'New template' }).click();
    const editor = page.getByRole('region', { name: 'New workflow template', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill('Fictional leaver checklist');
    await editor.getByLabel('Type', { exact: true }).selectOption({ label: 'Offboarding' });
    await expect(editor.getByLabel('Start automatically')).toBeChecked();
    const task = (n: number) =>
      editor
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: `Task ${n}`, exact: true }) });
    await task(1).getByLabel('Task', { exact: true }).fill('Collect the laptop');
    await task(1).getByLabel('Who').selectOption({ label: 'Their manager' });
    await task(1).getByLabel('Due (days from the leaving date)').fill('-3');
    await task(1).getByLabel('Reminder (days before it is due)').fill('1');
    await editor.getByRole('button', { name: 'Add a task' }).click();
    await task(2).getByLabel('Task', { exact: true }).fill('Close the payroll record');
    await task(2).getByLabel('Who').selectOption({ label: 'Anyone with a role' });
    await task(2).getByLabel('Role').selectOption({ label: 'Payroll admin' });
    await task(2).getByLabel('Due (days from the leaving date)').fill('0');
    await axeBoth(page);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Workflow template saved.', { exact: true })).toBeVisible();

    const card = page.getByRole('region', { name: 'Fictional leaver checklist', exact: true });
    await expect(card).toContainText('Starts automatically');
    await expect(card.getByRole('row', { name: /Collect the laptop/ })).toContainText(
      '3 days before the leaving date',
    );
    await expect(card.getByRole('row', { name: /Collect the laptop/ })).toContainText(
      '1 day before it is due',
    );
    await expect(card.getByRole('row', { name: /Close the payroll record/ })).toContainText(
      'On the leaving date',
    );
    await expect(card.getByRole('row', { name: /Close the payroll record/ })).toContainText(
      'Anyone who is Payroll admin',
    );
    const [tpl] = await (await page.request.get('/v1/workflow-templates')).json();
    expect(tpl).toMatchObject({
      kind: 'offboarding',
      autoStart: true,
      tasks: [
        {
          title: 'Collect the laptop',
          assignee: { type: 'manager' },
          dueOffsetDays: -3,
          reminderDaysBefore: 1,
        },
        {
          title: 'Close the payroll record',
          assignee: { type: 'role', value: 'payroll_admin' },
          dueOffsetDays: 0,
        },
      ],
    });
    await axeBoth(page);
  });

  test('start a leaver from a profile (their reports move to someone else) and transfer a colleague', async ({
    page,
  }) => {
    const co = await company(page);
    const location = (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/locations', {
        name: 'Fictional Store Leeds',
        country: 'GB',
        regionCode: 'GB-ENG',
        timeZone: 'Europe/London',
        entityId: co.entity,
      })
    ).id;
    const morgan = await co.hire('Morgan', { jobTitle: 'Team lead' });
    await co.hire('Reese', { managerId: morgan });
    const pat = await co.hire('Pat');

    await page.goto(`/app/people/${morgan}`);
    await page.getByRole('button', { name: 'Start leaver' }).click();
    const dialog = page.getByRole('dialog', { name: 'Start a leaver for Morgan Fictional' });
    await dialog.getByLabel('Last working day').fill('2026-12-18');
    await dialog.getByLabel('Reason').fill('Resigned (fictional)');
    await dialog.getByLabel('Move their direct reports to').selectOption({ label: 'Pat Fictional' });
    await dialog.getByRole('button', { name: 'Start leaver' }).click();
    await expect(
      page.getByText('Leaver started for Morgan Fictional. Last working day: 18 Dec 2026.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('leaving-on')).toHaveText('Leaving on 18 Dec 2026');
    await expect(page.getByRole('button', { name: 'Start leaver' })).toHaveCount(0);
    expect(
      (await apiCall<{ employee: { endDate: string } }>(page.request, 'GET', `/v1/employees/${morgan}`))
        .employee.endDate,
    ).toBe('2026-12-18');
    await axeBoth(page);

    await page.goto(`/app/people/${pat}`);
    await page.getByRole('button', { name: 'Transfer' }).click();
    const transfer = page.getByRole('dialog', { name: 'Transfer Pat Fictional' });
    await transfer.getByRole('button', { name: 'Transfer' }).click();
    await expect(transfer.getByRole('alert')).toHaveText('Choose at least one thing to change.');
    await transfer.getByLabel('Location').selectOption({ label: 'Fictional Store Leeds' });
    await transfer.getByLabel('Job title').fill('Senior analyst');
    await transfer.getByRole('button', { name: 'Transfer' }).click();
    await expect(page.getByText(/^Pat Fictional transfers on /)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Pat Fictional' })).toBeVisible();
    await expect(page.getByText('Senior analyst').first()).toBeVisible();
    const after = await apiCall<{ employee: { jobTitle: string; locationId: string } }>(
      page.request,
      'GET',
      `/v1/employees/${pat}`,
    );
    expect(after.employee).toMatchObject({ jobTitle: 'Senior analyst', locationId: location });
  });

  test('a manager delegates their approvals to a colleague for a period and ends it', async ({
    page,
    browser,
  }) => {
    const co = await company(page);
    const email = `mona.manager@${co.slug}.example.test`;
    const mona = await co.hire('Mona', { jobTitle: 'Store manager', workEmail: email });
    await apiCall(page.request, 'POST', `/v1/employees/${mona}/invite`, { roles: ['manager'] });

    const context = await browser.newContext({ locale: 'en-GB' });
    const mp = await context.newPage();
    await mp.goto(magicLink((await lastMailTo(email)).text));
    await mp.waitForURL(/\/app$/);
    await mp.goto('/app/approvals');
    await mp.getByRole('link', { name: 'Delegate approvals' }).click();
    await expectPageTitle(mp, 'Settings', 'Delegations');
    // a manager sees only the settings they may use
    const subnav = mp.getByRole('navigation', { name: 'Settings sections' });
    await expect(subnav.getByRole('link', { name: 'Delegations' })).toBeVisible();
    await expect(subnav.getByRole('link', { name: 'Single sign-on' })).toHaveCount(0);

    const start = today('Europe/London');
    await mp.getByLabel('Search for Delegate').fill('Olive');
    await mp.getByLabel('Choose Delegate').selectOption({ label: 'Olive Owner' });
    await mp.getByLabel('First day').fill(start);
    await mp.getByLabel('Last day').fill(addDays(start, 6));
    await mp.getByRole('button', { name: 'Delegate approvals' }).click();
    await expect(mp.getByText('Approvals delegated.', { exact: true })).toBeVisible();
    const row = mp
      .getByRole('region', { name: 'Delegated by you', exact: true })
      .getByRole('row', { name: /Olive Owner/ });
    await expect(row).toContainText('Active');
    await axeBoth(mp);
    // the owner sees it as received
    await page.goto('/app/settings/delegations');
    await expect(
      page
        .getByRole('region', { name: 'Delegated to you', exact: true })
        .getByRole('row', { name: /Mona Fictional/ }),
    ).toContainText('Active');

    await row.getByRole('button', { name: 'End now: delegation to Olive Owner' }).click();
    await mp
      .getByRole('dialog', { name: 'End the delegation to Olive Owner?' })
      .getByRole('button', { name: 'End now' })
      .click();
    await expect(row).toContainText('Ended');
    await context.close();
  });
});
