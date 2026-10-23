import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DB } from './env';
import { expectAccessible, signUpAndEnrol } from './helpers';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';

/** Stands in for Thapsus staff entitling the workspace in the back office (the staff-managed aiAssistant flag). */
async function entitle(slug: string) {
  const c = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM registry.tenants WHERE slug = $1), true)`, [slug]);
    await c.query(`UPDATE app.tenants SET features = jsonb_set(features, '{flags}', coalesce(features->'flags', '{}'::jsonb) || '{"aiAssistant": true}'::jsonb)`);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

test('Ask HR: off by default, set up by the owner, answers with an AI disclosure and cited sources', async ({ page }) => {
  const { slug } = await signUpAndEnrol(page);
  const nav = page.getByRole('navigation');

  // Off by default: no nav entry, and the page says so.
  await page.goto('/app/ask');
  await expect(page.getByText('Ask HR is not turned on')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Ask HR' })).toHaveCount(0);

  // Thapsus entitles the workspace; the owner chooses the policies and turns it on.
  await entitle(slug);
  await page.goto('/app/settings/ask-hr');
  await expect(page.getByTestId('ai-region')).toContainText('eu-west-2');
  await expect(page.getByTestId('ai-region')).toContainText('Your data stays in this region');
  await page.getByLabel('New policy folder').fill('Company policies');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.getByRole('checkbox', { name: 'Company policies' })).toBeChecked();
  await page.getByLabel('Title').fill('Annual leave policy');
  await page.getByLabel('Policy text').fill('# Annual leave\nFull-time employees receive 25 days of annual leave each year plus bank holidays.');
  await page.getByRole('button', { name: 'Add policy' }).click();
  await expect(page.getByRole('cell', { name: 'Annual leave policy' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Indexed' })).toBeVisible();
  const toggle = page.getByRole('switch', { name: 'Ask HR for employees' });
  await toggle.click(); // controlled switch: it flips once the API confirms
  await expect(toggle).toBeChecked();
  await expectAccessible(page);

  // Employees see the assistant, always with the AI disclosure.
  await page.goto('/app/ask');
  await expect(nav.getByRole('link', { name: 'Ask HR' })).toBeVisible();
  await expect(page.getByTestId('ai-disclosure')).toContainText('You are talking to an AI assistant');
  await page.getByLabel('Your question').fill('How many days of annual leave do I get?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = page.getByTestId('ai-exchange').first();
  await expect(answer.getByText('AI-generated answer')).toBeVisible();
  await expect(answer).toContainText('25 days of annual leave');
  await expect(answer.getByRole('button', { name: /^Annual leave policy/ })).toBeVisible();
  await expect(answer.getByRole('link', { name: 'Source 1' })).toBeVisible();
  await expect(answer).toContainText('You are talking to an AI assistant');
  await expectAccessible(page);
  await answer.getByRole('button', { name: 'Helpful', exact: true }).click();
  await expect(answer.getByText('Thanks for your feedback.')).toBeVisible();

  // Decisions about people are refused.
  await page.getByLabel('Your question').fill('Should I fire my colleague for being late?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const refusal = page.getByTestId('ai-exchange').first();
  await expect(refusal.getByTestId('ai-message')).toContainText("I can't make or recommend decisions about people");
  await expect(refusal).toContainText('You are talking to an AI assistant');
});
