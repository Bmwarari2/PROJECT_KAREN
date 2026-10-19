import { addDays } from '@thapsus/core/time';
import { emitEvent, type Tx } from '@thapsus/db';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { evaluate, type Condition } from '../approvals/service';
import { startWorkflow } from '../workflows/service';
import { integrationHandlers, isPublicHttpsUrl, signBody } from './integrations';

export type Trigger =
  | { type: 'record.created'; entity: 'employee' }
  | { type: 'record.changed'; entity: 'employee'; fields?: string[] }
  | { type: 'date.reached'; dateField: 'startDate' | 'endDate' | 'probationEndDate' | 'workAnniversary' | 'birthday'; offsetDays: number }
  | { type: 'document.expiring'; offsetDays: number }
  | { type: 'threshold'; metric: 'department_headcount' | 'overdue_tasks'; gt: number };

export type Action =
  | { type: 'task'; title: string; assignee: { type: 'manager' | 'role' | 'user' | 'employee'; value?: string }; dueInDays?: number }
  | { type: 'notification'; to: { type: 'manager' | 'role' | 'user' | 'employee'; value?: string }; message: string }
  | { type: 'workflow'; templateId: string }
  | { type: 'webhook'; url: string }
  | { type: 'integration'; integration: string; operation: string; params?: Record<string, string | number | boolean> };

export interface Rule {
  id: string;
  name: string;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}

export interface Subject {
  employeeId?: string | null;
  values: Record<string, unknown>;
  eventKey: string;
  date: string;
}

export interface PlannedAction {
  type: string;
  detail: Record<string, unknown>;
}

async function recipients(tx: Tx, spec: { type: string; value?: string }, employeeId?: string | null): Promise<string[]> {
  if (spec.type === 'user' && spec.value) return [spec.value];
  if (spec.type === 'role' && spec.value) return usersWithRole(tx, spec.value);
  if (spec.type === 'employee') return [await userForEmployee(tx, employeeId)].filter(Boolean) as string[];
  if (spec.type === 'manager' && employeeId) {
    const m = await tx.maybe<{ manager_id: string | null }>('SELECT manager_id FROM app.employees WHERE id = $1', [employeeId]);
    return [await userForEmployee(tx, m?.manager_id)].filter(Boolean) as string[];
  }
  return [];
}

