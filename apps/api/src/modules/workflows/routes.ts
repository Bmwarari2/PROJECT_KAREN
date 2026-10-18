import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { enqueueJob } from '@thapsus/db';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { notify } from '../../lib/notify';
import { loadTarget } from '../employees/service';
import { periodic, registerJob, subscribe } from '../../jobs/registry';
import { autoStart, DEFAULT_REMINDER_DAYS_BEFORE, listTasks, maybeCompleteInstance, startWorkflow, taskRoles } from './service';

export { taskRoles };

const TaskDef = Type.Object({
  key: Type.String({ pattern: '^[a-z0-9_-]{1,40}$' }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  assignee: Type.Object({ type: Type.Union(['role', 'manager', 'employee', 'user'].map((t) => Type.Literal(t))), value: Type.Optional(Type.String()) }),
  dueOffsetDays: Type.Integer({ minimum: -365, maximum: 365 }),
  reminderDaysBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
});
const Task = Type.Object({ id: Uuid, title: Type.String(), description: Nullable(Type.String()), source: Type.String(), status: Type.String(), dueOn: Nullable(Type.String()), subjectEmployeeId: Nullable(Type.String()), subjectName: Nullable(Type.String()), assigneeRole: Nullable(Type.String()), link: Nullable(Type.String()) });


export async function workflowRoutes(app: FastifyInstance) {
  app.get('/v1/workflow-templates', { schema: { tags: ['workflows'], response: { 200: Type.Array(Type.Any()) } } }, async (req) => {
    authorize(req, 'workflows.read');
    return app.tenantTx(req, (tx) => tx.query(`SELECT id, kind, name, tasks, auto_start AS "autoStart", entity_id AS "entityId" FROM app.workflow_templates ORDER BY kind, name`), { readOnly: true });
  });

  app.post(
    '/v1/workflow-templates',
    { config: { selfAudited: true }, schema: { tags: ['workflows'], body: Type.Object({ kind: Type.Union(['onboarding', 'offboarding', 'transfer', 'custom'].map((k) => Type.Literal(k))), name: Type.String({ minLength: 1, maxLength: 120 }), tasks: Type.Array(TaskDef, { minItems: 1, maxItems: 100 }), autoStart: Type.Optional(Type.Boolean()), entityId: Type.Optional(Nullable(Uuid)) }), response: { 201: Type.Object({ id: Uuid }), 403: Problem } } },
    async (req, reply) => {
      authorize(req, 'workflows.manage');
      const b = req.body as { kind: string; name: string; tasks: unknown[]; autoStart?: boolean; entityId?: string | null };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.workflow_templates (tenant_id, kind, name, tasks, auto_start, entity_id) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [b.kind, b.name, JSON.stringify(b.tasks), b.autoStart ?? true, b.entityId ?? null]);
        await app.audit(tx, req, { action: 'workflow_template.created', targetType: 'workflow_template', targetId: r.id, diff: { kind: b.kind, name: b.name, tasks: b.tasks.length } });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  app.post(
    '/v1/workflows',
    { config: { selfAudited: true }, schema: { tags: ['workflows'], body: Type.Object({ templateId: Uuid, employeeId: Uuid, anchorDate: CivilDate }), response: { 201: Type.Object({ id: Nullable(Uuid) }), 403: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { templateId: string; employeeId: string; anchorDate: string };
      const id = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'workflows.start', await loadTarget(tx, b.employeeId))) throw new ApiError('forbidden');
        const instance = await startWorkflow(tx, b.templateId, b.employeeId, b.anchorDate, auth.userId);
        await app.audit(tx, req, { action: 'workflow.started', targetType: 'employee', targetId: b.employeeId, diff: { templateId: b.templateId, anchorDate: b.anchorDate } });
        return instance ?? null;
      });
      return reply.status(201).send({ id });
    },
  );

  app.get(
    '/v1/workflows',
    { schema: { tags: ['workflows'], querystring: Type.Object({ employeeId: Type.Optional(Uuid), status: Type.Optional(Type.String()) }), response: { 200: Type.Array(Type.Any()) } } },
    async (req) => {
      authorize(req, 'workflows.read');
      const q = req.query as { employeeId?: string; status?: string };
      return app.tenantTx(
        req,
        (tx) =>
          tx.query(
            `SELECT i.id, i.kind, i.anchor_date AS "anchorDate", i.status, i.employee_id AS "employeeId", e.display_name AS "employeeName", t.name AS "templateName",
                    (SELECT count(*)::int FROM app.tasks k WHERE k.source = 'workflow' AND k.source_id = i.id) AS "taskCount",
                    (SELECT count(*)::int FROM app.tasks k WHERE k.source = 'workflow' AND k.source_id = i.id AND k.status = 'done') AS "doneCount"
               FROM app.workflow_instances i JOIN app.employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
               JOIN app.workflow_templates t ON t.tenant_id = i.tenant_id AND t.id = i.template_id
              WHERE ($1::uuid IS NULL OR i.employee_id = $1) AND ($2::text IS NULL OR i.status = $2) ORDER BY i.created_at DESC LIMIT 500`,
            [q.employeeId ?? null, q.status ?? null],
          ),
        { readOnly: true },
      );
    },
  );

  // ---- tasks ------------------------------------------------------------------------------------------
  app.get(
    '/v1/tasks',
    { schema: { tags: ['tasks'], querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('all')])) }), response: { 200: Type.Array(Task) } } },
    async (req) => {
      const auth = requireAuth(req);
      const status = (req.query as { status?: string }).status ?? 'open';
      return app.tenantTx(req, (tx) => listTasks(tx, auth.userId, auth.principal.grants.map((g) => g.roleKey), status), { readOnly: true });
    },
  );

  app.post(
    '/v1/tasks/:id/complete',
    { config: { selfAudited: true }, schema: { tags: ['tasks'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const roles = taskRoles(auth.principal.grants.map((g) => g.roleKey));
      return app.tenantTx(req, async (tx) => {
        const task = await tx.maybe<{ id: string; assignee_user_id: string | null; assignee_role: string | null; source: string; source_id: string | null }>('SELECT * FROM app.tasks WHERE id = $1 FOR UPDATE', [id]);
        if (!task) throw new ApiError('notFound');
        const mine = task.assignee_user_id === auth.userId || (!task.assignee_user_id && task.assignee_role && roles.includes(task.assignee_role));
        if (!mine && !canSome(auth.principal, 'workflows.manage')) throw new ApiError('forbidden');
        await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE id = $1 AND status = 'open'`, [id, auth.userId]);
        if (task.source === 'workflow' && task.source_id) await maybeCompleteInstance(tx, task.source_id);
        await app.audit(tx, req, { action: 'task.completed', targetType: 'task', targetId: id });
        return { id, status: 'done' };
      });
    },
  );
}

// ---- auto-start from domain events (outbox subscribers enqueue idempotent jobs) ---------------------
subscribe('employee.created', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, { kind: 'onboarding', employeeId: ev.payload.employeeId, anchorDate: ev.payload.startDate });
});
subscribe('employee.terminated', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, { kind: 'offboarding', employeeId: ev.payload.employeeId, anchorDate: ev.payload.endDate });
});
subscribe('employee.transferred', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, { kind: 'transfer', employeeId: ev.payload.employeeId, anchorDate: ev.payload.effectiveDate });
});
registerJob('workflows.autostart', async (ctx) => {
  const { kind, employeeId, anchorDate } = ctx.job.input as { kind: 'onboarding' | 'offboarding' | 'transfer'; employeeId: string; anchorDate: string };
  const started = await ctx.tx((tx) => autoStart(tx, kind, employeeId, anchorDate));
  return { started: started.length };
});

// ---- reminders: one "due soon" reminder per task at its own lead time, one "overdue" reminder ----------
registerJob('tasks.reminders', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    // reminder_days_before comes from the workflow template task (persisted on the task); NULL = default
    const due = await tx.query<{ id: string; title: string; assignee_user_id: string; overdue: boolean }>(
      `SELECT id, title, assignee_user_id, due_on < $1::date AS overdue FROM app.tasks
        WHERE status = 'open' AND assignee_user_id IS NOT NULL AND due_on IS NOT NULL
          AND due_on - coalesce(reminder_days_before, $2::int) <= $1::date`,
      [date, DEFAULT_REMINDER_DAYS_BEFORE],
    );
    let sent = 0;
    let overdue = 0;
    for (const t of due) {
      const ids = await notify(tx, {
        userIds: [t.assignee_user_id],
        kind: t.overdue ? 'task.overdue' : 'task.due',
        titleKey: t.overdue ? 'notify.taskOverdue' : 'notify.taskDueSoon',
        params: { title: t.title },
        link: '/app/tasks',
        dedupeKey: t.overdue ? `overdue:${t.id}` : `due:${t.id}`,
      });
      sent += ids.length;
      if (t.overdue) overdue += ids.length;
    }
    return { date, sent, overdue };
  });
});
periodic.push(async (tx, now) => {
  const date = now.toISOString().slice(0, 10);
  await enqueueJob(tx, 'tasks.reminders', date, { date });
});
