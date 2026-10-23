import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import { companyWithStaff, sql } from './time-helpers';

// UK English labels (the catalogue's en-US variant says "Schedule" and "Time clock").
test.use({ locale: 'en-GB' });

test.describe('rota builder', () => {
  test('manager builds a week, publishes it, the employee is notified once and sees the shift (axe on both views)', async ({
    page,
  }) => {
    const co = await companyWithStaff(page, 2);
    await page.goto('/app/rota');
    await expect(page.getByRole('heading', { name: 'Rota', level: 1 })).toBeVisible();
    const grid = page.getByRole('grid', { name: /Rota for the week of/ });
    await expect(grid.getByRole('rowheader', { name: /Ben Fictional/ })).toBeVisible();
    await expect(page.getByText('2 people')).toBeVisible();

    await grid
      .getByRole('button', { name: /Add shift for Ada Fictional on/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add shift' });
    await dialog.getByLabel('Start').fill('09:00');
    await dialog.getByLabel('Finish').fill('17:00');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(grid.getByRole('button', { name: /^Draft shift for Ada Fictional/ })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Publish week' }).click();
    await expect(page.getByText('1 shift published. 1 person notified.', { exact: true })).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Published shift for Ada Fictional/ })).toBeVisible();
    const notified = () =>
      sql(
        `SELECT n.id FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE lower(u.email) = lower($1) AND n.kind = 'rota.published'`,
        [co.email],
      );
    expect(await notified()).toHaveLength(1);
    expect(
      await sql(`SELECT 1 FROM app.jobs WHERE kind = 'notifications.deliver' AND idempotency_key = $1`, [
        (await notified())[0]!.id,
      ]),
    ).toHaveLength(1);
    // publishing again changes nothing and notifies nobody
    await page.getByRole('button', { name: 'Publish week' }).click();
    await expect(page.getByText('0 shifts published. 0 people notified.', { exact: true })).toBeVisible();
    expect(await notified()).toHaveLength(1);

    await page.getByRole('tab', { name: 'My shifts' }).click();
    const mine = page.getByRole('tabpanel', { name: 'My shifts' });
    await expect(mine.getByText(/9:00–17:00/).first()).toBeVisible();
    await expectAccessible(page);
  });
});
