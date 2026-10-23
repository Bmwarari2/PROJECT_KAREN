import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  assertTestModeKey,
  StripeBillingProvider,
  type StripeLike,
} from '../src/modules/billing/stripe-provider';
import { verifyWebhook, WebhookSignatureError } from '../src/modules/billing/provider';

/**
 * Contract check of the Stripe request shapes against the official API reference (URLs in
 * stripe-provider.ts), with a recording stand-in for the SDK client: no network, test mode only.
 */
type Call = { method: string; args: unknown[] };
function mockStripe(opts: { productExists?: boolean } = {}) {
  const calls: Call[] = [];
  const rec =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (typeof result === 'function') return (result as (...a: unknown[]) => unknown)(...args);
      return result;
    };
  const sub = {
    id: 'sub_test_fictional',
    status: 'trialing',
    trial_end: 1_800_000_000,
    cancel_at: null,
    items: {
      data: [
        { id: 'si_test_fictional', current_period_start: 1_790_000_000, current_period_end: 1_800_000_000 },
      ],
    },
  };
  const stripe = {
    customers: {
      create: rec('customers.create', { id: 'cus_test_fictional' }),
      update: rec('customers.update', { id: 'cus_test_fictional' }),
    },
    products: {
      retrieve: rec('products.retrieve', () => {
        if (opts.productExists) return { id: 'thapsus_hr_core' };
        throw Object.assign(new Error('No such product'), { code: 'resource_missing' });
      }),
      create: rec('products.create', { id: 'thapsus_hr_core' }),
    },
    subscriptions: {
      create: rec('subscriptions.create', sub),
      retrieve: rec('subscriptions.retrieve', sub),
      update: rec('subscriptions.update', { ...sub, cancel_at: 1_800_000_000 }),
      cancel: rec('subscriptions.cancel', { ...sub, status: 'canceled' }),
    },
    checkout: {
      sessions: {
        create: rec('checkout.sessions.create', { url: 'https://checkout.stripe.example.test/c/fictional' }),
      },
    },
    setupIntents: { retrieve: rec('setupIntents.retrieve', { payment_method: 'pm_test_fictional' }) },
  };
  return { calls, provider: new StripeBillingProvider(stripe as unknown as StripeLike) };
}

const customer = {
  tenantId: '0b9a3f30-0000-4000-8000-00000000c001',
  billingAccountId: '0b9a3f30-0000-4000-8000-00000000a001',
  legalName: 'Fictional Widgets Ltd',
  contactName: 'Olive Owner',
  contactEmail: 'billing@fictional-widgets.example.test',
  companyAddress: { line1: '1 Example Street', city: 'London', postalCode: 'EC1A 1AA', country: 'GB' },
  companyTaxId: { type: 'gb_vat', value: 'GB000000000' },
  poNumber: 'PO-FICTIONAL-42',
  locale: 'en-GB' as const,
};
const subscription = {
  tenantId: customer.tenantId,
  billingAccountId: customer.billingAccountId,
  customerId: 'cus_test_fictional',
  planId: 'core',
  productName: 'Thapsus-HR Core',
  taxCode: 'txcd_10103001',
  currency: 'EUR',
  interval: 'year' as const,
  unitAmountMinor: 4590,
  quantity: 120,
  collection: 'send_invoice' as const,
  daysUntilDue: 45,
  idempotencyKey: 'contract:x:y',
};

