import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { closesItself, parseDueRule, parseTaskAction } from '@thapsus/core/task-actions';
import { enqueueJob } from '@thapsus/db';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { notify } from '../../lib/notify';
import { loadTarget } from '../employees/service';
import { periodic, registerJob, subscribe } from '../../jobs/registry';
import { ruleBook } from '../rules/routes';
import { refreshTaskDueDates } from '../tasks/due';
import {
  taskActionView,
  taskDescription,
  taskOrigin,
  taskRecordStatus,
  taskTitle,
  TASK_VIEW_COLUMNS,
  TASK_VIEW_JOINS,
  type TaskRow,
} from '../tasks/view';
import { resolveHrRequest } from './hr-requests';
import {
  autoStart,
  DEFAULT_REMINDER_DAYS_BEFORE,
  hrefOfRow,
  legacyHrefOfRow,
  listTasks,
  maybeCompleteInstance,
  startWorkflow,
  taskRoles,
} from './service';

export { taskRoles };

const TaskDef = Type.Object({
  key: Type.String({ pattern: '^[a-z0-9_-]{1,40}$' }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  assignee: Type.Object({
    type: Type.Union(['role', 'manager', 'employee', 'user'].map((t) => Type.Literal(t))),
    value: Type.Optional(Type.String()),
  }),
  dueOffsetDays: Type.Integer({
    minimum: -365,
    maximum: 365,
    description:
      'Calendar days from the workflow date (start, leaving or transfer date); used when `due` is absent',
  }),
  due: Type.Optional(
    Type.Object(
      {
        anchor: Type.Union(
          ['anchor', 'start', 'end', 'probation_end'].map((a) => Type.Literal(a)),
          {
            description:
              "The workflow's own date, or the person's start date, leaving date or probation end date",
          },
        ),
        offsetDays: Type.Integer({ minimum: -365, maximum: 365 }),
        businessDays: Type.Optional(Type.Boolean()),
        packDeadline: Type.Optional(
          Type.Literal('i9_section2', { description: 'The deadline comes from the jurisdiction pack' }),
        ),
      },
      { additionalProperties: false, description: 'When the task is due (ADR-0193)' },
    ),
  ),
  reminderDaysBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
  action: Type.Optional(
    Type.Object(
      {
        kind: Type.String({ pattern: '^[a-z][a-z0-9_]{1,40}$' }),
        params: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.Any(), { maxProperties: 10 })),
      },
      { additionalProperties: false, description: "The task's main button (ADR-0191)" },
    ),
  ),
});
const TaskActionOut = Type.Object({
  kind: Type.String({ description: 'The action kind the task asks for' }),
  opens: Type.String({
    description: 'The kind whose page the button opens (its fallback until the kind lands)',
  }),
  label: Type.String(),
  href: Type.String(),
  landed: Type.Boolean({
    description: "False while the kind's own page is not built and a fallback page opens",
  }),
});
const Task = Type.Object({
  id: Uuid,
  title: Type.String(),
  description: Nullable(Type.String()),
  source: Type.String(),
  status: Type.String(),
  dueOn: Nullable(Type.String()),
  subjectEmployeeId: Nullable(Type.String()),
  subjectName: Nullable(Type.String()),
  assigneeRole: Nullable(Type.String()),
  link: Nullable(Type.String()),
  href: Type.String({ description: 'The page the task is about (its request, document or its own page)' }),
  action: Nullable(TaskActionOut),
});
const TaskDetail = Type.Object({
  id: Uuid,
  title: Type.String(),
  description: Nullable(Type.String()),
  source: Type.String(),
  status: Type.String(),
  dueOn: Nullable(Type.String()),
  createdAt: Type.String(),
  completedAt: Nullable(Type.String()),
  completedByName: Nullable(Type.String()),
  subject: Nullable(Type.Object({ id: Uuid, name: Type.String() })),
  assigneeRole: Nullable(Type.String()),
  assigneeName: Nullable(Type.String()),
  workflow: Nullable(Type.Object({ id: Uuid, kind: Type.String(), name: Type.String() })),
  href: Type.String(),
  canComplete: Type.Boolean(),
  action: Nullable(TaskActionOut),
  recordStatus: Nullable(
    Type.Object({
      text: Type.String({ description: 'The live status of the record the task is linked to' }),
      tone: Type.String(),
    }),
  ),
  origin: Type.Object({
    source: Type.String(),
    label: Type.String({ description: '"Comes from": the real source of the task' }),
    href: Nullable(Type.String()),
  }),
  closesItself: Type.Boolean({ description: 'The task closes when its linked record is complete' }),
  completedVia: Nullable(Type.String()),
  completionNote: Nullable(Type.String()),
});

