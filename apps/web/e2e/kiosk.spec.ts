import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { companyWithStaff, sql } from './time-helpers';

// UK English labels (the catalogue's en-US variant says "Schedule" and "Time clock").
test.use({ locale: 'en-GB' });

/** Presses "Clock in" and waits for the kiosk API to answer (messages can repeat, so wait on the response). */
const tap = async (kiosk: Page) => {
  await Promise.all([
    kiosk.waitForResponse((r) => r.url().includes('/v1/kiosk/clock')),
    kiosk.getByRole('button', { name: 'Clock in' }).click(),
  ]);
};

test.describe('shared kiosk', () => {
  test('pairs once, then clocks an employee with number + PIN; a wrong PIN is refused without saying why', async ({
    page,
    browser,
  }) => {
    const co = await companyWithStaff(page, 1);
    await page.goto('/app/clock');
    await page.getByLabel('New PIN (4 to 8 digits)').fill('4826');
    await page.getByRole('button', { name: 'Set PIN' }).click();
    await expect(page.getByText('PIN saved.', { exact: true })).toBeVisible();
    await page.getByLabel('Kiosk name').fill('Front desk');
    await page.getByRole('button', { name: 'Add kiosk' }).click();
    const link = (await page.getByTestId('kiosk-link').textContent())!;
    expect(link).toContain('/kiosk#pair=kio_');

    // the kiosk is a separate, signed-out device
    const device = await browser.newContext();
    const kiosk = await device.newPage();
    await kiosk.goto(link);
    await expect(kiosk.getByRole('heading', { name: 'Kiosk: Front desk' })).toBeVisible();
    expect(new URL(kiosk.url()).hash).toBe(''); // the token is moved off the URL into device storage
    await expectAccessible(kiosk);

    await kiosk.getByLabel('Employee number').fill(co.employeeNumber);
    for (const d of '1111') await kiosk.getByRole('button', { name: `Digit ${d}` }).click();
    await tap(kiosk);
    await expect(kiosk.getByTestId('kiosk-message')).toHaveText('Employee number or PIN not recognised.');

    await kiosk.getByLabel('Employee number').fill('NOT-A-NUMBER');
    for (const d of '4826') await kiosk.getByRole('button', { name: `Digit ${d}` }).click();
    await tap(kiosk);
    await expect(kiosk.getByTestId('kiosk-message')).toHaveText('Employee number or PIN not recognised.');

    await kiosk.getByLabel('Employee number').fill(co.employeeNumber);
    for (const d of '4826') await kiosk.getByRole('button', { name: `Digit ${d}` }).click();
    await tap(kiosk);
    await expect(kiosk.getByTestId('kiosk-message')).toHaveText('Clocked in. Thank you, Ada.');
    const rows = await sql<{ source: string }>('SELECT source FROM app.clock_events WHERE employee_id = $1', [
      co.staff[0],
    ]);
    expect(rows).toEqual([{ source: 'kiosk' }]);
    const pin = (
      await sql<{ pin_hash: string }>('SELECT pin_hash FROM app.kiosk_pins WHERE employee_id = $1', [
        co.staff[0],
      ])
    )[0]!;
    expect(pin.pin_hash.startsWith('$argon2id$')).toBe(true);

    await kiosk.reload();
    await expect(kiosk.getByRole('heading', { name: 'Kiosk: Front desk' })).toBeVisible();
    await device.close();
  });
});
