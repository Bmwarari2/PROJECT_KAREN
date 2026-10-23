import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { expectModulePage, expectPageTitle } from './module-helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

test.describe('help centre and support tickets', () => {
  test('searches the help centre, raises a ticket with an attachment and replies', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/time-off');
    await page.getByRole('link', { name: 'Help for this page' }).click();
    await expect(page.getByRole('heading', { name: 'Help for the page you were on' })).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Help for the page you were on' })
        .getByRole('link', { name: 'Requesting and approving time off' }),
    ).toBeVisible();
    await page.getByLabel('Search the help centre').fill('cancel plan');
    await page.getByRole('main').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByTestId('help-results').getByRole('link').first()).toHaveText(
      'Plans, billing and cancelling',
    );
    await expectAccessible(page);

    await page.goto('/app/support');
    await expectModulePage(page, 'Help', 'Support');
    await expect(page.getByRole('table', { name: 'Our response targets' })).toBeVisible();
    await page.getByLabel('Subject').fill('Exported payslips show the wrong month');
    await page.getByLabel('Category').selectOption('problem');
    await page.getByLabel('Priority', { exact: true }).selectOption('high');
    await page
      .getByLabel('What happened?')
      .fill('Steps: Payroll → Export for October. Fictional details only.');
    await page.getByLabel('Attachment (optional)').setInputFiles({
      name: 'screenshot.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('fictional-image'),
      ]),
    }); // real PNG signature: content is checked against the type
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Send ticket' }).click();
    await page.waitForURL(/\/app\/support\/[0-9a-f-]{36}$/);
    await expectPageTitle(page, 'Help', 'Exported payslips show the wrong month');
    await expect(page.getByRole('button', { name: 'screenshot.png' })).toBeVisible();
    await expect(page.getByText('On track', { exact: true })).toBeVisible();
    await page.getByLabel('Reply').fill('It also happens for September.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText('It also happens for September.')).toBeVisible();
    await expectAccessible(page);
  });
});
