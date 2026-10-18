import { addDays } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';

/** Reminder lead time for tasks whose template does not set `reminderDaysBefore`. */
export const DEFAULT_REMINDER_DAYS_BEFORE = 2;

export interface WorkflowTaskDef {
  key: string;
  title: string;
  description?: string;
  assignee: { type: 'role' | 'manager' | 'employee' | 'user'; value?: string };
  dueOffsetDays: number;
  reminderDaysBefore?: number;
}

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
    // The person a task is for (the joiner or their manager), kept even before they can sign in.
    let person: string | null = null;
    if (task.assignee.type === 'user' && task.assignee.value) assignees = [task.assignee.value];
    if (task.assignee.type === 'employee') person = employeeId;
    if (task.assignee.type === 'manager') person = emp.manager_id;
    if (person) assignees = [await userForEmployee(tx, person)].filter(Boolean) as string[];
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
        assigneeEmployeeId: person,
        dueOn,
        reminderDaysBefore: task.reminderDaysBefore ?? null,
        link: `/app/tasks`,
        // person tasks dedupe on the person, so a sign-in created later does not duplicate them
        dedupeKey: `wf:${inst.id}:${task.key}:${person ? `emp:${person}` : (user ?? role ?? 'unassigned')}`,
      });
    }
    if (assignees.length) await notify(tx, { userIds: assignees, kind: 'task.assigned', titleKey: 'notify.taskAssigned', params: { title: task.title }, link: '/app/tasks', dedupeKey: `wf:${inst.id}:${task.key}` });
  }
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

/**
 * Hands open tasks that were waiting for a person (e.g. a joiner's pre-start checklist created before
 * they were invited) to that person's new sign-in.
 */
export async function claimPersonTasks(tx: Tx, employeeId: string, userId: string): Promise<number> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE app.tasks SET assignee_user_id = $2 WHERE assignee_employee_id = $1 AND assignee_user_id IS NULL AND status = 'open' RETURNING id`,
    [employeeId, userId],
  );
  return rows.length;
}

/** Role queues a user works from; company owners also see the HR admin queue. */
export const taskRoles = (keys: string[]) => [...new Set([...keys, ...(keys.includes('owner') ? ['hr_admin'] : [])])];

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  source: string;
  status: string;
  dueOn: string | null;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  assigneeRole: string | null;
  link: string | null;
}

/** The caller's tasks: assigned to them, or to a role queue they work from. Shared by the list and export. */
export async function listTasks(tx: Tx, userId: string, roleKeys: string[], status: string, limit = 500): Promise<TaskView[]> {
  const rows = await tx.query<Record<string, string | null>>(
    `SELECT k.*, e.display_name AS subject_name FROM app.tasks k LEFT JOIN app.employees e ON e.tenant_id = k.tenant_id AND e.id = k.subject_employee_id
      WHERE (k.assignee_user_id = $1 OR (k.assignee_user_id IS NULL AND k.assignee_role = ANY($2::text[])))
        AND ($3 = 'all' OR k.status = $3) ORDER BY k.due_on NULLS LAST, k.created_at LIMIT ${Math.trunc(limit)}`,
    [userId, taskRoles(roleKeys), status],
  );
  return rows.map((r) => ({ id: r.id!, title: r.title!, description: r.description ?? null, source: r.source!, status: r.status!, dueOn: r.due_on ?? null, subjectEmployeeId: r.subject_employee_id ?? null, subjectName: r.subject_name ?? null, assigneeRole: r.assignee_role ?? null, link: r.link ?? null }));
}
