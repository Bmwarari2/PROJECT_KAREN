import { afterAll, describe, expect, it } from 'vitest';
import { regionPairs } from '@thapsus/core';
import { withTenant } from '@thapsus/db';
import { FakeBillingProvider } from '../src/modules/billing/provider';
import { MemoryObjectStore } from '../src/lib/object-store';
import { closeDb, ownerSession, startTestApp } from './helpers';
import { injector, postWebhook, runQueued, signedEvent, staffSession, WEBHOOK_SECRET } from './phase10-helpers';

/**
 * Phase 10 residency, for every region pair: billing webhooks, failed-payment emails, support tickets,
 * attachments and the status endpoint never cross from a tenant's home cell to another cell.
 */
afterAll(closeDb);

describe.each(regionPairs())('support and billing stay home (%s → %s)', (home, other) => {
  it(`a ${home} tenant's billing events, emails, tickets and files are handled only by the ${home} cell`, async () => {
    const homeCell = await startTestApp({ cell: home, listen: false });
    const otherCell = await startTestApp({ cell: other, listen: false, directory: homeCell.directory });
    for (const c of [homeCell, otherCell]) {
      c.deps.billing = new FakeBillingProvider(() => c.clock.now);
      c.deps.stripeWebhookSecret = WEBHOOK_SECRET;
    }
    try {
      const owner = await ownerSession(homeCell);
      const api = injector(homeCell);
      const acct = (await api('GET', '/v1/billing', undefined, owner.cookie)).json().accounts[0];
      await api('PUT', `/v1/billing/accounts/${acct.id}/details`, { name: 'Fictional Region Ltd', address: { line1: '1 Example Way', city: 'Exampleton', postalCode: '00000', country: home === 'us' ? 'US' : home === 'uk' ? 'GB' : 'DE' }, contacts: [{ name: 'Bill Contact', email: `billing@${owner.slug}.example.test`, isPrimary: true }] }, owner.cookie);
      expect((await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: home === 'us' ? 'USD' : home === 'uk' ? 'GBP' : 'EUR' }, owner.cookie)).statusCode).toBe(201);
      const fake = homeCell.deps.billing as FakeBillingProvider;
      const customer = [...fake.customers.keys()][0]!;
      const sub = [...fake.subscriptions.keys()][0]!;
      const failed = (c: typeof homeCell, id: string) => signedEvent(c, 'invoice.payment_failed', { id: `in_test_${id}`, customer, status: 'open', currency: 'gbp', amount_due: 100, total: 100, subtotal: 100, parent: { subscription_details: { subscription: sub } } });

      // Stripe would only deliver to the home region's endpoint; even if another cell receives it, it is ignored.
      expect((await postWebhook(otherCell, failed(otherCell, 'other'))).json().outcome).toBe('ignored');
      await withTenant(homeCell.deps.router, owner.tenantId, async (tx) => {
        expect(await tx.query(`SELECT 1 FROM app.billing_invoices WHERE provider_invoice_id = 'in_test_other'`)).toHaveLength(0);
      });
      expect((await postWebhook(homeCell, failed(homeCell, 'home'))).json().outcome).toBe('processed');
      await runQueued(homeCell, owner.tenantId, 'billing.payment_failed_email');
      expect(homeCell.mailer.region).toBe(home);
      expect(homeCell.mailer.sent.some((m) => m.to === `billing@${owner.slug}.example.test`)).toBe(true);
      expect(otherCell.mailer.sent).toHaveLength(0);

      // Support: the ticket and its attachment live in the home cell; the other cell's staff cannot open it.
      const t = (await api('POST', '/v1/support/tickets', { subject: 'Residency check', body: 'Fictional', category: 'question', priority: 'normal' }, owner.cookie)).json();
      const b = 'rb';
      await homeCell.app.inject({ method: 'POST', url: `/v1/support/tickets/${t.id}/attachments`, headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${b}` }, payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nfictional\r\n--${b}--\r\n` });
      expect([...(homeCell.deps.objects as MemoryObjectStore).objects.keys()].some((k) => k.startsWith(`${owner.tenantId}/support/`))).toBe(true);
      expect([...(otherCell.deps.objects as MemoryObjectStore).objects.keys()]).toEqual([]);
      const otherStaff = await staffSession(otherCell, 'support');
      expect((await injector(otherCell)('GET', `/v1/backoffice/support/tickets/${owner.tenantId}/${t.id}`, undefined, otherStaff.cookie)).statusCode).toBe(404);
      expect((await injector(otherCell)('GET', `/v1/backoffice/tenants/${owner.tenantId}`, undefined, otherStaff.cookie)).statusCode).toBe(404);

      // Each cell's status endpoint speaks for its own region only.
      expect((await homeCell.app.inject({ method: 'GET', url: '/v1/status' })).json().region).toBe(home);
      expect((await otherCell.app.inject({ method: 'GET', url: '/v1/status' })).json().region).toBe(other);
    } finally {
      await homeCell.close();
      await otherCell.close();
    }
  });
});
