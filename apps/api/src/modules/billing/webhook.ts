import { TenantNotFoundError, enqueueJob, withTenant, writeAudit } from '@thapsus/db';
import type { Deps } from '../../deps';
import { billingProvider, enqueueReplacement, providerStatus, type SubRow } from './service';
import type { BillingEvent } from './provider';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * Applies a verified provider event to the tenant's billing state, once per event id (ADR-0103).
 * Events for customers that are not homed in this cell are acknowledged and ignored; only ids,
 * statuses, amounts and dates are read, and nothing from the payload is logged.
 */
export async function handleBillingEvent(deps: Deps, e: BillingEvent): Promise<WebhookOutcome> {
  let route: { tenantId: string; accountId: string | null } | null = null;
  if (e.customerId) {
    const { rows } = await deps.router
      .registryPool()
      .query<{ subject_tenant_id: string; billing_account_id: string }>(
        'SELECT subject_tenant_id, billing_account_id FROM backoffice.billing_customers WHERE provider_customer_id = $1',
        [e.customerId],
      );
    if (rows[0]) route = { tenantId: rows[0].subject_tenant_id, accountId: rows[0].billing_account_id };
  }
  if (!route && e.subscription?.tenantId && /^[0-9a-f-]{36}$/i.test(e.subscription.tenantId))
    route = { tenantId: e.subscription.tenantId, accountId: null };
  if (!route) return 'ignored';
  try {
    await deps.router.lookup(route.tenantId);
  } catch (err) {
    if (err instanceof TenantNotFoundError) return 'ignored';
    throw err;
  }
  const { tenantId, accountId } = route;
  let setupToComplete: { customerId: string; setupIntentId: string } | null = null;
  const outcome = await withTenant(deps.router, tenantId, async (tx): Promise<WebhookOutcome> => {
    const fresh = await tx.maybe(
      'INSERT INTO app.billing_webhook_events (tenant_id, event_id, type) VALUES (app.current_tenant(), $1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
      [e.id, e.type],
    );
    if (!fresh) return 'duplicate';
    const now = deps.now().toISOString();
    if (e.subscription) {
      const s = e.subscription;
      const row = await tx.maybe<SubRow>(
        'SELECT * FROM app.billing_subscriptions WHERE provider_subscription_id = $1',
        [s.id],
      );
      if (row) {
        const deleted = e.type === 'customer.subscription.deleted';
        const status = deleted ? 'canceled' : providerStatus(s.status);
        await tx.exec(
          `UPDATE app.billing_subscriptions SET status = $2, current_period_start = coalesce($3, current_period_start), current_period_end = coalesce($4, current_period_end),
             trial_ends_at = coalesce($5, trial_ends_at), cancel_effective_at = CASE WHEN $6::timestamptz IS NULL AND NOT $7 THEN NULL ELSE coalesce($6, cancel_effective_at) END,
             canceled_at = CASE WHEN $2 = 'canceled' THEN coalesce(canceled_at, $8) END WHERE id = $1`,
          [row.id, status, s.currentPeriodStart, s.currentPeriodEnd, s.trialEnd, s.cancelAt, deleted, now],
        );
        if (deleted && row.pending_change?.kind === 'replace') await enqueueReplacement(tx, row.id);
        await writeAudit(tx, {
          actorType: 'system',
          action: `billing.provider.${e.type}`,
          targetType: 'billing_subscription',
          targetId: row.id,
          diff: { status },
        });
      }
    }
    if (e.invoice) {
      const i = e.invoice;
      const acct =
        accountId ??
        (
          await tx.maybe<{ billing_account_id: string }>(
            'SELECT billing_account_id FROM app.billing_subscriptions WHERE provider_subscription_id = $1',
            [i.subscriptionId],
          )
        )?.billing_account_id;
      if (acct) {
        const status = ['draft', 'open', 'paid', 'uncollectible', 'void'].includes(i.status)
          ? i.status
          : 'open';
        const failed = e.type === 'invoice.payment_failed';
        const inv = await tx.one<{ id: string }>(
          `INSERT INTO app.billing_invoices (tenant_id, billing_account_id, provider_invoice_id, number, status, currency, subtotal_minor, tax_minor, total_minor, amount_due_minor, amount_paid_minor, period_start, period_end, due_at, hosted_url, po_number, payment_failed_at)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, (SELECT po_number FROM app.billing_accounts WHERE id = $1), CASE WHEN $15 THEN $16::timestamptz END)
           ON CONFLICT (tenant_id, provider_invoice_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, subtotal_minor = EXCLUDED.subtotal_minor, tax_minor = EXCLUDED.tax_minor,
             total_minor = EXCLUDED.total_minor, amount_due_minor = EXCLUDED.amount_due_minor, amount_paid_minor = EXCLUDED.amount_paid_minor, due_at = EXCLUDED.due_at, hosted_url = EXCLUDED.hosted_url,
             payment_failed_at = coalesce(EXCLUDED.payment_failed_at, app.billing_invoices.payment_failed_at)
           RETURNING id`,
          [
            acct,
            i.id,
            i.number,
            status,
            i.currency,
            i.subtotalMinor,
            i.taxMinor,
            i.totalMinor,
            i.amountDueMinor,
            i.amountPaidMinor,
            i.periodStart,
            i.periodEnd,
            i.dueAt,
            i.hostedUrl,
            failed,
            now,
          ],
        );
        if (i.subscriptionId && (failed || e.type === 'invoice.paid')) {
          await tx.exec(
            `UPDATE app.billing_subscriptions SET status = $2 WHERE provider_subscription_id = $1 AND status IN ('active', 'past_due', 'incomplete')`,
            [i.subscriptionId, failed ? 'past_due' : 'active'],
          );
        }
        // Failed-payment email to the billing contacts, sent by this (home-region) cell. One per event.
        if (failed) await enqueueJob(tx, 'billing.payment_failed_email', e.id, { invoiceId: inv.id });
        await writeAudit(tx, {
          actorType: 'system',
          action: `billing.provider.${e.type}`,
          targetType: 'billing_invoice',
          targetId: inv.id,
          diff: { status },
        });
      }
    }
    if (e.setup && e.setup.mode === 'setup' && e.customerId && e.setup.setupIntentId && accountId) {
      await tx.exec('UPDATE app.billing_accounts SET has_payment_method = true WHERE id = $1', [accountId]);
      setupToComplete = { customerId: e.customerId, setupIntentId: e.setup.setupIntentId };
      await writeAudit(tx, {
        actorType: 'system',
        action: 'billing.payment_method_added',
        targetType: 'billing_account',
        targetId: accountId,
      });
    }
    return 'processed';
  });
  if (setupToComplete) await billingProvider(deps).completePaymentSetup(setupToComplete);
  return outcome;
}
