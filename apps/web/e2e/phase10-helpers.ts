import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { e2eEnv } from './env';
import { totp } from './helpers';

/** Creates a fictional Thapsus staff account with the real CLI (prints a one-time password and TOTP secret). */
export function createStaff(role: 'support' | 'billing' | 'rules_editor' | 'super_admin') {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@thapsus.example.test`;
  const api = join(import.meta.dirname, '..', '..', 'api');
  const out = execFileSync('npx', ['tsx', 'src/cli/create-staff.ts', email, 'Fictional Staff Member', role], { cwd: api, env: { ...process.env, ...e2eEnv() }, encoding: 'utf8' });
  const password = /one-time password: (\S+)/.exec(out)![1]!;
  const secret = /TOTP secret[^:]*: (\S+)/.exec(out)![1]!;
  return { email, password, secret };
}

/** Back-office sign-in through the UI: password, then the authenticator code. */
export async function staffSignIn(page: Page, staff: { email: string; password: string; secret: string }) {
  await page.goto('/backoffice/signin');
  await page.getByLabel('Work email').fill(staff.email);
  await page.getByLabel('Password').fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Authenticator code')).toBeVisible();
  await page.getByLabel('Authenticator code').fill(totp(staff.secret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/backoffice$/);
}
