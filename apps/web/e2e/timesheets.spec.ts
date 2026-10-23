import { expect, test } from '@playwright/test';
import { addDays, dayOfWeek, today, zonedToInstant } from '../../../packages/core/src/time';
import { expectAccessible } from './helpers';
import { companyWithStaff } from './time-helpers';

// UK English labels (the catalogue's en-US variant says "Schedule" and "Time clock").
test.use({ locale: 'en-GB' });

test.describe('timesheets', () => {
  test('last week: recorded time against the rota with the variance highlighted; submit for approval; export offered', async ({
    page,
  }) => {
    const co = await companyWithStaff(page, 1);
    const d = today('Europe/London');
    const mon = addDays(d, 1 - dayOfWeek(d) - 7); // Monday of last week
    for (const day of [mon, addDays(mon, 1)])
      expect(
        (
          await page.request.post('/v1/shifts', {
            data: { employeeId: co.staff[0], date: day, start: '09:00', end: '17:00', breakMinutes: 0 },
          })
        ).status(),
      ).toBe(201);
    expect(
      (await page.request.post('/v1/rota/publish', { data: { from: mon, to: addDays(mon, 6) } })).status(),
    ).toBe(200);
    const punch = async (day: string, kind: string, time: string) =>
      expect(
        (
          await page.request.post('/v1/clock/corrections', {
            data: {
              employeeId: co.staff[0],
              kind,
              occurredAt: zonedToInstant(day, time, 'Europe/London'),
              reason: 'Fictional paper timesheet',
            },
          })
        ).status(),
      ).toBe(201);
    await punch(mon, 'in', '09:00');
    await punch(mon, 'out', '17:00');
    await punch(addDays(mon, 1), 'in', '09:00');
    await punch(addDays(mon, 1), 'out', '19:00');

    await page.goto('/app/timesheets');
    const sheet = page.getByTestId('my-timesheet');
    await expect(sheet.getByText('Not submitted')).toBeVisible();
    const tuesday = sheet.getByRole('row').filter({ hasText: /Tuesday/ });
    await expect(tuesday).toContainText('+2 h');
    await expect(tuesday).toContainText('(differs from the rota)');
    await expect(sheet.getByRole('row').filter({ hasText: 'Total' })).toContainText('18 h');
    await expect(page.getByTestId('ts-overtime')).toHaveText('0 h');
    await expectAccessible(page);

    await sheet.getByRole('button', { name: 'Submit week' }).click();
    await expect(sheet.getByText('Waiting for approval')).toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: 'Ada Fictional' }).getByText('Waiting for approval'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export for payroll (CSV)' })).toHaveAttribute(
      'href',
      `/v1/timesheets/export?weekStart=${mon}`,
    );
    await expectAccessible(page);
  });
});
