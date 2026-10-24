import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { e2eEnv, staffBaseUrl } from './env';

export type StaffRole = 'support' | 'billing' | 'rules_editor' | 'super_admin';

/** Creates a fictional Thapsus staff account with the real operator CLI, which prints a one-time enrolment link. */
export function createStaff(role: StaffRole) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@thapsus.example.test`;
  const api = join(import.meta.dirname, '..', '..', 'api');
  const out = execFileSync('npx', ['tsx', 'src/cli/create-staff.ts', email, 'Fictional Staff Member', role], {
    cwd: api,
    env: { ...process.env, ...e2eEnv() },
    encoding: 'utf8',
  });
  const enrolmentUrl = /enrolment link[^:]*: (\S+)/.exec(out)![1]!;
  return { email, role, enrolmentUrl };
}

/** A browser context for staff: the back office's own host name (staff passkeys are bound to it). */
export const staffContext = (browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) =>
  browser.newContext({ ...options, baseURL: staffBaseUrl() });

/**
 * Gives the page a virtual platform authenticator (Chrome DevTools Protocol WebAuthn domain) with user
 * verification, so passkey prompts complete without a person: the e2e stand-in for Face ID or a security
 * key. No test-only path exists in the app; the real WebAuthn ceremony runs.
 */
export async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** Registers the staff member's key from their enrolment link (which also signs them in). */
export async function staffSignIn(page: Page, staff: { enrolmentUrl: string }) {
  await virtualAuthenticator(page);
  await page.goto(staff.enrolmentUrl);
  await expect(page.getByRole('heading', { level: 1, name: 'Register your security key' })).toBeVisible();
  await page.getByRole('button', { name: 'Register key' }).click();
  await page.waitForURL(/\/backoffice$/);
}

/**
 * Asks for an elevation as the signed-in staff page and has a second, freshly enrolled staff member approve
 * it in their own browser (plan 2.2.3: nobody approves their own access).
 */
export async function elevateStaff(
  browser: Browser,
  page: Page,
  scope: 'super_admin' | 'rules_publish' | 'support_grant',
) {
  const r = await page.request.post('/v1/backoffice/elevations', {
    data: { scope, reason: 'Fictional e2e check of the back office', minutes: 120 },
  });
  expect(r.status(), await r.text()).toBe(201);
  const approverRole: StaffRole =
    scope === 'super_admin' ? 'super_admin' : scope === 'rules_publish' ? 'rules_editor' : 'support';
  const context: BrowserContext = await staffContext(browser);
  try {
    const approver = await context.newPage();
    await staffSignIn(approver, createStaff(approverRole));
    const ok = await approver.request.post(`/v1/backoffice/elevations/${(await r.json()).id}/approve`);
    expect(ok.status(), await ok.text()).toBe(200);
  } finally {
    await context.close();
  }
}
