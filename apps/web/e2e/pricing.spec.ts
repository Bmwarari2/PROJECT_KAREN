import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/** The published price list comes from the billing configuration (no price lives in the page). */
const cfg = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'core', 'src', 'billing', 'config-v1.json'),
    'utf8',
  ),
);
const core = cfg.plans.find((p: { id: string }) => p.id === 'core');
const gbp = (minor: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
const eur = (minor: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(minor / 100);

test.describe('pricing page', () => {
  test('shows plans, bands and prices from config in the chosen currency and term, and is accessible', async ({
    page,
  }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fair prices, published for everyone');
    await expect(page.getByText(`Free for ${cfg.trial.days} days, no card needed`)).toBeVisible();
    const plans = page.getByRole('list', { name: 'Plans' });
    await expect(plans.getByRole('heading', { name: 'Core' })).toBeVisible();
    await expect(plans.getByRole('heading', { name: 'Enterprise' })).toBeVisible();
    // monthly GBP: the first band's monthly unit price for Core
    await expect(plans.getByText(gbp(core.bands[0].monthlyUnit.GBP), { exact: true }).first()).toBeVisible();
    const table = page.getByRole('table', { name: /Price per employee per month in GBP/ });
    await expect(table.getByRole('row')).toHaveCount(core.bands.length + 2);
    await expectAccessible(page);

    await page.getByRole('link', { name: 'EUR' }).click();
    await expect(page).toHaveURL(/currency=EUR/);
    await expect(page.getByRole('table', { name: /in EUR/ })).toBeVisible();
    await expect(
      page
        .getByRole('list', { name: 'Plans' })
        .getByText(eur(core.bands[0].monthlyUnit.EUR), { exact: true })
        .first(),
    ).toBeVisible();

    await page.getByRole('link', { name: /Annual/ }).click();
    await expect(page).toHaveURL(/term=annual/);
    await expect(page.getByText('billed annually').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Annual/ })).toHaveAttribute('aria-current', 'true');
    await expectAccessible(page);
  });
});
