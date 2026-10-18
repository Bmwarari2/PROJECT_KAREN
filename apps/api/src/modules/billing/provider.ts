import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { Temporal } from '@thapsus/core/time';

/**
 * Billing provider boundary (ADR-0103). The billing module only ever sends these typed, company-level
 * inputs. There is no field for employee data: names and emails here are the customer's own billing
 * contact, listed in docs/SUBPROCESSORS.md. Headcount is an aggregate quantity.
 */
export interface ProviderAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export interface CustomerInput {
  tenantId: string;
  billingAccountId: string;
  existingCustomerId?: string | null;
  /** The customer company's legal name (shown on invoices). */
  legalName: string;
  /** Primary billing contact (the customer's own staff member, not an employee record). */
  contactName: string;
  contactEmail: string;
  address: ProviderAddress;
  companyTaxId?: { type: string; value: string } | null;
  poNumber?: string | null;
  locale: 'en-GB' | 'en-US';
}

export interface SubscriptionInput {
  tenantId: string;
  billingAccountId: string;
  customerId: string;
  planId: string;
  productName: string;
  taxCode: string;
  currency: string;
  interval: 'month' | 'year';
  unitAmountMinor: number;
  /** Aggregate count of billable employees (or 1 for a flat contract fee). */
  quantity: number;
  /** UTC instant; omitted = no trial. */
  trialEnd?: string | null;
  collection: 'charge_automatically' | 'send_invoice';
  daysUntilDue?: number | null;
  idempotencyKey: string;
}

export interface SubscriptionUpdate {
  planId: string;
  productName: string;
  taxCode: string;
  currency: string;
  interval: 'month' | 'year';
  unitAmountMinor: number;
  quantity: number;
  proration: 'create_prorations' | 'none';
  idempotencyKey: string;
}

export interface ProviderSubscription {
  id: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
}

export interface BillingProvider {
  readonly kind: 'stripe' | 'fake';
  upsertCustomer(input: CustomerInput): Promise<{ customerId: string }>;
  createSubscription(input: SubscriptionInput): Promise<ProviderSubscription>;
  updateSubscription(id: string, input: SubscriptionUpdate): Promise<ProviderSubscription>;
  /** Schedules (instant) or clears (null) the end of a subscription. */
  setCancelAt(id: string, at: string | null, idempotencyKey: string): Promise<ProviderSubscription>;
  cancelNow(id: string, idempotencyKey: string): Promise<void>;
  /** Hosted page where the customer adds a card (card data never touches Thapsus-HR). */
  createPaymentSetupSession(input: { customerId: string; currency: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }>;
  /** After a hosted setup completes: make the new payment method the customer's default. */
  completePaymentSetup(input: { customerId: string; setupIntentId: string }): Promise<void>;
}

// ---- fake provider (tests, local dev and e2e; never in production) ------------------------------------
export interface RecordedCall {
  op: keyof BillingProvider;
  input: unknown;
}

const iso = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime()).round({ smallestUnit: 'second', roundingMode: 'floor' }).toString();

