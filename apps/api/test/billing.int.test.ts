import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancellationEffectiveAt, loadBillingConfig, planById, quote, trialEndsAt } from '@thapsus/core/billing';
import { withTenant } from '@thapsus/db';
import { FIELDS } from '../src/modules/employees/model';
import { FakeBillingProvider, type CustomerInput, type SubscriptionInput, type SubscriptionUpdate } from '../src/modules/billing/provider';
import { eventSubscribers } from '../src/worker';
import { closeDb, ownerSession, signup, startTestApp, type TestContext } from './helpers';
import { hire, injector, legalEntity, postWebhook, runJob, runQueued, signedEvent, unix, userSession, WEBHOOK_SECRET } from './phase10-helpers';

/**
 * Self-serve billing (PROGRESS 10.4) against the recording fake provider: trial at sign-up, prices
 * from config, plan changes with the documented proration rules, cancellation with notice,
 * reactivation, signed idempotent webhooks, failed-payment emails from the home region — and proof
 * that no employee data is ever sent to the billing provider.
 */
const cfg = loadBillingConfig('builtin:billing-config-v1');
let ctx: TestContext;
let fake: FakeBillingProvider;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let api: (method: string, url: string, payload?: unknown, cookie?: string) => ReturnType<TestContext['app']['inject']>;
let entityId: string;
const people = [
  { legalFirstName: 'Ada', legalLastName: 'Fictionalson', workEmail: 'ada.fictionalson@billing-people.example.test', employeeNumber: 'FIC-0001', jobTitle: 'Payroll analyst' },
  { legalFirstName: 'Bo', legalLastName: 'Placeholder', workEmail: 'bo.placeholder@billing-people.example.test', employeeNumber: 'FIC-0002', jobTitle: 'Rota planner' },
];

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  fake = new FakeBillingProvider(() => ctx.clock.now);
  ctx.deps.billing = fake;
  ctx.deps.stripeWebhookSecret = WEBHOOK_SECRET;
  owner = await ownerSession(ctx);
  const inj = injector(ctx);
  api = (m, u, p, c = owner.cookie) => inj(m, u, p, c);
  entityId = await legalEntity(ctx, owner.cookie);
  for (const p of people) await hire(ctx, owner.cookie, entityId, p);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const billing = async () => (await api('GET', '/v1/billing')).json();
const details = {
  name: 'Fictional Widgets Ltd',
  address: { line1: '1 Example Street', city: 'London', postalCode: 'EC1A 1AA', country: 'GB' },
  companyTaxId: { type: 'gb_vat', value: 'GB000000000' },
  contacts: [
    { name: 'Olive Owner', email: 'billing@fictional-widgets.example.test', isPrimary: true },
    { name: 'Finn Finance', email: 'finance@fictional-widgets.example.test', isPrimary: false },
  ],
};
const tenantCustomer = () => [...fake.customers.entries()].find(([, v]) => v.tenantId === owner.tenantId)![0];
const activate = async (subId: string, start: string, end: string) => {
  // the provider's own state moves on too (as Stripe's would when the trial ends and payment succeeds)
  Object.assign(fake.subscriptions.get(subId)!, { status: 'active', currentPeriodStart: start, currentPeriodEnd: end, trialEnd: null });
  const e = signedEvent(ctx, 'customer.subscription.updated', { id: subId, object: 'subscription', status: 'active', customer: tenantCustomer(), items: { data: [{ current_period_start: unix(start), current_period_end: unix(end) }] }, cancel_at: null, metadata: { thapsus_tenant_id: owner.tenantId } });
  return postWebhook(ctx, e);
};