describe('Stripe Billing + Stripe Tax request shapes', () => {
  it('creates customers with company address, tax id, PO number custom field and Thapsus ids as metadata', async () => {
    const { calls, provider } = mockStripe();
    expect(await provider.upsertCustomer(customer)).toEqual({ customerId: 'cus_test_fictional' });
    const [params, options] = calls[0]!.args as [Record<string, unknown>, Record<string, unknown>];
    expect(calls[0]!.method).toBe('customers.create');
    expect(params).toMatchObject({
      name: 'Fictional Widgets Ltd',
      email: customer.contactEmail,
      address: { line1: '1 Example Street', city: 'London', postal_code: 'EC1A 1AA', country: 'GB' },
      preferred_locales: ['en-gb'],
      invoice_settings: { custom_fields: [{ name: 'PO number', value: 'PO-FICTIONAL-42' }] },
      metadata: {
        thapsus_tenant_id: customer.tenantId,
        thapsus_billing_account_id: customer.billingAccountId,
      },
      tax: { validate_location: 'deferred' },
      tax_id_data: [{ type: 'gb_vat', value: 'GB000000000' }],
    });
    expect(
      String((params.invoice_settings as { custom_fields: Array<{ name: string }> }).custom_fields[0]!.name)
        .length,
    ).toBeLessThanOrEqual(40);
    expect(options).toEqual({ idempotencyKey: `customer:${customer.tenantId}:${customer.billingAccountId}` });
    await provider.upsertCustomer({ ...customer, existingCustomerId: 'cus_test_fictional', poNumber: null });
    expect(calls.at(-1)).toMatchObject({
      method: 'customers.update',
      args: ['cus_test_fictional', { invoice_settings: { custom_fields: '' } }],
    });
  });

  it('creates subscriptions with inline prices, automatic tax, the subscription currency and invoice collection with payment terms', async () => {
    const { calls, provider } = mockStripe();
    const out = await provider.createSubscription(subscription);
    expect(calls.map((c) => c.method)).toEqual([
      'products.retrieve',
      'products.create',
      'subscriptions.create',
    ]);
    expect(calls[1]!.args[0]).toMatchObject({
      id: 'thapsus_hr_core',
      name: 'Thapsus-HR Core',
      tax_code: 'txcd_10103001',
    });
    const [params, options] = calls[2]!.args as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({
      customer: 'cus_test_fictional',
      currency: 'eur',
      items: [
        {
          price_data: {
            currency: 'eur',
            product: 'thapsus_hr_core',
            recurring: { interval: 'year' },
            unit_amount: 4590,
            tax_behavior: 'exclusive',
          },
          quantity: 120,
        },
      ],
      automatic_tax: { enabled: true },
      collection_method: 'send_invoice',
      days_until_due: 45,
      metadata: { thapsus_tenant_id: customer.tenantId, thapsus_plan_id: 'core' },
    });
    expect(params).not.toHaveProperty('payment_behavior');
    expect(options).toEqual({ idempotencyKey: 'contract:x:y' });
    expect(out).toEqual({
      id: 'sub_test_fictional',
      status: 'trialing',
      currentPeriodStart: new Date(1_790_000_000_000).toISOString().replace('.000', ''),
      currentPeriodEnd: new Date(1_800_000_000_000).toISOString().replace('.000', ''),
      trialEnd: new Date(1_800_000_000_000).toISOString().replace('.000', ''),
      cancelAt: null,
    });
  });

  it('card-paid self-serve subscriptions keep a trial end and allow incomplete first payments', async () => {
    const { calls, provider } = mockStripe({ productExists: true });
    await provider.createSubscription({
      ...subscription,
      currency: 'GBP',
      interval: 'month',
      collection: 'charge_automatically',
      daysUntilDue: null,
      trialEnd: '2027-01-01T00:00:00Z',
    });
    const params = calls.at(-1)!.args[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      currency: 'gbp',
      collection_method: 'charge_automatically',
      payment_behavior: 'allow_incomplete',
      trial_end: Date.UTC(2027, 0, 1) / 1000,
    });
    expect(params).not.toHaveProperty('days_until_due');
  });

  it('updates the existing item (proration as requested) and schedules or clears cancellation', async () => {
    const { calls, provider } = mockStripe({ productExists: true });
    await provider.updateSubscription('sub_test_fictional', {
      planId: 'core',
      productName: 'Thapsus-HR Core',
      taxCode: 'txcd_10103001',
      currency: 'GBP',
      interval: 'month',
      unitAmountMinor: 360,
      quantity: 60,
      proration: 'none',
      idempotencyKey: 'k1',
    });
    const upd = calls.find((c) => c.method === 'subscriptions.update')!;
    expect(upd.args[1]).toMatchObject({
      items: [{ id: 'si_test_fictional', quantity: 60, price_data: { unit_amount: 360, currency: 'gbp' } }],
      proration_behavior: 'none',
      automatic_tax: { enabled: true },
    });
    await provider.setCancelAt('sub_test_fictional', '2027-06-01T00:00:00Z', 'k2');
    expect(calls.at(-1)!.args[1]).toEqual({
      cancel_at: Date.UTC(2027, 5, 1) / 1000,
      proration_behavior: 'none',
    });
    await provider.setCancelAt('sub_test_fictional', null, 'k3');
    expect(calls.at(-1)!.args[1]).toEqual({ cancel_at: '' });
  });

  it('collects cards on a Stripe-hosted setup page and sets the default payment method afterwards', async () => {
    const { calls, provider } = mockStripe();
    expect(
      await provider.createPaymentSetupSession({
        customerId: 'cus_test_fictional',
        currency: 'USD',
        returnUrl: 'https://app.us.thapsus-hr.example/app/billing',
        idempotencyKey: 'k',
      }),
    ).toEqual({ url: 'https://checkout.stripe.example.test/c/fictional' });
    expect(calls[0]!.args[0]).toEqual({
      mode: 'setup',
      customer: 'cus_test_fictional',
      currency: 'usd',
      success_url: 'https://app.us.thapsus-hr.example/app/billing?setup=done',
      cancel_url: 'https://app.us.thapsus-hr.example/app/billing',
    });
    await provider.completePaymentSetup({
      customerId: 'cus_test_fictional',
      setupIntentId: 'seti_test_fictional',
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'customers.update',
      args: ['cus_test_fictional', { invoice_settings: { default_payment_method: 'pm_test_fictional' } }],
    });
  });

  it('accepts only test-mode keys until live mode is approved', () => {
    expect(() => assertTestModeKey('sk_test_fictional')).not.toThrow();
    expect(() => assertTestModeKey('rk_test_fictional')).not.toThrow();
    expect(() => assertTestModeKey('sk_' + 'live_fictional')).toThrow(/test-mode/);
    expect(() => StripeBillingProvider.fromKey('pk_test_fictional')).toThrow(/test-mode/);
  });
});

