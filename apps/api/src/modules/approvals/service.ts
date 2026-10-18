import { writeAudit, type Tx } from '@thapsus/db';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { ApiError } from '../../http/errors';

export interface ApproverSpec {
  type: 'manager' | 'skip_level' | 'role' | 'user';
  value?: string;
}
export interface StepSpec {
  approver: ApproverSpec;
  timeoutHours?: number;
  escalateTo?: ApproverSpec;
  /** Step only applies when this condition holds (conditional chains). */
  condition?: Condition;
}
export interface Condition {
  field: string;
  op: 'present' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value?: unknown;
}

export function evaluate(c: Condition | null | undefined, payload: Record<string, unknown>): boolean {
  if (!c) return true;
  const v = payload[c.field];
  const num = (x: unknown) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : (x as number));
  switch (c.op) {
    case 'present':
      return v !== undefined && v !== null;
    case 'eq':
      return v === c.value;
    case 'neq':
      return v !== c.value;
    case 'gt':
      return num(v) > num(c.value);
    case 'gte':
      return num(v) >= num(c.value);
    case 'lt':
      return num(v) < num(c.value);
    case 'lte':
      return num(v) <= num(c.value);
    case 'in':
      return Array.isArray(c.value) && c.value.includes(v);
  }
}

/** Resolves approver user ids, adding active delegates of each approver. */
export async function resolveApprovers(tx: Tx, spec: ApproverSpec, subjectEmployeeId: string | null): Promise<string[]> {
  let ids: string[] = [];
  if (spec.type === 'user' && spec.value) ids = [spec.value];
  if (spec.type === 'role' && spec.value) ids = await usersWithRole(tx, spec.value);
  if ((spec.type === 'manager' || spec.type === 'skip_level') && subjectEmployeeId) {
    const mgr = await tx.maybe<{ manager_id: string | null }>('SELECT manager_id FROM app.employees WHERE id = $1', [subjectEmployeeId]);
    let target = mgr?.manager_id ?? null;
    if (spec.type === 'skip_level' && target) target = (await tx.maybe<{ manager_id: string | null }>('SELECT manager_id FROM app.employees WHERE id = $1', [target]))?.manager_id ?? null;
    const u = await userForEmployee(tx, target);
    ids = u ? [u] : await usersWithRole(tx, 'hr_admin'); // no manager → HR decides
  }
  const delegates = await tx.query<{ to_user_id: string }>(
    `SELECT to_user_id FROM app.delegations WHERE from_user_id = ANY($1::uuid[]) AND now() >= starts_at AND now() < ends_at`,
    [ids],
  );
  return [...new Set([...ids, ...delegates.map((d) => d.to_user_id)])];
}

async function openStep(tx: Tx, requestId: string, index: number, step: StepSpec, subjectEmployeeId: string | null, title: string) {
  const approvers = await resolveApprovers(tx, step.approver, subjectEmployeeId);
  const due = step.timeoutHours ? new Date(Date.now() + step.timeoutHours * 3_600_000) : null;
  await tx.exec(
    `INSERT INTO app.approval_steps (tenant_id, request_id, step_index, approver_user_ids, status, due_at) VALUES (app.current_tenant(), $1, $2, $3, 'pending', $4)`,
    [requestId, index, approvers, due],
  );
  await tx.exec('UPDATE app.approval_requests SET current_step = $2 WHERE id = $1', [requestId, index]);
  for (const user of approvers) {
    await createTask(tx, { source: 'approval', sourceId: requestId, title, subjectEmployeeId, assigneeUserId: user, link: `/app/approvals`, dedupeKey: `appr:${requestId}:${index}:${user}` });
  }
  await notify(tx, { userIds: approvers, kind: 'approval.requested', titleKey: 'notify.approvalRequested', params: { title }, link: '/app/approvals', dedupeKey: `appr:${requestId}:${index}` });
}

/** Applies the effect of an approved request. Registered per subject by modules. */
type Handler = (tx: Tx, request: { id: string; subject_employee_id: string | null; payload: Record<string, unknown>; requested_by: string | null }) => Promise<void>;
export const approvalHandlers: Record<string, Handler> = {};
/** Called when a request is rejected or cancelled. */
export const rejectionHandlers: Record<string, Handler> = {};

/**
 * Starts an approval if an enabled policy matches the subject and payload; returns the request id,
 * or undefined when no approval is needed.
 */
