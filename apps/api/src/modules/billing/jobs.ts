import { formatDate, formatMoney, isLocale, t } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { instantToDate } from '@thapsus/core/time';
import { enqueueJob, writeAudit } from '@thapsus/db';
import { periodic, registerJob, subscribe } from '../../jobs/registry';
import {
  applyReplacement,
  billingConfig,
  ensureBillingDefaults,
  recordUsage,
  settleSchedules,
  syncHeadcount,
} from './service';

// Trial starts at sign-up (the subscriber runs in the outbox dispatch transaction).
subscribe('tenant.created', async (tx) => {
  await ensureBillingDefaults(tx, billingConfig(), new Date());
});

/**
 * Daily billing upkeep per tenant (idempotent per date): trial expiry, scheduled downgrades and
 * replacements, headcount re-pricing (aggregate counts only) and the usage snapshot for the back office.
 */
registerJob('billing.daily', async (ctx) => {
  const now = ctx.deps.now().toISOString();
  const settled = await ctx.tx(async (tx) => {
    await ensureBillingDefaults(tx, billingConfig(), ctx.deps.now());
    return settleSchedules(tx, now);
  });
  for (const id of settled.replacementsDue) await applyReplacement(ctx.deps, ctx.tenantId, id);
  const repriced = await syncHeadcount(ctx.deps, ctx.tenantId);
  const usage = await ctx.tx((tx) => recordUsage(ctx.deps, ctx.tenantId, tx, now));
  return {
    ...settled,
    replacementsDue: settled.replacementsDue.length,
    repriced,
    headcount: usage.headcount,
  };
});

periodic.push(async (tx, now) => {
  await enqueueJob(tx, 'billing.daily', instantToDate(now.toISOString(), 'UTC'), {});
});

registerJob('billing.apply_replacement', async (ctx) =>
  applyReplacement(ctx.deps, ctx.tenantId, String(ctx.job.input.subscriptionId)),
);

/** Failed-payment email to every billing contact of the account, from this cell's home-region mailer. */
registerJob('billing.payment_failed_email', async (ctx) => {
  const invoiceId = String(ctx.job.input.invoiceId);
  const data = await ctx.tx(async (tx) => {
    const inv = await tx.maybe<{
      id: string;
      billing_account_id: string;
      number: string | null;
      currency: string;
      amount_due_minor: string;
      due_at: string | null;
    }>(
      'SELECT id, billing_account_id, number, currency, amount_due_minor, due_at FROM app.billing_invoices WHERE id = $1',
      [invoiceId],
    );
    if (!inv) return null;
    const contacts = await tx.query<{ email: string }>(
      'SELECT email FROM app.billing_contacts WHERE billing_account_id = $1 ORDER BY is_primary DESC, created_at',
      [inv.billing_account_id],
    );
    const tenant = await tx.one<{ default_locale: string; name: string }>(
      'SELECT default_locale, name FROM app.tenants',
    );
    return { inv, contacts, tenant };
  });
  if (!data || !data.contacts.length) return { sent: 0 };
  const locale = isLocale(data.tenant.default_locale) ? data.tenant.default_locale : 'en-GB';
  const amount = formatMoney(money(BigInt(data.inv.amount_due_minor), data.inv.currency), locale);
  const vars = {
    company: data.tenant.name,
    amount,
    number: data.inv.number ?? '—',
    link: `${ctx.deps.config.appBaseUrl}/app/billing`,
    due: data.inv.due_at ? formatDate(instantToDate(data.inv.due_at, 'UTC'), locale) : '—',
  };
  for (const c of data.contacts) {
    await ctx.deps.mailer.send({
      to: c.email,
      subject: t(locale, 'billing.email.paymentFailedSubject', vars),
      text: t(locale, 'billing.email.paymentFailedBody', vars),
    });
  }
  await ctx.tx((tx) =>
    writeAudit(tx, {
      actorType: 'system',
      action: 'billing.payment_failed_emailed',
      targetType: 'billing_invoice',
      targetId: invoiceId,
      diff: { recipients: data.contacts.length, region: ctx.deps.mailer.region },
    }),
  );
  return { sent: data.contacts.length, region: ctx.deps.mailer.region };
});
