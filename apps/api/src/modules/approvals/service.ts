import { writeAudit, type Tx } from '@thapsus/db';
import { targetHref, type LinkTarget } from '@thapsus/core/links';
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
  const num = (x: unknown) =>
    typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : (x as number);
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
export async function resolveApprovers(
  tx: Tx,
  spec: ApproverSpec,
  subjectEmployeeId: string | null,
): Promise<string[]> {
  let ids: string[] = [];
  if (spec.type === 'user' && spec.value) ids = [spec.value];
  if (spec.type === 'role' && spec.value) ids = await usersWithRole(tx, spec.value);
  if ((spec.type === 'manager' || spec.type === 'skip_level') && subjectEmployeeId) {
    const mgr = await tx.maybe<{ manager_id: string | null }>(
      'SELECT manager_id FROM app.employees WHERE id = $1',
      [subjectEmployeeId],
    );
    let target = mgr?.manager_id ?? null;
    if (spec.type === 'skip_level' && target)
      target =
        (
          await tx.maybe<{ manager_id: string | null }>(
            'SELECT manager_id FROM app.employees WHERE id = $1',
            [target],
          )
        )?.manager_id ?? null;
    const u = await userForEmployee(tx, target);
    ids = u ? [u] : await usersWithRole(tx, 'hr_admin'); // no manager → HR decides
  }
  const delegates = await tx.query<{ to_user_id: string }>(
    `SELECT to_user_id FROM app.delegations WHERE from_user_id = ANY($1::uuid[]) AND now() >= starts_at AND now() < ends_at`,
    [ids],
  );
  return [...new Set([...ids, ...delegates.map((d) => d.to_user_id)])];
}

async function openStep(
  tx: Tx,
  requestId: string,
  index: number,
  step: StepSpec,
  subjectEmployeeId: string | null,
  title: string,
) {
  const approvers = await resolveApprovers(tx, step.approver, subjectEmployeeId);
  const due = step.timeoutHours ? new Date(Date.now() + step.timeoutHours * 3_600_000) : null;
  await tx.exec(
    `INSERT INTO app.approval_steps (tenant_id, request_id, step_index, approver_user_ids, status, due_at) VALUES (app.current_tenant(), $1, $2, $3, 'pending', $4)`,
    [requestId, index, approvers, due],
  );
  await tx.exec('UPDATE app.approval_requests SET current_step = $2 WHERE id = $1', [requestId, index]);
  for (const user of approvers) {
    await createTask(tx, {
      source: 'approval',
      sourceId: requestId,
      title,
      subjectEmployeeId,
      assigneeUserId: user,
      link: targetHref({ type: 'approval_request', id: requestId })!,
      dedupeKey: `appr:${requestId}:${index}:${user}`,
    });
  }
  await notify(tx, {
    userIds: approvers,
    kind: 'approval.requested',
    titleKey: 'notify.approvalRequested',
    params: { title },
    target: { type: 'approval_request', id: requestId },
    dedupeKey: `appr:${requestId}:${index}`,
  });
}

/** Applies the effect of an approved request. Registered per subject by modules. */
type Handler = (
  tx: Tx,
  request: {
    id: string;
    subject_employee_id: string | null;
    payload: Record<string, unknown>;
    requested_by: string | null;
  },
) => Promise<void>;
export const approvalHandlers: Record<string, Handler> = {};
/** Called when a request is rejected or cancelled. */
export const rejectionHandlers: Record<string, Handler> = {};

/**
 * Starts an approval if an enabled policy matches the subject and payload; returns the request id,
 * or undefined when no approval is needed.
 */
