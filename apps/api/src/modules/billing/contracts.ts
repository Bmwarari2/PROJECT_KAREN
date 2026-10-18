import { moneyJson, planById, quote, validateContractPricing } from '@thapsus/core/billing';
import { addDays, startOfDayInstant } from '@thapsus/core/time';
import { getPool, withTenant, writeAudit } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { activeContract, billingConfig, billingProvider, contractPricing, headcounts, providerStatus, syncCustomer, type ContractRow, type SubRow } from './service';

/**
 * Enterprise contracts (ADR-0107): custom pricing from the back-office contract record, annual
 * invoicing with payment terms (collection by invoice), purchase-order numbers on invoices, and one
 * subscription per billing account (multi-entity billing). Prices never come from code.
 */
const backoffice = (deps: Deps) => {
  if (!deps.backofficeDbUrl) throw new ApiError('internal', 'Back office database not configured');
  return getPool(deps.backofficeDbUrl);
};

export async function activateContract(deps: Deps, contract: ContractRow, staffId: string) {
  const cfg = billingConfig();
  const problems = validateContractPricing(cfg, contractPricing(contract));
  if (problems.length) throw new ApiError('validation', problems.join('; '));
  const tenantId = contract.subject_tenant_id;
  const toCancel = await withTenant(deps.router, tenantId, async (tx) => {
    const accounts = await tx.query<{ id: string }>('SELECT id FROM app.billing_accounts');
    if (!accounts.length) throw new ApiError('unprocessable', 'The customer has no billing account yet');
    const counts = await headcounts(tx);
    const cancels: string[] = [];
    for (const a of accounts) {
      const live = await tx.maybe<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE billing_account_id = $1 AND status <> 'canceled'`, [a.id]);
      if (live?.provider_subscription_id) cancels.push(live.provider_subscription_id);
      if (live) await tx.exec(`UPDATE app.billing_subscriptions SET status = 'canceled', canceled_at = $2, pending_change = NULL WHERE id = $1`, [live.id, deps.now().toISOString()]);
      const q = quote(cfg, { planId: contract.plan_id, term: contract.term, currency: contract.currency, headcount: counts.get(a.id) ?? 0, contract: contractPricing(contract) });
      await tx.exec(
        `INSERT INTO app.billing_subscriptions (tenant_id, billing_account_id, plan_id, term, currency, status, source, contract_id, quantity, band_id, unit_amount_minor, interval_amount_minor, config_version)
         VALUES (app.current_tenant(), $1, $2, $3, $4, 'incomplete', 'contract', $5, $6, $7, $8, $9, $10)`,
        [a.id, q.planId, q.term, q.currency, contract.id, q.quantity, q.bandId, moneyJson(q.unitAmount).amountMinor, moneyJson(q.totalAmount).amountMinor, cfg.version],
      );
      await tx.exec('UPDATE app.billing_accounts SET collection = $2, payment_terms_days = $3, currency = CASE WHEN provider_customer_id IS NULL THEN $4 ELSE currency END WHERE id = $1', [a.id, contract.collection, contract.payment_terms_days, contract.currency]);
    }
    await writeAudit(tx, { actorType: 'support', actorId: staffId, action: 'billing.contract_activated', targetType: 'contract', targetId: contract.id, diff: { reference: contract.reference, planId: contract.plan_id, term: contract.term, accounts: accounts.length } });
    return cancels;
  });
  for (const id of toCancel) await billingProvider(deps).cancelNow(id, `contract:${contract.id}:replaces:${id}`);
  await backoffice(deps).query(`UPDATE backoffice.contracts SET status = 'active', activated_at = $2, updated_by = $3, updated_at = $2 WHERE id = $1`, [contract.id, deps.now().toISOString(), staffId]);
  const started = await startPendingContractSubscriptions(deps, tenantId);
  await deps.directory.update(tenantId, { planRef: contract.plan_id }).catch(() => undefined);
  return started;
}

/** Starts contract subscriptions whose billing account now has complete billing details (idempotent). */
export async function startPendingContractSubscriptions(deps: Deps, tenantId: string, accountId?: string) {
  const contract = await activeContract(deps.router, tenantId);
  if (!contract) return [];
  const cfg = billingConfig();
  const plan = planById(cfg, contract.plan_id)!;
  const pending = await withTenant(deps.router, tenantId, async (tx) => {
    const rows = await tx.query<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE source = 'contract' AND contract_id = $1 AND provider_subscription_id IS NULL AND status = 'incomplete' AND ($2::uuid IS NULL OR billing_account_id = $2)`, [contract.id, accountId ?? null]);
    return { rows, counts: await headcounts(tx) };
  });
  const out: Array<{ accountId: string; status: 'started' | 'pending_details' }> = [];
  for (const s of pending.rows) {
    const customerId = await syncCustomer(deps, tenantId, s.billing_account_id);
    if (!customerId) {
      out.push({ accountId: s.billing_account_id, status: 'pending_details' });
      continue;
    }
    const q = quote(cfg, { planId: contract.plan_id, term: contract.term, currency: contract.currency, headcount: pending.counts.get(s.billing_account_id) ?? 0, contract: contractPricing(contract) });
    const p = await billingProvider(deps).createSubscription({
      tenantId,
      billingAccountId: s.billing_account_id,
      customerId,
      planId: q.planId,
      productName: plan.providerProductName,
      taxCode: cfg.providerTaxCode,
      currency: q.currency,
      interval: q.interval,
      unitAmountMinor: moneyJson(q.unitAmount).amountMinor,
      quantity: q.quantity,
      collection: contract.collection,
      daysUntilDue: contract.collection === 'send_invoice' ? contract.payment_terms_days : null,
      idempotencyKey: `contract:${contract.id}:${s.billing_account_id}`,
    });
    await withTenant(deps.router, tenantId, async (tx) => {
      await tx.exec(
        'UPDATE app.billing_subscriptions SET provider_subscription_id = $2, status = $3, current_period_start = $4, current_period_end = $5, quantity = $6, unit_amount_minor = $7, interval_amount_minor = $8 WHERE id = $1',
        [s.id, p.id, providerStatus(p.status), p.currentPeriodStart, p.currentPeriodEnd, q.quantity, moneyJson(q.unitAmount).amountMinor, moneyJson(q.totalAmount).amountMinor],
      );
      await writeAudit(tx, { actorType: 'system', action: 'billing.contract_subscription_started', targetType: 'billing_subscription', targetId: s.id, diff: { contractId: contract.id, quantity: q.quantity } });
    });
    out.push({ accountId: s.billing_account_id, status: 'started' });
  }
  return out;
}

