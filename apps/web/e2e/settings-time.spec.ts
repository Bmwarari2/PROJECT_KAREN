import { expect, test } from '@playwright/test';
import { addDays, dayOfWeek, today } from '../../../packages/core/src/time';
import { companyWithStaff } from './time-helpers';
import { axeBoth } from './settings-helpers';

// UK English labels (the en-US catalogue says "Schedule" and "Time clock"); fictional data only.
test.use({ locale: 'en-GB' });

test.describe('time and attendance settings', () => {
  test('switching working-time rules to block stops a shift that breaks the daily rest rule', async ({
    page,
  }) => {
    const co = await companyWithStaff(page, 1);
    await page.goto('/app/settings/time');
    const rules = page.getByRole('region', { name: 'Working-time rules', exact: true });
    await expect(rules.getByLabel('Warn the scheduler')).toBeChecked();
    await rules.getByLabel('Block the shift').check();
    await rules.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
    expect((await (await page.request.get('/v1/settings/time')).json()).enforcement).toBe('block');
    await axeBoth(page);

    // Monday's late shift ends at 23:00; a Tuesday start at 06:00 leaves 7 hours' rest (GB needs 11)
    const d = today('Europe/London');
    const monday = addDays(d, 1 - dayOfWeek(d));
    const late = await page.request.post('/v1/shifts', {
      data: { employeeId: co.staff[0], date: monday, start: '14:00', end: '23:00', breakMinutes: 60 },
    });
    expect(late.status(), await late.text()).toBe(201);
    await page.goto('/app/rota');
    const grid = page.getByRole('grid', { name: /Rota for the week of/ });
    await grid.getByRole('button', { name: /^Add shift for Ada Fictional on Tuesday/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Add shift' });
    await dialog.getByLabel('Start').fill('06:00');
    await dialog.getByLabel('Finish').fill('12:00');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'This shift would break a working-time rule, so it was not saved.',
    );
    await expect(dialog.getByRole('alert')).toContainText('Less than the minimum daily rest between shifts');
  });

  test('enable geofencing for GB with the notice workers see, set the store area, and the clock page shows the notice', async ({
    page,
  }) => {
    await companyWithStaff(page, 1);
    await page.goto('/app/settings/time');
    const geo = page.getByRole('region', { name: 'Geofencing', exact: true });
    await expect(geo).toContainText('Geofencing is off in every country.');
    await geo.getByLabel('Country', { exact: true }).fill('gb');
    await expect(geo.getByLabel('Country', { exact: true })).toHaveValue('GB');
    // a notice is required before location is ever recorded
    await geo.getByRole('button', { name: 'Turn on geofencing' }).click();
    await expect(geo.getByRole('alert')).toHaveText(
      'Write the notice workers will see in at least one language.',
    );
    await geo
      .getByLabel('Notice for workers (English (UK))')
      .fill('Fictional Shops checks you are at the store when you clock in or out.');
    await geo.getByRole('button', { name: 'Turn on geofencing' }).click();
    await expect(page.getByText('Geofencing saved for GB.', { exact: true })).toBeVisible();
    await expect(geo.getByTestId('geofence-GB')).toContainText('Fictional Shops checks you are at the store');
    expect((await (await page.request.get('/v1/settings/time')).json()).geofence).toEqual({
      countries: ['GB'],
      notice: { GB: { 'en-GB': 'Fictional Shops checks you are at the store when you clock in or out.' } },
    });

    const sites = page.getByRole('region', { name: 'Site areas', exact: true });
    await sites.getByRole('button', { name: 'Edit the area for Fictional Store London' }).click();
    const dialog = page.getByRole('dialog', { name: 'Area for Fictional Store London' });
    await dialog.getByLabel('Latitude').fill('51.5');
    await dialog.getByLabel('Longitude').fill('-0.12');
    await dialog.getByLabel('Radius (metres)').fill('200');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(sites.getByRole('row', { name: /Fictional Store London/ })).toContainText(
      '51.5, -0.12 (within 200 m)',
    );
    await expect(sites.getByRole('row', { name: /Fictional Store London/ })).toContainText('Geofencing on');
    await axeBoth(page);

    await page.getByRole('link', { name: 'Manage kiosks' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Clock in' })).toBeVisible();
    await expect(page.getByTestId('geofence-notice')).toContainText(
      'Fictional Shops checks you are at the store',
    );
  });
});