describe('webhook signature verification (official SDK)', () => {
  const secret = 'whsec_fictional_unit_test_only';
  const now = 1_790_000_000;
  const payload = JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: 'in_test_1',
        customer: 'cus_test_1',
        status: 'open',
        currency: 'gbp',
        subtotal: 1000,
        total: 1200,
        total_excluding_tax: 1000,
        amount_due: 1200,
        amount_paid: 0,
        customer_email: 'someone@fictional.example.test',
        customer_name: 'Fictional Person',
        parent: { subscription_details: { subscription: 'sub_test_1' } },
      },
    },
  });

  it('verifies with the SDK test header and reduces the event to the fields billing needs', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now });
    const e = verifyWebhook(Buffer.from(payload), header, secret, now * 1000);
    expect(e).toEqual({
      id: 'evt_test_1',
      type: 'invoice.payment_failed',
      customerId: 'cus_test_1',
      invoice: {
        id: 'in_test_1',
        number: null,
        status: 'open',
        currency: 'GBP',
        subtotalMinor: 1000,
        taxMinor: 200,
        totalMinor: 1200,
        amountDueMinor: 1200,
        amountPaidMinor: 0,
        periodStart: null,
        periodEnd: null,
        dueAt: null,
        hostedUrl: null,
        subscriptionId: 'sub_test_1',
      },
    });
    // personal fields present in the payload are not carried forward
    expect(JSON.stringify(e)).not.toMatch(/someone@|Fictional Person/);
  });

  it('rejects tampered bodies, wrong secrets and stale timestamps', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now });
    expect(() =>
      verifyWebhook(Buffer.from(payload.replace('1200', '1')), header, secret, now * 1000),
    ).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(Buffer.from(payload), header, 'whsec_other_fictional', now * 1000)).toThrow(
      WebhookSignatureError,
    );
    expect(() => verifyWebhook(Buffer.from(payload), header, secret, (now + 3600) * 1000)).toThrow(
      WebhookSignatureError,
    );
    expect(() => verifyWebhook(Buffer.from(payload), undefined, secret, now * 1000)).toThrow(
      WebhookSignatureError,
    );
  });
});
