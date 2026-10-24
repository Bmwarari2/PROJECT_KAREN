import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { e2eMailDir } from './env';
import { apiCall, expectAccessible, lastMailTo, signUpAndEnrol, totp, uniq } from './helpers';
import { signOutFromMenu } from './module-helpers';
import { sql } from './time-helpers';

// Forgotten passwords and admin-sent reset links (ADR-0171). UK English labels; fictional people only.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

const NEW_PASSWORD = 'Harbour-lights-after-rain-31';
const resetLink = (text: string) => /(https?:\/\/\S+\/auth\/reset\?token=\S+)/.exec(text)![1]!;
const mailsTo = (to: string) => {
  try {
    return readdirSync(e2eMailDir())
      .map((f) => JSON.parse(readFileSync(join(e2eMailDir(), f), 'utf8')) as { to: string })
      .filter((m) => m.to === to).length;
  } catch {
    return 0;
  }
};

async function askForLink(page: Page, workspace: string, email: string) {
  await page.goto(`/signin?workspace=${workspace}`);
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
  await expect(page.getByLabel('Workspace')).toHaveValue(workspace);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
}

test.describe('forgotten password', () => {
  test('someone who forgot their password follows the emailed link, chooses a new one and still needs their authenticator', async ({
    page,
    browser,
  }) => {
    const owner = await signUpAndEnrol(page, uniq('reset'), { mfaForEveryone: true });
    const context = await browser.newContext({ locale: 'en-GB', reducedMotion: 'reduce' });
    const p = await context.newPage();
    await askForLink(p, owner.slug, owner.email);
    await expectAccessible(p);
    // an unknown address gets exactly the same page, and no email is sent
    const unknown = `nobody.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
    const q = await context.newPage();
    await askForLink(q, owner.slug, unknown);
    await expect(q.getByRole('status')).toContainText(unknown);
    await q.close();

    // the emailed link: the token leaves the address bar at once
    const link = resetLink((await lastMailTo(owner.email)).text);
    await p.goto(link);
    await expect(p.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
    await expect(p).toHaveURL(/\/auth\/reset$/);
    await expectAccessible(p);
    await p.getByLabel('New password').fill('qwertyuiopasdfgh');
    await p.getByRole('button', { name: 'Save new password' }).click();
    await expect(p.getByText('That password is too common. Choose one that is harder to guess.')).toBeVisible();
    await p.getByLabel('New password').fill(NEW_PASSWORD);
    await p.getByRole('button', { name: 'Save new password' }).click();
    await expect(p.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible();
    await expectAccessible(p);
    // every session ended, including the owner's other browser
    expect((await page.request.get('/v1/auth/session')).status()).toBe(401);
    // told by email
    expect((await lastMailTo(owner.email)).subject).toBe('Your Thapsus-HR password was changed');

    // sign in with the new password: the authenticator is still required
    await p.getByRole('link', { name: 'Sign in' }).click();
    await expect(p.getByLabel('Workspace')).toHaveValue(owner.slug);
    await p.getByLabel('Email').fill(owner.email);
    await p.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(p.getByLabel('Six-digit code')).toBeVisible();
    await p.getByLabel('Six-digit code').fill(totp(owner.secret, 1));
    await p.getByRole('button', { name: 'Verify' }).click();
    await p.waitForURL(/\/app$/);

    // the link worked once
    await p.goto(link);
    await p.getByLabel('New password').fill('Another-harbour-light-77');
    await p.getByRole('button', { name: 'Save new password' }).click();
    await expect(p.getByRole('heading', { level: 1, name: 'This link no longer works' })).toBeVisible();
    await expectAccessible(p);
    expect(mailsTo(unknown)).toBe(0);
    await context.close();
  });

  test('an admin sends a reset link from the person’s access page; they set a password and must set up two-step verification', async ({
    page,
    browser,
  }) => {
    const owner = await signUpAndEnrol(page, uniq('adminreset'), { mfaForEveryone: true });
    const entity = await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', {
      name: 'Fictional Lanterns Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    });
    const email = `sam.fictional@${owner.slug}.example.test`;
    const employee = await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', {
      startDate: '2025-01-06',
      legalFirstName: 'Sam',
      legalLastName: 'Fictional',
      jobTitle: 'Store associate',
      entityId: entity.id,
      workEmail: email,
      weeklyHours: 40,
      payAmountMinor: 1500,
      payCurrency: 'GBP',
      payFrequency: 'hourly',
      contractType: 'permanent',
    });
    const invited = await apiCall<{ userId: string }>(
      page.request,
      'POST',
      `/v1/employees/${employee.id}/invite`,
      {},
    );

    await page.goto(`/app/settings/users/${invited.userId}`);
    const controls = page.getByRole('region', { name: 'Sign-in and security' });
    await expect(controls).toContainText('only an owner can help another owner');
    await expectAccessible(page);
    await controls.getByRole('button', { name: 'Send password reset link' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send Sam Fictional a password reset link?' });
    await expect(dialog).toContainText('You never see or set the password');
    await dialog.getByRole('button', { name: 'Send link' }).click();
    await expect(page.getByText('Password reset link sent.', { exact: true })).toBeVisible();

    const mail = await lastMailTo(email);
    expect(mail.subject).toBe('Set a new password for Thapsus-HR');
    expect(mail.text).toContain('24 hours');
    const context = await browser.newContext({ locale: 'en-GB', reducedMotion: 'reduce' });
    const p = await context.newPage();
    await p.goto(resetLink(mail.text));
    await p.getByLabel('New password').fill(NEW_PASSWORD);
    await p.getByRole('button', { name: 'Save new password' }).click();
    await expect(p.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible();
    await p.getByRole('link', { name: 'Sign in' }).click();
    await p.getByLabel('Email').fill(email);
    await p.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    // two-step verification for everyone: the employee sets up an authenticator first
    await p.waitForURL(/\/app\/security\?setup=1/);
    await expect(p.getByRole('button', { name: 'Set up authenticator app' })).toBeVisible();
    await expectAccessible(p);
    await context.close();
    // the admin's action and the reset are in the audit log
    const audit = await sql<{ action: string }>(
      `SELECT action FROM audit.events WHERE target_id = $1 AND action LIKE 'auth.password_reset_%' ORDER BY id`,
      [invited.userId],
    );
    expect(audit.map((r) => r.action)).toEqual(['auth.password_reset_sent', 'auth.password_reset_completed']);
    await signOutFromMenu(page);
  });
});