export async function requestApproval(tx: Tx, subject: string, subjectEmployeeId: string | null, requestedBy: string | null, payload: Record<string, unknown>): Promise<string | undefined> {
  const policies = await tx.query<{ id: string; name: string; steps: StepSpec[]; condition: Condition | null }>(
    `SELECT id, name, steps, condition FROM app.approval_policies WHERE subject = $1 AND enabled ORDER BY priority, created_at`,
    [subject],
  );
  const policy = policies.find((p) => evaluate(p.condition, payload));
  if (!policy) return undefined;
  const steps = policy.steps.filter((s) => evaluate(s.condition, payload));
  if (!steps.length) return undefined;
  const req = await tx.one<{ id: string }>(
    `INSERT INTO app.approval_requests (tenant_id, policy_id, subject, subject_employee_id, payload, requested_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
    [policy.id, subject, subjectEmployeeId, JSON.stringify({ ...payload, __steps: steps }), requestedBy],
  );
  await openStep(tx, req.id, 0, steps[0]!, subjectEmployeeId, policy.name);
  return req.id;
}

/** Records a decision. Returns the request's resulting status. */
export async function decide(tx: Tx, requestId: string, userId: string, decision: 'approve' | 'reject', comment?: string): Promise<string> {
  const req = await tx.maybe<{ id: string; status: string; current_step: number; subject: string; subject_employee_id: string | null; payload: Record<string, unknown> & { __steps: StepSpec[] }; requested_by: string | null; policy_name: string }>(
    `SELECT r.*, p.name AS policy_name FROM app.approval_requests r JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id WHERE r.id = $1 FOR UPDATE OF r`,
    [requestId],
  );
  if (!req) throw new ApiError('notFound');
  if (req.status !== 'pending') throw new ApiError('conflict');
  const step = await tx.one<{ id: string; approver_user_ids: string[] }>(`SELECT id, approver_user_ids FROM app.approval_steps WHERE request_id = $1 AND step_index = $2`, [requestId, req.current_step]);
  if (!step.approver_user_ids.includes(userId)) throw new ApiError('forbidden');
  if (req.requested_by === userId) throw new ApiError('forbidden', 'You cannot approve your own request');
  await tx.exec(`UPDATE app.approval_steps SET status = $2, decided_by = $3, decided_at = now(), comment = $4 WHERE id = $1`, [step.id, decision === 'approve' ? 'approved' : 'rejected', userId, comment ?? null]);
  await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE source = 'approval' AND source_id = $1 AND status = 'open'`, [requestId, userId]);
  await writeAudit(tx, { actorType: 'user', actorId: userId, action: `approval.${decision}d`, targetType: 'approval_request', targetId: requestId, diff: { step: req.current_step, comment } });
  const steps = req.payload.__steps;
  let status = 'pending';
  if (decision === 'reject') status = 'rejected';
  else if (req.current_step + 1 < steps.length) await openStep(tx, requestId, req.current_step + 1, steps[req.current_step + 1]!, req.subject_employee_id, req.policy_name);
  else status = 'approved';
  if (status !== 'pending') {
    await tx.exec('UPDATE app.approval_requests SET status = $2, decided_at = now() WHERE id = $1', [requestId, status]);
    if (status === 'approved') {
      const { __steps: _s, ...payload } = req.payload;
      void _s;
      await approvalHandlers[req.subject]?.(tx, { id: requestId, subject_employee_id: req.subject_employee_id, payload, requested_by: req.requested_by });
    } else {
      const { __steps: _s2, ...payload } = req.payload;
      void _s2;
      await rejectionHandlers[req.subject]?.(tx, { id: requestId, subject_employee_id: req.subject_employee_id, payload, requested_by: req.requested_by });
    }
    if (req.requested_by) await notify(tx, { userIds: [req.requested_by], kind: 'approval.decided', titleKey: 'notify.approvalDecided', params: { decision: status }, link: '/app/approvals', dedupeKey: `appr-done:${requestId}` });
  }
  return status;
}

/** Escalates overdue steps: adds the escalation approvers and restarts the clock (idempotent per step). */
export async function escalateOverdue(tx: Tx, now: Date): Promise<number> {
  const overdue = await tx.query<{ id: string; request_id: string; step_index: number; approver_user_ids: string[]; payload: { __steps: StepSpec[] }; subject_employee_id: string | null; name: string }>(
    `SELECT s.id, s.request_id, s.step_index, s.approver_user_ids, r.payload, r.subject_employee_id, p.name
       FROM app.approval_steps s JOIN app.approval_requests r ON r.tenant_id = s.tenant_id AND r.id = s.request_id
       JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE s.status = 'pending' AND r.status = 'pending' AND s.due_at IS NOT NULL AND s.due_at < $1`,
    [now],
  );
  for (const s of overdue) {
    const spec = s.payload.__steps[s.step_index]!;
    const extra = spec.escalateTo ? await resolveApprovers(tx, spec.escalateTo, s.subject_employee_id) : await usersWithRole(tx, 'hr_admin');
    const all = [...new Set([...s.approver_user_ids, ...extra])];
    await tx.exec(`UPDATE app.approval_steps SET approver_user_ids = $2, due_at = NULL WHERE id = $1`, [s.id, all]);
    await writeAudit(tx, { actorType: 'system', action: 'approval.escalated', targetType: 'approval_request', targetId: s.request_id, diff: { step: s.step_index, added: extra.length } });
    for (const u of extra) await createTask(tx, { source: 'approval', sourceId: s.request_id, title: s.name, subjectEmployeeId: s.subject_employee_id, assigneeUserId: u, link: '/app/approvals', dedupeKey: `appr:${s.request_id}:${s.step_index}:${u}` });
    await notify(tx, { userIds: extra, kind: 'approval.escalated', titleKey: 'notify.approvalEscalated', params: { title: s.name }, link: '/app/approvals', dedupeKey: `esc:${s.id}` });
  }
  return overdue.length;
}
