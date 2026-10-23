import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { expectModulePage, moduleTabs, openModule } from './module-helpers';

test.describe('public trust pages', () => {
  for (const path of ['/trust', '/trust/subprocessors', '/trust/subprocessors?region=us']) {
    test(`${path} renders and passes axe (light and dark)`, async ({ page }) => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        const res = await page.goto(path);
        expect(res?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectAccessible(page);
      }
    });
  }

  test('the trust page shows residency per region and links to the sub-processor list', async ({ page }) => {
    await page.goto('/trust');
    for (const region of ['eu-west-2', 'eu-central-1', 'us-east-2'])
      await expect(page.getByText(new RegExp(`AWS ${region}`)).first()).toBeVisible();
    await expect(page.getByText(/eu-west-1/).first()).toBeVisible();
    await page.getByRole('link', { name: 'See the list' }).click();
    await page.waitForURL(/\/trust\/subprocessors/);
    await expect(page.getByRole('heading', { name: 'Sub-processors', level: 1 })).toBeVisible();
  });

  test('the sub-processor list shows only the chosen region’s locations', async ({ page }) => {
    await page.goto('/trust/subprocessors?region=us');
    await expect(page.getByRole('link', { name: 'United States' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('us-east-2 (Ohio)', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('eu-west-2 (London) only', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Change log' })).toBeVisible();
    // The footer links straight to the list.
    await page.goto('/');
    await page
      .getByRole('contentinfo')
      .getByRole('link', { name: /Sub-processors/ })
      .click();
    await page.waitForURL(/\/trust\/subprocessors$/);
  });
});

test.describe('privacy administration', () => {
  test('an admin logs an access request with its legal deadline and downloads the export', async ({
    page,
  }) => {
    await signUpAndEnrol(page);
    const post = async (url: string, data: unknown) => {
      const res = await page.request.post(url, { data });
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()).id as string;
    };
    const entityId = await post('/v1/org/legal-entities', {
      name: 'Fictional Exports Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
    });
    const locationId = await post('/v1/org/locations', {
      name: 'Fictional studio',
      entityId,
      country: 'GB',
      regionCode: 'GB-ENG',
      timeZone: 'Europe/London',
    });
    const employeeId = await post('/v1/employees', {
      startDate: '2024-03-04',
      legalFirstName: 'Fictional',
      legalLastName: 'Exportable',
      jobTitle: 'Analyst',
      entityId,
      locationId,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
    });

    await page.goto('/app');
    await openModule(page, 'Privacy');
    await page.waitForURL(/\/app\/privacy$/);
    await expectModulePage(page, 'Privacy', 'Requests');
    // the shell's tab bar is the only privacy navigation (no second sub-navigation)
    await expect(page.getByRole('navigation', { name: 'Privacy sections' })).toHaveCount(1);
    await expectAccessible(page);

    await page.getByLabel('Request type').selectOption('access');
    await page.getByLabel('Find the person').fill('Exportable');
    const person = page.getByLabel('Person', { exact: true });
    await expect(person.locator('option', { hasText: 'Fictional Exportable' })).toHaveCount(1);
    await person.selectOption({ label: 'Fictional Exportable' });
    await page.getByLabel('Identity verified by').selectOption('signed_in_account');
    await page.getByRole('button', { name: 'Log request' }).click();

    const detail = page.getByRole('heading', {
      name: /Access \(copy of data\) request — Fictional Exportable/,
    });
    await expect(detail).toBeVisible();
    await expect(page.getByRole('link', { name: /UK GDPR Article 12A/ })).toHaveAttribute(
      'href',
      /legislation\.gov\.uk/,
    );
    await expect(page.getByRole('row', { name: /Fictional Exportable/ })).toContainText(/days left/);

    await page.getByRole('button', { name: 'Generate export' }).click();
    await expect(page.getByRole('button', { name: 'Download JSON' })).toBeVisible();
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download JSON' }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/\.json$/);
    const body = JSON.parse(
      Buffer.concat(await streamChunks(await json.createReadStream())).toString('utf8'),
    );
    expect(body.format).toBe('thapsus-hr.subject-access-export');
    expect(body.tables['app.employees'][0].id).toBe(employeeId);
    expect(body.tables['app.employee_personal'][0].legal_last_name).toBe('Exportable');
    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download PDF summary' }).click(),
    ]);
    expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
    const head = Buffer.concat(await streamChunks(await pdf.createReadStream()))
      .subarray(0, 5)
      .toString();
    expect(head).toBe('%PDF-');
    await expectAccessible(page);
  });

  test('retention, incidents, legal and export sections render and pass axe', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/privacy');
    for (const [tab, heading] of [
      ['Retention', 'Retention rules from the law'],
      ['Incidents', 'Log an incident'],
      ['Legal documents', 'Data processing agreement'],
      ['Exports', 'Export all company data'],
    ] as const) {
      await moduleTabs(page, 'Privacy').getByRole('link', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectModulePage(page, 'Privacy', tab);
      await expectAccessible(page);
    }
    await expect(page.getByText(/Your account will be closed|Type .* to confirm/).first()).toBeVisible();
  });
});

async function streamChunks(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return chunks;
}