/** Ends a contract: its subscriptions stop at the end of the contract's last day (UTC). */
export async function endContract(deps: Deps, contract: ContractRow, staffId: string) {
  const at = startOfDayInstant(addDays(contract.ends_on, 1), 'UTC');
  const subs = await withTenant(deps.router, contract.subject_tenant_id, (tx) => tx.query<SubRow>(`SELECT * FROM app.billing_subscriptions WHERE contract_id = $1 AND status <> 'canceled'`, [contract.id]));
  for (const s of subs) if (s.provider_subscription_id) await billingProvider(deps).setCancelAt(s.provider_subscription_id, at, `contract:${contract.id}:end:${s.id}`);
  await withTenant(deps.router, contract.subject_tenant_id, async (tx) => {
    await tx.exec(`UPDATE app.billing_subscriptions SET cancel_effective_at = $2, cancel_requested_at = $3 WHERE contract_id = $1 AND status <> 'canceled'`, [contract.id, at, deps.now().toISOString()]);
    await writeAudit(tx, { actorType: 'support', actorId: staffId, action: 'billing.contract_ended', targetType: 'contract', targetId: contract.id, diff: { endsAt: at } });
  });
  await backoffice(deps).query(`UPDATE backoffice.contracts SET status = 'ended', updated_by = $2, updated_at = $3 WHERE id = $1`, [contract.id, staffId, deps.now().toISOString()]);
  return { endsAt: at };
}
