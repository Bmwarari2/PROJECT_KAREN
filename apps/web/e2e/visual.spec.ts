import { expect, test } from '@playwright/test';
import { signUpAndEnrol } from './helpers';

/** Visual regression baselines: light/dark × phone/desktop (projects). Fictional data only. */
const PAGES = ['/', '/signin', '/signup', '/design/gallery', '/pricing', '/status'];

for (const path of PAGES) {
  test(`page ${path}`, async ({ page }) => {
    // The long marketing page takes well over a minute to capture full-page in the container on slow hosts.
    test.setTimeout(600_000);
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${path === '/' ? 'home' : path.slice(1).replace(/\//g, '-')}.png`, {
      fullPage: true,
      timeout: 300_000,
      mask: [page.locator('footer p'), page.locator('[data-volatile]')],
    });
  });
}

test('app shell', async ({ page }) => {
  await signUpAndEnrol(page);
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot('app-home.png', { fullPage: true, mask: [page.locator('header span[title]')] });
});