/** Evaluates conditions and either plans (dry run) or executes the rule's actions, idempotently per event. */
export async function runRule(
  tx: Tx,
  rule: Rule,
  subject: Subject,
  opts: { dryRun: boolean; fetch?: typeof fetch; signingKey?: string },
): Promise<{ matched: boolean; actions: PlannedAction[]; status: string }> {
  const matched = rule.conditions.every((c) => evaluate(c, subject.values));
  const planned: PlannedAction[] = [];
  if (!matched) {
    if (opts.dryRun) await log(tx, rule.id, subject.eventKey, true, 'skipped', { reason: 'conditions' });
    return { matched, actions: [], status: 'skipped' };
  }
  if (!opts.dryRun) {
    // claim the event for this rule first: a re-delivered event is a no-op
    const claimed = await tx.maybe(
      `INSERT INTO app.automation_runs (tenant_id, rule_id, event_key, status) VALUES (app.current_tenant(), $1, $2, 'matched')
       ON CONFLICT (tenant_id, rule_id, event_key) WHERE NOT dry_run DO NOTHING RETURNING id`,
      [rule.id, subject.eventKey],
    );
    if (!claimed) return { matched, actions: [], status: 'duplicate' };
  }
  for (const action of rule.actions) {
    switch (action.type) {
      case 'task': {
        const users = await recipients(tx, action.assignee, subject.employeeId);
        planned.push({ type: 'task', detail: { title: action.title, assignees: users.length } });
        if (!opts.dryRun)
          for (const u of users.length ? users : [null])
            await createTask(tx, { source: 'automation', sourceId: rule.id, title: action.title, subjectEmployeeId: subject.employeeId, assigneeUserId: u, assigneeRole: action.assignee.type === 'role' ? action.assignee.value : null, dueOn: action.dueInDays !== undefined ? addDays(subject.date, action.dueInDays) : null, link: '/app/tasks', dedupeKey: `auto:${rule.id}:${subject.eventKey}:${u ?? 'role'}` });
        break;
      }
      case 'notification': {
        const users = await recipients(tx, action.to, subject.employeeId);
        planned.push({ type: 'notification', detail: { recipients: users.length } });
        if (!opts.dryRun) await notify(tx, { userIds: users, kind: 'automation', titleKey: 'notify.automation', params: { title: action.message }, link: '/app', dedupeKey: `auto:${rule.id}:${subject.eventKey}` });
        break;
      }
      case 'workflow':
        planned.push({ type: 'workflow', detail: { templateId: action.templateId } });
        if (!opts.dryRun && subject.employeeId) await startWorkflow(tx, action.templateId, subject.employeeId, subject.date, null);
        break;
      case 'webhook': {
        planned.push({ type: 'webhook', detail: { url: action.url } });
        if (!opts.dryRun) {
          // Only identifiers leave the cell; receivers fetch details through the API with their own credentials.
          const body = JSON.stringify({ rule: rule.id, event: subject.eventKey, employeeId: subject.employeeId ?? null, date: subject.date });
          // Signed with the tenant's derived key, like integration calls; never sent unsigned.
          if (!opts.signingKey) {
            planned[planned.length - 1]!.detail.status = 0;
            planned[planned.length - 1]!.detail.reason = 'signing_key_not_configured';
            break;
          }
          const { t: tenantId } = await tx.one<{ t: string }>('SELECT app.current_tenant()::text AS t');
          // re-checked at call time: rules saved before the check existed may hold any URL
          const res = isPublicHttpsUrl(action.url)
            ? await (opts.fetch ?? fetch)(action.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-thapsus-signature': signBody(opts.signingKey, tenantId, body) }, body, signal: AbortSignal.timeout(5000) }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message }))
            : { ok: false, status: 0 };
          planned[planned.length - 1]!.detail.status = res.status;
        }
        break;
      }
      case 'integration':
        planned.push({ type: 'integration', detail: { integration: action.integration, operation: action.operation, available: action.integration in integrationHandlers } });
        // dispatched by the integrations.dispatch job (outbox → idempotent job → registered handler)
        if (!opts.dryRun)
          await emitEvent(tx, 'integration.requested', { integration: action.integration, operation: action.operation, params: action.params ?? {}, employeeId: subject.employeeId ?? null, rule: rule.id, eventKey: subject.eventKey, date: subject.date }, { type: 'automation_rule', id: rule.id });
        break;
    }
  }
  await log(tx, rule.id, subject.eventKey, opts.dryRun, 'succeeded', { actions: planned });
  return { matched, actions: planned, status: 'succeeded' };
}

async function log(tx: Tx, ruleId: string, eventKey: string, dryRun: boolean, status: string, detail: unknown) {
  if (dryRun) {
    await tx.exec(`INSERT INTO app.automation_runs (tenant_id, rule_id, event_key, dry_run, status, detail) VALUES (app.current_tenant(), $1, $2, true, $3, $4)`, [ruleId, eventKey, status, JSON.stringify(detail)]);
  } else {
    await tx.exec(`UPDATE app.automation_runs SET status = $3, detail = $4 WHERE rule_id = $1 AND event_key = $2 AND NOT dry_run`, [ruleId, eventKey, status, JSON.stringify(detail)]);
  }
}

/** Current employee values used by conditions (camelCase, matching the API). */
export async function employeeValues(tx: Tx, employeeId: string): Promise<Record<string, unknown>> {
  const e = await tx.maybe<Record<string, unknown>>(
    `SELECT e.id, e.status, e.country, e.entity_id, e.department_id, e.location_id, e.job_title, e.start_date, e.end_date,
            j.employment_type, j.weekly_hours, j.fte, c.contract_type, c.probation_end_date, pay.amount_minor, pay.currency
       FROM app.employees e
       LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= current_date AND (j.valid_to IS NULL OR j.valid_to > current_date)
       LEFT JOIN app.employee_contracts c ON c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.valid_from <= current_date AND (c.valid_to IS NULL OR c.valid_to > current_date)
       LEFT JOIN app.employee_pay pay ON pay.tenant_id = e.tenant_id AND pay.employee_id = e.id AND pay.valid_from <= current_date AND (pay.valid_to IS NULL OR pay.valid_to > current_date)
      WHERE e.id = $1`,
    [employeeId],
  );
  if (!e) return {};
  return { status: e.status, country: e.country, entityId: e.entity_id, departmentId: e.department_id, locationId: e.location_id, jobTitle: e.job_title, startDate: e.start_date, endDate: e.end_date, employmentType: e.employment_type, weeklyHours: e.weekly_hours, fte: e.fte, contractType: e.contract_type, probationEndDate: e.probation_end_date, payAmountMinor: e.amount_minor, payCurrency: e.currency };
}

/** Employees whose date field (plus offset) falls on `date` — for date.reached triggers. */
export async function employeesForDate(tx: Tx, trigger: Extract<Trigger, { type: 'date.reached' }>, date: string): Promise<string[]> {
  const target = addDays(date, -trigger.offsetDays);
  const sql: Record<string, string> = {
    startDate: `SELECT id FROM app.employees WHERE start_date = $1`,
    endDate: `SELECT id FROM app.employees WHERE end_date = $1`,
    probationEndDate: `SELECT employee_id AS id FROM app.employee_contracts WHERE probation_end_date = $1 AND valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`,
    workAnniversary: `SELECT id FROM app.employees WHERE status = 'active' AND start_date < $1 AND to_char(start_date, 'MM-DD') = to_char($1::date, 'MM-DD')`,
    birthday: `SELECT employee_id AS id FROM app.employee_personal WHERE valid_to IS NULL AND to_char(date_of_birth, 'MM-DD') = to_char($1::date, 'MM-DD')`,
  };
  return (await tx.query<{ id: string }>(sql[trigger.dateField]!, [target])).map((r) => r.id);
}
