import { expect, test, type Page } from '@playwright/test';
import { apiCall, expectAccessible, lastMailTo, signUpAndEnrol } from './helpers';

/** Role and access management in the browser, against the real API. Fictional data only. */

const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

async function hire(page: Page, entityId: string, values: Record<string, unknown>) {
  const base = {
    startDate: '2026-01-05',
    entityId,
    jobTitle: 'Analyst',
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
  };
  return (await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', { ...base, ...values })).id;
}

test.describe('roles and access', () => {
  test('an owner creates a custom role, gives it to an employee for one department, and that person sees only what it allows', async ({
    page,
    browser,
  }) => {
    const { slug } = await signUpAndEnrol(page);
    const entity = (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', {
        name: 'Fictional UK Ltd',
        country: 'GB',
        currency: 'GBP',
        timeZone: 'Europe/London',
      })
    ).id;
    const engineering = (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/departments', { name: 'Engineering' })
    ).id;
    const sales = (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/departments', { name: 'Sales' })
    ).id;
    const danaEmail = `dana.developer@${slug}.example.test`;
    const dana = await hire(page, entity, {
      legalFirstName: 'Dana',
      legalLastName: 'Developer',
      departmentId: engineering,
      workEmail: danaEmail,
    });
    const eli = await hire(page, entity, {
      legalFirstName: 'Eli',
      legalLastName: 'Engineer',
      departmentId: engineering,
      jobTitle: 'Platform engineer',
    });
    const sara = await hire(page, entity, {
      legalFirstName: 'Sara',
      legalLastName: 'Seller',
      departmentId: sales,
      jobTitle: 'Account executive',
    });
    await apiCall(page.request, 'POST', `/v1/employees/${dana}/invite`, {});

    // the owner creates the role in settings
    await page.goto('/app/settings');
    await page.getByRole('link', { name: 'Roles and permissions', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Roles and permissions' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Company owner' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'New role' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New role' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Engineering viewer');
    await expect(page.getByLabel('Identifier')).toHaveValue('engineering_viewer');
    await page.getByLabel('View people', { exact: true }).check();
    for (const field of ['Name', 'Job title', 'Department'])
      await page.getByRole('radio', { name: `${field}: View`, exact: true }).check();
    await expect(page.getByLabel('Admin role')).not.toBeChecked();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create role' }).click();
    await page.waitForURL(/\/app\/settings\/roles\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Engineering viewer' })).toBeVisible();
    await expect(page.getByLabel('View people', { exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Job title: View', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Pay: Default', exact: true })).toBeChecked();

    // …and assigns it to Dana for Engineering only
    await page.goto('/app/settings/users');
    await page.getByRole('searchbox', { name: 'Search by name or email' }).fill('Dana');
    await page.getByRole('link', { name: 'Dana Developer' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dana Developer' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Only themselves', exact: true })).toBeVisible();
    await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Engineering viewer' });
    await page.getByLabel('Applies to', { exact: true }).selectOption({ label: 'Departments' });
    await page.getByLabel('Engineering', { exact: true }).check();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Assign role' }).click();
    await expect(page.getByRole('cell', { name: 'Departments: Engineering', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Revoke Engineering viewer (Departments: Engineering)' }),
    ).toBeVisible();

    // Dana signs in from her invitation and sees Engineering colleagues' names and titles only
    const context = await browser.newContext();
    const dp = await context.newPage();
    await dp.goto(magicLink((await lastMailTo(danaEmail)).text));
    await dp.waitForURL(/\/app$/);
    await expect(dp.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await dp.getByRole('link', { name: 'People', exact: true }).click();
    await expect(dp.getByRole('link', { name: 'Eli Engineer' })).toBeVisible();
    await expect(dp.getByRole('link', { name: 'Dana Developer' })).toBeVisible();
    await expect(dp.getByRole('link', { name: 'Sara Seller' })).toHaveCount(0);
    await expectAccessible(dp);
    const listed = await (await dp.request.get('/v1/employees?limit=200')).json();
    expect((listed.data as Array<{ id: string }>).map((r) => r.id).sort()).toEqual([dana, eli].sort());

    await dp.getByRole('link', { name: 'Eli Engineer' }).click();
    await expect(dp.getByRole('heading', { level: 1, name: 'Eli Engineer' })).toBeVisible();
    await expect(dp.getByText('Platform engineer').first()).toBeVisible();
    await expect(dp.getByRole('heading', { name: 'Pay', exact: true })).toHaveCount(0);
    await expect(dp.getByText('£40,000.00')).toHaveCount(0);
    await expect(dp.getByRole('button', { name: 'Make a change' })).toHaveCount(0);
    // outside the department there is nothing to see
    await dp.goto(`/app/people/${sara}`);
    await expect(dp.getByRole('heading', { name: /not allowed|permission/i })).toBeVisible();
    await context.close();
  });
});