export async function requestApproval(
  tx: Tx,
  subject: string,
  subjectEmployeeId: string | null,
  requestedBy: string | null,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  const policies = await tx.query<{
    id: string;
    name: string;
    steps: StepSpec[];
    condition: Condition | null;
  }>(
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
export async function decide(
  tx: Tx,
  requestId: string,
  userId: string,
  decision: 'approve' | 'reject',
  comment?: string,
): Promise<string> {
  const req = await tx.maybe<{
    id: string;
    status: string;
    current_step: number;
    subject: string;
    subject_employee_id: string | null;
    payload: Record<string, unknown> & { __steps: StepSpec[] };
    requested_by: string | null;
    policy_name: string;
  }>(
    `SELECT r.*, p.name AS policy_name FROM app.approval_requests r JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id WHERE r.id = $1 FOR UPDATE OF r`,
    [requestId],
  );
  if (!req) throw new ApiError('notFound');
  if (req.status !== 'pending') throw new ApiError('conflict');
  const step = await tx.one<{ id: string; approver_user_ids: string[] }>(
    `SELECT id, approver_user_ids FROM app.approval_steps WHERE request_id = $1 AND step_index = $2`,
    [requestId, req.current_step],
  );
  if (!step.approver_user_ids.includes(userId)) throw new ApiError('forbidden');
  if (req.requested_by === userId) throw new ApiError('forbidden', 'You cannot approve your own request');
  await tx.exec(
    `UPDATE app.approval_steps SET status = $2, decided_by = $3, decided_at = now(), comment = $4 WHERE id = $1`,
    [step.id, decision === 'approve' ? 'approved' : 'rejected', userId, comment ?? null],
  );
  await tx.exec(
    `UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE source = 'approval' AND source_id = $1 AND status = 'open'`,
    [requestId, userId],
  );
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: `approval.${decision}d`,
    targetType: 'approval_request',
    targetId: requestId,
    diff: { step: req.current_step, comment },
  });
  const steps = req.payload.__steps;
  let status = 'pending';
  if (decision === 'reject') status = 'rejected';
  else if (req.current_step + 1 < steps.length)
    await openStep(
      tx,
      requestId,
      req.current_step + 1,
      steps[req.current_step + 1]!,
      req.subject_employee_id,
      req.policy_name,
    );
  else status = 'approved';
  if (status !== 'pending') {
    await tx.exec('UPDATE app.approval_requests SET status = $2, decided_at = now() WHERE id = $1', [
      requestId,
      status,
    ]);
    if (status === 'approved') {
      const { __steps: _s, ...payload } = req.payload;
      void _s;
      await approvalHandlers[req.subject]?.(tx, {
        id: requestId,
        subject_employee_id: req.subject_employee_id,
        payload,
        requested_by: req.requested_by,
      });
    } else {
      const { __steps: _s2, ...payload } = req.payload;
      void _s2;
      await rejectionHandlers[req.subject]?.(tx, {
        id: requestId,
        subject_employee_id: req.subject_employee_id,
        payload,
        requested_by: req.requested_by,
      });
    }
    if (req.requested_by)
      await notify(tx, {
        userIds: [req.requested_by],
        kind: 'approval.decided',
        titleKey: 'notify.approvalDecided',
        params: { decision: status },
        target: { type: 'approval_request', id: requestId },
        dedupeKey: `appr-done:${requestId}`,
      });
  }
  return status;
}

