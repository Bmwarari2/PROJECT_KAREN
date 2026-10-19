import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { periodic, registerJob, subscribe } from '../../jobs/registry';
import { employeesForDate, employeeValues, runRule, type Action, type Rule } from './engine';
import { integrationHandlers, isPublicHttpsUrl } from './integrations';

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
  Type.Object({
    type: Type.Literal('integration'),
    integration: Type.String({ maxLength: 40 }),
    operation: Type.String({ maxLength: 60 }),
    params: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean()]), { maxProperties: 20 })),
  }),
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
      const b = req.body as { name: string; trigger: unknown; conditions?: unknown[]; actions: Action[]; enabled?: boolean };
      for (const a of b.actions) {
        if (a.type === 'webhook' && !isPublicHttpsUrl(a.url)) throw new ApiError('validation', 'Webhook URL must be a public https URL');
        if (a.type !== 'integration') continue;
        const handler = integrationHandlers[a.integration];
        if (!handler) throw new ApiError('validation', `Unknown integration ${a.integration}`);
        const problem = handler.validate(a.operation, a.params ?? {});
        if (problem) throw new ApiError('validation', problem);
      }
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

  app.get('/v1/automation/integrations', { schema: { tags: ['automation'], response: { 200: Type.Array(Type.Object({ id: Type.String() })) } } }, async (req) => {
    authorize(req, 'automation.read');
    return Object.keys(integrationHandlers).sort().map((id) => ({ id }));
  });

  const IntegrationCall = Type.Object({ id: Uuid, ruleId: Nullable(Type.String()), integration: Type.String(), operation: Type.String(), subjectEmployeeId: Nullable(Type.String()), status: Type.String(), attempts: Type.Integer(), result: Type.Any(), createdAt: Type.String(), completedAt: Nullable(Type.String()) });
  app.get(
    '/v1/automation/integration-calls',
    { schema: { tags: ['automation'], summary: 'Execution log of "call integration" actions', querystring: Type.Object({ ruleId: Type.Optional(Uuid) }), response: { 200: Type.Array(IntegrationCall) } } },
    async (req) => {
      authorize(req, 'automation.read');
      const { ruleId } = req.query as { ruleId?: string };
      return app.tenantTx(
        req,
        (tx) =>
          tx.query(
            `SELECT id, rule_id AS "ruleId", integration, operation, subject_employee_id AS "subjectEmployeeId", status, attempts, result, created_at AS "createdAt", completed_at AS "completedAt"
               FROM app.integration_calls WHERE ($1::uuid IS NULL OR rule_id = $1) ORDER BY created_at DESC LIMIT 200`,
            [ruleId ?? null],
          ),
        { readOnly: true },
      );
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
      const r = await runRule(tx, rule, { employeeId: payload.employeeId, values: { ...values, changedFields: payload.fields }, eventKey: `ev:${eventId}`, date: payload.effectiveDate ?? payload.startDate ?? new Date().toISOString().slice(0, 10) }, { dryRun: false, fetch: ctx.deps.fetch, signingKey: ctx.deps.integrationSigningKey });
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
          const r = await runRule(tx, rule, { employeeId: emp, values: await employeeValues(tx, emp), eventKey: `date:${emp}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch, signingKey: ctx.deps.integrationSigningKey });
          if (r.status === 'succeeded') ran++;
        }
      } else if (t.type === 'document.expiring') {
        const docs = await tx.query<{ id: string; employee_id: string | null }>(`SELECT id, employee_id FROM app.documents WHERE status = 'ready' AND expires_on = ($1::date + $2::int)`, [date, t.offsetDays]);
        for (const d of docs) {
          const values = d.employee_id ? await employeeValues(tx, d.employee_id) : {};
          const r = await runRule(tx, rule, { employeeId: d.employee_id, values: { ...values, documentId: d.id }, eventKey: `doc:${d.id}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch, signingKey: ctx.deps.integrationSigningKey });
          if (r.status === 'succeeded') ran++;
        }
      } else if (t.type === 'threshold') {
        const breached =
          t.metric === 'department_headcount'
            ? await tx.query<{ key: string; n: number }>(`SELECT department_id::text AS key, count(*)::int AS n FROM app.employees WHERE status = 'active' AND department_id IS NOT NULL GROUP BY 1 HAVING count(*) > $1`, [t.gt])
            : await tx.query<{ key: string; n: number }>(`SELECT 'overdue' AS key, count(*)::int AS n FROM app.tasks WHERE status = 'open' AND due_on < $2 HAVING count(*) > $1`, [t.gt, date]);
        for (const b of breached) {
          const r = await runRule(tx, rule, { employeeId: null, values: { metric: t.metric, key: b.key, value: b.n }, eventKey: `thr:${b.key}:${date}`, date }, { dryRun: false, fetch: ctx.deps.fetch, signingKey: ctx.deps.integrationSigningKey });
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

// ---- integration dispatch: outbox event → execution-log row + idempotent job → registered handler ----
subscribe('integration.requested', async (tx, ev) => {
  const p = ev.payload as { integration: string; operation: string; employeeId: string | null; rule: string | null };
  await tx.exec(
    `INSERT INTO app.integration_calls (tenant_id, event_id, rule_id, integration, operation, subject_employee_id) VALUES (app.current_tenant(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, event_id) DO NOTHING`,
    [ev.id, p.rule, p.integration, p.operation, p.employeeId],
  );
  await enqueueJob(tx, 'integrations.dispatch', `ev:${ev.id}`, { eventId: ev.id });
});

registerJob('integrations.dispatch', async (ctx) => {
  const eventId = String(ctx.job.input.eventId);
  const call = await ctx.tx((tx) =>
    tx.maybe<{ id: string; status: string; payload: { integration: string; operation: string; params?: Record<string, string | number | boolean>; employeeId: string | null; rule: string | null; eventKey: string; date: string } }>(
      `SELECT c.id, c.status, o.payload FROM app.integration_calls c JOIN app.outbox o ON o.tenant_id = c.tenant_id AND o.id = c.event_id WHERE c.event_id = $1`,
      [eventId],
    ),
  );
  if (!call || call.status !== 'pending') return { skipped: true };
  const p = call.payload;
  const handler = integrationHandlers[p.integration];
  let result: { ok: boolean; detail: Record<string, unknown> };
  if (!handler) result = { ok: false, detail: { reason: 'unknown_integration' } };
  else {
    result = await handler
      .call(
        { tenantId: ctx.tenantId, integration: p.integration, operation: p.operation, params: p.params ?? {}, ruleId: p.rule, eventKey: p.eventKey, employeeId: p.employeeId, date: p.date },
        { fetch: ctx.deps.fetch, signingKey: ctx.deps.integrationSigningKey },
      )
      .catch((e: Error) => ({ ok: false, detail: { reason: 'handler_error', error: e.name } }));
  }
  await ctx.tx((tx) =>
    tx.exec(`UPDATE app.integration_calls SET status = $2, result = $3, attempts = attempts + 1, completed_at = now() WHERE id = $1 AND status = 'pending'`, [call.id, result.ok ? 'succeeded' : 'failed', JSON.stringify(result.detail)]),
  );
  return { status: result.ok ? 'succeeded' : 'failed' };
});
