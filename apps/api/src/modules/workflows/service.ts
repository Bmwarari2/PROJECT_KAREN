import { addDays } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';

export interface WorkflowTaskDef {
  key: string;
  title: string;
  description?: string;
  assignee: { type: 'role' | 'manager' | 'employee' | 'user'; value?: string };
  dueOffsetDays: number;
  reminderDaysBefore?: number;
}

/**
 * Called after a workflow instance and its template tasks are created, in the same transaction. Feature
 * modules add their own steps here (e.g. the asset register adds one return task per issued asset when
 * an offboarding workflow starts). Hooks must be idempotent (use task dedupe keys).
 */
export type WorkflowStartHook = (tx: Tx, instance: { id: string; kind: string; employeeId: string; anchorDate: string }) => Promise<void>;
export const workflowStartHooks: WorkflowStartHook[] = [];

/**
 * Starts a workflow instance (idempotent per template + employee + anchor date) and creates its tasks
 * with due dates relative to the anchor (start date, leave date or transfer date).
 */
export async function startWorkflow(tx: Tx, templateId: string, employeeId: string, anchorDate: string, startedBy: string | null) {
  const tpl = await tx.maybe<{ id: string; kind: string; name: string; tasks: WorkflowTaskDef[] }>('SELECT id, kind, name, tasks FROM app.workflow_templates WHERE id = $1', [templateId]);
  if (!tpl) return undefined;
  const inst = await tx.maybe<{ id: string }>(
    `INSERT INTO app.workflow_instances (tenant_id, template_id, employee_id, kind, anchor_date, started_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, template_id, employee_id, anchor_date) DO NOTHING RETURNING id`,
    [templateId, employeeId, tpl.kind, anchorDate, startedBy],
  );
  if (!inst) return undefined;
  // The manager as of the anchor date (a future joiner's reporting line starts on their start date).
  const emp = await tx.one<{ display_name: string; manager_id: string | null }>(
    `SELECT e.display_name, coalesce((SELECT r.manager_id FROM app.reporting_lines r WHERE r.employee_id = e.id AND r.kind = 'solid'
        AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to > $2) LIMIT 1), e.manager_id) AS manager_id FROM app.employees e WHERE e.id = $1`,
    [employeeId, anchorDate],
  );
  for (const task of tpl.tasks) {
    let assignees: string[] = [];
    let role: string | null = null;
    if (task.assignee.type === 'user' && task.assignee.value) assignees = [task.assignee.value];
    if (task.assignee.type === 'employee') assignees = [await userForEmployee(tx, employeeId)].filter(Boolean) as string[];
    if (task.assignee.type === 'manager') assignees = [await userForEmployee(tx, emp.manager_id)].filter(Boolean) as string[];
    if (task.assignee.type === 'role' && task.assignee.value) {
      role = task.assignee.value;
      assignees = await usersWithRole(tx, task.assignee.value);
    }
    const dueOn = addDays(anchorDate, task.dueOffsetDays);
    // Role tasks are one shared task visible to the role; person tasks are assigned individually.
    const targets = role ? [null] : assignees.length ? assignees : [null];
    for (const user of targets) {
      await createTask(tx, {
        source: 'workflow',
        sourceId: inst.id,
        title: task.title,
        description: task.description,
        subjectEmployeeId: employeeId,
        assigneeUserId: user,
        assigneeRole: role,
        dueOn,
        link: `/app/tasks`,
        dedupeKey: `wf:${inst.id}:${task.key}:${user ?? role ?? 'unassigned'}`,
      });
    }
    if (assignees.length) await notify(tx, { userIds: assignees, kind: 'task.assigned', titleKey: 'notify.taskAssigned', params: { title: task.title }, link: '/app/tasks', dedupeKey: `wf:${inst.id}:${task.key}` });
  }
  for (const hook of workflowStartHooks) await hook(tx, { id: inst.id, kind: tpl.kind, employeeId, anchorDate });
  return inst.id;
}

/** Completes the instance once all of its tasks are done or cancelled. */
export async function maybeCompleteInstance(tx: Tx, instanceId: string) {
  const open = await tx.maybe(`SELECT 1 FROM app.tasks WHERE source = 'workflow' AND source_id = $1 AND status = 'open' LIMIT 1`, [instanceId]);
  if (!open) await tx.exec(`UPDATE app.workflow_instances SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'active'`, [instanceId]);
}

export async function autoStart(tx: Tx, kind: 'onboarding' | 'offboarding' | 'transfer', employeeId: string, anchorDate: string) {
  const emp = await tx.maybe<{ entity_id: string | null }>('SELECT entity_id FROM app.employees WHERE id = $1', [employeeId]);
  const templates = await tx.query<{ id: string }>(
    `SELECT id FROM app.workflow_templates WHERE kind = $1 AND auto_start AND (entity_id IS NULL OR entity_id = $2)`,
    [kind, emp?.entity_id ?? null],
  );
  const started: string[] = [];
  for (const t of templates) {
    const id = await startWorkflow(tx, t.id, employeeId, anchorDate, null);
    if (id) started.push(id);
  }
  return started;
}
