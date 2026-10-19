import Stripe from 'stripe';
import { Temporal } from '@thapsus/core/time';
import type { BillingProvider, CustomerInput, ProviderSubscription, SubscriptionInput, SubscriptionUpdate } from './provider';

/**
 * Stripe Billing + Stripe Tax, TEST MODE ONLY until the product owner approves live mode (HUMAN_TODO
 * 4.1). One Stripe account per home region; this cell only holds its own region's keys (ADR-0103).
 * Request shapes follow the official API reference:
 *  - Customers: https://docs.stripe.com/api/customers/create (invoice_settings.custom_fields ≤ 4,
 *    name ≤ 40 chars, value ≤ 140 chars; tax.validate_location)
 *  - Subscriptions: https://docs.stripe.com/api/subscriptions/create (items[].price_data with
 *    currency, product, recurring.interval, unit_amount, tax_behavior; automatic_tax[enabled];
 *    collection_method + days_until_due; trial_end; proration_behavior)
 *  - Stripe Tax on subscriptions: https://docs.stripe.com/tax/subscriptions
 *  - Tax codes: https://docs.stripe.com/tax/tax-codes (txcd_10103001, SaaS for business use)
 *  - Checkout in setup mode: https://docs.stripe.com/payments/save-and-reuse?platform=checkout
 */
export type StripeLike = Pick<Stripe, 'customers' | 'subscriptions' | 'products' | 'checkout' | 'setupIntents'>;

const unix = (instant: string) => Math.floor(Temporal.Instant.from(instant).epochMilliseconds / 1000);
const instant = (s: number | null | undefined) => (s ? Temporal.Instant.fromEpochMilliseconds(s * 1000).toString() : null);

export function assertTestModeKey(key: string): void {
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Only Stripe test-mode keys are accepted until live mode is approved (HUMAN_TODO 4.1)');
}

export class StripeBillingProvider implements BillingProvider {
  readonly kind = 'stripe' as const;
  private readonly products = new Set<string>();
  constructor(private readonly stripe: StripeLike) {}

  static fromKey(secretKey: string): StripeBillingProvider {
    assertTestModeKey(secretKey);
    return new StripeBillingProvider(new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, telemetry: false }));
  }

  async upsertCustomer(c: CustomerInput) {
    const params = {
      name: c.legalName,
      business_name: c.legalName,
      individual_name: c.contactName,
      email: c.contactEmail,
      address: { line1: c.companyAddress.line1, line2: c.companyAddress.line2 ?? undefined, city: c.companyAddress.city, state: c.companyAddress.region ?? undefined, postal_code: c.companyAddress.postalCode, country: c.companyAddress.country },
      preferred_locales: [c.locale.toLowerCase()],
      invoice_settings: { custom_fields: c.poNumber ? [{ name: 'PO number', value: c.poNumber.slice(0, 140) }] : ('' as const) },
      metadata: { thapsus_tenant_id: c.tenantId, thapsus_billing_account_id: c.billingAccountId },
      tax: { validate_location: 'deferred' as const },
    };
    if (c.existingCustomerId) {
      await this.stripe.customers.update(c.existingCustomerId, params);
      return { customerId: c.existingCustomerId };
    }
    const created = await this.stripe.customers.create(
      { ...params, ...(c.companyTaxId ? { tax_id_data: [{ type: c.companyTaxId.type as Stripe.CustomerCreateParams.TaxIdDatum.Type, value: c.companyTaxId.value }] } : {}) },
      { idempotencyKey: `customer:${c.tenantId}:${c.billingAccountId}` },
    );
    return { customerId: created.id };
  }

  private async product(planId: string, name: string, taxCode: string): Promise<string> {
    const id = `thapsus_hr_${planId}`;
    if (this.products.has(id)) return id;
    try {
      await this.stripe.products.retrieve(id);
    } catch (err) {
      if ((err as { code?: string }).code !== 'resource_missing') throw err;
      await this.stripe.products.create({ id, name, tax_code: taxCode, metadata: { thapsus_plan_id: planId } }, { idempotencyKey: `product:${id}` });
    }
    this.products.add(id);
    return id;
  }

  private priceData(i: { planId: string; currency: string; interval: 'month' | 'year'; unitAmountMinor: number }, product: string) {
    return { currency: i.currency.toLowerCase(), product, recurring: { interval: i.interval }, unit_amount: i.unitAmountMinor, tax_behavior: 'exclusive' as const };
  }

  private view(s: Stripe.Subscription): ProviderSubscription {
    const item = s.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
    return { id: s.id, status: s.status, currentPeriodStart: instant(item?.current_period_start), currentPeriodEnd: instant(item?.current_period_end), trialEnd: instant(s.trial_end), cancelAt: instant(s.cancel_at) };
  }

  async createSubscription(i: SubscriptionInput) {
    const product = await this.product(i.planId, i.productName, i.taxCode);
    const sub = await this.stripe.subscriptions.create(
      {
        customer: i.customerId,
        currency: i.currency.toLowerCase(),
        items: [{ price_data: this.priceData(i, product), quantity: i.quantity }],
        automatic_tax: { enabled: true },
        collection_method: i.collection,
        ...(i.collection === 'send_invoice' ? { days_until_due: i.daysUntilDue ?? 30 } : { payment_behavior: 'allow_incomplete' as const }),
        ...(i.trialEnd ? { trial_end: unix(i.trialEnd), trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' as const } } } : {}),
        metadata: { thapsus_tenant_id: i.tenantId, thapsus_billing_account_id: i.billingAccountId, thapsus_plan_id: i.planId },
      },
      { idempotencyKey: i.idempotencyKey },
    );
    return this.view(sub);
  }

  async updateSubscription(id: string, u: SubscriptionUpdate) {
    const product = await this.product(u.planId, u.productName, u.taxCode);
    const current = await this.stripe.subscriptions.retrieve(id);
    const itemId = current.items.data[0]?.id;
    const sub = await this.stripe.subscriptions.update(
      id,
      {
        items: [{ ...(itemId ? { id: itemId } : {}), price_data: this.priceData(u, product), quantity: u.quantity }],
        automatic_tax: { enabled: true },
        proration_behavior: u.proration,
        metadata: { thapsus_plan_id: u.planId },
      },
      { idempotencyKey: u.idempotencyKey },
    );
    return this.view(sub);
  }

  async setCancelAt(id: string, at: string | null, idempotencyKey: string) {
    const sub = await this.stripe.subscriptions.update(id, at ? { cancel_at: unix(at), proration_behavior: 'none' } : { cancel_at: '' }, { idempotencyKey });
    return this.view(sub);
  }

  async cancelNow(id: string, idempotencyKey: string) {
    await this.stripe.subscriptions.cancel(id, { prorate: false }, { idempotencyKey });
  }

  async createPaymentSetupSession(i: { customerId: string; currency: string; returnUrl: string; idempotencyKey: string }) {
    const s = await this.stripe.checkout.sessions.create(
      { mode: 'setup', customer: i.customerId, currency: i.currency.toLowerCase(), success_url: `${i.returnUrl}?setup=done`, cancel_url: i.returnUrl },
      { idempotencyKey: i.idempotencyKey },
    );
    if (!s.url) throw new Error('Stripe returned no checkout URL');
    return { url: s.url };
  }

  async completePaymentSetup(i: { customerId: string; setupIntentId: string }) {
    const si = await this.stripe.setupIntents.retrieve(i.setupIntentId);
    const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
    if (pm) await this.stripe.customers.update(i.customerId, { invoice_settings: { default_payment_method: pm } });
  }
}
