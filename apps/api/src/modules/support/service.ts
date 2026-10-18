import { randomBytes } from 'node:crypto';
import { slaDeadlines, slaState, worstSla, type BillingConfig, type Priority, type SlaState } from '@thapsus/core/billing';
import type { HomeRegion } from '@thapsus/core';
import type { TenantRouter, Tx } from '@thapsus/db';
import type { ContractRow } from '../billing/service';

/**
 * Support tickets live in the tenant's home region under forced RLS (ADR-0101). The back-office queue
 * index holds routing metadata only (ids, priority, status, plan, deadlines) — never subjects,
 * messages or files.
 */
export interface TicketRow {
  id: string;
  reference: string;
  requester_user_id: string;
  subject: string;
  category: string;
  priority: Priority;
  status: 'open' | 'awaiting_customer' | 'resolved' | 'closed';
  plan_id: string;
  context_path: string | null;
  first_response_due_at: string;
  first_response_at_risk_at: string;
  resolution_due_at: string;
  resolution_at_risk_at: string;
  first_responded_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  sla_at_risk_notified_at: string | null;
  sla_breached_notified_at: string | null;
  last_activity_at: string;
  created_at: string;
}

export const CATEGORIES = ['question', 'problem', 'billing', 'account', 'data', 'feature_request'] as const;
export const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv']);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const newReference = () => `T-${randomBytes(4).toString('hex').toUpperCase()}`;

/** The plan whose SLA applies: the enterprise contract, else the default account's live subscription, else the trial plan. */
export async function supportPlanId(tx: Tx, cfg: BillingConfig, contract: ContractRow | null): Promise<string> {
  if (contract) return contract.plan_id;
  const s = await tx.maybe<{ plan_id: string }>(
    `SELECT s.plan_id FROM app.billing_subscriptions s JOIN app.billing_accounts a ON a.tenant_id = s.tenant_id AND a.id = s.billing_account_id
      WHERE a.is_default AND s.status NOT IN ('canceled', 'trial_expired') ORDER BY s.created_at DESC LIMIT 1`,
  );
  return s?.plan_id ?? cfg.trial.planId;
}

export function deadlinesFor(cfg: BillingConfig, planId: string, priority: Priority, region: HomeRegion, openedAt: string) {
  return slaDeadlines(cfg, planId, priority, region, openedAt);
}

export interface SlaView {
  firstResponse: { dueAt: string; state: SlaState };
  resolution: { dueAt: string; state: SlaState };
  flag: SlaState;
}

export function slaView(t: Pick<TicketRow, 'first_response_due_at' | 'first_response_at_risk_at' | 'resolution_due_at' | 'resolution_at_risk_at' | 'first_responded_at' | 'resolved_at' | 'status'>, now: string): SlaView {
  const fr = slaState({ dueAt: t.first_response_due_at, atRiskAt: t.first_response_at_risk_at, metAt: t.first_responded_at }, now);
  const resolvedAt = t.resolved_at ?? (t.status === 'closed' ? now : null);
  const res = slaState({ dueAt: t.resolution_due_at, atRiskAt: t.resolution_at_risk_at, metAt: resolvedAt }, now);
  return { firstResponse: { dueAt: t.first_response_due_at, state: fr }, resolution: { dueAt: t.resolution_due_at, state: res }, flag: worstSla(fr, res) };
}

/** Upserts the queue index entry (cell back-office store, shared database). Metadata only. */
export async function syncQueueEntry(router: TenantRouter, tenantId: string, t: TicketRow, lastAuthor: 'user' | 'staff') {
  await router.registryPool().query(
    `INSERT INTO backoffice.support_queue (ticket_id, subject_tenant_id, reference, priority, status, category, plan_id, first_response_due_at, first_response_at_risk_at, resolution_due_at, resolution_at_risk_at, first_responded_at, resolved_at, last_activity_at, last_author, created_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
     ON CONFLICT (ticket_id) DO UPDATE SET priority = EXCLUDED.priority, status = EXCLUDED.status, category = EXCLUDED.category, plan_id = EXCLUDED.plan_id,
       first_response_due_at = EXCLUDED.first_response_due_at, first_response_at_risk_at = EXCLUDED.first_response_at_risk_at, resolution_due_at = EXCLUDED.resolution_due_at,
       resolution_at_risk_at = EXCLUDED.resolution_at_risk_at, first_responded_at = EXCLUDED.first_responded_at, resolved_at = EXCLUDED.resolved_at,
       last_activity_at = EXCLUDED.last_activity_at, last_author = EXCLUDED.last_author, synced_at = now()`,
    [t.id, tenantId, t.reference, t.priority, t.status, t.category, t.plan_id, t.first_response_due_at, t.first_response_at_risk_at, t.resolution_due_at, t.resolution_at_risk_at, t.first_responded_at, t.resolved_at, t.last_activity_at, lastAuthor, t.created_at],
  );
}

export async function lastAuthorOf(tx: Tx, ticketId: string): Promise<'user' | 'staff'> {
  return (await tx.maybe<{ author_type: 'user' | 'staff' }>('SELECT author_type FROM app.support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [ticketId]))?.author_type ?? 'user';
}
