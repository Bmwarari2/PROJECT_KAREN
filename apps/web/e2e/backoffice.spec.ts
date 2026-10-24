import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { createStaff, staffContext, staffSignIn } from './phase10-helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/**
 * Back office (ADR-0174): staff sign in only with a passkey or security key (a virtual authenticator here),
 * registered from a one-time enrolment link; then the support queue (ticket content view is audited), and
 * just-in-time elevation approved by a second staff member.
 */
test.describe('back office', () => {
  test('staff sign in with a passkey and work the support queue', async ({ browser }) => {
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

    const context = await staffContext(browser, { locale: 'en-GB', reducedMotion: 'reduce' });
    const page = await context.newPage();
    // no password and no code: the sign-in page offers the key only, and nothing works without it
    await page.goto('/backoffice/signin');
    await expect(page.getByRole('heading', { level: 1, name: 'Staff sign-in' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expectAccessible(page);
    expect((await page.request.get('/v1/backoffice/support/queue')).status()).toBe(401);
    // the operator's one-time link registers the key and signs the staff member in
    const staff = createStaff('support');
    await staffSignIn(page, staff);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expectAccessible(page);
    // the link works once
    await page.goto(staff.enrolmentUrl);
    await page.getByRole('button', { name: 'Register key' }).click();
    await expect(page.getByText('This enrolment link has expired or was already used')).toBeVisible();
    // signing out and in again uses the registered key
    await page.goto('/backoffice');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/backoffice\/signin$/);
    await page.getByRole('button', { name: 'Sign in with a passkey or security key' }).click();
    await page.waitForURL(/\/backoffice$/);

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
    await context.close();

    // the customer sees the reply and that the first-response target was met
    await cpage.goto('/app/support');
    await cpage.getByRole('link', { name: reference }).click();
    await expect(cpage.getByText('Thanks — please try again now.')).toBeVisible();
    await customer.close();
  });

  test('a super admin asks for time-boxed access and another super admin approves it', async ({
    browser,
  }) => {
    const options = { locale: 'en-GB', reducedMotion: 'reduce' as const };
    const mine = await staffContext(browser, options);
    const admin = await mine.newPage();
    await staffSignIn(admin, createStaff('super_admin'));
    // no standing access: the staff trail needs an approved elevation
    await expect(admin.getByRole('status').filter({ hasText: 'no active super-admin access' })).toBeVisible();
    expect(
      (
        await admin.request.get('/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z')
      ).status(),
    ).toBe(403);
    await admin.getByRole('link', { name: 'Go to Access' }).click();
    await expect(admin.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
    await admin.getByLabel('Reason').fill('Fictional incident 7: export the staff trail');
    await admin.getByLabel('For how long').selectOption({ label: '1 hour' });
    await admin.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(admin.getByText('Request sent. Another staff member must approve it.')).toBeVisible();
    const myList = admin.getByRole('region', { name: 'Your access' });
    await expect(myList).toContainText('Waiting for approval');
    await expectAccessible(admin);

    const theirs = await staffContext(browser, options);
    const approver = await theirs.newPage();
    await staffSignIn(approver, createStaff('super_admin'));
    await approver.goto('/backoffice/access');
    const waiting = approver.getByRole('region', { name: 'Waiting for your approval' });
    await expect(waiting).toContainText('Fictional incident 7');
    await expectAccessible(approver);
    await waiting.getByRole('button', { name: /^Approve Super-admin actions for / }).click();
    await expect(approver.getByText('Approved. The access starts now.').first()).toBeVisible();
    await theirs.close();

    await admin.reload();
    await expect(myList).toContainText('Active');
    expect(
      (
        await admin.request.get('/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z')
      ).status(),
    ).toBe(200);
    await myList.getByRole('button', { name: 'End now' }).click();
    await expect(admin.getByText('Access ended.').first()).toBeVisible();
    await mine.close();
  });

  test('a phone gets 44px controls and one column on the access page', async ({ browser }) => {
    const context = await staffContext(browser, { viewport: { width: 390, height: 844 }, locale: 'en-GB' });
    const page = await context.newPage();
    await staffSignIn(page, createStaff('support'));
    await page.goto('/backoffice/access');
    const submit = page.getByRole('button', { name: 'Ask for approval' });
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
});
