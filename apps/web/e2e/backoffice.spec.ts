import { expect, test } from '@playwright/test';
import { expectAccessible, signUpAndEnrol } from './helpers';
import { createStaff, staffContext, staffSignIn } from './phase10-helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/**
 * Back office (ADR-0173): staff sign in only with a passkey or security key (a virtual authenticator here),
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
  test('companies are searchable and filterable, with a health signal, and every row opens its detail', async ({
    page,
    browser,
  }) => {
    const customer = await browser.newContext();
    const owner = await signUpAndEnrol(await customer.newPage());
    await customer.close();

    await staffSignIn(page, createStaff('support'));
    await page.getByRole('link', { name: 'Customers' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    await page.getByLabel('Search by workspace').fill(owner.slug);
    const row = page.getByRole('listitem').filter({ hasText: owner.slug });
    await expect(row).toContainText('No data yet');
    await expectAccessible(page);

    // the detail page is one tap away; refreshing the usage snapshot fills the row
    await row.getByRole('link', { name: owner.slug }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Fictional ${owner.slug} Ltd` })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Usage refreshed', { exact: true })).toBeVisible();
    await page.goBack();
    await page.getByLabel('Search by workspace').fill(owner.slug);
    await expect(row).toContainText('Healthy');
    await expect(row).toContainText(/active this week/);

    // filters narrow the list and live in the address
    await page.getByLabel('Health').selectOption('risk');
    await expect(page).toHaveURL(/health=risk/);
    await expect(page.getByText('No company matches these filters.')).toBeVisible();
    await page.getByLabel('Health').selectOption('');
    await page.getByLabel('Region', { exact: true }).selectOption('all');
    await expect(page.getByRole('listitem').filter({ hasText: owner.slug })).toContainText('UK');
    await expectAccessible(page);
  });
  test('platform performance shows requests, errors, response times, queues and incidents for this region', async ({
    page,
  }) => {
    await staffSignIn(page, createStaff('support'));
    await page.getByRole('link', { name: 'Performance' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Performance' })).toBeVisible();
    const range = page.getByRole('navigation', { name: 'Time range' });
    await expect(range.getByRole('link', { name: 'Last 24 hours' })).toHaveAttribute('aria-current', 'page');
    // the back office's own requests are counted (by route group, never by path)
    await expect(page.getByTestId('requests-chart').getByRole('img')).toBeVisible();
    const routes = page.getByRole('region', { name: 'By area of the product' });
    await expect(routes.getByRole('listitem').filter({ hasText: 'backoffice' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Background queues' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Incidents and maintenance' })).toBeVisible();
    await expectAccessible(page);
    await range.getByRole('link', { name: 'Last 7 days' }).click();
    await expect(page).toHaveURL(/window=7d/);
    await expect(page.getByTestId('requests-chart').getByRole('img')).toHaveAttribute(
      'aria-label',
      /per day/,
    );
    await expectAccessible(page);
  });
  test('security analysts see detections, work an incident, test the rules and check the honeytokens', async ({
    page,
  }) => {
    // a scanner asks the web host for a honey endpoint and tries the decoy API key from the documentation
    expect((await page.request.get('/.env')).status()).toBe(404);
    const decoy = await page.request.get('/v1/employees', {
      headers: {
        authorization:
          'Bearer thr_sk_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e.decoyKeyDoNotUseXq7Lm2Np9Rs4Tv6Wy8Za0Bc3Df5Gh',
      },
    });
    expect(decoy.status()).toBe(401);

    await staffSignIn(page, createStaff('security_analyst'));
    await page.getByRole('link', { name: 'Security' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    await page.getByRole('button', { name: 'Run detections now' }).click();
    await expect(page.getByText('Detections run', { exact: true })).toBeVisible();
    await expect(page.getByText('Detections in 24 hours')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Top offending addresses' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Staff elevation log' })).toBeVisible();
    await expectAccessible(page);

    const sections = page.getByRole('navigation', { name: 'Security sections' });
    await sections.getByRole('link', { name: 'Incidents' }).click();
    // both decoys were touched from one address, so they roll up into one incident, critical because of the key
    const row = page
      .getByRole('region', { name: 'Incidents' })
      .getByRole('listitem')
      .filter({ hasText: 'Critical' })
      .first();
    await expect(row).toContainText('Deception');
    await expectAccessible(page);
    await row.getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: /SEC-\d{5}/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Detections' })).toContainText('Decoy key or object used');
    // the request came through this region's own proxy: its address is internal and never blocked
    await page
      .getByRole('region', { name: 'Containment' })
      .getByRole('listitem')
      .filter({ hasText: 'Block the address' })
      .getByRole('button', { name: 'Apply' })
      .click();
    await expect(
      page.getByText(/Nothing to do: it is one of this region's own internal addresses/).first(),
    ).toBeVisible();
    await page.getByLabel('Note', { exact: true }).fill('Fictional scanner; nothing reached a workspace.');
    await page.getByRole('button', { name: 'Add a note' }).click();
    await expect(page.getByText('Note added', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Timeline' })).toContainText('Fictional scanner');
    await page.getByLabel('Status').selectOption('resolved');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Incident updated', { exact: true })).toBeVisible();
    await expectAccessible(page);

    await sections.getByRole('link', { name: 'Rules' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Detection rules' })).toBeVisible();
    await page.getByRole('button', { name: 'Test every rule' }).click();
    await expect(page.getByText(/Rules tested: (\d+) of \1 passed/).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Cloud' })).toContainText('Planned');
    await expectAccessible(page);

    await sections.getByRole('link', { name: 'Honeytokens' }).click();
    const key = page.getByRole('region', { name: 'Decoy API key' }).getByRole('listitem').first();
    await expect(key).toContainText(/touch(es)? in 30 days/);
    await expect(key).not.toContainText('0 touches');
    await expect(page.getByText(/No fake employees are planted/)).toBeVisible();
    await expectAccessible(page);
  });
});
