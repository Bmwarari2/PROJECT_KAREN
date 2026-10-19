import { escalationAddress, slaState, worstSla, type SlaState } from '@thapsus/core/billing';
import { t } from '@thapsus/core/i18n';
import { enqueueJob, writeAudit } from '@thapsus/db';
import { periodic, registerJob } from '../../jobs/registry';
import { billingConfig } from '../billing/service';
import { lastAuthorOf, syncQueueEntry, type TicketRow } from './service';

/** Sweep slot length: escalation checks run at most once per slot per tenant (idempotency key). */
export const SLA_SWEEP_SLOT_MINUTES = 5;

/**
 * Escalation notifications for at-risk and breached SLA timers (ADR-0102). Idempotent twice over:
 * one job per tenant per slot, and each stage notifies once per ticket (guarded column update). The
 * email goes to the region's support escalation mailbox from this cell and carries the reference,
 * priority, plan and deadline only — never the ticket text.
 */
registerJob('support.sla_sweep', async (ctx) => {
  const now = ctx.deps.now().toISOString();
  const cfg = billingConfig();
  const due = await ctx.tx((tx) =>
    tx.query<TicketRow>(
      `SELECT * FROM app.support_tickets WHERE status IN ('open', 'awaiting_customer')
         AND ((first_responded_at IS NULL AND first_response_at_risk_at <= $1) OR (resolved_at IS NULL AND resolution_at_risk_at <= $1))
         AND (sla_breached_notified_at IS NULL)`,
      [now],
    ),
  );
  let notified = 0;
  for (const ticket of due) {
    const fr = slaState({ dueAt: ticket.first_response_due_at, atRiskAt: ticket.first_response_at_risk_at, metAt: ticket.first_responded_at }, now);
    const res = slaState({ dueAt: ticket.resolution_due_at, atRiskAt: ticket.resolution_at_risk_at, metAt: ticket.resolved_at }, now);
    const flag: SlaState = worstSla(fr, res);
    const stage = flag === 'breached' ? 'breached' : flag === 'at_risk' ? 'at_risk' : null;
    if (!stage) continue;
    const column = stage === 'breached' ? 'sla_breached_notified_at' : 'sla_at_risk_notified_at';
    const claimed = await ctx.tx(async (tx) => {
      const row = await tx.maybe<TicketRow>(`UPDATE app.support_tickets SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL RETURNING *`, [ticket.id, now]);
      if (row) await writeAudit(tx, { actorType: 'system', action: `support_ticket.sla_${stage}`, targetType: 'support_ticket', targetId: ticket.id, diff: { priority: ticket.priority, planId: ticket.plan_id } });
      return row ? { row, last: await lastAuthorOf(tx, ticket.id) } : null;
    });
    if (!claimed) continue;
    const timer = fr === 'breached' || fr === 'at_risk' ? 'firstResponse' : 'resolution';
    const vars = { reference: ticket.reference, priority: ticket.priority, plan: ticket.plan_id, state: stage, timer, due: timer === 'firstResponse' ? ticket.first_response_due_at : ticket.resolution_due_at, link: `${ctx.deps.config.appBaseUrl}/backoffice/support/${ctx.tenantId}/${ticket.id}`, region: ctx.deps.config.cell };
    await ctx.deps.mailer.send({ to: escalationAddress(cfg, ctx.deps.config.cell, ctx.deps.config.domain), subject: t('en-GB', 'support.email.escalationSubject', vars), text: t('en-GB', 'support.email.escalationBody', vars) });
    await syncQueueEntry(ctx.deps.router, ctx.tenantId, claimed.row, claimed.last);
    notified++;
  }
  return { checked: due.length, notified };
});

periodic.push(async (tx, now) => {
  const open = await tx.maybe(`SELECT 1 FROM app.support_tickets WHERE status IN ('open', 'awaiting_customer') LIMIT 1`);
  if (!open) return;
  const slot = Math.floor(now.getTime() / (SLA_SWEEP_SLOT_MINUTES * 60_000));
  await enqueueJob(tx, 'support.sla_sweep', `slot:${slot}`, {});
});