describe('trial and prices', () => {
  it('starts a free trial at sign-up (length from config) on the default billing account', async () => {
    const b = await billing();
    expect(b.selfServe).toBe(true);
    expect(b.accounts).toHaveLength(1);
    const sub = b.accounts[0].subscription;
    const created = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.one<{ created_at: string }>('SELECT created_at FROM app.tenants'));
    expect(sub).toMatchObject({ status: 'trialing', planId: cfg.trial.planId, hasProviderSubscription: false });
    expect(new Date(sub.trialEndsAt).toISOString()).toBe(new Date(trialEndsAt(cfg, created.created_at)).toISOString());
    expect(b.accounts[0].headcount).toBe(people.length);
  });

  it('the tenant.created subscriber creates the trial idempotently', async () => {
    const other = await signup(ctx);
    for (let i = 0; i < 2; i++) await withTenant(ctx.deps.router, other.tenantId, (tx) => Promise.all((eventSubscribers['tenant.created'] ?? []).map((s) => s(tx, { tenantId: other.tenantId, id: '1', topic: 'tenant.created', aggregateType: 'tenant', aggregateId: other.tenantId, payload: {}, createdAt: '' }))));
    const n = await withTenant(ctx.deps.router, other.tenantId, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.billing_subscriptions WHERE status = 'trialing'`));
    expect(n.n).toBe(1);
  });

  it('publishes plans and prices from the billing configuration (public endpoint)', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/billing/plans' });
    expect(r.statusCode).toBe(200);
    expect(r.json().configVersion).toBe(cfg.version);
    expect(r.json().plans.find((p: { id: string }) => p.id === 'core').bands).toEqual(planById(cfg, 'core')!.bands);
  });

  it('quotes from config for the aggregate headcount (minimum billable employees applies)', async () => {
    const r = await api('POST', '/v1/billing/quote', { planId: 'core', term: 'annual', currency: 'EUR' });
    expect(r.statusCode, r.body).toBe(200);
    const q = quote(cfg, { planId: 'core', term: 'annual', currency: 'EUR', headcount: people.length });
    expect(r.json().quote).toMatchObject({ quantity: q.quantity, interval: 'year', totalAmount: { amountMinor: Number(q.totalAmount.amountMinor), currency: 'EUR' } });
    expect((await api('POST', '/v1/billing/quote', { planId: 'enterprise', term: 'annual', currency: 'GBP' })).statusCode).toBe(422);
    expect((await api('POST', '/v1/billing/quote', { planId: 'core', term: 'monthly', currency: 'GBP', discountCode: 'NOPE' })).statusCode).toBe(400);
  });

  it('only owners manage billing', async () => {
    const e = await userSession(ctx, owner);
    expect((await api('GET', '/v1/billing', undefined, e.cookie)).statusCode).toBe(403);
    expect((await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: 'GBP' }, e.cookie)).statusCode).toBe(403);
  });
});

describe('subscription lifecycle (Stripe test mode, mocked provider)', () => {
  let subId: string;

  it('needs billing details, then starts the chosen plan, term and currency keeping the trial days left', async () => {
    const before = await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: 'GBP' });
    expect(before.statusCode).toBe(422);
    const acct = (await billing()).accounts[0];
    expect((await api('PUT', `/v1/billing/accounts/${acct.id}/details`, { ...details, contacts: [{ ...details.contacts[0], isPrimary: false }] })).statusCode).toBe(400);
    expect((await api('PUT', `/v1/billing/accounts/${acct.id}/details`, details)).statusCode).toBe(204);
    const r = await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: 'GBP' });
    expect(r.statusCode, r.body).toBe(201);
    const create = fake.calls.find((c) => c.op === 'createSubscription')!.input as SubscriptionInput;
    const q = quote(cfg, { planId: 'core', term: 'monthly', currency: 'GBP', headcount: people.length });
    expect(create).toMatchObject({ planId: 'core', currency: 'GBP', interval: 'month', quantity: q.quantity, unitAmountMinor: Number(q.unitAmount.amountMinor), collection: 'charge_automatically', taxCode: cfg.providerTaxCode });
    expect(create.trialEnd).toBe(acct.subscription.trialEndsAt);
    const sub = (await billing()).accounts[0].subscription;
    expect(sub).toMatchObject({ status: 'trialing', planId: 'core', hasProviderSubscription: true });
    subId = [...fake.subscriptions.keys()][0]!;
    expect(ctx.directory.entries.get(owner.tenantId)?.planRef).toBe('core');
    expect((await api('POST', '/v1/billing/subscription', { planId: 'plus', term: 'monthly', currency: 'GBP' })).statusCode).toBe(409);
  });

  it('upgrades immediately with a prorated charge for the rest of the period', async () => {
    const start = new Date(ctx.clock.now.getTime() - 10 * 86_400_000).toISOString();
    const end = new Date(ctx.clock.now.getTime() + 20 * 86_400_000).toISOString();
    expect((await activate(subId, start, end)).json()).toMatchObject({ outcome: 'processed' });
    expect((await billing()).accounts[0].subscription.status).toBe('active');
    const preview = (await api('POST', '/v1/billing/quote', { planId: 'plus', term: 'monthly' })).json();
    expect(preview.kind).toBe('upgrade');
    expect(preview.proration.net.amountMinor).toBeGreaterThan(0);
    const r = await api('POST', '/v1/billing/subscription/change', { planId: 'plus', term: 'monthly' });
    expect(r.statusCode, r.body).toBe(200);
    const upd = fake.calls.filter((c) => c.op === 'updateSubscription').at(-1)!.input as SubscriptionUpdate;
    expect(upd).toMatchObject({ planId: 'plus', proration: 'create_prorations', interval: 'month' });
    expect((await billing()).accounts[0].subscription).toMatchObject({ planId: 'plus', pendingChange: null });
  });

  it('downgrades at the end of the paid period (new price from the next renewal, plan kept until then)', async () => {
    const r = await api('POST', '/v1/billing/subscription/change', { planId: 'core', term: 'monthly' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().kind).toBe('downgrade');
    const upd = fake.calls.filter((c) => c.op === 'updateSubscription').at(-1)!.input as SubscriptionUpdate;
    expect(upd).toMatchObject({ planId: 'core', proration: 'none' });
    const sub = (await billing()).accounts[0].subscription;
    expect(sub.planId).toBe('plus');
    expect(sub.pendingChange).toMatchObject({ kind: 'downgrade', planId: 'core', effectiveAt: sub.currentPeriodEnd });
    // after the period ends the daily job applies it
    const saved = ctx.clock.now;
    ctx.clock.now = new Date(new Date(sub.currentPeriodEnd).getTime() + 3_600_000);
    try {
      const out = await runJob(ctx, owner.tenantId, 'billing.daily');
      expect(out).toMatchObject({ downgrades: 1 });
    } finally {
      ctx.clock.now = saved;
    }
    expect((await billing()).accounts[0].subscription).toMatchObject({ planId: 'core', pendingChange: null });
  });

  it('switching annual → monthly waits for the end of the term, then a replacement starts', async () => {
    const up = await api('POST', '/v1/billing/subscription/change', { planId: 'core', term: 'annual' });
    expect(up.json().kind).toBe('term_upgrade');
    expect((fake.calls.filter((c) => c.op === 'updateSubscription').at(-1)!.input as SubscriptionUpdate).interval).toBe('year');
    const down = await api('POST', '/v1/billing/subscription/change', { planId: 'core', term: 'monthly' });
    expect(down.json().kind).toBe('term_downgrade');
    const sub = (await billing()).accounts[0].subscription;
    expect(sub.pendingChange).toMatchObject({ kind: 'replace', term: 'monthly' });
    expect(fake.calls.filter((c) => c.op === 'setCancelAt').at(-1)!.input).toMatchObject({ id: subId, at: sub.currentPeriodEnd });
    // the provider ends the annual subscription at term end → replacement monthly subscription
    const ended = signedEvent(ctx, 'customer.subscription.deleted', { id: subId, object: 'subscription', status: 'canceled', customer: tenantCustomer(), items: { data: [] }, metadata: { thapsus_tenant_id: owner.tenantId } });
    expect((await postWebhook(ctx, ended)).json().outcome).toBe('processed');
    await runQueued(ctx, owner.tenantId, 'billing.apply_replacement');
    const next = (await billing()).accounts[0].subscription;
    expect(next).toMatchObject({ planId: 'core', term: 'monthly', hasProviderSubscription: true, status: 'active' });
    expect((fake.calls.filter((c) => c.op === 'createSubscription').at(-1)!.input as SubscriptionInput).interval).toBe('month');
    subId = [...fake.subscriptions.entries()].find(([, s]) => s.status !== 'canceled' && s.id !== subId)![0];
  });

  it('cancels with notice (end of the first period after the notice period) and can be reactivated before then', async () => {
    const sub = (await billing()).accounts[0].subscription;
    const r = await api('POST', '/v1/billing/subscription/cancel');
    expect(r.statusCode, r.body).toBe(200);
    const expected = cancellationEffectiveAt(cfg, { term: 'monthly', requestedAt: ctx.clock.now.toISOString(), currentPeriodEnd: sub.currentPeriodEnd, status: sub.status });
    expect(new Date(r.json().effectiveAt).toISOString()).toBe(new Date(expected).toISOString());
    expect(fake.calls.filter((c) => c.op === 'setCancelAt').at(-1)!.input).toMatchObject({ id: subId, at: expected });
    expect((await billing()).accounts[0].subscription.cancelEffectiveAt).toBeTruthy();
    expect((await api('POST', '/v1/billing/subscription/change', { planId: 'plus', term: 'monthly' })).statusCode).toBe(409);
    expect((await api('POST', '/v1/billing/subscription/reactivate')).statusCode).toBe(204);
    expect(fake.calls.filter((c) => c.op === 'setCancelAt').at(-1)!.input).toMatchObject({ id: subId, at: null });
    expect((await billing()).accounts[0].subscription.cancelEffectiveAt).toBeNull();
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.query<{ action: string }>(`SELECT action FROM audit.events WHERE action LIKE 'billing.%' ORDER BY id`));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['billing.trial_started', 'billing.subscription_started', 'billing.subscription_changed', 'billing.subscription_cancelled', 'billing.subscription_reactivated', 'billing.details_updated']));
  });

  it('hosted card setup: only the customer id, currency and return URL are sent', async () => {
    const r = await api('POST', '/v1/billing/payment-method', {});
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'createPaymentSetupSession', input: { currency: 'GBP', returnUrl: `${ctx.deps.config.appBaseUrl}/app/billing` } });
  });

  it('re-prices for the current headcount (aggregate count) from the next invoice', async () => {
    for (let i = 0; i < 4; i++) await hire(ctx, owner.cookie, entityId, { legalFirstName: `Extra${i}`, legalLastName: 'Fictional' });
    await runJob(ctx, owner.tenantId, 'billing.daily');
    const upd = fake.calls.filter((c) => c.op === 'updateSubscription').at(-1)!.input as SubscriptionUpdate;
    expect(upd).toMatchObject({ quantity: people.length + 4, proration: 'none' });
    const usage = await ctx.deps.router.registryPool().query('SELECT headcount FROM backoffice.tenant_usage WHERE subject_tenant_id = $1', [owner.tenantId]);
    expect(usage.rows[0].headcount).toBe(people.length + 4);
  });
});

describe('webhooks', () => {
  const customerId = tenantCustomer;

  it('rejects bad signatures and stale or tampered payloads', async () => {
    const e = signedEvent(ctx, 'invoice.paid', { id: 'in_test_bad', customer: customerId() });
    expect((await postWebhook(ctx, { payload: e.payload, header: 't=1,v1=deadbeef' })).statusCode).toBe(400);
    expect((await postWebhook(ctx, { payload: e.payload.replace('in_test_bad', 'in_test_evil'), header: e.header })).statusCode).toBe(400);
    const wrongSecret = signedEvent(ctx, 'invoice.paid', { id: 'in_test_bad', customer: customerId() }, undefined, 'whsec_someone_else');
    expect((await postWebhook(ctx, wrongSecret)).statusCode).toBe(400);
  });

  it('records failed payments once per event id, marks the subscription past due and emails the billing contacts from the home region', async () => {
    const sub = (await billing()).accounts[0].subscription;
    const providerSubId = subId();
    const e = signedEvent(ctx, 'invoice.payment_failed', {
      id: 'in_test_fictional_1',
      object: 'invoice',
      customer: customerId(),
      number: 'FIC-0001',
      status: 'open',
      currency: 'gbp',
      subtotal: 6000,
      total: 7200,
      total_excluding_tax: 6000,
      amount_due: 7200,
      amount_paid: 0,
      due_date: unix(ctx.clock.now.toISOString()),
      hosted_invoice_url: 'https://invoice.stripe.example.test/i/fictional',
      parent: { subscription_details: { subscription: providerSubId } },
      lines: { data: [{ period: { start: unix(sub.currentPeriodStart), end: unix(sub.currentPeriodEnd) } }] },
      customer_email: 'billing@fictional-widgets.example.test',
    });
    expect((await postWebhook(ctx, e)).json()).toEqual({ received: true, outcome: 'processed' });
    expect((await postWebhook(ctx, e)).json()).toEqual({ received: true, outcome: 'duplicate' });
    const invoices = (await api('GET', '/v1/billing/invoices')).json();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ number: 'FIC-0001', status: 'open', total: { amountMinor: 7200, currency: 'GBP' }, tax: { amountMinor: 1200 }, paymentFailedAt: expect.any(String) });
    expect((await billing()).accounts[0].subscription.status).toBe('past_due');
    ctx.mailer.sent.length = 0;
    await runQueued(ctx, owner.tenantId, 'billing.payment_failed_email');
    await runQueued(ctx, owner.tenantId, 'billing.payment_failed_email'); // idempotent: nothing left to run
    expect(ctx.mailer.region).toBe(ctx.deps.config.cell);
    expect(ctx.mailer.sent.map((m) => m.to).sort()).toEqual(details.contacts.map((c) => c.email).sort());
    expect(ctx.mailer.sent[0]!.text).toContain('FIC-0001');
    // only the event id and type are kept; no payload is stored
    const stored = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.query('SELECT * FROM app.billing_webhook_events'));
    for (const row of stored) expect(Object.keys(row).sort()).toEqual(['event_id', 'received_at', 'tenant_id', 'type']);
    const paid = signedEvent(ctx, 'invoice.paid', { id: 'in_test_fictional_1', customer: customerId(), status: 'paid', currency: 'gbp', total: 7200, amount_paid: 7200, amount_due: 0, parent: { subscription_details: { subscription: providerSubId } } });
    await postWebhook(ctx, paid);
    expect((await billing()).accounts[0].subscription.status).toBe('active');
  });

  it('ignores events for customers that are not homed in this cell', async () => {
    const e = signedEvent(ctx, 'invoice.payment_failed', { id: 'in_test_elsewhere', customer: 'cus_fake_unknown_elsewhere', status: 'open', currency: 'eur' });
    expect((await postWebhook(ctx, e)).json()).toEqual({ received: true, outcome: 'ignored' });
  });

  function subId() {
    return [...fake.subscriptions.values()].filter((s) => s.status !== 'canceled').at(-1)!.id;
  }
});

describe('no employee personal data reaches the billing provider', () => {
  it('every payload sent to the provider holds company-level data, ids and aggregate counts only', () => {
    expect(fake.calls.length).toBeGreaterThan(8);
    const ALLOWED: Record<string, string[]> = {
      upsertCustomer: ['tenantId', 'billingAccountId', 'existingCustomerId', 'legalName', 'contactName', 'contactEmail', 'companyAddress', 'companyTaxId', 'poNumber', 'locale'],
      createSubscription: ['tenantId', 'billingAccountId', 'customerId', 'planId', 'productName', 'taxCode', 'currency', 'interval', 'unitAmountMinor', 'quantity', 'trialEnd', 'collection', 'daysUntilDue', 'idempotencyKey'],
      updateSubscription: ['id', 'planId', 'productName', 'taxCode', 'currency', 'interval', 'unitAmountMinor', 'quantity', 'proration', 'idempotencyKey'],
      setCancelAt: ['id', 'at', 'idempotencyKey'],
      cancelNow: ['id', 'idempotencyKey'],
      createPaymentSetupSession: ['customerId', 'currency', 'returnUrl', 'idempotencyKey'],
      completePaymentSetup: ['customerId', 'setupIntentId'],
    };
    const employeeKeys = new Set([...Object.keys(FIELDS), 'employee', 'employees', 'employeeId', 'employeeNumber', 'workEmail', 'personalEmail', 'displayName', 'legalFirstName', 'legalLastName', 'dateOfBirth', 'nationalId', 'salary', 'jobTitle', 'manager']);
    const forbiddenValues = people.flatMap((p) => [`${p.legalFirstName} ${p.legalLastName}`, p.legalLastName, p.workEmail, p.employeeNumber, p.jobTitle, ...['Extra0', 'Extra1', 'Extra2', 'Extra3']]);
    const walk = (v: unknown, path: string, out: Array<[string, unknown]>) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
      else out.push([path, v]);
      return out;
    };
    for (const call of fake.calls) {
      const input = call.input as Record<string, unknown>;
      expect(Object.keys(input).every((k) => ALLOWED[call.op]!.includes(k)), `${call.op} keys ${Object.keys(input)}`).toBe(true);
      for (const [path, value] of walk(input, '', [])) {
        expect(employeeKeys.has(path.split('.').at(-1)!), `${call.op}: ${path}`).toBe(false);
        if (typeof value === 'string') for (const f of forbiddenValues) expect(value.toLowerCase().includes(f.toLowerCase()), `${call.op}: ${path}`).toBe(false);
      }
    }
    // the only personal data sent is the billing contact listed in docs/SUBPROCESSORS.md
    const customer = fake.calls.find((c) => c.op === 'upsertCustomer')!.input as CustomerInput;
    expect(customer).toMatchObject({ contactName: 'Olive Owner', contactEmail: 'billing@fictional-widgets.example.test', legalName: 'Fictional Widgets Ltd' });
  });
});