/** In-memory provider that records every payload it is sent, for the no-employee-data test. */
export class FakeBillingProvider implements BillingProvider {
  readonly kind = 'fake' as const;
  readonly calls: RecordedCall[] = [];
  readonly customers = new Map<string, CustomerInput>();
  readonly subscriptions = new Map<string, ProviderSubscription & { input: SubscriptionInput | SubscriptionUpdate }>();
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly checkoutBase = '/app/billing',
  ) {}

  private record(op: keyof BillingProvider, input: unknown) {
    this.calls.push({ op, input: structuredClone(input) });
  }

  async upsertCustomer(input: CustomerInput) {
    this.record('upsertCustomer', input);
    const id = input.existingCustomerId ?? `cus_fake_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.customers.set(id, input);
    return { customerId: id };
  }

  private period(interval: 'month' | 'year', from: Date) {
    const start = iso(from);
    const end = Temporal.Instant.from(start).toZonedDateTimeISO('UTC').add(interval === 'month' ? { months: 1 } : { years: 1 }).toInstant().toString();
    return { currentPeriodStart: start, currentPeriodEnd: end };
  }

  async createSubscription(input: SubscriptionInput) {
    this.record('createSubscription', input);
    const id = `sub_fake_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const start = input.trialEnd ? new Date(input.trialEnd) : this.now();
    const sub = { id, status: input.trialEnd ? 'trialing' : 'active', ...this.period(input.interval, start), trialEnd: input.trialEnd ?? null, cancelAt: null, input };
    if (input.trialEnd) sub.currentPeriodStart = iso(this.now());
    this.subscriptions.set(id, sub);
    return this.view(sub);
  }

  async updateSubscription(id: string, input: SubscriptionUpdate) {
    this.record('updateSubscription', { id, ...input });
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error('No such subscription');
    const prev = sub.input as SubscriptionUpdate;
    // Interval changes reset the billing cycle (as Stripe does).
    if (prev.interval !== input.interval) Object.assign(sub, this.period(input.interval, this.now()), { status: 'active', trialEnd: null });
    sub.input = input;
    return this.view(sub);
  }

  async setCancelAt(id: string, at: string | null, idempotencyKey: string) {
    this.record('setCancelAt', { id, at, idempotencyKey });
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error('No such subscription');
    sub.cancelAt = at;
    return this.view(sub);
  }

  async cancelNow(id: string, idempotencyKey: string) {
    this.record('cancelNow', { id, idempotencyKey });
    const sub = this.subscriptions.get(id);
    if (sub) sub.status = 'canceled';
  }

  async createPaymentSetupSession(input: { customerId: string; currency: string; returnUrl: string; idempotencyKey: string }) {
    this.record('createPaymentSetupSession', input);
    return { url: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}setup=fake_${randomUUID().slice(0, 8)}` };
  }

  async completePaymentSetup(input: { customerId: string; setupIntentId: string }) {
    this.record('completePaymentSetup', input);
  }

  private view(s: ProviderSubscription): ProviderSubscription {
    return { id: s.id, status: s.status, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd, trialEnd: s.trialEnd, cancelAt: s.cancelAt };
  }
}

// ---- webhooks ---------------------------------------------------------------------------------------
/** The only webhook fields the billing module reads. The raw payload is never logged or stored. */
export interface BillingEvent {
  id: string;
  type: string;
  customerId: string | null;
  subscription?: ProviderSubscription & { tenantId: string | null };
  invoice?: {
    id: string;
    number: string | null;
    status: string;
    currency: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    amountDueMinor: number;
    amountPaidMinor: number;
    periodStart: string | null;
    periodEnd: string | null;
    dueAt: string | null;
    hostedUrl: string | null;
    subscriptionId: string | null;
  };
  setup?: { setupIntentId: string | null; mode: string };
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

const ts = (v: unknown): string | null => (typeof v === 'number' && v > 0 ? iso(new Date(v * 1000)) : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);

/**
 * Verifies the `Stripe-Signature` header with the official SDK (HMAC-SHA256, 5-minute tolerance) and
 * reduces the event to the fields above. https://docs.stripe.com/webhooks#verify-events
 */
export function verifyWebhook(rawBody: Buffer, signature: string | undefined, secret: string, nowSeconds?: number): BillingEvent {
  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature ?? '', secret, undefined, undefined, nowSeconds) as never;
  } catch {
    throw new WebhookSignatureError();
  }
  const o = event.data?.object ?? {};
  const out: BillingEvent = { id: event.id, type: event.type, customerId: idOf(o.customer) };
  if (event.type.startsWith('customer.subscription.')) {
    // API 2025-03-31+: billing periods live on the subscription items.
    const item = ((o.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0] ?? {};
    out.subscription = {
      id: String(o.id),
      status: String(o.status),
      currentPeriodStart: ts(item.current_period_start ?? o.current_period_start),
      currentPeriodEnd: ts(item.current_period_end ?? o.current_period_end),
      trialEnd: ts(o.trial_end),
      cancelAt: ts(o.cancel_at),
      tenantId: str((o.metadata as Record<string, unknown> | undefined)?.thapsus_tenant_id),
    };
  } else if (event.type.startsWith('invoice.')) {
    const parent = (o.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details;
    const line = ((o.lines as { data?: Array<{ period?: { start?: number; end?: number } }> } | undefined)?.data ?? [])[0];
    out.invoice = {
      id: String(o.id),
      number: str(o.number),
      status: String(o.status ?? 'open'),
      currency: String(o.currency ?? '').toUpperCase(),
      subtotalMinor: int(o.subtotal),
      taxMinor: int(o.total) - int(o.total_excluding_tax ?? o.subtotal),
      totalMinor: int(o.total),
      amountDueMinor: int(o.amount_due),
      amountPaidMinor: int(o.amount_paid),
      periodStart: ts(line?.period?.start ?? o.period_start),
      periodEnd: ts(line?.period?.end ?? o.period_end),
      dueAt: ts(o.due_date),
      hostedUrl: str(o.hosted_invoice_url),
      subscriptionId: idOf(parent?.subscription ?? o.subscription),
    };
  } else if (event.type === 'checkout.session.completed') {
    out.setup = { setupIntentId: idOf(o.setup_intent), mode: String(o.mode) };
  }
  return out;
}
