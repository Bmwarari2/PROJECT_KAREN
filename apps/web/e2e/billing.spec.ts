import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/** Owner billing against the recording fake provider (no Stripe call; test mode only in AWS). */
test.describe('billing', () => {
  test('owner adds billing details, starts a plan and upgrades it', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/billing');
    await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible();
    await expect(page.getByTestId('current-plan')).toHaveText('Plus'); // the free trial plan
    await expect(page.getByText('Free trial').first()).toBeVisible();
    await expectAccessible(page);

    await page.getByLabel('Company legal name').fill('Fictional Billing Ltd');
    await page.getByLabel('Address line 1').fill('1 Example Street');
    await page.getByLabel('Town or city').fill('London');
    await page.getByLabel('Postcode').fill('EC1A 1AA');
    await page.getByLabel('Country code').fill('GB');
    await page.getByLabel('Billing contact name').fill('Olive Owner');
    await page.getByLabel('Billing contact email').fill('billing@fictional-billing.example.test');
    await page.getByRole('button', { name: 'Save billing details' }).click();
    await expect(page.getByText('Billing details saved', { exact: true })).toBeVisible();

    await page.getByLabel('Plan', { exact: true }).selectOption('core');
    await page.getByLabel('Term', { exact: true }).selectOption('monthly');
    await expect(page.getByTestId('quote')).toContainText('per month');
    await page.getByRole('button', { name: 'Start subscription' }).click();
    await expect(page.getByText('Subscription started', { exact: true })).toBeVisible();
    await expect(page.getByTestId('current-plan')).toHaveText('Core');

    await page.getByLabel('Plan', { exact: true }).selectOption('plus');
    await expect(page.getByTestId('quote')).toContainText('Takes effect now');
    await page.getByRole('button', { name: 'Change plan' }).click();
    await expect(page.getByText('Plan changed', { exact: true })).toBeVisible();
    await expect(page.getByTestId('current-plan')).toHaveText('Plus');
    await expect(page.getByLabel('Currency')).toBeDisabled();
    await expectAccessible(page);
  });
});
