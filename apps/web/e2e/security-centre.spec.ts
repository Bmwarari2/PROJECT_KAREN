import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';

test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/** The customer's Security centre in Settings (ADR-0178): alerts, sign-ins, admin changes, MFA and recipients. */
test.describe('security centre', () => {
  test('workspace admins see their security picture and choose who receives security alerts', async ({
    page,
  }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings');
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Security centre' })
      .click();
    // under the Settings module the page title is the section heading
    await expect(page.getByRole('heading', { name: 'Security centre' })).toBeVisible();
    for (const heading of [
      'Security alerts',
      'Sign-ins in the last 7 days',
      'Recent failed sign-ins',
      'Admin changes in the last 30 days',
      'Two-step verification',
      'Who is told',
    ])
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByText('Users with it: 1 of 1')).toBeVisible();
    await expect(page.getByText('Nobody is chosen, so the owners are told.')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('checkbox', { name: /Olive Owner/ }).check();
    await page.getByRole('button', { name: 'Save recipients' }).click();
    await expect(page.getByText('Recipients saved', { exact: true })).toBeVisible();
    await expect(page.getByText('Nobody is chosen, so the owners are told.')).toBeHidden();
    await expectAccessible(page);
  });
});