/** Escalates overdue steps: adds the escalation approvers and restarts the clock (idempotent per step). */
export async function escalateOverdue(tx: Tx, now: Date): Promise<number> {
  const overdue = await tx.query<{
    id: string;
    request_id: string;
    step_index: number;
    approver_user_ids: string[];
    payload: { __steps: StepSpec[] };
    subject_employee_id: string | null;
    name: string;
  }>(
    `SELECT s.id, s.request_id, s.step_index, s.approver_user_ids, r.payload, r.subject_employee_id, p.name
       FROM app.approval_steps s JOIN app.approval_requests r ON r.tenant_id = s.tenant_id AND r.id = s.request_id
       JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
      WHERE s.status = 'pending' AND r.status = 'pending' AND s.due_at IS NOT NULL AND s.due_at < $1`,
    [now],
  );
  for (const s of overdue) {
    const spec = s.payload.__steps[s.step_index]!;
    const extra = spec.escalateTo
      ? await resolveApprovers(tx, spec.escalateTo, s.subject_employee_id)
      : await usersWithRole(tx, 'hr_admin');
    const all = [...new Set([...s.approver_user_ids, ...extra])];
    await tx.exec(`UPDATE app.approval_steps SET approver_user_ids = $2, due_at = NULL WHERE id = $1`, [
      s.id,
      all,
    ]);
    await writeAudit(tx, {
      actorType: 'system',
      action: 'approval.escalated',
      targetType: 'approval_request',
      targetId: s.request_id,
      diff: { step: s.step_index, added: extra.length },
    });
    for (const u of extra)
      await createTask(tx, {
        source: 'approval',
        sourceId: s.request_id,
        title: s.name,
        subjectEmployeeId: s.subject_employee_id,
        assigneeUserId: u,
        link: targetHref({ type: 'approval_request', id: s.request_id })!,
        dedupeKey: `appr:${s.request_id}:${s.step_index}:${u}`,
      });
    await notify(tx, {
      userIds: extra,
      kind: 'approval.escalated',
      titleKey: 'notify.approvalEscalated',
      params: { title: s.name },
      target: { type: 'approval_request', id: s.request_id },
      dedupeKey: `esc:${s.id}`,
    });
  }
  return overdue.length;
}

export interface ApprovalView {
  id: string;
  subject: string;
  status: string;
  policy: string;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  requestedAt: string;
  currentStep: number;
  payload: Record<string, unknown>;
}

