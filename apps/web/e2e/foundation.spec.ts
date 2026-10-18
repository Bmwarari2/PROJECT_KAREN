import { expect, test } from '@playwright/test';
import { expectAccessible, PASSWORD, signUpAndEnrol, totp } from './helpers';

test.describe('public pages', () => {
  for (const path of ['/', '/signin', '/signup', '/find-workspace', '/design/gallery', '/offline']) {
    test(`${path} renders and passes axe (light and dark)`, async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        const res = await page.goto(path);
        expect(res?.status()).toBe(200);
        await expect(page.locator('main')).toBeVisible();
        await expectAccessible(page);
      }
    });
  }

  test('marketing nav is sticky and translucent, and skip link works', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header').first();
    await expect(header).toHaveCSS('position', 'sticky');
    expect(await header.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  });

  test('locale switch changes spelling (en-GB → en-US)', async ({ page, context }) => {
    await context.addCookies([{ name: 'thr_locale', value: 'en-US', url: page.url() === 'about:blank' ? 'http://127.0.0.1:3100' : page.url() }]);
    await page.goto('/');
    await expect(page.getByText('People and organization')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  });

  test('theme preference is applied server-side without a flash', async ({ page, context }) => {
    await context.addCookies([{ name: 'thr_theme', value: 'dark', url: 'http://127.0.0.1:3100' }]);
    const res = await page.goto('/');
    expect(await res!.text()).toContain('data-theme="dark"');
  });
});

test.describe('PWA', () => {
  test('manifest, icons, service worker and offline fallback', async ({ page, request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/app' });
    for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
    await page.goto('/');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toMatch(/\/$/);
    await page.context().setOffline(true);
    await page.goto('/app/somewhere-uncached').catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    await page.context().setOffline(false);
  });
});

test.describe('sign-up, MFA and the app shell', () => {
  test('owner signs up in the UK region, must enrol MFA, then reaches the app', async ({ page }) => {
    const { slug, secret, email } = await signUpAndEnrol(page);
    await expect(page.getByRole('heading', { name: /Welcome, Olive/ })).toBeVisible();
    await expectAccessible(page);
    // authenticated responses are never cacheable
    const res = await page.request.get('/v1/auth/session');
    expect(res.headers()['cache-control']).toBe('private, no-store');
    const html = await page.request.get('/app');
    expect(html.headers()['cache-control']).toContain('no-store');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/signin/);
    await page.getByLabel('Workspace').fill(slug);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Six-digit code').fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(/\/app$/);
    await expect(page.getByRole('navigation', { name: 'App' }).first()).toBeVisible();
  });

  test('wrong password shows an accessible error', async ({ page }) => {
    await page.goto('/signin?workspace=does-not-exist');
    await page.getByLabel('Email').fill('nobody@example.test');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
