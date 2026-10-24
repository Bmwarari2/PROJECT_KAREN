import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { createStaff, staffSignIn } from './phase10-helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/** Back office: staff sign-in with mandatory MFA, then the support queue (ticket content view is audited). */
test.describe('back office', () => {
  test('staff sign in with MFA and work the support queue', async ({ page, browser }) => {
    // a customer raises a ticket in their own browser
    const customer = await browser.newContext();
    const cpage = await customer.newPage();
    const owner = await signUpAndEnrol(cpage);
    const r = await cpage.request.post('/v1/support/tickets', {
      data: {
        subject: 'Cannot invite a new manager',
        body: 'Fictional details only.',
        category: 'account',
        priority: 'urgent',
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    const reference = (await r.json()).reference as string;

    // staff without the second factor cannot reach the back office
    const staff = createStaff('support');
    await page.goto('/backoffice/signin');
    await expectAccessible(page);
    await page.getByLabel('Work email').fill(staff.email);
    await page.getByLabel('Password').fill(staff.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Authenticator code')).toBeVisible();
    expect((await page.request.get('/v1/backoffice/support/queue')).status()).toBe(403);
    await page.goto('/backoffice/signin');
    await staffSignIn(page, staff);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('link', { name: 'Support queue' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Support queue' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(reference) });
    await expect(row).toContainText(owner.slug);
    await expect(row).toContainText('Urgent');
    await expect(row).not.toContainText('Cannot invite a new manager'); // the queue holds metadata only
    await expectAccessible(page);

    await row.getByRole('link', { name: reference }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Cannot invite a new manager' })).toBeVisible();
    await expect(page.getByText(/recorded in the customer's audit log/)).toBeVisible();
    await page.getByLabel('Reply to the customer').fill('Thanks — please try again now.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText('Reply sent', { exact: true })).toBeVisible();
    await expectAccessible(page);

    // the customer sees the reply and that the first-response target was met
    await cpage.goto('/app/support');
    await cpage.getByRole('link', { name: reference }).click();
    await expect(cpage.getByText('Thanks — please try again now.')).toBeVisible();
    await customer.close();
  });
});

/** Founder's console (ADR-0175 to ADR-0179): business overview by region. */
test.describe("founder's console", () => {
  test('the overview shows companies, revenue, usage and support for this region, and directory counts elsewhere', async ({
    page,
    browser,
  }) => {
    // a fictional customer signs up in this (UK) cell
    const customer = await browser.newContext();
    await signUpAndEnrol(await customer.newPage());
    await customer.close();

    await staffSignIn(page, createStaff('support'));
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const regions = page.getByRole('navigation', { name: 'Region' });
    await expect(regions.getByRole('link', { name: 'UK' })).toHaveAttribute('aria-current', 'page');
    for (const section of ['Companies', 'Revenue', 'Usage', 'Support and incidents'])
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Companies/ })).toBeVisible();
    await expect(
      page.getByText('Monthly recurring revenue').or(page.getByText('No paying customers yet.')),
    ).toBeVisible();
    await expect(page.getByTestId('signups-chart').getByRole('img')).toBeVisible();
    await expectAccessible(page);

    // every region: counts from the global directory only, sign-ups stacked by region
    await regions.getByRole('link', { name: 'All regions' }).click();
    await expect(page).toHaveURL(/region=all/);
    await expect(page.getByRole('heading', { level: 3, name: 'Sign-ups by week and region' })).toBeVisible();
    await expect(page.getByText(/Counts from the global directory/)).toBeVisible();
    await expectAccessible(page);

    // another region's revenue and usage stay there: a link to its own back office
    await regions.getByRole('link', { name: 'EU' }).click();
    await expect(page.getByRole('link', { name: 'Open the EU back office' })).toBeVisible();
    await expectAccessible(page);
  });
});
