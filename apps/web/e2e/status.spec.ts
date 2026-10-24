import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import { createStaff, staffContext, staffSignIn } from './phase10-helpers';
import { sql } from './time-helpers';

// Reduced motion: axe must not sample toasts or reveals mid-transition.
test.use({ locale: 'en-GB', reducedMotion: 'reduce' });

/** Public status page: UK, EU and US reported separately; staff-posted incidents appear for their region. */
test.describe('status page', () => {
  test('renders each region separately, with posted incidents, and is accessible', async ({
    page,
    browser,
  }) => {
    await sql(
      `INSERT INTO backoffice.service_heartbeats (service, beat_at) VALUES ('worker', now()) ON CONFLICT (service) DO UPDATE SET beat_at = now()`,
    );
    await page.goto('/status');
    await expect(page.getByRole('heading', { level: 1, name: 'Service status' })).toBeVisible();
    for (const name of ['United Kingdom (London)', 'European Union (Frankfurt)', 'United States (Ohio)'])
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    await expect(page.getByTestId('overall-uk')).toContainText('All systems operational');
    // this e2e environment runs only the UK cell: the other regions say so instead of borrowing UK data
    await expect(page.getByTestId('unavailable-eu')).toBeVisible();
    await expect(page.getByTestId('unavailable-us')).toBeVisible();
    await expectAccessible(page);

    // a support staff member posts an incident for this (UK) cell through the back-office API
    const staffBrowser = await staffContext(browser);
    const staffPage = await staffBrowser.newPage();
    await staffSignIn(staffPage, createStaff('support'));
    const post = await staffPage.request.post('/v1/backoffice/status/incidents', {
      data: {
        kind: 'incident',
        impact: 'minor',
        title: 'Email delivery delays',
        components: ['email'],
        body: 'Some notification emails are delayed.',
      },
    });
    expect(post.status(), await post.text()).toBe(201);
    await staffBrowser.close();

    await page.reload();
    const uk = page.getByRole('region', { name: 'United Kingdom (London)' });
    await expect(uk.getByText('Email delivery delays')).toBeVisible();
    await expect(uk.getByText('Some notification emails are delayed.')).toBeVisible();
    await expect(page.getByTestId('overall-uk')).toContainText('Some systems degraded');
    await expectAccessible(page);
  });
});
