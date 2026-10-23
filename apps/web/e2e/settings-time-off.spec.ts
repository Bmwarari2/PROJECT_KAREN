import { expect, test, type Page } from '@playwright/test';
import { today } from '../../../packages/core/src/time';
import { apiCall, signUpAndEnrol } from './helpers';
import { axeBoth } from './settings-helpers';

// UK English labels; fictional data only.
test.use({ locale: 'en-GB' });

async function companyWithAda(page: Page) {
  await signUpAndEnrol(page);
  const entity = (
    await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', {
      name: 'Fictional Shops Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
  const ada = (
    await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', {
      startDate: '2025-01-06',
      legalFirstName: 'Ada',
      legalLastName: 'Fictional',
      jobTitle: 'Store associate',
      entityId: entity,
      weeklyHours: 37.5,
      payAmountMinor: 2_600_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
    })
  ).id;
  return { entity, ada };
}

test.describe('time off and absence settings', () => {
  test('create a leave policy, assign it to a fictional employee and see it applied to their balance', async ({
    page,
  }) => {
    const { ada } = await companyWithAda(page);
    const year = today('Europe/London').slice(0, 4);
    await page.goto('/app/settings/leave');
    await expect(
      page
        .getByRole('region', { name: 'Leave types', exact: true })
        .getByRole('row', { name: /Annual leave/ }),
    ).toBeVisible();

    const form = page.getByRole('region', { name: 'Add a leave policy', exact: true });
    await form.getByLabel('Name', { exact: true }).fill('Fictional 30 days');
    await form.getByLabel('Type', { exact: true }).selectOption({ label: 'Annual leave' });
    await form.getByLabel('All at the start of the leave year').check();
    await form.getByLabel('Days per year').fill('30');
    await form.getByLabel('Waiting period (days)').fill('0');
    await form.getByLabel('Allow unused leave to carry over').check();
    await form.getByLabel('Most days carried over').fill('5');
    await form.getByLabel('Use within (months)').fill('3');
    await form.getByLabel('Rounding').selectOption({ label: 'Rounded to the nearest half day' });
    await axeBoth(page);
    await form.getByRole('button', { name: 'Add policy' }).click();
    await expect(page.getByText('Leave policy added.', { exact: true })).toBeVisible();

    const policy = page
      .getByRole('region', { name: 'Policies', exact: true })
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Fictional 30 days' }) });
    await expect(policy).toContainText('30 days a year, given at the start of the year');
    await expect(policy).toContainText('Up to 5 days, used within 3 months');
    await expect(policy).toContainText('0 assigned');
    await policy.getByRole('button', { name: 'Assign Fictional 30 days to people' }).click();
    const dialog = page.getByRole('dialog', { name: 'Assign Fictional 30 days' });
    await dialog.getByLabel('From').fill(`${year}-01-01`);
    await dialog.getByLabel('Ada Fictional').check();
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByText('Policy assigned. People added: 1.', { exact: true })).toBeVisible();
    await expect(policy).toContainText('1 assigned');

    const check = page.getByRole('region', { name: 'Check a balance', exact: true });
    await check.getByLabel('Person').selectOption({ label: 'Ada Fictional' });
    const row = check.getByRole('row', { name: /Annual leave/ });
    await expect(row).toContainText('Fictional 30 days');
    await expect(row.getByRole('cell').nth(2)).toHaveText('30 days');
    await axeBoth(page);
    // the same balance from the API, and on Ada's profile
    const balances = await apiCall<Array<{ leaveType: string; policy: string; entitlement: number }>>(
      page.request,
      'GET',
      `/v1/leave/balances/${ada}`,
    );
    expect(balances.find((b) => b.leaveType === 'annual')).toMatchObject({
      policy: 'Fictional 30 days',
      entitlement: 30,
    });
    await page.goto(`/app/people/${ada}`);
    await page.getByRole('tab', { name: 'Time off' }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Time off' }).getByRole('row', { name: /Annual leave/ }),
    ).toContainText('Fictional 30 days');
    // time off in lieu is earned through an adjustment on the profile
    const adjust = page.getByRole('form', { name: 'Adjust a balance' });
    await adjust.getByLabel('Type', { exact: true }).selectOption({ label: 'Time off in lieu' });
    await adjust.getByLabel('Kind of adjustment').selectOption({ label: 'Time off in lieu earned' });
    await adjust.getByLabel('Amount').fill('1.5');
    await adjust.getByLabel('Reason').fill('Fictional stocktake on a Sunday');
    await adjust.getByRole('button', { name: 'Adjust balance' }).click();
    await expect(page.getByText('Balance adjusted.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('balance-toil')).toHaveText('1.5 days');
    await axeBoth(page);
  });

  test('company closure days, an absence trigger alert and a cover rule', async ({ page }) => {
    await companyWithAda(page);
    await page.goto('/app/settings/calendars');
    const form = page.getByRole('region', { name: 'Add a calendar', exact: true });
    await form.getByLabel('Name', { exact: true }).fill('Winter closure');
    await form.getByLabel('Date 1').fill('2026-12-29');
    await form.getByLabel('Name of day 1').fill('Company closure');
    await form.getByRole('button', { name: 'Add a day' }).click();
    await form.getByLabel('Date 2').fill('2026-12-30');
    await form.getByLabel('Name of day 2').fill('Company closure');
    await form.getByRole('button', { name: 'Add calendar' }).click();
    await expect(page.getByText('Company calendar added.', { exact: true })).toBeVisible();
    const calendars = page.getByRole('region', { name: 'Calendars', exact: true });
    await expect(calendars).toContainText('Winter closure');
    await expect(calendars).toContainText('29 Dec 2026');
    await expect(calendars).toContainText('30 Dec 2026');
    await axeBoth(page);

    await page.goto('/app/settings/absence');
    const triggers = page.getByRole('region', { name: 'Absence trigger alerts', exact: true });
    await triggers.getByLabel('Name', { exact: true }).fill('Bradford 250');
    // without a threshold the form explains what is missing
    await triggers.getByRole('button', { name: 'Add trigger alert' }).click();
    await expect(triggers.getByRole('alert')).toHaveText(
      'Set a Bradford score, a number of spells, or both.',
    );
    await triggers.getByLabel('Bradford score').fill('250');
    await triggers.getByRole('button', { name: 'Add trigger alert' }).click();
    await expect(triggers.getByRole('row', { name: /Bradford 250/ })).toContainText(
      'Bradford score is 250 or more',
    );
    await expect(triggers.getByRole('row', { name: /Bradford 250/ })).toContainText(
      'HR admin and the manager',
    );

    const cover = page.getByRole('region', { name: 'Minimum cover', exact: true });
    await cover.getByLabel('Name', { exact: true }).fill('Two on the shop floor');
    await cover.getByLabel('Minimum on duty').fill('2');
    await cover.getByLabel('Refuse the request').check();
    await cover.getByRole('button', { name: 'Add cover rule' }).click();
    await expect(cover.getByRole('row', { name: /Two on the shop floor/ })).toContainText(
      'Refuse the request',
    );

    const policyCard = page.getByRole('region', { name: 'Absence policy', exact: true });
    await policyCard.getByLabel('Ask for a fit note after (calendar days)').fill('7');
    await policyCard.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
    expect(await (await page.request.get('/v1/settings/absence')).json()).toMatchObject({
      fitNoteAfterCalendarDays: 7,
    });
    await axeBoth(page);
  });
});
