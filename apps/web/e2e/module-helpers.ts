import { expect, type Page } from '@playwright/test';

/**
 * Workspace navigation (ADR-0154): the rail ("App" navigation) lists modules; a module page opens with
 * the module name as its only h1 and, when it has more than one tab, a "<Module> sections" tab bar.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The module's tab bar. */
export const moduleTabs = (page: Page, module: string) =>
  page.getByRole('navigation', { name: `${module} sections`, exact: true });

/** The page is a module page: the module is the h1 and, when given, `tab` is the current tab. */
export async function expectModulePage(page: Page, module: string, tab?: string) {
  await expect(page.getByRole('heading', { level: 1, name: module, exact: true })).toBeVisible();
  if (tab)
    await expect(moduleTabs(page, module).getByRole('link', { name: tab, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
}

/** Opens a module from the rail (its first tab the viewer may see), then `tab` from its tab bar. */
export async function openModule(page: Page, module: string, tab?: string) {
  // a module with pending items carries its count in the link name ("Inbox pending 2")
  await page
    .getByRole('navigation', { name: 'App', exact: true })
    .first()
    .getByRole('link', { name: new RegExp(`^${escape(module)}\\b`) })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: module, exact: true })).toBeVisible();
  if (tab) {
    await moduleTabs(page, module).getByRole('link', { name: tab, exact: true }).click();
    await expectModulePage(page, module, tab);
  }
}

/** A page with its own title under a module header: the module is the h1, the page title an h2. */
export async function expectPageTitle(page: Page, module: string, title: string) {
  await expect(page.getByRole('heading', { level: 1, name: module, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible();
}

/** Signs out from the account menu in the top bar (the menu opens from the button with the viewer's name). */
export async function signOutFromMenu(page: Page) {
  await page.getByRole('banner').locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
}
