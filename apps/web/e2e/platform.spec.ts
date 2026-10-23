import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { expectPageTitle } from './module-helpers';

/** Phase 9 settings screens: API credentials, webhooks and branding (functional + axe, WCAG 2.2 AA). */
test.describe('enterprise platform settings', () => {
  test('an admin creates an API key and sees it exactly once', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings');
    await page.getByRole('link', { name: /API access/ }).click();
    await page.waitForURL(/\/app\/settings\/api$/);
    await expectPageTitle(page, 'Settings', 'API access');
    await expectAccessible(page);

    await page.getByLabel('Name', { exact: true }).fill('Fictional payroll sync');
    await page.getByLabel(/Read people records/).check();
    await page.getByRole('button', { name: 'Create API key' }).click();
    const secret = page.getByTestId('secret-value');
    await expect(secret).toContainText(/^thr_sk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const key = (await secret.textContent())!.trim();
    await expect(page.getByText('it is shown only once')).toBeVisible();
    await expectAccessible(page);

    // the key works against the API from outside the browser session
    const res = await page.request.get('/v1/employees', { headers: { authorization: `Bearer ${key}` } });
    expect(res.status()).toBe(200);
    expect(res.headers()['ratelimit-limit']).toBeDefined();

    await page.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByTestId('secret-value')).toHaveCount(0);
    const row = page.getByRole('row', { name: /Fictional payroll sync/ });
    await expect(row).toContainText(`thr_sk_…${key.split('.')[1]!.slice(0, 8)}`);
    await page.reload();
    await expect(page.getByRole('row', { name: /Fictional payroll sync/ })).toBeVisible();
    expect(await page.content()).not.toContain(key.split('.')[1]);

    await page.getByRole('button', { name: 'Revoke Fictional payroll sync' }).click();
    await expect(page.getByRole('row', { name: /Fictional payroll sync/ })).toContainText('Revoked');
    expect(
      (await page.request.get('/v1/employees', { headers: { authorization: `Bearer ${key}` } })).status(),
    ).toBe(401);
  });

  test('an admin adds a webhook endpoint, sees the signing secret once and finds it in the list', async ({
    page,
  }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings/webhooks');
    await expectPageTitle(page, 'Settings', 'Webhooks');
    await expectAccessible(page);

    // private and non-https addresses are refused
    await page.getByLabel('Endpoint URL').fill('https://169.254.169.254/latest/meta-data');
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(page.getByText('That address cannot be used').first()).toBeVisible();

    await page.getByLabel('Endpoint URL').fill('https://hooks.example.com/thapsus');
    await page.getByLabel('Description').fill('Fictional HRIS');
    await page.getByRole('checkbox', { name: 'employee.created' }).check();
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(page.getByTestId('secret-value')).toContainText(/^whsec_/);
    await expectAccessible(page);
    await page.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByRole('heading', { name: 'https://hooks.example.com/thapsus' })).toBeVisible();
    await expect(page.getByText(/Fictional HRIS/)).toBeVisible();

    await page.getByRole('button', { name: 'Send test event' }).click();
    await expect(page.getByText('Test event queued.').first()).toBeVisible();
    await page.getByRole('button', { name: 'Delivery log' }).click();
    await expect(
      page.getByRole('table', { name: /Deliveries to/ }).or(page.getByText('No deliveries yet.')),
    ).toBeVisible();
    await expectAccessible(page);
  });

  test('a brand accent is rejected when contrast fails and applied when it passes', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings/branding');
    await expectPageTitle(page, 'Settings', 'Branding');

    await page.getByLabel(/Accent colou?r \(light mode\)/).fill('#FFFF00');
    await page.getByRole('button', { name: /Save colou?r/ }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'enough contrast' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Light mode: accent\/bg is 1\.\d\d:1 \(needs at least 4\.5:1\)/);
    await expectAccessible(page);
    // nothing was applied
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
      ),
    ).toBe('#0b6b63');

    await page.getByLabel(/Accent colou?r \(light mode\)/).fill('#1F3A8A');
    await page.getByRole('button', { name: /Save colou?r/ }).click();
    await expect(page.getByText(/Accent colou?r saved\./).first()).toBeVisible();
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
        ),
      )
      .toBe('#1f3a8a');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
        ),
      )
      .not.toBe('#1f3a8a');
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
        ),
      )
      .toBe('#1f3a8a');
  });

  test('the developer documentation is generated from the OpenAPI document and accessible', async ({
    page,
  }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const res = await page.goto('/developers');
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Developer documentation', level: 1 })).toBeVisible();
      await expect(page.getByText('/v1/oauth/token').first()).toBeAttached();
      await expectAccessible(page);
    }
  });
});
