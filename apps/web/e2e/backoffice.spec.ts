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
