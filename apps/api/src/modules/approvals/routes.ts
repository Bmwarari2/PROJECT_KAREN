import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { enqueueJob } from '@thapsus/db';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { periodic, registerJob } from '../../jobs/registry';
import { applyEmployeeChange, assertWritable, loadTarget } from '../employees/service';
import { FIELDS } from '../employees/model';
import { loadPrincipal } from '../authz/principal';
import { approvalHandlers, decide, escalateOverdue, listApprovals } from './service';

const Approver = Type.Object({ type: Type.Union(['manager', 'skip_level', 'role', 'user'].map((t) => Type.Literal(t))), value: Type.Optional(Type.String()) });
const Condition = Type.Object({ field: Type.String({ maxLength: 60 }), op: Type.Union(['present', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].map((t) => Type.Literal(t))), value: Type.Optional(Type.Any()) });
const Step = Type.Object({ approver: Approver, timeoutHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })), escalateTo: Type.Optional(Approver), condition: Type.Optional(Condition) });

// Approved employee changes are applied with the requester as the actor.
approvalHandlers['employee.change'] = async (tx, r) => {
  await applyEmployeeChange(tx, r.subject_employee_id!, r.payload as never, r.requested_by);
};

export async function approvalRoutes(app: FastifyInstance) {
  app.post(
    '/v1/approval-policies',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['approvals'],
        body: Type.Object({ subject: Type.String({ maxLength: 60 }), name: Type.String({ minLength: 1, maxLength: 120 }), condition: Type.Optional(Nullable(Condition)), priority: Type.Optional(Type.Integer()), steps: Type.Array(Type.Object({ approver: Approver, timeoutHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })), escalateTo: Type.Optional(Approver), condition: Type.Optional(Condition) }), { minItems: 1, maxItems: 10 }) }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'approvals.manage');
      const b = req.body as { subject: string; name: string; condition?: unknown; priority?: number; steps: unknown[] };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.approval_policies (tenant_id, subject, name, steps, condition, priority) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [b.subject, b.name, JSON.stringify(b.steps), b.condition ? JSON.stringify(b.condition) : null, b.priority ?? 100]);
        await app.audit(tx, req, { action: 'approval_policy.created', targetType: 'approval_policy', targetId: r.id, diff: b });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  const PolicyOut = Type.Object({ id: Uuid, subject: Type.String(), name: Type.String(), condition: Nullable(Condition), priority: Type.Integer(), enabled: Type.Boolean(), steps: Type.Array(Step), createdAt: Type.String() });
  type PolicyRow = { id: string; subject: string; name: string; condition: unknown; priority: number; enabled: boolean; steps: unknown[]; created_at: string };
  const policyOut = (r: PolicyRow) => ({ id: r.id, subject: r.subject, name: r.name, condition: r.condition ?? null, priority: r.priority, enabled: r.enabled, steps: r.steps, createdAt: r.created_at });
  const POLICY_COLUMNS = 'id, subject, name, condition, priority, enabled, steps, created_at';

  app.get('/v1/approval-policies', { schema: { tags: ['approvals'], summary: 'Approval chains, in the order they are matched (priority, then age)', response: { 200: Type.Array(PolicyOut), 403: Problem } } }, async (req) => {
    authorize(req, 'approvals.manage');
    const rows = await app.tenantTx(req, (tx) => tx.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM app.approval_policies ORDER BY subject, priority, created_at`), { readOnly: true });
    return rows.map(policyOut);
  });

  app.put(
    '/v1/approval-policies/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['approvals'],
        summary: 'Replaces an approval chain. Requests already in progress keep the steps they started with.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ subject: Type.String({ maxLength: 60 }), name: Type.String({ minLength: 1, maxLength: 120 }), condition: Type.Optional(Nullable(Condition)), priority: Type.Optional(Type.Integer()), enabled: Type.Optional(Type.Boolean()), steps: Type.Array(Step, { minItems: 1, maxItems: 10 }) }),
        response: { 200: PolicyOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'approvals.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { subject: string; name: string; condition?: unknown; priority?: number; enabled?: boolean; steps: unknown[] };
      return app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM app.approval_policies WHERE id = $1 FOR UPDATE`, [id]);
        if (!before) throw new ApiError('notFound');
        const row = await tx.one<PolicyRow>(
          `UPDATE app.approval_policies SET subject = $2, name = $3, steps = $4, condition = $5, priority = $6, enabled = $7 WHERE id = $1 RETURNING ${POLICY_COLUMNS}`,
          [id, b.subject, b.name, JSON.stringify(b.steps), b.condition ? JSON.stringify(b.condition) : null, b.priority ?? before.priority, b.enabled ?? before.enabled],
        );
        await app.audit(tx, req, { action: 'approval_policy.updated', targetType: 'approval_policy', targetId: id, diff: { before: policyOut(before), after: policyOut(row) } });
        return policyOut(row);
      });
    },
  );

  app.get(
    '/v1/approvals',
    { schema: { tags: ['approvals'], querystring: Type.Object({ view: Type.Optional(Type.Union([Type.Literal('mine'), Type.Literal('requested'), Type.Literal('all')])) }), response: { 200: Type.Array(Type.Object({ id: Uuid, subject: Type.String(), status: Type.String(), policy: Type.String(), subjectName: Nullable(Type.String()), requestedAt: Type.String(), currentStep: Type.Integer(), payload: Type.Any() })) } } },
    async (req) => {
      const auth = requireAuth(req);
      const view = (req.query as { view?: string }).view ?? 'mine';
      if (view === 'all') authorizeSome(req, 'approvals.manage');
      return app.tenantTx(req, (tx) => listApprovals(tx, auth.userId, view), { readOnly: true });
    },
  );

  app.post(
    '/v1/approvals/:id/decide',
    { config: { selfAudited: true }, schema: { tags: ['approvals'], params: Type.Object({ id: Uuid }), body: Type.Object({ decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]), comment: Type.Optional(Type.String({ maxLength: 1000 })) }), response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem, 409: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { decision: 'approve' | 'reject'; comment?: string };
      const status = await app.tenantTx(req, async (tx) => {
        req.auditWritten = true;
        return decide(tx, id, auth.userId, b.decision, b.comment);
      });
      return { id, status };
    },
  );

  app.post(
    '/v1/approvals/bulk',
    { config: { selfAudited: true }, schema: { tags: ['approvals'], body: Type.Object({ ids: Type.Array(Uuid, { minItems: 1, maxItems: 500 }), decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]), comment: Type.Optional(Type.String({ maxLength: 1000 })) }), response: { 200: Type.Object({ succeeded: Type.Array(Uuid), failed: Type.Array(Type.Object({ id: Uuid, code: Type.String() })) }) } } },
    async (req) => {
      const auth = requireAuth(req);
      const b = req.body as { ids: string[]; decision: 'approve' | 'reject'; comment?: string };
      const succeeded: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      for (const id of b.ids) {
        try {
          // each decision commits independently so one failure does not block the rest
          await app.tenantTx(req, (tx) => decide(tx, id, auth.userId, b.decision, b.comment));
          succeeded.push(id);
        } catch (err) {
          failed.push({ id, code: err instanceof ApiError ? err.code : 'internal' });
        }
      }
      req.auditWritten = true;
      return { succeeded, failed };
    },
  );

  // ---- delegation (e.g. manager on holiday) ------------------------------------------------------------
  app.post(
    '/v1/delegations',
    { config: { selfAudited: true }, schema: { tags: ['approvals'], body: Type.Object({ toUserId: Uuid, startsAt: Type.String({ format: 'date-time' }), endsAt: Type.String({ format: 'date-time' }) }), response: { 201: Type.Object({ id: Uuid }), 422: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { toUserId: string; startsAt: string; endsAt: string };
      if (b.toUserId === auth.userId) throw new ApiError('unprocessable');
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(`INSERT INTO app.delegations (tenant_id, from_user_id, to_user_id, starts_at, ends_at) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`, [auth.userId, b.toUserId, b.startsAt, b.endsAt]);
        await app.audit(tx, req, { action: 'delegation.created', targetType: 'delegation', targetId: r.id, diff: b });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  const DelegationOut = Type.Object({ id: Uuid, fromUserId: Uuid, fromName: Type.String(), toUserId: Uuid, toName: Type.String(), startsAt: Type.String(), endsAt: Type.String(), direction: Type.Union([Type.Literal('given'), Type.Literal('received')]) });
  app.get('/v1/delegations', { schema: { tags: ['approvals'], summary: "The caller's delegations: given to someone else, or received from someone (most recent first)", response: { 200: Type.Array(DelegationOut) } } }, async (req) => {
    const auth = requireAuth(req);
    const rows = await app.tenantTx(
      req,
      (tx) =>
        tx.query<{ id: string; from_user_id: string; from_name: string; to_user_id: string; to_name: string; starts_at: string; ends_at: string }>(
          `SELECT d.id, d.from_user_id, f.display_name AS from_name, d.to_user_id, t.display_name AS to_name, d.starts_at, d.ends_at
             FROM app.delegations d
             JOIN app.users f ON f.tenant_id = d.tenant_id AND f.id = d.from_user_id
             JOIN app.users t ON t.tenant_id = d.tenant_id AND t.id = d.to_user_id
            WHERE d.from_user_id = $1 OR d.to_user_id = $1 ORDER BY d.starts_at DESC LIMIT 100`,
          [auth.userId],
        ),
      { readOnly: true },
    );
    return rows.map((r) => ({ id: r.id, fromUserId: r.from_user_id, fromName: r.from_name, toUserId: r.to_user_id, toName: r.to_name, startsAt: r.starts_at, endsAt: r.ends_at, direction: r.from_user_id === auth.userId ? ('given' as const) : ('received' as const) }));
  });

  app.delete(
    '/v1/delegations/:id',
    { config: { selfAudited: true }, schema: { tags: ['approvals'], summary: 'Ends a delegation you gave: an active one ends now, a future one is removed', params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const d = await tx.maybe<{ id: string; future: boolean; ended: boolean }>('SELECT id, starts_at > now() AS future, ends_at <= now() AS ended FROM app.delegations WHERE id = $1 AND from_user_id = $2 FOR UPDATE', [id, auth.userId]);
        if (!d || d.ended) throw new ApiError('notFound');
        if (d.future) await tx.exec('DELETE FROM app.delegations WHERE id = $1', [id]);
        else await tx.exec(`UPDATE app.delegations SET ends_at = greatest(now(), starts_at + interval '1 second') WHERE id = $1`, [id]);
        await app.audit(tx, req, { action: 'delegation.ended', targetType: 'delegation', targetId: id, diff: { removed: d.future } });
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/delegations/candidates',
    {
      schema: {
        tags: ['approvals'],
        summary: 'Active colleagues who can receive approval authority (name and job title only)',
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }),
        response: { 200: Type.Array(Type.Object({ userId: Uuid, displayName: Type.String(), jobTitle: Nullable(Type.String()) })) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const q = (req.query as { q?: string }).q?.trim() ?? '';
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{ id: string; display_name: string; job_title: string | null }>(
            `SELECT u.id, u.display_name, e.job_title FROM app.users u
               LEFT JOIN app.employees e ON e.tenant_id = u.tenant_id AND e.id = u.employee_id
              WHERE u.status = 'active' AND u.id <> $1 AND ($2 = '' OR u.display_name ILIKE '%' || $2 || '%')
              ORDER BY u.display_name, u.id LIMIT 20`,
            [auth.userId, q],
          ),
        { readOnly: true },
      );
      return rows.map((r) => ({ userId: r.id, displayName: r.display_name, jobTitle: r.job_title }));
    },
  );

  // ---- bulk edit -----------------------------------------------------------------------------------------
  const valueProps: Record<string, ReturnType<typeof Type.Any>> = {};
  for (const k of Object.keys(FIELDS)) valueProps[k] = Type.Optional(Type.Any());
  app.post(
    '/v1/employees/bulk-change',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        body: Type.Object({ employeeIds: Type.Array(Uuid, { minItems: 1, maxItems: 1000 }), effectiveDate: CivilDate, values: Type.Object({ ...valueProps, managerId: Type.Optional(Nullable(Uuid)) }, { additionalProperties: false }), reason: Type.Optional(Type.String({ maxLength: 200 })) }),
        response: { 200: Type.Object({ updated: Type.Integer(), pendingApproval: Type.Integer(), forbidden: Type.Array(Uuid), failed: Type.Array(Type.Object({ id: Uuid, code: Type.String() })) }) },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'employees.update');
      const b = req.body as { employeeIds: string[]; effectiveDate: string; values: Record<string, unknown>; reason?: string };
      const summary = { updated: 0, pendingApproval: 0, forbidden: [] as string[], failed: [] as Array<{ id: string; code: string }> };
      for (const id of b.employeeIds) {
        try {
          await app.tenantTx(req, async (tx) => {
            const target = await loadTarget(tx, id);
            if (!can(auth.principal, 'employees.update', target)) throw new ApiError('forbidden');
            assertWritable(auth.principal, [...Object.keys(b.values).filter((k) => k in FIELDS), ...(b.values.managerId !== undefined ? ['manager'] : [])], target);
            const payload = { ...b.values, effectiveDate: b.effectiveDate, reason: b.reason };
            const { requestApproval } = await import('./service');
            if (await requestApproval(tx, 'employee.change', id, auth.userId, payload)) {
              summary.pendingApproval++;
              return;
            }
            const diff = await applyEmployeeChange(tx, id, payload, auth.userId);
            await app.audit(tx, req, { action: 'employee.changed', targetType: 'employee', targetId: id, diff: { effectiveDate: b.effectiveDate, bulk: true, changes: diff } });
            summary.updated++;
          });
        } catch (err) {
          if (err instanceof ApiError && err.code === 'forbidden') summary.forbidden.push(id);
          else summary.failed.push({ id, code: err instanceof ApiError ? err.code : 'internal' });
        }
      }
      return summary;
    },
  );

  // ---- transfer (job/entity/location change + transfer workflow) --------------------------------------------
  app.post(
    '/v1/employees/:id/transfer',
    {
      config: { selfAudited: true },
      schema: { tags: ['employees'], params: Type.Object({ id: Uuid }), body: Type.Object({ effectiveDate: CivilDate, entityId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), departmentId: Type.Optional(Uuid), jobTitle: Type.Optional(Type.String()), managerId: Type.Optional(Uuid), reason: Type.Optional(Type.String({ maxLength: 200 })) }), response: { 200: Type.Object({ id: Uuid }), 403: Problem } },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as Record<string, string> & { effectiveDate: string };
      await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (!can(auth.principal, 'employees.update', target)) throw new ApiError('forbidden');
        // HR must also be allowed to act in the destination entity
        if (b.entityId) {
          const ent = await tx.maybe<{ country: string }>('SELECT country FROM app.legal_entities WHERE id = $1', [b.entityId]);
          if (!ent || !can(auth.principal, 'employees.update', { ...target, entityId: b.entityId, country: ent.country })) throw new ApiError('forbidden');
        }
        const diff = await applyEmployeeChange(tx, id, b, auth.userId, 'employee.transferred');
        await app.audit(tx, req, { action: 'employee.transferred', targetType: 'employee', targetId: id, diff: { effectiveDate: b.effectiveDate, changes: diff } });
      });
      return { id };
    },
  );
}

registerJob('approvals.escalate', async (ctx) => ({ escalated: await ctx.tx((tx) => escalateOverdue(tx, new Date())) }));
periodic.push(async (tx, now) => {
  // one escalation sweep per tenant per 15 minutes
  const slot = new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();
  await enqueueJob(tx, 'approvals.escalate', slot, {});
});

export { loadPrincipal };