/** Approval requests for a view: mine (awaiting my decision), requested (by me) or all. Shared by the list and export. */
export async function listApprovals(
  tx: Tx,
  userId: string,
  view: string,
  limit = 500,
): Promise<ApprovalView[]> {
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT r.id, r.subject, r.status, p.name AS policy, r.subject_employee_id, e.display_name AS subject_name, r.created_at, r.current_step, r.payload
       FROM app.approval_requests r JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
       LEFT JOIN app.employees e ON e.tenant_id = r.tenant_id AND e.id = r.subject_employee_id
      WHERE CASE $2
              WHEN 'mine' THEN r.status = 'pending' AND EXISTS (SELECT 1 FROM app.approval_steps s WHERE s.request_id = r.id AND s.step_index = r.current_step AND $1 = ANY(s.approver_user_ids))
              WHEN 'requested' THEN r.requested_by = $1
              ELSE true END
      ORDER BY r.created_at DESC LIMIT ${Math.trunc(limit)}`,
    [userId, view],
  );
  return rows.map((r) => {
    const { __steps: _s, ...payload } = r.payload as Record<string, unknown>;
    void _s;
    return {
      id: r.id as string,
      subject: r.subject as string,
      status: r.status as string,
      policy: r.policy as string,
      subjectEmployeeId: (r.subject_employee_id as string | null) ?? null,
      subjectName: r.subject_name as string | null,
      requestedAt: r.created_at as string,
      currentStep: r.current_step as number,
      payload,
    };
  });
}

/** The record an approval request is about, and the page that shows it (ADR-0160). */
export function relatedTarget(
  subject: string,
  subjectEmployeeId: string | null,
  payload: Record<string, unknown>,
): LinkTarget | null {
  const id = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  if (subject === 'leave.request' && id('leaveRequestId'))
    return { type: 'leave_request', id: id('leaveRequestId')! };
  if (subject === 'timesheet' && id('timesheetId')) return { type: 'timesheet', id: id('timesheetId')! };
  if ((subject === 'employee.change' || subject === 'employee.self_change') && subjectEmployeeId)
    return { type: 'employee', id: subjectEmployeeId };
  // a countersignature is reviewed and signed in the document viewer (ADR-0169)
  if (subject === 'document.countersign' && id('documentId'))
    return { type: 'document', id: id('documentId')! };
  return null;
}

export interface ApprovalDetail extends ApprovalView {
  requestedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
  steps: Array<{
    index: number;
    status: string;
    approvers: string[];
    decidedByName: string | null;
    decidedAt: string | null;
    comment: string | null;
    dueAt: string | null;
  }>;
  related: { type: string; id: string; href: string } | null;
  /** The caller is an approver of the current step and did not make the request. */
  canDecide: boolean;
}

/**
 * One approval request with its steps, for the people involved: its approvers (any step), whoever made
 * it, and those who manage approvals. Undefined when the caller may not see it.
 */
export async function approvalDetail(
  tx: Tx,
  id: string,
  caller: { userId: string; manages: boolean },
): Promise<ApprovalDetail | undefined> {
  const r = await tx.maybe<{
    id: string;
    subject: string;
    status: string;
    policy: string;
    subject_employee_id: string | null;
    subject_name: string | null;
    requested_by: string | null;
    requester_name: string | null;
    created_at: string;
    decided_at: string | null;
    current_step: number;
    payload: Record<string, unknown>;
  }>(
    `SELECT r.id, r.subject, r.status, p.name AS policy, r.subject_employee_id, e.display_name AS subject_name, r.requested_by,
            u.display_name AS requester_name, r.created_at, r.decided_at, r.current_step, r.payload
       FROM app.approval_requests r JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
       LEFT JOIN app.employees e ON e.tenant_id = r.tenant_id AND e.id = r.subject_employee_id
       LEFT JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.requested_by
      WHERE r.id = $1`,
    [id],
  );
  if (!r) throw new ApiError('notFound');
  const steps = await tx.query<{
    step_index: number;
    status: string;
    approver_user_ids: string[];
    approvers: string[] | null;
    decided_by_name: string | null;
    decided_at: string | null;
    comment: string | null;
    due_at: string | null;
  }>(
    `SELECT s.step_index, s.status, s.approver_user_ids, s.decided_at, s.comment, s.due_at, d.display_name AS decided_by_name,
            (SELECT array_agg(a.display_name ORDER BY a.display_name) FROM app.users a WHERE a.tenant_id = s.tenant_id AND a.id = ANY(s.approver_user_ids)) AS approvers
       FROM app.approval_steps s LEFT JOIN app.users d ON d.tenant_id = s.tenant_id AND d.id = s.decided_by
      WHERE s.request_id = $1 ORDER BY s.step_index`,
    [id],
  );
  // the person a request is about sees it only when they made it: a change HR proposes about someone
  // (and its reason) stays with the approvers until it is decided
  const approver = steps.some((s) => s.approver_user_ids.includes(caller.userId));
  const involved = approver || r.requested_by === caller.userId;
  if (!involved && !caller.manages) return undefined;
  const { __steps: _s, ...payload } = r.payload;
  void _s;
  const current = steps.find((s) => s.step_index === r.current_step);
  const related = relatedTarget(r.subject, r.subject_employee_id, payload);
  const relatedHref = related ? targetHref(related) : null;
  return {
    id: r.id,
    subject: r.subject,
    status: r.status,
    policy: r.policy,
    subjectEmployeeId: r.subject_employee_id,
    subjectName: r.subject_name,
    requestedAt: r.created_at,
    currentStep: r.current_step,
    payload,
    requestedBy: r.requested_by ? { userId: r.requested_by, name: r.requester_name ?? '' } : null,
    decidedAt: r.decided_at,
    steps: steps.map((s) => ({
      index: s.step_index,
      status: s.status,
      approvers: s.approvers ?? [],
      decidedByName: s.decided_by_name,
      decidedAt: s.decided_at,
      comment: s.comment,
      dueAt: s.due_at,
    })),
    related: related && relatedHref ? { ...related, href: relatedHref } : null,
    canDecide:
      r.status === 'pending' &&
      !!current &&
      current.approver_user_ids.includes(caller.userId) &&
      r.requested_by !== caller.userId,
  };
}