/** Validates template tasks against the action registry and the due-date model (ADR-0191, ADR-0193). */
function checkTemplateTasks(tasks: Array<{ action?: unknown; due?: unknown; key: string }>) {
  const keys = new Set<string>();
  for (const [i, task] of tasks.entries()) {
    if (keys.has(task.key))
      throw new ApiError('validation', `Task ${i + 1}: the key ${task.key} is used twice`);
    keys.add(task.key);
    if (task.action !== undefined && !parseTaskAction(task.action))
      throw new ApiError('validation', `Task ${i + 1}: unknown action or invalid parameters`);
    if (task.due !== undefined && !parseDueRule(task.due))
      throw new ApiError('validation', `Task ${i + 1}: invalid due rule`);
  }
}
const normaliseTasks = <T extends { action?: unknown; due?: unknown }>(tasks: T[]) =>
  tasks.map((task) => ({
    ...task,
    ...(task.action !== undefined ? { action: parseTaskAction(task.action) } : {}),
    ...(task.due !== undefined ? { due: parseDueRule(task.due) } : {}),
  }));

export async function workflowRoutes(app: FastifyInstance) {
  app.get(
    '/v1/workflow-templates',
    { schema: { tags: ['workflows'], response: { 200: Type.Array(Type.Any()) } } },
    async (req) => {
      authorize(req, 'workflows.read');
      return app.tenantTx(
        req,
        (tx) =>
          tx.query(
            `SELECT id, kind, name, tasks, auto_start AS "autoStart", entity_id AS "entityId" FROM app.workflow_templates ORDER BY kind, name`,
          ),
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/workflow-templates',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['workflows'],
        body: Type.Object({
          kind: Type.Union(['onboarding', 'offboarding', 'transfer', 'custom'].map((k) => Type.Literal(k))),
          name: Type.String({ minLength: 1, maxLength: 120 }),
          tasks: Type.Array(TaskDef, { minItems: 1, maxItems: 100 }),
          autoStart: Type.Optional(Type.Boolean()),
          entityId: Type.Optional(Nullable(Uuid)),
        }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'workflows.manage');
      const b = req.body as {
        kind: string;
        name: string;
        tasks: Array<{ key: string; action?: unknown; due?: unknown }>;
        autoStart?: boolean;
        entityId?: string | null;
      };
      checkTemplateTasks(b.tasks);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.workflow_templates (tenant_id, kind, name, tasks, auto_start, entity_id) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [b.kind, b.name, JSON.stringify(normaliseTasks(b.tasks)), b.autoStart ?? true, b.entityId ?? null],
        );
        await app.audit(tx, req, {
          action: 'workflow_template.created',
          targetType: 'workflow_template',
          targetId: r.id,
          diff: { kind: b.kind, name: b.name, tasks: b.tasks.length },
        });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  app.put(
    '/v1/workflow-templates/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['workflows'],
        summary:
          "Edit a workflow template's name, tasks, actions and due dates. Workflows already started keep their tasks.",
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          tasks: Type.Array(TaskDef, { minItems: 1, maxItems: 100 }),
          autoStart: Type.Optional(Type.Boolean()),
          entityId: Type.Optional(Nullable(Uuid)),
        }),
        response: { 200: Type.Object({ id: Uuid }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'workflows.manage');
      const { id } = req.params as { id: string };
      const b = req.body as {
        name: string;
        tasks: Array<{ key: string; action?: unknown; due?: unknown }>;
        autoStart?: boolean;
        entityId?: string | null;
      };
      checkTemplateTasks(b.tasks);
      return app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<{ name: string; tasks: unknown[] }>(
          'SELECT name, tasks FROM app.workflow_templates WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!before) throw new ApiError('notFound');
        await tx.exec(
          `UPDATE app.workflow_templates SET name = $2, tasks = $3, auto_start = coalesce($4, auto_start),
                  entity_id = CASE WHEN $5::boolean THEN $6::uuid ELSE entity_id END WHERE id = $1`,
          [
            id,
            b.name,
            JSON.stringify(normaliseTasks(b.tasks)),
            b.autoStart ?? null,
            b.entityId !== undefined,
            b.entityId ?? null,
          ],
        );
        await app.audit(tx, req, {
          action: 'workflow_template.updated',
          targetType: 'workflow_template',
          targetId: id,
          diff: {
            name: { from: before.name, to: b.name },
            tasks: { from: before.tasks.length, to: b.tasks.length },
          },
        });
        return { id };
      });
    },
  );

  app.post(
    '/v1/workflows',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['workflows'],
        body: Type.Object({ templateId: Uuid, employeeId: Uuid, anchorDate: CivilDate }),
        response: { 201: Type.Object({ id: Nullable(Uuid) }), 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { templateId: string; employeeId: string; anchorDate: string };
      const id = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'workflows.start', await loadTarget(tx, b.employeeId)))
          throw new ApiError('forbidden');
        const instance = await startWorkflow(tx, b.templateId, b.employeeId, b.anchorDate, auth.userId, {
          book: await ruleBook(app),
        });
        await app.audit(tx, req, {
          action: 'workflow.started',
          targetType: 'employee',
          targetId: b.employeeId,
          diff: { templateId: b.templateId, anchorDate: b.anchorDate },
        });
        return instance ?? null;
      });
      return reply.status(201).send({ id });
    },
  );

  app.get(
    '/v1/workflows',
    {
      schema: {
        tags: ['workflows'],
        querystring: Type.Object({ employeeId: Type.Optional(Uuid), status: Type.Optional(Type.String()) }),
        response: { 200: Type.Array(Type.Any()) },
      },
    },
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
    {
      schema: {
        tags: ['tasks'],
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('all')]),
          ),
        }),
        response: { 200: Type.Array(Task) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const status = (req.query as { status?: string }).status ?? 'open';
      return app.tenantTx(
        req,
        (tx) =>
          listTasks(
            tx,
            auth.userId,
            auth.principal.grants.map((g) => g.roleKey),
            status,
            500,
            req.ctx.locale,
          ),
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/tasks/:id',
    {
      schema: {
        tags: ['tasks'],
        summary:
          'One task: what it asks, when it is due, who it is about and the page it opens. Visible to its assignee, its role queue and people who manage workflows.',
        params: Type.Object({ id: Uuid }),
        response: { 200: TaskDetail, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const roles = taskRoles(auth.principal.grants.map((g) => g.roleKey));
      return app.tenantTx(
        req,
        async (tx) => {
          const r = await tx.maybe<TaskRow & Record<string, string | null>>(
            `SELECT k.*, e.display_name AS subject_name, a.display_name AS assignee_name, c.display_name AS completed_by_name,
                    ${TASK_VIEW_COLUMNS}
               FROM app.tasks k
               LEFT JOIN app.employees e ON e.tenant_id = k.tenant_id AND e.id = k.subject_employee_id
               LEFT JOIN app.users a ON a.tenant_id = k.tenant_id AND a.id = k.assignee_user_id
               LEFT JOIN app.users c ON c.tenant_id = k.tenant_id AND c.id = k.completed_by
               ${TASK_VIEW_JOINS}
              WHERE k.id = $1`,
            [id],
          );
          if (!r) throw new ApiError('notFound');
          const mine =
            r.assignee_user_id === auth.userId ||
            (!r.assignee_user_id && !!r.assignee_role && roles.includes(r.assignee_role));
          const manages = canSome(auth.principal, 'workflows.manage');
          if (!mine && !manages) {
            const readable =
              !!r.subject_employee_id &&
              can(auth.principal, 'workflows.read', await loadTarget(tx, r.subject_employee_id));
            if (!readable) throw new ApiError('forbidden');
          }
          const locale = req.ctx.locale;
          return {
            id: r.id,
            title: taskTitle(r, locale),
            description: taskDescription(r, locale),
            source: r.source,
            status: r.status,
            dueOn: r.due_on ?? null,
            createdAt: r.created_at!,
            completedAt: r.completed_at ?? null,
            completedByName: r.completed_by_name ?? null,
            subject:
              r.subject_employee_id && r.subject_name
                ? { id: r.subject_employee_id, name: r.subject_name }
                : null,
            assigneeRole: r.assignee_role ?? null,
            assigneeName: r.assignee_name ?? null,
            workflow:
              r.source === 'workflow' && r.source_id && r.workflow_name
                ? { id: r.source_id, kind: r.href_workflow_kind ?? 'custom', name: r.workflow_name }
                : null,
            href: hrefOfRow(r),
            // requests and signatures close their tasks when they are decided or signed
            canComplete:
              r.status === 'open' && (mine || manages) && r.source !== 'approval' && r.source !== 'document',
            action: r.status === 'open' ? taskActionView(r, legacyHrefOfRow(r), locale) : null,
            recordStatus: await taskRecordStatus(tx, r, locale),
            origin: taskOrigin(r, auth.principal, locale, auth.principal.employeeId ?? null),
            closesItself: !!r.record_id && r.source !== 'hr_request' && closesItself(r.record_type),
            completedVia: r.completed_via ?? null,
            completionNote: r.completion_note ?? null,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/tasks/:id/complete',
    {
      config: { selfAudited: true },
      // the body is optional: a joiner's checklist marks a step done without one
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['tasks'],
        summary:
          'Mark a task as done by hand, with a short note (audited). Tasks linked to a record close themselves when the record is complete; this is the fallback.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object(
          {
            note: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 500,
                description:
                  'What was done, or why the task is closed by hand. For a request to HR, the reply the person sees.',
              }),
            ),
          },
          { additionalProperties: false, description: 'Optional' },
        ),
        response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const note = (req.body as { note?: string } | undefined)?.note?.trim() || null;
      const roles = taskRoles(auth.principal.grants.map((g) => g.roleKey));
      return app.tenantTx(req, async (tx) => {
        const task = await tx.maybe<{
          id: string;
          assignee_user_id: string | null;
          assignee_role: string | null;
          source: string;
          source_id: string | null;
          subject_employee_id: string | null;
        }>('SELECT * FROM app.tasks WHERE id = $1 FOR UPDATE', [id]);
        if (!task) throw new ApiError('notFound');
        const mine =
          task.assignee_user_id === auth.userId ||
          (!task.assignee_user_id && task.assignee_role && roles.includes(task.assignee_role));
        if (!mine && !canSome(auth.principal, 'workflows.manage')) throw new ApiError('forbidden');
        // a request to HR is resolved: closed through its record, the reply kept, the person told (ADR-0163)
        if (task.source === 'hr_request') {
          await resolveHrRequest(tx, id, auth.userId, note);
          await app.audit(tx, req, {
            action: 'hr_request.resolved',
            targetType: 'task',
            targetId: id,
            diff: { reply: note !== null },
          });
          return { id, status: 'done' };
        }
        const done = await tx.maybe(
          `UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2, completed_via = 'manual', completion_note = $3
            WHERE id = $1 AND status = 'open' RETURNING id`,
          [id, auth.userId, note],
        );
        if (task.source === 'workflow' && task.source_id) await maybeCompleteInstance(tx, task.source_id);
        // by hand: the note says what was done instead of the work its record would have recorded
        if (done)
          await app.audit(tx, req, {
            action: 'task.completed',
            targetType: 'task',
            targetId: id,
            diff: { via: 'manual', note },
          });
        return { id, status: 'done' };
      });
    },
  );
}

// ---- auto-start from domain events (outbox subscribers enqueue idempotent jobs) ---------------------
subscribe('employee.created', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, {
    kind: 'onboarding',
    employeeId: ev.payload.employeeId,
    anchorDate: ev.payload.startDate,
  });
});
subscribe('employee.terminated', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, {
    kind: 'offboarding',
    employeeId: ev.payload.employeeId,
    anchorDate: ev.payload.endDate,
  });
});
subscribe('employee.transferred', async (tx, ev) => {
  await enqueueJob(tx, 'workflows.autostart', `ev:${ev.id}`, {
    kind: 'transfer',
    employeeId: ev.payload.employeeId,
    anchorDate: ev.payload.effectiveDate,
  });
});
registerJob('workflows.autostart', async (ctx) => {
  const { kind, employeeId, anchorDate } = ctx.job.input as {
    kind: 'onboarding' | 'offboarding' | 'transfer';
    employeeId: string;
    anchorDate: string;
  };
  const book = await ruleBook({ deps: ctx.deps } as unknown as FastifyInstance);
  const started = await ctx.tx((tx) => autoStart(tx, kind, employeeId, anchorDate, { book }));
  return { started: started.length };
});

// ---- due dates follow the person's own dates (ADR-0193) ------------------------------------------------
const DUE_FIELDS = ['startDate', 'endDate', 'probationEndDate'];
subscribe('employee.changed', async (tx, ev) => {
  const fields = (ev.payload.fields as string[] | undefined) ?? [];
  if (fields.some((f) => DUE_FIELDS.includes(f)))
    await enqueueJob(tx, 'tasks.refresh_due', `ev:${ev.id}`, { employeeId: ev.payload.employeeId });
});
subscribe('employee.terminated', async (tx, ev) => {
  await enqueueJob(tx, 'tasks.refresh_due', `ev:${ev.id}`, { employeeId: ev.payload.employeeId });
});
registerJob('tasks.refresh_due', async (ctx) => {
  const { employeeId } = ctx.job.input as { employeeId: string };
  const book = await ruleBook({ deps: ctx.deps } as unknown as FastifyInstance);
  const changed = await ctx.tx((tx) => refreshTaskDueDates(tx, employeeId, book));
  return { changed };
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
        target: { type: 'task', id: t.id },
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
