import { expect, test } from '@playwright/test';
import { signUpAndEnrol } from './helpers';
import { axeBoth } from './settings-helpers';

// UK English labels; fictional data only.
test.use({ locale: 'en-GB' });

test.describe('sign-in and security settings', () => {
  test('the settings index groups the sections; an OIDC connection shows the redirect URI to copy, can be required, refused when last, and deleted', async ({ page }) => {
    const { slug } = await signUpAndEnrol(page);
    await page.getByRole('navigation', { name: 'App' }).getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sign-in and security', exact: true })).toContainText('User provisioning (SCIM)');
    await axeBoth(page);

    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Single sign-on' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Single sign-on' })).toBeVisible();
    await expect(page.getByText('No connections yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Require single sign-on' })).toBeDisabled();
    const form = page.getByRole('region', { name: 'Add a connection', exact: true });
    await expect(form.getByLabel('OpenID Connect (OIDC)')).toBeChecked();
    await form.getByLabel('Name', { exact: true }).fill('Fictional IdP');
    await form.getByLabel('Issuer URL').fill('https://idp.fictional.example');
    await form.getByLabel('Client ID').fill('thapsus-fictional-client');
    await form.getByLabel('Client secret').fill('fictional-secret-value');
    await form.getByRole('button', { name: 'Add connection' }).click();
    await expect(page.getByTestId('sso-created')).toContainText('Connection added');
    await expect(page.getByTestId('created-redirect-uri')).toHaveText(/^https?:\/\/[^ ]+\/v1\/auth\/sso\/oidc\/callback$/);

    const item = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Fictional IdP' }) });
    await expect(item).toContainText('Stored (hidden)');
    await expect(item.getByTestId(/-redirect-uri$/)).toHaveText(/\/v1\/auth\/sso\/oidc\/callback$/);
    await expect(item.getByRole('link', { name: /Test sign-in/ })).toHaveAttribute('href', new RegExp(`/v1/auth/sso/start\\?tenant=${slug}&connection=[0-9a-f-]{36}$`));
    // the client secret is sealed by the API and never comes back to the browser
    await page.reload();
    await expect(item).toBeVisible();
    expect(await page.content()).not.toContain('fictional-secret-value');
    await axeBoth(page);

    // require SSO (behind a confirmation), then try to turn off the only connection: refused, reason announced
    await page.getByRole('button', { name: 'Require single sign-on' }).click();
    await page.getByRole('dialog', { name: 'Require single sign-on for everyone?' }).getByRole('button', { name: 'Require single sign-on' }).click();
    await expect(page.getByTestId('sso-enforced')).toContainText('Required');
    await item.getByRole('button', { name: 'Turn off' }).click();
    await expect(item.getByRole('alert')).toContainText('Stop enforcing SSO');
    await page.getByRole('button', { name: 'Stop requiring single sign-on' }).click();
    await expect(page.getByTestId('sso-enforced')).toContainText('Not required');

    await item.getByRole('button', { name: 'Delete Fictional IdP' }).click();
    await page.getByRole('dialog', { name: 'Delete Fictional IdP?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No connections yet')).toBeVisible();
  });

  test('a SCIM token is shown once, works for the directory, and stops working when revoked', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings/scim');
    await expect(page.getByTestId('scim-base-url')).toHaveText(/\/scim\/v2$/);
    await page.getByLabel('Token name').fill('Fictional directory');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = (await page.getByTestId('scim-token').textContent())!.trim();
    expect(token).toMatch(/^scim_/);
    const scim = () => page.request.get('/scim/v2/Users', { headers: { authorization: `Bearer ${token}` } });
    expect((await scim()).status()).toBe(200);
    await axeBoth(page);

    await page.getByRole('button', { name: 'I have copied it' }).click();
    await expect(page.getByTestId('scim-token')).toHaveCount(0);
    await page.reload();
    const row = page.getByRole('row', { name: /Fictional directory/ });
    await expect(row).toContainText('Active');
    expect(await page.content()).not.toContain(token);

    await row.getByRole('button', { name: 'Revoke Fictional directory' }).click();
    await page.getByRole('dialog', { name: 'Revoke Fictional directory?' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toContainText('Revoked');
    expect((await scim()).status()).toBe(401);
  });

  test('support access is granted for a limited time with a level and reason, then revoked; the sign-in policy and domains save', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.goto('/app/settings/support-access');
    await expect(page.getByText('Support has never been given access')).toBeVisible();
    const staff = crypto.randomUUID(); // a fictional Thapsus staff id
    await page.getByLabel('Support staff ID').fill(staff);
    await page.getByLabel('For how long').selectOption({ label: '1 day' });
    await page.getByLabel('View and change').check();
    await page.getByLabel('Reason').fill('Fictional ticket 1234: a question about the rota import');
    await page.getByRole('button', { name: 'Grant access' }).click();
    const row = page.getByRole('row', { name: new RegExp(staff) });
    await expect(row).toContainText('View and change');
    await expect(row).toContainText('Active');
    const grants = await (await page.request.get('/v1/settings/support-grants')).json();
    expect(grants[0]).toMatchObject({ staffId: staff, accessLevel: 'read_write', revokedAt: null });
    expect(new Date(grants[0].expiresAt).getTime() - new Date(grants[0].startsAt).getTime()).toBe(86_400_000);
    await axeBoth(page);
    await row.getByRole('button', { name: `Revoke access for ${staff}` }).click();
    await page.getByRole('dialog', { name: 'Revoke support access?' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toContainText('Revoked');

    await page.goto('/app/settings/sign-in-policy');
    await page.getByLabel('Sign out after inactivity (minutes)').fill('45');
    await page.getByLabel('Failed attempts before lockout').fill('8');
    await page.getByLabel('Trust two-step verification done by the identity provider').uncheck();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
    expect(await (await page.request.get('/v1/settings/security')).json()).toMatchObject({ sessionIdleMinutes: 45, lockoutThreshold: 8, trustIdpMfa: false });
    await axeBoth(page);

    await page.goto('/app/settings/domains');
    await page.getByLabel('Domain', { exact: true }).fill('fictional-shops.example');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('row', { name: /fictional-shops\.example/ })).toContainText('Pending');
  });

  test('on a phone the settings sub-navigation is a disclosure and pages fit the screen', async ({ page }) => {
    await signUpAndEnrol(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app/settings/sso');
    const subnav = page.getByRole('navigation', { name: 'Settings sections' });
    const toggle = subnav.getByRole('button', { name: 'Single sign-on', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(subnav.getByRole('link', { name: 'Leave policies' })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await subnav.getByRole('link', { name: 'Leave policies' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Leave policies' })).toBeVisible();
    await expect(subnav.getByRole('button', { name: 'Leave policies', exact: true })).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axeBoth(page);
  });
});
