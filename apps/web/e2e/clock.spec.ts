import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import { companyWithStaff, sql } from './time-helpers';

// UK English labels (the catalogue's en-US variant says "Schedule" and "Time clock").
test.use({ locale: 'en-GB' });

/** Counts calls to the geolocation API so tests can prove location is requested only with geofencing on. */
const countGeo = () =>
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      const w = window as unknown as { __geoCalls: number };
      w.__geoCalls = 0;
      const orig = navigator.geolocation?.getCurrentPosition?.bind(navigator.geolocation);
      if (orig) navigator.geolocation.getCurrentPosition = (...args: Parameters<Geolocation['getCurrentPosition']>) => ((w.__geoCalls += 1), orig(...args));
    });
  });

test.describe('clock in/out (PWA offline queue)', () => {
  countGeo();

  test('punches made offline are queued on the device and synced once online, without duplicates', async ({ page, context }) => {
    const co = await companyWithStaff(page, 1);
    await page.goto('/app/clock');
    await expect(page.getByTestId('clock-state')).toHaveText('You are clocked out');
    await expectAccessible(page);

    await context.setOffline(true);
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText(/You are offline/)).toBeVisible();
    await expect(page.getByTestId('clock-queued')).toHaveText('1 waiting to sync');
    await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');
    await page.getByRole('button', { name: 'Start break' }).click();
    await expect(page.getByTestId('clock-queued')).toHaveText('2 waiting to sync');
    expect(await sql('SELECT 1 FROM app.clock_events WHERE employee_id = $1', [co.staff[0]])).toHaveLength(0);
    const queued = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('thr.clock.queue'))!);

    await context.setOffline(false);
    await expect(page.getByTestId('clock-synced')).toBeVisible();
    await expect(page.getByTestId('clock-state')).toContainText('On a break since');
    // Replay the same queue as if the first response had been lost: the server answers "duplicate".
    await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), queued);
    await page.reload();
    await expect(page.getByTestId('clock-synced')).toBeVisible();
    const rows = await sql<{ kind: string; lat: string | null }>('SELECT kind, lat FROM app.clock_events WHERE employee_id = $1 ORDER BY occurred_at', [co.staff[0]]);
    expect(rows).toEqual([{ kind: 'in', lat: null }, { kind: 'break_start', lat: null }]);
    // geofencing is off by default: location was never requested
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls)).toBe(0);
  });

  test('with geofencing enabled for the country, the notice is shown and location is read only when clocking', async ({ page, context }) => {
    const co = await companyWithStaff(page, 1);
    expect((await page.request.patch(`/v1/org/locations/${co.location}`, { data: { geofence: { lat: 51.5, lng: -0.12, radiusMetres: 200 } } })).status()).toBe(200);
    expect((await page.request.put('/v1/settings/time', { data: { geofence: { countries: ['GB'], notice: { GB: { 'en-GB': 'Fictional Shops checks you are at the store when you clock in or out.' } } } } })).status()).toBe(200);
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 51.5001, longitude: -0.1201 });
    await page.goto('/app/clock');
    await expect(page.getByTestId('geofence-notice')).toContainText('Fictional Shops checks you are at the store');
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls)).toBe(0);
    await page.getByRole('button', { name: 'Clock in' }).click();
    // "all synced" also shows while the location is read and before the punch is queued, so wait for the new state
    await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');
    await expect(page.getByTestId('clock-synced')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __geoCalls: number }).__geoCalls)).toBe(1);
    await expect
      .poll(async () => (await sql<{ within_geofence: boolean; lat: string }>('SELECT within_geofence, lat FROM app.clock_events WHERE employee_id = $1', [co.staff[0]]))[0])
      .toEqual({ within_geofence: true, lat: '51.5001' });
    await expectAccessible(page);
  });
});
