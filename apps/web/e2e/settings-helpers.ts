import type { Page } from '@playwright/test';
import { expectAccessible } from './helpers';

/** axe (WCAG 2.2 AA) in light and then dark mode, with reduced motion; ends in light mode. */
export async function axeBoth(page: Page) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await expectAccessible(page);
  }
}
