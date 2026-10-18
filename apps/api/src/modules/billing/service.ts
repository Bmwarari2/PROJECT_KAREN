import type { FastifyInstance } from 'fastify';
import { REGIONS, type HomeRegion } from '@thapsus/core';
import {
  cancellationEffectiveAt,
  classifyChange,
  isBillingCurrency,
  loadBillingConfig,
  moneyJson,
  planById,
  prorationPreview,
  quote,
  trialEndsAt,
  type BillingConfig,
  type BillingCurrency,
  type ContractPricing,
  type Quote,
  type Term,
} from '@thapsus/core/billing';
import { money } from '@thapsus/core/money';
import { compareInstants, type Instant } from '@thapsus/core/time';
import { enqueueJob, withTenant, writeAudit, type TenantRouter, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { FakeBillingProvider, type BillingProvider, type ProviderAddress, type ProviderSubscription } from './provider';

/**
 * Billing domain (ADR-0103, ADR-0104, ADR-0107). Billing state lives in the tenant's home cell;
 * provider calls carry company-level data only and never run inside a database transaction.
 */
export const billingConfig = (): BillingConfig => loadBillingConfig(process.env.BILLING_CONFIG_LOCATION ?? 'builtin:billing-config-v1');

let fallbackProvider: FakeBillingProvider | undefined;
export function billingProvider(deps: Deps): BillingProvider {
  if (deps.billing) return deps.billing;
  if (deps.config.env === 'prod') throw new ApiError('internal', 'Billing provider not configured');
  fallbackProvider ??= new FakeBillingProvider(deps.now);
  return fallbackProvider;
}

export interface AccountRow {
  id: string;
  name: string;
  is_default: boolean;
  currency: BillingCurrency;
  address: Partial<ProviderAddress>;
  company_tax_id: string | null;
  company_tax_id_type: string | null;
  po_number: string | null;
  collection: 'charge_automatically' | 'send_invoice';
  payment_terms_days: number | null;
  provider_customer_id: string | null;
  has_payment_method: boolean;
}
export interface SubRow {
  id: string;
  billing_account_id: string;
  plan_id: string;
  term: Term;
  currency: BillingCurrency;
  status: 'trialing' | 'trial_expired' | 'incomplete' | 'active' | 'past_due' | 'canceled';
  source: 'self_serve' | 'contract';
  contract_id: string | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  quantity: number;
  band_id: string | null;
  unit_amount_minor: string;
  interval_amount_minor: string;
  discount_code: string | null;
  pending_change: PendingChange | null;
  cancel_requested_at: string | null;
  cancel_effective_at: string | null;
  canceled_at: string | null;
  provider_subscription_id: string | null;
  config_version: number;
}
export interface PendingChange {
  kind: 'downgrade' | 'replace';
  planId: string;
  term: Term;
  effectiveAt: string;
  quantity: number;
  bandId: string | null;
  unitAmountMinor: number;
  intervalAmountMinor: number;
}
export interface ContractRow {
  id: string;
  subject_tenant_id: string;
  reference: string;
  status: 'draft' | 'active' | 'ended';
  plan_id: string;
  currency: BillingCurrency;
  term: Term;
  starts_on: string;
  ends_on: string;
  renewal: string;
  renewal_notice_days: number;
  collection: 'charge_automatically' | 'send_invoice';
  payment_terms_days: number;
  pricing: ContractPricing;
  notes: string | null;
  activated_at: string | null;
}

const LIVE = `status <> 'canceled'`;

export async function defaultAccount(tx: Tx): Promise<AccountRow> {
  return tx.one<AccountRow>('SELECT * FROM app.billing_accounts WHERE is_default');
}

/**
 * The default billing account and the sign-up trial exist for every tenant. Created idempotently on
 * sign-up (tenant.created subscriber), on first billing access and by the daily job.
 */
export async function ensureBillingDefaults(tx: Tx, cfg: BillingConfig, now: Date): Promise<{ account: AccountRow; created: boolean }> {
  const t = await tx.one<{ name: string; default_currency: string; home_region: HomeRegion; created_at: string }>('SELECT name, default_currency, home_region, created_at FROM app.tenants');
  const currency = isBillingCurrency(t.default_currency) ? t.default_currency : REGIONS[t.home_region].defaultCurrency;
  await tx.exec(
    `INSERT INTO app.billing_accounts (tenant_id, name, is_default, currency) VALUES (app.current_tenant(), $1, true, $2)
     ON CONFLICT (tenant_id) WHERE is_default DO NOTHING`,
    [t.name.slice(0, 200), currency],
  );
  const account = await defaultAccount(tx);
  const any = await tx.maybe('SELECT 1 FROM app.billing_subscriptions WHERE billing_account_id = $1 LIMIT 1', [account.id]);
  if (any) return { account, created: false };
  const ends = trialEndsAt(cfg, t.created_at);
  const expired = compareInstants(ends, now.toISOString()) <= 0;
  await tx.exec(
    `INSERT INTO app.billing_subscriptions (tenant_id, billing_account_id, plan_id, term, currency, status, trial_ends_at, current_period_start, current_period_end, config_version)
     VALUES (app.current_tenant(), $1, $2, 'monthly', $3, $4, $5, $6, $5, $7)`,
    [account.id, cfg.trial.planId, currency, expired ? 'trial_expired' : 'trialing', ends, t.created_at, cfg.version],
  );
  await writeAudit(tx, { actorType: 'system', action: 'billing.trial_started', targetType: 'billing_account', targetId: account.id, diff: { planId: cfg.trial.planId, trialEndsAt: ends } });
  return { account, created: true };
}

/** Aggregate billable headcount per billing account (active employees; counts only). */
export async function headcounts(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx.query<{ account: string | null; n: number }>(
    `SELECT coalesce(bae.billing_account_id, (SELECT id FROM app.billing_accounts WHERE is_default)) AS account, count(*)::int AS n
       FROM app.employees e LEFT JOIN app.billing_account_entities bae ON bae.tenant_id = e.tenant_id AND bae.entity_id = e.entity_id
      WHERE e.status = 'active' GROUP BY 1`,
  );
  return new Map(rows.filter((r) => r.account).map((r) => [r.account!, r.n]));
}

export async function liveSubscription(tx: Tx, accountId: string): Promise<SubRow | undefined> {
  return tx.maybe<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE billing_account_id = $1 AND ${LIVE}`, [accountId]);
}

/** The tenant's active enterprise contract, from the cell's back-office store (shared database). */
export async function activeContract(router: TenantRouter, tenantId: string): Promise<ContractRow | null> {
  const { rows } = await router.registryPool().query<ContractRow>(
    `SELECT id, subject_tenant_id, reference, status, plan_id, currency, term, starts_on, ends_on, renewal, renewal_notice_days, collection, payment_terms_days, pricing, notes, activated_at
       FROM backoffice.contracts WHERE subject_tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export function contractPricing(c: ContractRow): ContractPricing {
  return { ...c.pricing, planId: c.plan_id, currency: c.currency, term: c.term };
}

export function quoteJson(q: Quote) {
  return {
    planId: q.planId,
    term: q.term,
    currency: q.currency,
    interval: q.interval,
    headcount: q.headcount,
    quantity: q.quantity,
    bandId: q.bandId,
    unitAmount: moneyJson(q.unitAmount),
    listAmount: moneyJson(q.listAmount),
    discountAmount: moneyJson(q.discountAmount),
    totalAmount: moneyJson(q.totalAmount),
    monthlyEquivalent: moneyJson(q.monthlyEquivalent),
    discountCode: q.discountCode,
    source: q.source,
    configVersion: q.configVersion,
  };
}

export function accountComplete(a: AccountRow, primary: { name: string; email: string } | undefined): boolean {
  return !!(primary && a.address?.line1 && a.address.city && a.address.postalCode && a.address.country);
}

export function providerStatus(s: string): SubRow['status'] {
  switch (s) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    default:
      return 'canceled';
  }
}

/** Creates or updates the provider customer for an account and records the routing entry (ids only). */
export async function syncCustomer(deps: Deps, tenantId: string, accountId: string): Promise<string | null> {
  const data = await withTenant(deps.router, tenantId, async (tx) => {
    const a = await tx.one<AccountRow>('SELECT * FROM app.billing_accounts WHERE id = $1', [accountId]);
    const primary = await tx.maybe<{ name: string; email: string }>('SELECT name, email FROM app.billing_contacts WHERE billing_account_id = $1 AND is_primary', [accountId]);
    const locale = (await tx.one<{ default_locale: string }>('SELECT default_locale FROM app.tenants')).default_locale;
    return { a, primary, locale };
  });
  if (!accountComplete(data.a, data.primary)) return data.a.provider_customer_id;
  const addr = data.a.address as ProviderAddress;
  const { customerId } = await billingProvider(deps).upsertCustomer({
    tenantId,
    billingAccountId: accountId,
    existingCustomerId: data.a.provider_customer_id,
    legalName: data.a.name,
    contactName: data.primary!.name,
    contactEmail: data.primary!.email,
    companyAddress: { line1: addr.line1, line2: addr.line2 ?? null, city: addr.city, region: addr.region ?? null, postalCode: addr.postalCode, country: addr.country },
    companyTaxId: data.a.company_tax_id && data.a.company_tax_id_type ? { type: data.a.company_tax_id_type, value: data.a.company_tax_id } : null,
    poNumber: data.a.po_number,
    locale: data.locale === 'en-US' ? 'en-US' : 'en-GB',
  });
  if (!data.a.provider_customer_id) {
    await withTenant(deps.router, tenantId, (tx) => tx.exec('UPDATE app.billing_accounts SET provider_customer_id = $2 WHERE id = $1', [accountId, customerId]));
    await deps.router
      .registryPool()
      .query('INSERT INTO backoffice.billing_customers (provider_customer_id, subject_tenant_id, billing_account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [customerId, tenantId, accountId]);
  }
  return customerId;
}

export interface QuoteContext {
  cfg: BillingConfig;
  account: AccountRow;
  sub: SubRow | undefined;
  headcount: number;
  contract: ContractRow | null;
}

export async function loadContext(app: FastifyInstance, tenantId: string, accountId?: string): Promise<QuoteContext> {
  const cfg = billingConfig();
  const contract = await activeContract(app.deps.router, tenantId);
  return withTenant(app.deps.router, tenantId, async (tx) => {
    const { account: def } = await ensureBillingDefaults(tx, cfg, app.deps.now());
    const account = accountId ? await tx.maybe<AccountRow>('SELECT * FROM app.billing_accounts WHERE id = $1', [accountId]) : def;
    if (!account) throw new ApiError('notFound');
    const sub = await liveSubscription(tx, account.id);
    const headcount = (await headcounts(tx)).get(account.id) ?? 0;
    return { cfg, account, sub, headcount, contract };
  });
}

export interface ChangePreview {
  kind: ReturnType<typeof classifyChange>;
  effectiveAt: Instant;
  quote: Quote;
  proration: ReturnType<typeof prorationPreview> | null;
}

/** What a self-serve change would do, before the owner confirms it. */
export function previewChange(ctx: QuoteContext, to: { planId: string; term: Term; currency: BillingCurrency; discountCode?: string | null }, now: Instant): ChangePreview {
  const q = quote(ctx.cfg, { ...to, headcount: ctx.headcount, on: now.slice(0, 10) });
  const sub = ctx.sub;
  if (!sub?.provider_subscription_id) return { kind: 'upgrade', effectiveAt: now, quote: q, proration: null };
  const kind = classifyChange(ctx.cfg, { planId: sub.plan_id, term: sub.term }, { planId: q.planId, term: q.term });
  const immediate = kind === 'upgrade' || kind === 'term_upgrade' || sub.status === 'trialing';
  const effectiveAt = immediate ? now : (sub.current_period_end ?? now);
  const proration =
    immediate && sub.status !== 'trialing' && sub.current_period_start && sub.current_period_end && sub.term === q.term
      ? prorationPreview({ oldIntervalAmount: money(BigInt(sub.interval_amount_minor), sub.currency), newIntervalAmount: q.totalAmount, periodStart: sub.current_period_start, periodEnd: sub.current_period_end, changeAt: now })
      : null;
  return { kind, effectiveAt, quote: q, proration };
}

const subFromProvider = (p: ProviderSubscription) => [providerStatus(p.status), p.currentPeriodStart, p.currentPeriodEnd, p.trialEnd] as const;

/** Starts a paid self-serve subscription for the default account (keeping any trial days left). */
export async function startSubscription(app: FastifyInstance, tenantId: string, actorId: string, to: { planId: string; term: Term; currency: BillingCurrency; discountCode?: string | null }) {
  const deps = app.deps;
  const now = deps.now().toISOString();
  const ctx = await loadContext(app, tenantId);
  if (ctx.contract) throw new ApiError('conflict', 'Billing is managed by your contract');
  if (ctx.sub?.provider_subscription_id) throw new ApiError('conflict', 'A subscription already exists; change it instead');
  const plan = planById(ctx.cfg, to.planId);
  if (!plan?.selfServe) throw new ApiError('validation', 'This plan is not available self-serve');
  const q = quote(ctx.cfg, { ...to, headcount: ctx.headcount, on: now.slice(0, 10) });
  // The account currency follows the first paid subscription (Stripe customers bill in one currency).
  await withTenant(deps.router, tenantId, (tx) => tx.exec('UPDATE app.billing_accounts SET currency = $2 WHERE id = $1 AND provider_customer_id IS NULL', [ctx.account.id, q.currency]));
  const customerId = await syncCustomer(deps, tenantId, ctx.account.id);
  if (!customerId) throw new ApiError('unprocessable', 'Add your billing details first', { code: 'billingDetailsRequired' });
  const trialEnd = ctx.sub?.status === 'trialing' && ctx.sub.trial_ends_at && compareInstants(ctx.sub.trial_ends_at, now) > 0 ? ctx.sub.trial_ends_at : null;
  const p = await billingProvider(deps).createSubscription({
    tenantId,
    billingAccountId: ctx.account.id,
    customerId,
    planId: q.planId,
    productName: plan.providerProductName,
    taxCode: ctx.cfg.providerTaxCode,
    currency: q.currency,
    interval: q.interval,
    unitAmountMinor: moneyJson(q.unitAmount).amountMinor,
    quantity: q.quantity,
    trialEnd,
    collection: 'charge_automatically',
    idempotencyKey: `subscription:${ctx.sub?.id ?? ctx.account.id}:start`,
  });
  const [status, ps, pe, te] = subFromProvider(p);
  return withTenant(deps.router, tenantId, async (tx) => {
    const values = [q.planId, q.term, q.currency, status, te ?? trialEnd, ps, pe, q.quantity, q.bandId, moneyJson(q.unitAmount).amountMinor, moneyJson(q.totalAmount).amountMinor, q.discountCode, p.id, ctx.cfg.version];
    let id: string;
    if (ctx.sub) {
      await tx.exec(
        `UPDATE app.billing_subscriptions SET plan_id = $2, term = $3, currency = $4, status = $5, trial_ends_at = $6, current_period_start = $7, current_period_end = $8, quantity = $9, band_id = $10,
           unit_amount_minor = $11, interval_amount_minor = $12, discount_code = $13, provider_subscription_id = $14, config_version = $15, cancel_effective_at = NULL, cancel_requested_at = NULL WHERE id = $1`,
        [ctx.sub.id, ...values],
      );
      id = ctx.sub.id;
    } else {
      id = (
        await tx.one<{ id: string }>(
          `INSERT INTO app.billing_subscriptions (tenant_id, billing_account_id, plan_id, term, currency, status, trial_ends_at, current_period_start, current_period_end, quantity, band_id, unit_amount_minor, interval_amount_minor, discount_code, provider_subscription_id, config_version)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [ctx.account.id, ...values],
        )
      ).id;
    }
    await writeAudit(tx, { actorType: 'user', actorId, action: 'billing.subscription_started', targetType: 'billing_subscription', targetId: id, diff: { planId: q.planId, term: q.term, currency: q.currency, quantity: q.quantity, intervalAmountMinor: moneyJson(q.totalAmount).amountMinor } });
    await deps.directory.update(tenantId, { planRef: q.planId }).catch(() => undefined);
    return { id, status, quote: q };
  });
}

/** Applies a self-serve plan or term change following the proration rules (ADR-0104). */
export async function changeSubscription(app: FastifyInstance, tenantId: string, actorId: string, to: { planId: string; term: Term }) {
  const deps = app.deps;
  const now = deps.now().toISOString();
  const ctx = await loadContext(app, tenantId);
  if (ctx.contract || ctx.sub?.source === 'contract') throw new ApiError('conflict', 'Billing is managed by your contract');
  const sub = ctx.sub;
  if (!sub?.provider_subscription_id) throw new ApiError('conflict', 'Choose a plan first');
  if (sub.cancel_effective_at) throw new ApiError('conflict', 'Reactivate the subscription before changing it');
  const plan = planById(ctx.cfg, to.planId);
  if (!plan?.selfServe) throw new ApiError('validation', 'This plan is not available self-serve');
  const preview = previewChange(ctx, { ...to, currency: sub.currency, discountCode: sub.discount_code }, now);
  if (preview.kind === 'none') throw new ApiError('validation', 'Nothing to change');
  const q = preview.quote;
  const provider = billingProvider(deps);
  const amounts = { quantity: q.quantity, bandId: q.bandId, unitAmountMinor: moneyJson(q.unitAmount).amountMinor, intervalAmountMinor: moneyJson(q.totalAmount).amountMinor };
  const update = { planId: q.planId, productName: plan.providerProductName, taxCode: ctx.cfg.providerTaxCode, currency: q.currency, interval: q.interval, unitAmountMinor: amounts.unitAmountMinor, quantity: q.quantity };
  const key = `subscription:${sub.id}:change:${q.planId}:${q.term}:${now}`;
  const immediate = preview.kind === 'upgrade' || preview.kind === 'term_upgrade' || sub.status === 'trialing';
  let pending: PendingChange | null = null;
  let p: ProviderSubscription;
  if (immediate) {
    p = await provider.updateSubscription(sub.provider_subscription_id, { ...update, proration: sub.status === 'trialing' ? 'none' : 'create_prorations', idempotencyKey: key });
  } else if (preview.kind === 'downgrade' && sub.term === q.term) {
    // The new price applies from the next renewal; the current plan stays until the period ends.
    p = await provider.updateSubscription(sub.provider_subscription_id, { ...update, proration: 'none', idempotencyKey: key });
    pending = { kind: 'downgrade', planId: q.planId, term: q.term, effectiveAt: sub.current_period_end ?? now, ...amounts };
  } else {
    // Shorter or different term: the current subscription ends with its paid period and is replaced.
    p = await provider.setCancelAt(sub.provider_subscription_id, sub.current_period_end ?? now, key);
    pending = { kind: 'replace', planId: q.planId, term: q.term, effectiveAt: sub.current_period_end ?? now, ...amounts };
  }
  const [status, ps, pe, te] = subFromProvider(p);
  await withTenant(deps.router, tenantId, async (tx) => {
    if (pending) {
      await tx.exec('UPDATE app.billing_subscriptions SET pending_change = $2, status = $3, current_period_start = coalesce($4, current_period_start), current_period_end = coalesce($5, current_period_end) WHERE id = $1', [sub.id, JSON.stringify(pending), status, ps, pe]);
    } else {
      await tx.exec(
        `UPDATE app.billing_subscriptions SET plan_id = $2, term = $3, quantity = $4, band_id = $5, unit_amount_minor = $6, interval_amount_minor = $7, status = $8, current_period_start = $9, current_period_end = $10, trial_ends_at = $11, pending_change = NULL, config_version = $12 WHERE id = $1`,
        [sub.id, q.planId, q.term, amounts.quantity, amounts.bandId, amounts.unitAmountMinor, amounts.intervalAmountMinor, status, ps, pe, te, ctx.cfg.version],
      );
    }
    await writeAudit(tx, { actorType: 'user', actorId, action: 'billing.subscription_changed', targetType: 'billing_subscription', targetId: sub.id, diff: { from: { planId: sub.plan_id, term: sub.term }, to: { planId: q.planId, term: q.term }, kind: preview.kind, effectiveAt: preview.effectiveAt } });
  });
  if (!pending) await deps.directory.update(tenantId, { planRef: q.planId }).catch(() => undefined);
  return preview;
}

export async function cancelSubscription(app: FastifyInstance, tenantId: string, actorId: string) {
  const deps = app.deps;
  const now = deps.now().toISOString();
  const ctx = await loadContext(app, tenantId);
  if (ctx.contract || ctx.sub?.source === 'contract') throw new ApiError('conflict', 'Billing is managed by your contract');
  const sub = ctx.sub;
  if (!sub || sub.status === 'trial_expired') throw new ApiError('conflict', 'Nothing to cancel');
  if (sub.cancel_effective_at) return { effectiveAt: sub.cancel_effective_at };
  const effectiveAt = cancellationEffectiveAt(ctx.cfg, { term: sub.term, requestedAt: now, currentPeriodEnd: sub.current_period_end ?? now, trialEndsAt: sub.trial_ends_at, status: sub.status });
  if (sub.provider_subscription_id) await billingProvider(deps).setCancelAt(sub.provider_subscription_id, effectiveAt, `subscription:${sub.id}:cancel:${now}`);
  await withTenant(deps.router, tenantId, async (tx) => {
    await tx.exec('UPDATE app.billing_subscriptions SET cancel_requested_at = $2, cancel_effective_at = $3, pending_change = NULL WHERE id = $1', [sub.id, now, effectiveAt]);
    await writeAudit(tx, { actorType: 'user', actorId, action: 'billing.subscription_cancelled', targetType: 'billing_subscription', targetId: sub.id, diff: { effectiveAt, noticeDays: ctx.cfg.terms[sub.term].cancellationNoticeDays } });
  });
  return { effectiveAt };
}

export async function reactivateSubscription(app: FastifyInstance, tenantId: string, actorId: string) {
  const deps = app.deps;
  const now = deps.now().toISOString();
  const ctx = await loadContext(app, tenantId);
  const sub = ctx.sub;
  if (!sub?.cancel_effective_at || compareInstants(sub.cancel_effective_at, now) <= 0) throw new ApiError('conflict', 'The subscription has already ended; choose a plan to start again');
  if (sub.provider_subscription_id) await billingProvider(deps).setCancelAt(sub.provider_subscription_id, null, `subscription:${sub.id}:reactivate:${now}`);
  await withTenant(deps.router, tenantId, async (tx) => {
    await tx.exec('UPDATE app.billing_subscriptions SET cancel_requested_at = NULL, cancel_effective_at = NULL WHERE id = $1', [sub.id]);
    await writeAudit(tx, { actorType: 'user', actorId, action: 'billing.subscription_reactivated', targetType: 'billing_subscription', targetId: sub.id });
  });
}

/** Creates the replacement subscription once a scheduled term switch ends the old one (idempotent). */
export async function applyReplacement(deps: Deps, tenantId: string, subId: string) {
  const cfg = billingConfig();
  const sub = await withTenant(deps.router, tenantId, (tx) => tx.maybe<SubRow>('SELECT * FROM app.billing_subscriptions WHERE id = $1', [subId]));
  if (!sub?.pending_change || sub.pending_change.kind !== 'replace') return { skipped: true };
  const pc = sub.pending_change;
  const plan = planById(cfg, pc.planId)!;
  const account = await withTenant(deps.router, tenantId, (tx) => tx.one<AccountRow>('SELECT * FROM app.billing_accounts WHERE id = $1', [sub.billing_account_id]));
  if (!account.provider_customer_id) return { skipped: true };
  const p = await billingProvider(deps).createSubscription({
    tenantId,
    billingAccountId: account.id,
    customerId: account.provider_customer_id,
    planId: pc.planId,
    productName: plan.providerProductName,
    taxCode: cfg.providerTaxCode,
    currency: sub.currency,
    interval: cfg.terms[pc.term].interval,
    unitAmountMinor: pc.unitAmountMinor,
    quantity: pc.quantity,
    collection: account.collection,
    daysUntilDue: account.payment_terms_days,
    idempotencyKey: `subscription:${sub.id}:replacement`,
  });
  const [status, ps, pe] = subFromProvider(p);
  await withTenant(deps.router, tenantId, async (tx) => {
    await tx.exec(`UPDATE app.billing_subscriptions SET status = 'canceled', canceled_at = coalesce(canceled_at, $2), pending_change = NULL WHERE id = $1`, [sub.id, deps.now().toISOString()]);
    const n = await tx.one<{ id: string }>(
      `INSERT INTO app.billing_subscriptions (tenant_id, billing_account_id, plan_id, term, currency, status, current_period_start, current_period_end, quantity, band_id, unit_amount_minor, interval_amount_minor, provider_subscription_id, config_version, source)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'self_serve') RETURNING id`,
      [account.id, pc.planId, pc.term, sub.currency, status, ps, pe, pc.quantity, pc.bandId, pc.unitAmountMinor, pc.intervalAmountMinor, p.id, cfg.version],
    );
    await writeAudit(tx, { actorType: 'system', action: 'billing.subscription_replaced', targetType: 'billing_subscription', targetId: n.id, diff: { replaces: sub.id, planId: pc.planId, term: pc.term } });
  });
  await deps.directory.update(tenantId, { planRef: pc.planId }).catch(() => undefined);
  return { replaced: true };
}

/** Finalises downgrades whose period has ended, and expires unused trials. */
export async function settleSchedules(tx: Tx, now: string): Promise<{ downgrades: number; trialsExpired: number; replacementsDue: string[] }> {
  const trialsExpired = await tx.exec(`UPDATE app.billing_subscriptions SET status = 'trial_expired' WHERE status = 'trialing' AND provider_subscription_id IS NULL AND trial_ends_at <= $1`, [now]);
  const due = await tx.query<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE pending_change IS NOT NULL AND (pending_change->>'effectiveAt')::timestamptz <= $1 AND ${LIVE}`, [now]);
  let downgrades = 0;
  const replacementsDue: string[] = [];
  for (const s of due) {
    const pc = s.pending_change!;
    if (pc.kind === 'downgrade') {
      await tx.exec(`UPDATE app.billing_subscriptions SET plan_id = $2, term = $3, quantity = $4, band_id = $5, unit_amount_minor = $6, interval_amount_minor = $7, pending_change = NULL WHERE id = $1`, [s.id, pc.planId, pc.term, pc.quantity, pc.bandId, pc.unitAmountMinor, pc.intervalAmountMinor]);
      await writeAudit(tx, { actorType: 'system', action: 'billing.downgrade_applied', targetType: 'billing_subscription', targetId: s.id, diff: { planId: pc.planId } });
      downgrades++;
    } else replacementsDue.push(s.id);
  }
  // Cancellations that have taken effect (the provider webhook normally does this first).
  await tx.exec(`UPDATE app.billing_subscriptions SET status = 'canceled', canceled_at = coalesce(canceled_at, $1) WHERE cancel_effective_at <= $1 AND ${LIVE} AND pending_change IS NULL`, [now]);
  return { downgrades, trialsExpired, replacementsDue };
}

/** Usage aggregates for the back office (counts and bytes only). */
export async function usageAggregates(tx: Tx) {
  return tx.one<{ headcount: number; active_users: number; storage_bytes: string }>(
    `SELECT (SELECT count(*)::int FROM app.employees WHERE status = 'active') AS headcount,
            (SELECT count(*)::int FROM app.users WHERE status = 'active') AS active_users,
            ((SELECT coalesce(sum(size_bytes), 0) FROM app.documents WHERE status = 'ready') + (SELECT coalesce(sum(size_bytes), 0) FROM app.support_ticket_attachments))::bigint::text AS storage_bytes`,
  );
}

export async function recordUsage(deps: Deps, tenantId: string, tx: Tx, now: string) {
  const u = await usageAggregates(tx);
  const sub = await tx.maybe<{ plan_id: string; status: string }>(`SELECT s.plan_id, s.status FROM app.billing_subscriptions s JOIN app.billing_accounts a ON a.tenant_id = s.tenant_id AND a.id = s.billing_account_id WHERE a.is_default AND s.${LIVE}`);
  await deps.router.registryPool().query(
    `INSERT INTO backoffice.tenant_usage (subject_tenant_id, headcount, active_users, storage_bytes, plan_id, billing_status, computed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (subject_tenant_id) DO UPDATE SET headcount = EXCLUDED.headcount, active_users = EXCLUDED.active_users, storage_bytes = EXCLUDED.storage_bytes, plan_id = EXCLUDED.plan_id, billing_status = EXCLUDED.billing_status, computed_at = EXCLUDED.computed_at`,
    [tenantId, u.headcount, u.active_users, u.storage_bytes, sub?.plan_id ?? null, sub?.status ?? null, now],
  );
  return u;
}

/** Re-prices live subscriptions for the current headcount; the new quantity applies from the next invoice. */
export async function syncHeadcount(deps: Deps, tenantId: string): Promise<number> {
  const cfg = billingConfig();
  const contract = await activeContract(deps.router, tenantId);
  const rows = await withTenant(deps.router, tenantId, async (tx) => {
    const counts = await headcounts(tx);
    const subs = await tx.query<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE ${LIVE} AND provider_subscription_id IS NOT NULL AND status IN ('active', 'past_due', 'trialing')`);
    return subs.map((s) => ({ s, headcount: counts.get(s.billing_account_id) ?? 0 }));
  });
  let changed = 0;
  for (const { s, headcount } of rows) {
    const usesContract = s.source === 'contract' && contract && contract.id === s.contract_id;
    let q: Quote;
    try {
      q = quote(cfg, { planId: s.plan_id, term: s.term, currency: s.currency, headcount, discountCode: s.discount_code, contract: usesContract ? contractPricing(contract) : null });
    } catch {
      continue; // e.g. headcount grew past the self-serve bands: support follows up (contract required)
    }
    const unit = moneyJson(q.unitAmount).amountMinor;
    if (q.quantity === s.quantity && String(unit) === String(s.unit_amount_minor)) continue;
    const plan = planById(cfg, q.planId)!;
    await billingProvider(deps).updateSubscription(s.provider_subscription_id!, { planId: q.planId, productName: plan.providerProductName, taxCode: cfg.providerTaxCode, currency: q.currency, interval: q.interval, unitAmountMinor: unit, quantity: q.quantity, proration: 'none', idempotencyKey: `subscription:${s.id}:headcount:${q.quantity}:${unit}` });
    await withTenant(deps.router, tenantId, async (tx) => {
      await tx.exec('UPDATE app.billing_subscriptions SET quantity = $2, band_id = $3, unit_amount_minor = $4, interval_amount_minor = $5 WHERE id = $1', [s.id, q.quantity, q.bandId, unit, moneyJson(q.totalAmount).amountMinor]);
      await writeAudit(tx, { actorType: 'system', action: 'billing.headcount_synced', targetType: 'billing_subscription', targetId: s.id, diff: { quantity: q.quantity, bandId: q.bandId } });
    });
    changed++;
  }
  return changed;
}

export async function enqueueReplacement(tx: Tx, subId: string) {
  await enqueueJob(tx, 'billing.apply_replacement', subId, { subscriptionId: subId });
}
