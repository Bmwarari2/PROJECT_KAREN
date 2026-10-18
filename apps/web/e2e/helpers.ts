import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { e2eMailDir } from './env';
import AxeBuilder from '@axe-core/playwright';
import * as OTPAuth from 'otpauth';

export const PASSWORD = 'Correct-Horse-Battery-9';
export const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** WCAG 2.2 AA (and 2.0/2.1 A/AA) checks with axe; fails on any violation. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`);
  expect(summary, summary.join('\n')).toEqual([]);
}

export function totp(secret: string, offsetSteps = 0) {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

/** Signs up a fictional UK workspace in the browser and completes admin MFA. Returns the TOTP secret. */
export async function signUpAndEnrol(page: Page, slug = uniq('e2e')) {
  await page.goto('/signup');
  await page.getByLabel(/United Kingdom/).check();
  await page.getByLabel('Company name').fill(`Fictional ${slug} Ltd`);
  await page.getByLabel('Workspace').fill(slug);
  await page.getByLabel('Your name').fill('Olive Owner');
  await page.getByLabel('Work email').fill(`owner@${slug}.example.test`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel(/data processing agreement/).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(/\/app\/security/);
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.locator('code').first().textContent())!.trim();
  await page.getByLabel('Six-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL(/\/app$/);
  return { slug, secret, email: `owner@${slug}.example.test` };
}

/** Latest email the e2e API sent to an address (written by the file mail transport). */
export async function lastMailTo(to: string, timeoutMs = 15_000): Promise<{ to: string; subject: string; text: string }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const files = (() => {
      try {
        return readdirSync(e2eMailDir()).sort();
      } catch {
        return [];
      }
    })();
    const mails = files.map((f) => JSON.parse(readFileSync(join(e2eMailDir(), f), 'utf8')) as { to: string; subject: string; text: string }).filter((m) => m.to === to);
    if (mails.length) return mails.at(-1)!;
    if (Date.now() > until) throw new Error(`no email to ${to}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** JSON API call in the signed-in browser context (cookies of the page); fails loudly on errors. */
export async function apiCall<T = Record<string, unknown>>(request: APIRequestContext, method: 'GET' | 'POST' | 'PUT', url: string, data?: unknown): Promise<T> {
  const res = await request.fetch(url, { method, data: data as object | undefined, headers: { accept: 'application/json' } });
  expect(res.status(), `${method} ${url}: ${await res.text()}`).toBeLessThan(300);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}
