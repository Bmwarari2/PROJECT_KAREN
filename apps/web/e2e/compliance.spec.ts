import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E_DB } from './env';
import { expectAccessible, signUpAndEnrol, uniq } from './helpers';

/**
 * Compliance centre (Phase 5): the dashboard renders for an admin and passes axe in light and dark,
 * and a tenant admin acknowledges a law change published in the back office. Fictional data only.
 */
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';

async function post(page: Page, url: string, data: unknown) {
  const res = await page.request.post(url, { data: data as object });
  expect(res.status(), `${url}: ${await res.text()}`).toBeLessThan(300);
  return res.json();
}

/** Publishes a law-change entry as a fictional back-office editor (direct insert into the e2e cell database). */
async function publishLawChange(jurisdiction: string, title: string) {
  const db = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await db.connect();
  try {
    const staff = await db.query<{ id: string }>(
      `INSERT INTO backoffice.staff_users (email, display_name, role) VALUES ($1, 'Fictional Editor', 'rules_editor') RETURNING id`,
      [`${uniq('editor')}@thapsus.example.test`],
    );
    await db.query(
      `INSERT INTO backoffice.law_changes (jurisdiction, effective_date, title, summary, what_to_do, pack_rule_refs, status, published_at, created_by)
       VALUES ($1, '2027-01-01', $2, $3, $4, $5, 'published', now(), $6)`,
      [
        jurisdiction,
        JSON.stringify({ 'en-GB': title }),
        JSON.stringify({
          'en-GB': 'The qualifying period for unfair dismissal falls from two years to six months.',
        }),
        JSON.stringify({
          'en-GB': 'Review probation and dismissal procedures for staff with six months of service.',
        }),
        JSON.stringify([
          {
            jurisdiction: 'GB',
            key: 'employment.unfair_dismissal_qualifying_period',
            effectiveFrom: '2027-01-01',
          },
        ]),
        staff.rows[0]!.id,
      ],
    );
  } finally {
    await db.end();
  }
}

test.describe('compliance centre', () => {
  test('dashboard renders the compliance overview and passes axe (light and dark)', async ({ page }) => {
    await signUpAndEnrol(page);
    const entity = await post(page, '/v1/org/legal-entities', {
      name: 'Fictional Compliance Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    });
    const employee = await post(page, '/v1/employees', {
      startDate: '2026-09-07',
      legalFirstName: 'Fiona',
      legalLastName: 'Fictional',
      jobTitle: 'Forklift Operator',
      entityId: entity.id,
      weeklyHours: 40,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
      probationEndDate: '2027-03-07',
    });
    await post(page, '/v1/compliance/requirements', {
      kind: 'licence',
      name: 'Fictional forklift licence',
      appliesTo: { jobTitles: ['Forklift Operator'] },
      validityMonths: 12,
    });
    const us = await post(page, '/v1/org/legal-entities', {
      name: 'Fictional Compliance Inc',
      country: 'US',
      regionCode: 'US-CA',
      currency: 'USD',
      timeZone: 'America/Los_Angeles',
    });
    await post(page, '/v1/employees', {
      startDate: '2026-02-02',
      legalFirstName: 'Sam',
      legalLastName: 'Fictional',
      jobTitle: 'Engineer',
      entityId: us.id,
      weeklyHours: 40,
      payAmountMinor: 6_000_000,
      payCurrency: 'USD',
      payFrequency: 'annual',
      contractType: 'permanent',
      flsaStatus: 'exempt',
    });
    expect(employee.id).toBeTruthy();
    await page.getByRole('link', { name: 'Compliance', exact: true }).first().click();
    await page.waitForURL(/\/app\/compliance$/);
    await expect(page.getByRole('heading', { level: 1, name: /^Compliance cent(re|er)$/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Compliance sections' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Right to work (UK)' })).toBeVisible();
    await expect(page.getByText(/^Licen[cs]es, certificates and training$/)).toBeVisible(); // en-GB or en-US spelling (browser locale)
    await expect(page.getByText('Statutory leave where you employ people')).toBeVisible();
    await expect(page.getByText('Paid sick leave: US-CA rules apply')).toBeVisible();
    await expect(page.getByText('Exempt and non-exempt (US)')).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await expect(page.getByRole('heading', { level: 1, name: /^Compliance cent(re|er)$/ })).toBeVisible();
      await expectAccessible(page);
    }
    // the right-to-work and matrix pages list the new starter as missing a check / licence
    await page.getByRole('link', { name: 'Right to work', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Fiona Fictional', exact: true })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Matrix', exact: true }).click();
    await expect(page.getByRole('table').getByText('Fictional forklift licence')).toBeVisible();
    await expect(page.getByRole('table').getByText('Missing', { exact: true })).toBeVisible();
    await expectAccessible(page);
  });

  test('a tenant admin sees a relevant law change and acknowledges it', async ({ page }) => {
    await signUpAndEnrol(page);
    await post(page, '/v1/org/legal-entities', {
      name: 'Fictional Feed Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    });
    const title = `Unfair dismissal qualifying period becomes six months (${uniq('e2e')})`;
    await publishLawChange('GB', title);
    await publishLawChange('FR', `Not relevant here (${uniq('fr')})`);
    await page.goto('/app/compliance/law-changes');
    await expect(page.getByRole('heading', { level: 1, name: 'Law changes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('Not relevant here')).toHaveCount(0);
    await expectAccessible(page);
    await page.getByRole('button', { name: `Acknowledge: ${title}` }).click();
    await expect(page.getByText(/^Acknowledged /).first()).toBeVisible();
    await expect(page.getByRole('button', { name: `Acknowledge: ${title}` })).toHaveCount(0);
    await expect(page.getByText('Acknowledged by Olive Owner')).toBeVisible();
    await expectAccessible(page);
    // the state is stored per admin and survives a reload
    await page.reload();
    await expect(page.getByText('Acknowledged by Olive Owner')).toBeVisible();
  });
});
