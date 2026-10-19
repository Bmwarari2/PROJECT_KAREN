import { expect, request as playwrightRequest, test } from '@playwright/test';
import { PASSWORD, signUpAndEnrol, totp } from './helpers';
import { axeBoth } from './settings-helpers';
import { sql } from './time-helpers';

// OWASP ASVS level 2 controls in the browser (docs/ASVS.md). UK English labels; fictional data only.
test.use({ locale: 'en-GB' });

test.describe('content security policy (V3.4.3)', () => {
  test('every page gets a fresh nonce policy and still runs: no inline script is allowed, nothing is blocked', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to (execute|load)/i.test(m.text())) violations.push(m.text());
    });
    const first = await page.goto('/');
    const csp = first!.headers()['content-security-policy']!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'/);
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain('unsafe-inline');
    const second = await page.request.get('/');
    expect(second.headers()['content-security-policy']).not.toBe(csp);
    // hydration works under the policy: the theme switch is interactive
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto('/developers');
    await page.goto('/signin');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    expect(violations).toEqual([]);
  });
});

test.describe('sessions and passwords (V7.4, V7.5, V6.2)', () => {
  test('people see where they are signed in, re-authenticate when the sign-in is old, and sign other sessions out', async ({ page, baseURL }) => {
    const { slug, secret, email } = await signUpAndEnrol(page);
    // a second browser signs in with the password and the authenticator
    const other = await playwrightRequest.newContext({ baseURL });
    const login = await other.post('/v1/auth/login', { data: { tenant: slug, email, password: PASSWORD } });
    expect(login.status()).toBe(200);
    expect((await other.post('/v1/auth/mfa/totp/verify', { data: { code: totp(secret, 1) } })).status()).toBe(204);
    expect((await other.get('/v1/auth/session')).status()).toBe(200);

    await page.goto('/app/security');
    await expect(page.getByRole('heading', { name: 'Where you are signed in' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Where you are signed in' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('This device')).toBeVisible();
    await axeBoth(page);

    // the sign-in is older than the re-authentication window: ending sessions asks for the password first
    await sql(`UPDATE app.sessions SET created_at = now() - interval '20 minutes' WHERE user_id = (SELECT id FROM app.users WHERE email = $1)`, [email]);
    await page.getByRole('button', { name: 'Sign out of all other sessions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog).toBeVisible();
    await axeBoth(page);
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('All your other sessions have been signed out.', { exact: true })).toBeVisible();
    await expect(page.getByText('You are not signed in anywhere else.')).toBeVisible();
    expect((await other.get('/v1/auth/session')).status()).toBe(401);
    await other.dispose();

    // change the password: common and context-specific choices are refused with a reason
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByLabel('New password').fill('qwertyuiopasdfgh');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'That password is too common. Choose one that is harder to guess.' })).toBeVisible();
    await page.getByLabel('New password').fill(`Notes-for-${slug}-2026`);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Do not use your name' })).toBeVisible();
    await page.getByLabel('New password').fill('Quiet-river-at-dawn-42');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password has been saved. Your other sessions have been signed out.', { exact: true })).toBeVisible();

    // signing out clears the session and reloads; the new password works
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(/\/signin/);
    expect((await page.request.get('/v1/auth/session')).status()).toBe(401);
    const again = await page.request.post('/v1/auth/login', { data: { tenant: slug, email, password: 'Quiet-river-at-dawn-42' } });
    expect(again.status()).toBe(200);
  });

  test('requests from another origin cannot change anything', async ({ page }) => {
    await signUpAndEnrol(page);
    const forged = await page.request.post('/v1/auth/logout', { headers: { origin: 'https://attacker.example.test' } });
    expect(forged.status()).toBe(403);
    expect((await page.request.get('/v1/auth/session')).status()).toBe(200);
  });
});
