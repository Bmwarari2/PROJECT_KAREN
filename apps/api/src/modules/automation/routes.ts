import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Problem, Uuid } from '../../http/schemas';
import { periodic, registerJob, subscribe } from '../../jobs/registry';
import { employeesForDate, employeeValues, runRule, type Rule } from './engine';

const Recipient = Type.Object({ type: Type.Union(['manager', 'role', 'user', 'employee'].map((t) => Type.Literal(t))), value: Type.Optional(Type.String()) });
const TriggerSchema = Type.Union([
  Type.Object({ type: Type.Literal('record.created'), entity: Type.Literal('employee') }),
  Type.Object({ type: Type.Literal('record.changed'), entity: Type.Literal('employee'), fields: Type.Optional(Type.Array(Type.String())) }),
  Type.Object({ type: Type.Literal('date.reached'), dateField: Type.Union(['startDate', 'endDate', 'probationEndDate', 'workAnniversary', 'birthday'].map((t) => Type.Literal(t))), offsetDays: Type.Integer({ minimum: -365, maximum: 365 }) }),
  Type.Object({ type: Type.Literal('document.expiring'), offsetDays: Type.Integer({ minimum: 0, maximum: 365 }) }),
  Type.Object({ type: Type.Literal('threshold'), metric: Type.Union([Type.Literal('department_headcount'), Type.Literal('overdue_tasks')]), gt: Type.Integer({ minimum: 0 }) }),
]);
const ActionSchema = Type.Union([
  Type.Object({ type: Type.Literal('task'), title: Type.String({ minLength: 1, maxLength: 200 }), assignee: Recipient, dueInDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })) }),
  Type.Object({ type: Type.Literal('notification'), to: Recipient, message: Type.String({ minLength: 1, maxLength: 300 }) }),
  Type.Object({ type: Type.Literal('workflow'), templateId: Uuid }),
  Type.Object({ type: Type.Literal('webhook'), url: Type.String({ format: 'uri', pattern: '^https://' }) }),
  Type.Object({ type: Type.Literal('integration'), integration: Type.String({ maxLength: 40 }), operation: Type.String({ maxLength: 60 }) }),
]);
const ConditionSchema = Type.Object({ field: Type.String({ maxLength: 60 }), op: Type.Union(['present', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].map((t) => Type.Literal(t))), value: Type.Optional(Type.Any()) });

async function loadRules(tx: Tx, types: string[]): Promise<Rule[]> {
  return tx.query<Rule>(`SELECT id, name, trigger, conditions, actions FROM app.automation_rules WHERE enabled AND trigger->>'type' = ANY($1)`, [types]);
}

export async function automationRoutes(app: FastifyInstance) {
  app.get('/v1/automation/rules', { schema: { tags: ['automation'], response: { 200: Type.Array(Type.Any()) } } }, async (req) => {
    authorize(req, 'automation.read');
    return app.tenantTx(req, (tx) => tx.query(`SELECT id, name, enabled, trigger, conditions, actions, created_at AS "createdAt" FROM app.automation_rules ORDER BY created_at DESC`), { readOnly: true });
  });

  app.post(
    '/v1/automation/rules',
    { config: { selfAudited: true }, schema: { tags: ['automation'], body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), trigger: TriggerSchema, conditions: Type.Optional(Type.Array(ConditionSchema, { maxItems: 20 })), actions: Type.Array(ActionSchema, { minItems: 1, maxItems: 10 }), enabled: Type.Optional(Type.Boolean()) }), response: { 201: Type.Object({ id: Uuid }), 403: Problem } } },
    async (req, reply) => {
      const auth = authorize(req, 'automation.manage');
      const b = req.body as { name: string; trigger: unknown; conditions?: unknown[]; actions: unknown[]; enabled?: boolean };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.automation_rules (tenant_id, name, trigger, conditions, actions, enabled, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`, [b.name, JSON.stringify(b.trigger), JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions), b.enabled ?? true, auth.userId]);
        await app.audit(tx, req, { action: 'automation_rule.created', targetType: 'automation_rule', targetId: r.id, diff: b });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  app.post(
    '/v1/automation/rules/:id/dry-run',
    { config: { selfAudited: true }, schema: { tags: ['automation'], params: Type.Object({ id: Uuid }), body: Type.Object({ employeeId: Type.Optional(Uuid), date: Type.Optional(CivilDate) }), response: { 200: Type.Object({ matched: Type.Boolean(), actions: Type.Array(Type.Any()), candidates: Type.Integer() }), 404: Problem } } },
    async (req) => {
      authorize(req, 'automation.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { employeeId?: string; date?: string };
      return app.tenantTx(req, async (tx) => {
        const rule = await tx.maybe<Rule>('SELECT id, name, trigger, conditions, actions FROM app.automation_rules WHERE id = $1', [id]);
        if (!rule) throw new ApiError('notFound');
        const date = b.date ?? new Date().toISOString().slice(0, 10);
        let ids = b.employeeId ? [b.employeeId] : [];
        if (!ids.length && rule.trigger.type === 'date.reached') ids = await employeesForDate(tx, rule.trigger, date);
        let matched = false;
        let actions: unknown[] = [];
        for (const emp of ids.slice(0, 50)) {
          const r = await runRule(tx, rule, { employeeId: emp, values: await employeeValues(tx, emp), eventKey: `dry:${emp}:${date}`, date }, { dryRun: true });
          if (r.matched) {
            matched = true;
            actions = r.actions;
          }
        }
        await app.audit(tx, req, { action: 'automation_rule.dry_run', targetType: 'automation_rule', targetId: id });
        return { matched, actions, candidates: ids.length };
      });
    },
  );

  app.get('/v1/automation/rules/:id/runs', { schema: { tags: ['automation'], params: Type.Object({ id: Uuid }), response: { 200: Type.Array(Type.Any()) } } }, async (req) => {
    authorize(req, 'automation.read');
    const { id } = req.params as { id: string };
    return app.tenantTx(req, (tx) => tx.query(`SELECT id, event_key AS "eventKey", dry_run AS "dryRun", status, detail, created_at AS "createdAt" FROM app.automation_runs WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 200`, [id]), { readOnly: true });
  });
}

// ---- event-driven evaluation: outbox → idempotent job per event -------------------------------------
subscribe('employee.*', async (tx, ev) => {
  if (!['employee.created', 'employee.changed', 'employee.transferred', 'employee.terminated'].includes(ev.topic)) return;
  const has = await tx.maybe(`SELECT 1 FROM app.automation_rules WHERE enabled AND trigger->>'type' IN ('record.created', 'record.changed') LIMIT 1`);
  if (has) await enqueueJob(tx, 'automation.evaluate', `ev:${ev.id}`, { eventId: ev.id, topic: ev.topic, payload: ev.payload });
});

registerJob('automation.evaluate', async (ctx) => {
  const { eventId, topic, payload } = ctx.job.input as { eventId: string; topic: string; payload: { employeeId: string; fields?: string[]; effectiveDate?: string; startDate?: string } };
  return ctx.tx(async (tx) => {
    const type = topic === 'employee.created' ? 'record.created' : 'record.changed';
    const rules = (await loadRules(tx, [type])).filter((r) => r.trigger.type !== 'record.changed' || !r.trigger.fields?.length || r.trigger.fields.some((f) => payload.fields?.includes(f)));
    const values = await employeeValues(tx, payload.employeeId);
    let ran = 0;
    for (const rule of rules) {
      const r = await runRule(tx, rule, { employeeId: payload.employeeId, values: { ...values, changedFields: payload.fields }, eventKey: `ev:${eventId}`, date: payload.effectiveDate ?? payload.startDate ?? new Date().toISOString().slice(0, 10) }, { dryRun: false, fetch: ctx.deps.fetch });
      if (r.status === 'succeeded') ran++;
    }
    return { rules: rules.length, ran };
  });
});

registerJob('automation.daily', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    let ran = 0;
    for (const rule of await loadRules(tx, ['date.reached', 'document.expiring', 'threshold'])) {
      const t = rule.trigger;
      if (t.type === 'date.reached') {
        for (const emp of await employeesForDate(tx, t, date)) {
          const r = await runRule(tx, rule, { employeeId: emp, values: await employeeValues(tx, emp), eventKey: `date:${emp}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch });
          if (r.status === 'succeeded') ran++;
        }
      } else if (t.type === 'document.expiring') {
        const docs = await tx.query<{ id: string; employee_id: string | null }>(`SELECT id, employee_id FROM app.documents WHERE status = 'ready' AND expires_on = ($1::date + $2::int)`, [date, t.offsetDays]);
        for (const d of docs) {
          const values = d.employee_id ? await employeeValues(tx, d.employee_id) : {};
          const r = await runRule(tx, rule, { employeeId: d.employee_id, values: { ...values, documentId: d.id }, eventKey: `doc:${d.id}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch });
          if (r.status === 'succeeded') ran++;
        }
      } else if (t.type === 'threshold') {
        const breached =
          t.metric === 'department_headcount'
            ? await tx.query<{ key: string; n: number }>(`SELECT department_id::text AS key, count(*)::int AS n FROM app.employees WHERE status = 'active' AND department_id IS NOT NULL GROUP BY 1 HAVING count(*) > $1`, [t.gt])
            : await tx.query<{ key: string; n: number }>(`SELECT 'overdue' AS key, count(*)::int AS n FROM app.tasks WHERE status = 'open' AND due_on < $2 HAVING count(*) > $1`, [t.gt, date]);
        for (const b of breached) {
          const r = await runRule(tx, rule, { employeeId: null, values: { metric: t.metric, key: b.key, value: b.n }, eventKey: `thr:${b.key}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch });
          if (r.status === 'succeeded') ran++;
        }
      }
    }
    return { date, ran };
  });
});
periodic.push(async (tx, now) => {
  const date = now.toISOString().slice(0, 10);
  await enqueueJob(tx, 'automation.daily', date, { date });
});
