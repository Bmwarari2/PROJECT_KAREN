// Type-only: brings the schema.hide augmentation into every consumer (e.g. the worker typecheck).
import type {} from '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { REGIONS } from '@thapsus/core';
import {
  addMinutes,
  compareDates,
  compareInstants,
  daysBetween,
  instantToDate,
  minutesBetween,
} from '@thapsus/core/time';
import { LEGAL, TRUST, templateForRegion, type LegalTemplate } from '@thapsus/core/trust';
import {
  breachDeadlines,
  retentionRules,
  RETENTION_CATEGORIES,
  type BreachDeadline,
  type RetentionCategory,
  type RuleBook,
} from '@thapsus/rules';
import { enqueueJob, withTenant, writeAudit, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { notify, usersWithRole } from '../../lib/notify';
import { periodic, registerJob } from '../../jobs/registry';
import { loadPrincipal } from '../authz/principal';
import { applyEmployeeChange, assertWritable, loadTarget } from '../employees/service';
import { FIELDS } from '../employees/model';
import { ruleBook } from '../rules/routes';
import { sha256 } from '../documents/pdf';
import { Vault, type VaultActor } from '../vault/service';
import {
  applyErasure,
  buildAccessExport,
  deadlineColumns,
  effectiveDue,
  erasurePlan,
  homeRegion,
  resolveSubject,
  todayUtc,
  type DsrRow,
} from './dsr';
import { buildCompanyExport, purgeTenant } from './company';
import { SUBJECT_TABLES } from './subject-map';
import { logRun, runRetention, tenantPolicies, validatePolicy } from './retention';

/** Rule book outside a request (jobs): pack data plus back-office edits. */
const bookFor = (deps: Deps) => ruleBook({ deps } as unknown as FastifyInstance);

const RuleRefSchema = Type.Object({
  jurisdiction: Type.String(),
  key: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Nullable(Type.String()),
  packVersion: Type.Integer(),
  source: Type.Object({ url: Type.String(), title: Type.String() }),
  verifiedOn: Type.String(),
});
const DsrKind = Type.Union([Type.Literal('access'), Type.Literal('correction'), Type.Literal('deletion')]);
const IdentityMethod = Type.Union(
  ['signed_in_account', 'known_contact_details', 'document_check', 'agent_authorisation', 'other'].map((x) =>
    Type.Literal(x),
  ),
);
const DsrOut = Type.Object({
  id: Uuid,
  kind: Type.String(),
  status: Type.String(),
  subjectEmployeeId: Nullable(Uuid),
  subjectUserId: Nullable(Uuid),
  subjectName: Nullable(Type.String()),
  jurisdiction: Type.String(),
  channel: Type.String(),
  requesterRelationship: Type.String(),
  receivedOn: Type.String(),
  informationReceivedOn: Nullable(Type.String()),
  pausedDays: Type.Integer(),
  dueOn: Nullable(Type.String()),
  extended: Type.Boolean(),
  extendedDueOn: Nullable(Type.String()),
  effectiveDueOn: Nullable(Type.String()),
  daysRemaining: Nullable(Type.Integer()),
  overdue: Type.Boolean(),
  extensionAllowed: Type.Boolean(),
  extensionNoticeBy: Nullable(Type.String()),
  extensionReason: Nullable(Type.String()),
  rule: Nullable(RuleRefSchema),
  identityVerifiedAt: Nullable(Type.String()),
  identityMethod: Nullable(Type.String()),
  identityNote: Nullable(Type.String()),
  details: Nullable(Type.String()),
  outcome: Nullable(Type.Any()),
  exportReady: Type.Boolean(),
  createdAt: Type.String(),
  completedAt: Nullable(Type.String()),
});
const IncidentOut = Type.Object({
  id: Uuid,
  source: Type.String(),
  title: Type.String(),
  description: Nullable(Type.String()),
  severity: Type.String(),
  status: Type.String(),
  personalDataBreach: Type.Boolean(),
  riskLevel: Nullable(Type.String()),
  occurredAt: Nullable(Type.String()),
  awareAt: Type.String(),
  containedAt: Nullable(Type.String()),
  closedAt: Nullable(Type.String()),
  affected: Type.Record(Type.String(), Type.Integer()),
  dataCategories: Type.Array(Type.String()),
  deadlines: Type.Array(
    Type.Object({
      jurisdiction: Type.String(),
      audience: Type.String(),
      body: Nullable(Type.String()),
      dueAt: Nullable(Type.String()),
      standard: Type.String(),
      required: Type.Boolean(),
      minAffected: Nullable(Type.Integer()),
      condition: Nullable(Type.String()),
      rule: RuleRefSchema,
      notifiedAt: Nullable(Type.String()),
      overdue: Type.Boolean(),
    }),
  ),
  unmodelled: Type.Array(Type.String()),
  createdAt: Type.String(),
});

type IncidentRow = {
  id: string;
  source: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  personal_data_breach: boolean;
  risk_level: string | null;
  occurred_at: string | null;
  aware_at: string;
  contained_at: string | null;
  closed_at: string | null;
  affected: Record<string, number>;
  data_categories: string[];
  deadlines: Array<BreachDeadline>;
  notifications: Record<string, { notifiedAt: string; reference?: string | null }>;
  created_at: string;
};

export async function privacyAdmins(tx: Tx): Promise<string[]> {
  return [...new Set([...(await usersWithRole(tx, 'owner')), ...(await usersWithRole(tx, 'hr_admin'))])];
}

function mapDsr(r: DsrRow & { subject_name?: string | null }, today: string, book: RuleBook) {
  const due = effectiveDue(r);
  const d = deadlineColumns(book, r);
  const open = !['completed', 'rejected', 'cancelled'].includes(r.status);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subjectEmployeeId: r.subject_employee_id,
    subjectUserId: r.subject_user_id,
    subjectName: r.subject_name ?? null,
    jurisdiction: r.jurisdiction,
    channel: r.channel,
    requesterRelationship: r.requester_relationship,
    receivedOn: r.received_on,
    informationReceivedOn: r.information_received_on,
    pausedDays: r.paused_days,
    dueOn: r.due_on,
    extended: r.extended,
    extendedDueOn: r.extended_due_on,
    effectiveDueOn: due,
    daysRemaining: due ? daysBetween(today, due) : null,
    overdue: open && !!due && compareDates(today, due) > 0,
    extensionAllowed:
      open &&
      !r.extended &&
      d.extensionAllowed &&
      !!d.extensionNoticeBy &&
      compareDates(today, d.extensionNoticeBy) <= 0,
    extensionNoticeBy: d.extensionNoticeBy,
    extensionReason: r.extension_reason,
    rule: r.rule,
    identityVerifiedAt: r.identity_verified_at,
    identityMethod: r.identity_method,
    identityNote: r.identity_note,
    details: r.details,
    outcome: r.outcome,
    exportReady: !!(r.outcome as { export?: unknown } | null)?.export,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function incidentDeadlines(
  book: RuleBook,
  r: Pick<IncidentRow, 'aware_at' | 'affected' | 'personal_data_breach' | 'source'>,
) {
  if (!r.personal_data_breach) return { deadlines: [] as BreachDeadline[], unmodelled: [] as string[] };
  // The customer is the controller: its processors' duties are not its deadlines.
  const deadlines = breachDeadlines(book, r.aware_at, r.affected).filter(
    (d) => d.audience !== 'processorToController',
  );
  const unmodelled = Object.keys(r.affected).filter((j) => !deadlines.some((d) => d.jurisdiction === j));
  return { deadlines, unmodelled };
}

function mapIncident(r: IncidentRow, now: string) {
  const open = r.status !== 'closed';
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    personalDataBreach: r.personal_data_breach,
    riskLevel: r.risk_level,
    occurredAt: r.occurred_at,
    awareAt: r.aware_at,
    containedAt: r.contained_at,
    closedAt: r.closed_at,
    affected: r.affected,
    dataCategories: r.data_categories,
    deadlines: r.deadlines.map((d) => {
      const n = r.notifications[`${d.jurisdiction}:${d.audience}`];
      return {
        ...d,
        notifiedAt: n?.notifiedAt ?? null,
        overdue: open && !n && d.required && !!d.dueAt && compareInstants(now, d.dueAt) > 0,
      };
    }),
    unmodelled: Object.keys(r.affected).filter((j) => !r.deadlines.some((d) => d.jurisdiction === j)),
    createdAt: r.created_at,
  };
}

const vaultActor = (req: FastifyRequest): VaultActor => {
  const auth = requireAuth(req);
  return {
    principal: auth.principal,
    actorType: auth.method === 'support' ? 'support' : 'user',
    requestId: req.id,
    ip: req.ctx.ip,
  };
};

export async function privacyRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);
  const today = () => todayUtc(deps.now());
  const loadDsr = async (tx: Tx, id: string) => {
    const r = await tx.maybe<DsrRow & { subject_name: string | null }>(
      `SELECT d.*, coalesce(e.display_name, u.display_name) AS subject_name FROM app.dsr_requests d
         LEFT JOIN app.employees e ON e.tenant_id = d.tenant_id AND e.id = d.subject_employee_id
         LEFT JOIN app.users u ON u.tenant_id = d.tenant_id AND u.id = d.subject_user_id WHERE d.id = $1`,
      [id],
    );
    if (!r) throw new ApiError('notFound');
    return r;
  };
  const assertOpen = (r: DsrRow) => {
    if (['completed', 'rejected', 'cancelled'].includes(r.status))
      throw new ApiError('conflict', 'The request is closed');
  };
  const recompute = async (tx: Tx, book: RuleBook, id: string) => {
    const r = await loadDsr(tx, id);
    const d = deadlineColumns(book, r);
    await tx.exec(`UPDATE app.dsr_requests SET due_on = $2, extended_due_on = $3, rule = $4 WHERE id = $1`, [
      id,
      d.due_on,
      r.extended ? r.extended_due_on : d.extended_due_on,
      d.rule ? JSON.stringify(d.rule) : null,
    ]);
    return loadDsr(tx, id);
  };

  // ---- Data subject requests -------------------------------------------------------------------------------
  app.get(
    '/v1/privacy/requests',
    {
      schema: {
        tags: ['privacy'],
        summary: 'Data subject request queue with statutory deadlines',
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union(
              ['open', 'all', 'received', 'in_progress', 'completed', 'rejected', 'cancelled'].map((s) =>
                Type.Literal(s),
              ),
            ),
          ),
        }),
        response: { 200: Type.Array(DsrOut), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.read');
      const status = (req.query as { status?: string }).status ?? 'open';
      const book = await ruleBook(app);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<DsrRow & { subject_name: string | null }>(
            `SELECT d.*, coalesce(e.display_name, u.display_name) AS subject_name FROM app.dsr_requests d
               LEFT JOIN app.employees e ON e.tenant_id = d.tenant_id AND e.id = d.subject_employee_id
               LEFT JOIN app.users u ON u.tenant_id = d.tenant_id AND u.id = d.subject_user_id
              WHERE ($1 = 'all' OR ($1 = 'open' AND d.status IN ('received', 'in_progress')) OR d.status = $1)
              ORDER BY coalesce(CASE WHEN d.extended THEN d.extended_due_on ELSE d.due_on END, '9999-12-31'), d.created_at LIMIT 1000`,
            [status],
          ),
        { readOnly: true },
      );
      return rows.map((r) => mapDsr(r, today(), book));
    },
  );

  app.post(
    '/v1/privacy/requests',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Log a data subject request; the deadline is computed from the jurisdiction packs',
        body: Type.Object({
          kind: DsrKind,
          subjectEmployeeId: Type.Optional(Uuid),
          subjectUserId: Type.Optional(Uuid),
          receivedOn: Type.Optional(CivilDate),
          channel: Type.Optional(
            Type.Union(
              ['email', 'portal', 'letter', 'phone', 'in_person', 'other'].map((x) => Type.Literal(x)),
            ),
          ),
          requesterRelationship: Type.Optional(
            Type.Union(
              ['self', 'authorised_agent', 'parent_or_guardian', 'other'].map((x) => Type.Literal(x)),
            ),
          ),
          details: Type.Optional(Type.String({ maxLength: 4000 })),
          identity: Type.Optional(
            Type.Object({ method: IdentityMethod, note: Type.Optional(Type.String({ maxLength: 1000 })) }),
          ),
        }),
        response: { 201: DsrOut, 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'privacy.dsr');
      const b = req.body as {
        kind: DsrRow['kind'];
        subjectEmployeeId?: string;
        subjectUserId?: string;
        receivedOn?: string;
        channel?: string;
        requesterRelationship?: string;
        details?: string;
        identity?: { method: string; note?: string };
      };
      if (!b.subjectEmployeeId && !b.subjectUserId)
        throw new ApiError('validation', 'subjectEmployeeId or subjectUserId is required');
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        const s = await resolveSubject(tx, { employeeId: b.subjectEmployeeId, userId: b.subjectUserId });
        const receivedOn = b.receivedOn ?? today();
        const d = deadlineColumns(book, {
          jurisdiction: s.jurisdiction,
          kind: b.kind,
          received_on: receivedOn,
          information_received_on: null,
          paused_days: 0,
          extended: false,
        });
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.dsr_requests (tenant_id, kind, subject_employee_id, subject_user_id, requester_relationship, channel, jurisdiction, received_on, due_on, extended_due_on, rule, identity_verified_at, identity_method, identity_note, details, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [
            b.kind,
            s.employeeId,
            s.userId,
            b.requesterRelationship ?? 'self',
            b.channel ?? 'email',
            s.jurisdiction,
            receivedOn,
            d.due_on,
            d.extended_due_on,
            d.rule ? JSON.stringify(d.rule) : null,
            b.identity ? deps.now().toISOString() : null,
            b.identity?.method ?? null,
            b.identity?.note ?? null,
            b.details ?? null,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'privacy.dsr_created',
          targetType: 'dsr_request',
          targetId: r.id,
          diff: {
            kind: b.kind,
            jurisdiction: s.jurisdiction,
            dueOn: d.due_on,
            rule: d.rule ? `${d.rule.jurisdiction}:${d.rule.key}@${d.rule.effectiveFrom}` : null,
          },
        });
        return loadDsr(tx, r.id);
      });
      return reply.status(201).send(mapDsr(row, today(), book));
    },
  );

  app.get(
    '/v1/privacy/requests/:id',
    {
      schema: {
        tags: ['privacy'],
        params: Type.Object({ id: Uuid }),
        response: { 200: DsrOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.read');
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, (tx) => loadDsr(tx, (req.params as { id: string }).id), {
        readOnly: true,
      });
      return mapDsr(row, today(), book);
    },
  );

  app.post(
    '/v1/privacy/requests/:id/identity',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Record how the requester identity was verified (a note, never document copies)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          method: IdentityMethod,
          note: Type.Optional(Type.String({ maxLength: 1000 })),
          informationReceivedOn: Type.Optional(CivilDate),
        }),
        response: { 200: DsrOut, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const b = req.body as { method: string; note?: string; informationReceivedOn?: string };
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        assertOpen(await loadDsr(tx, id));
        await tx.exec(
          `UPDATE app.dsr_requests SET identity_verified_at = $2, identity_method = $3, identity_note = $4, information_received_on = coalesce($5::date, information_received_on) WHERE id = $1`,
          [id, deps.now().toISOString(), b.method, b.note ?? null, b.informationReceivedOn ?? null],
        );
        const r = await recompute(tx, book, id);
        await app.audit(tx, req, {
          action: 'privacy.dsr_identity_verified',
          targetType: 'dsr_request',
          targetId: id,
          diff: { method: b.method, informationReceivedOn: b.informationReceivedOn ?? null, dueOn: r.due_on },
        });
        return r;
      });
      return mapDsr(row, today(), book);
    },
  );

  app.post(
    '/v1/privacy/requests/:id/clarification',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Record a clarification request; the clock stops where the law allows it',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ requestedOn: CivilDate, receivedOn: CivilDate }),
        response: { 200: DsrOut, 400: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const b = req.body as { requestedOn: string; receivedOn: string };
      if (compareDates(b.receivedOn, b.requestedOn) < 0)
        throw new ApiError('validation', 'receivedOn before requestedOn');
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        const cur = await loadDsr(tx, id);
        assertOpen(cur);
        await tx.exec(`UPDATE app.dsr_requests SET paused_days = paused_days + $2 WHERE id = $1`, [
          id,
          daysBetween(b.requestedOn, b.receivedOn),
        ]);
        const r = await recompute(tx, book, id);
        await app.audit(tx, req, {
          action: 'privacy.dsr_clarification',
          targetType: 'dsr_request',
          targetId: id,
          diff: { requestedOn: b.requestedOn, receivedOn: b.receivedOn, dueOn: r.due_on },
        });
        return r;
      });
      return mapDsr(row, today(), book);
    },
  );

  app.post(
    '/v1/privacy/requests/:id/extend',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Extend the deadline where the law allows it (notice before the initial deadline)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 1000 }) }),
        response: { 200: DsrOut, 403: Problem, 404: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const { reason } = req.body as { reason: string };
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await loadDsr(tx, id);
        assertOpen(r);
        const m = mapDsr(r, today(), book);
        if (r.extended) throw new ApiError('conflict', 'Already extended');
        if (!m.extensionAllowed)
          throw new ApiError(
            'unprocessable',
            m.extensionNoticeBy
              ? 'The extension notice period has passed'
              : 'The applicable law does not allow an extension',
          );
        const d = deadlineColumns(book, r);
        await tx.exec(
          `UPDATE app.dsr_requests SET extended = true, extended_due_on = $2, extension_reason = $3 WHERE id = $1`,
          [id, d.extended_due_on, reason],
        );
        await app.audit(tx, req, {
          action: 'privacy.dsr_extended',
          targetType: 'dsr_request',
          targetId: id,
          diff: { extendedDueOn: d.extended_due_on },
        });
        return loadDsr(tx, id);
      });
      return mapDsr(row, today(), book);
    },
  );

  app.post(
    '/v1/privacy/requests/:id/export',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Generate the access export (JSON and PDF) into the home-region object store',
        params: Type.Object({ id: Uuid }),
        response: { 200: DsrOut, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const r = await loadDsr(tx, id);
        assertOpen(r);
        if (r.kind !== 'access') throw new ApiError('conflict', 'Only access requests produce an export');
        await tx.exec(
          `UPDATE app.dsr_requests SET status = 'in_progress' WHERE id = $1 AND status = 'received'`,
          [id],
        );
        await app.audit(tx, req, {
          action: 'privacy.dsr_export_requested',
          targetType: 'dsr_request',
          targetId: id,
          sensitive: true,
        });
      });
      // One person's data is bounded, so the export is generated inline (the job handler does the same for automation).
      await generateAccessExport(deps, auth.tenantId, id, auth.userId, req.id);
      const book = await ruleBook(app);
      return mapDsr(await app.tenantTx(req, (tx) => loadDsr(tx, id), { readOnly: true }), today(), book);
    },
  );

  app.get(
    '/v1/privacy/requests/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Short-lived download link for the access export (home-region object store)',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ file: Type.Union([Type.Literal('json'), Type.Literal('pdf')]) }),
        response: {
          200: Type.Object({ url: Type.String(), sha256: Type.String() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const { file } = req.query as { file: 'json' | 'pdf' };
      const out = await app.tenantTx(req, async (tx) => {
        const r = await loadDsr(tx, id);
        const ex = (r.outcome as { export?: Record<string, { key: string; sha256: string }> } | null)
          ?.export?.[file];
        if (!ex) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'privacy.dsr_export_downloaded',
          targetType: 'dsr_request',
          targetId: id,
          diff: { file },
          sensitive: true,
        });
        return ex;
      });
      return {
        url: await deps.objects.presignGet(out.key, `subject-access-${id}.${file}`),
        sha256: out.sha256,
      };
    },
  );

  app.post(
    '/v1/privacy/requests/:id/correction',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Apply a correction as an effective-dated change to the employee record',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          effectiveDate: CivilDate,
          changes: Type.Record(Type.String(), Type.Any(), { minProperties: 1 }),
          note: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 200: DsrOut, 400: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const b = req.body as { effectiveDate: string; changes: Record<string, unknown>; note?: string };
      const unknown = Object.keys(b.changes).filter((k) => !(k in FIELDS));
      if (unknown.length) throw new ApiError('validation', `Unknown fields: ${unknown.join(', ')}`);
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await loadDsr(tx, id);
        assertOpen(r);
        if (r.kind !== 'correction') throw new ApiError('conflict', 'Not a correction request');
        if (!r.subject_employee_id)
          throw new ApiError('conflict', 'The request has no employee record to correct');
        const target = await loadTarget(tx, r.subject_employee_id);
        assertWritable(auth.principal, Object.keys(b.changes), target);
        const diff = await applyEmployeeChange(
          tx,
          r.subject_employee_id,
          {
            effectiveDate: b.effectiveDate,
            ...b.changes,
            reason: b.note ?? 'Data subject correction request',
          },
          auth.userId,
          'employee.corrected',
        );
        const correction = {
          effectiveDate: b.effectiveDate,
          fields: Object.keys(diff),
          note: b.note ?? null,
        };
        await tx.exec(
          `UPDATE app.dsr_requests SET correction = $2, outcome = coalesce(outcome, '{}'::jsonb) || jsonb_build_object('correction', $2::jsonb) WHERE id = $1`,
          [id, JSON.stringify(correction)],
        );
        await app.audit(tx, req, {
          action: 'privacy.dsr_correction_applied',
          targetType: 'employee',
          targetId: r.subject_employee_id,
          diff: { requestId: id, effectiveDate: b.effectiveDate, changes: diff },
        });
        return loadDsr(tx, id);
      });
      return mapDsr(row, today(), book);
    },
  );

  const ErasurePlanOut = Type.Object({
    holds: Type.Array(Type.Object({ id: Uuid, category: Nullable(Type.String()), reason: Type.String() })),
    erase: Type.Array(Type.String()),
    retain: Type.Array(
      Type.Object({
        category: Type.String(),
        until: Nullable(Type.String()),
        reason: Type.String(),
        rules: Type.Array(RuleRefSchema),
      }),
    ),
  });

  app.get(
    '/v1/privacy/requests/:id/erasure-plan',
    {
      schema: {
        tags: ['privacy'],
        summary: 'What erasure would delete now and what legal holds or statutory retention keep',
        params: Type.Object({ id: Uuid }),
        response: { 200: ErasurePlanOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const r = await loadDsr(tx, (req.params as { id: string }).id);
          return erasurePlan(
            tx,
            book,
            await resolveSubject(tx, { employeeId: r.subject_employee_id, userId: r.subject_user_id }),
            today(),
          );
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/privacy/requests/:id/erase',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Erase or anonymise the person, honouring legal holds and statutory retention',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ confirm: Type.Literal(true) }),
        response: {
          200: Type.Object({
            plan: ErasurePlanOut,
            rows: Type.Record(Type.String(), Type.Integer()),
            filesDeleted: Type.Integer(),
            request: DsrOut,
          }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'privacy.erase');
      const { id } = req.params as { id: string };
      const book = await ruleBook(app);
      const actor = vaultActor(req);
      const result = await app.tenantTx(req, async (tx) => {
        const r = await loadDsr(tx, id);
        assertOpen(r);
        if (r.kind !== 'deletion') throw new ApiError('conflict', 'Not a deletion request');
        const subject = await resolveSubject(tx, {
          employeeId: r.subject_employee_id,
          userId: r.subject_user_id,
        });
        const report = await applyErasure(tx, { vault, actor, book, subject, today: today(), requestId: id });
        // Deletion log: categories and counts only.
        const counts = new Map<string, number>();
        for (const [table, n] of Object.entries(report.rows)) {
          const cat = SUBJECT_TABLES[table]?.category ?? 'other';
          counts.set(cat, (counts.get(cat) ?? 0) + n);
        }
        for (const [cat, n] of Object.entries(report.vault))
          counts.set(`vault:${cat}`, (counts.get(`vault:${cat}`) ?? 0) + n);
        await logRun(
          tx,
          [...counts].map(([category, rows]) => ({
            category: category as RetentionCategory,
            jurisdiction: subject.jurisdiction,
            action: 'delete',
            rows,
            files: 0,
            cutoff: null,
            rules: [],
            policy: null,
          })),
          { trigger: 'dsr', dryRun: false },
        );
        for (const kept of report.plan.retain)
          await logRun(
            tx,
            [
              {
                category: kept.category as RetentionCategory,
                jurisdiction: subject.jurisdiction,
                action: 'retain',
                rows: 0,
                files: 0,
                cutoff: kept.until,
                rules: kept.rules,
                policy: null,
              },
            ],
            { trigger: 'dsr', dryRun: false },
          );
        const outcome = {
          erasure: {
            at: deps.now().toISOString(),
            erased: report.plan.erase,
            retained: report.plan.retain.map((k) => ({
              category: k.category,
              until: k.until,
              reason: k.reason,
            })),
            rows: report.rows,
            files: report.fileKeys.length,
          },
        };
        await tx.exec(
          `UPDATE app.dsr_requests SET status = 'completed', completed_at = now(), outcome = coalesce(outcome, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
          [id, JSON.stringify(outcome)],
        );
        await app.audit(tx, req, {
          action: 'privacy.dsr_erasure_completed',
          targetType: 'dsr_request',
          targetId: id,
          diff: { erased: report.plan.erase, retained: report.plan.retain.map((k) => k.category) },
          sensitive: true,
        });
        return { report, request: await loadDsr(tx, id) };
      });
      // Files go after the database commit, so a failed transaction never loses documents.
      for (const key of result.report.fileKeys) await deps.objects.delete(key).catch(() => undefined);
      return {
        plan: result.report.plan,
        rows: result.report.rows,
        filesDeleted: result.report.fileKeys.length,
        request: mapDsr(result.request, today(), book),
      };
    },
  );

  app.post(
    '/v1/privacy/requests/:id/close',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          outcome: Type.Union([
            Type.Literal('completed'),
            Type.Literal('rejected'),
            Type.Literal('cancelled'),
          ]),
          note: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 200: DsrOut, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.dsr');
      const { id } = req.params as { id: string };
      const b = req.body as { outcome: 'completed' | 'rejected' | 'cancelled'; note?: string };
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        assertOpen(await loadDsr(tx, id));
        await tx.exec(
          `UPDATE app.dsr_requests SET status = $2, completed_at = now(), rejection_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE rejection_reason END, outcome = coalesce(outcome, '{}'::jsonb) || jsonb_build_object('note', $3::text) WHERE id = $1`,
          [id, b.outcome, b.note ?? null],
        );
        await app.audit(tx, req, {
          action: `privacy.dsr_${b.outcome}`,
          targetType: 'dsr_request',
          targetId: id,
        });
        return loadDsr(tx, id);
      });
      return mapDsr(row, today(), book);
    },
  );

  // ---- Legal holds -----------------------------------------------------------------------------------------
  const HoldOut = Type.Object({
    id: Uuid,
    employeeId: Nullable(Uuid),
    employeeName: Nullable(Type.String()),
    category: Nullable(Type.String()),
    reason: Type.String(),
    reference: Nullable(Type.String()),
    createdAt: Type.String(),
    releasedAt: Nullable(Type.String()),
  });
  type HoldRow = {
    id: string;
    employee_id: string | null;
    display_name: string | null;
    category: string | null;
    reason: string;
    reference: string | null;
    created_at: string;
    released_at: string | null;
  };
  const mapHold = (h: HoldRow) => ({
    id: h.id,
    employeeId: h.employee_id,
    employeeName: h.display_name,
    category: h.category,
    reason: h.reason,
    reference: h.reference,
    createdAt: h.created_at,
    releasedAt: h.released_at,
  });
  app.get(
    '/v1/privacy/legal-holds',
    { schema: { tags: ['privacy'], response: { 200: Type.Array(HoldOut), 403: Problem } } },
    async (req) => {
      authorize(req, 'privacy.read');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<HoldRow>(
            `SELECT h.*, e.display_name FROM app.legal_holds h LEFT JOIN app.employees e ON e.tenant_id = h.tenant_id AND e.id = h.employee_id ORDER BY h.released_at NULLS FIRST, h.created_at DESC LIMIT 500`,
          ),
        { readOnly: true },
      );
      return rows.map(mapHold);
    },
  );
  app.post(
    '/v1/privacy/legal-holds',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        body: Type.Object({
          employeeId: Type.Optional(Nullable(Uuid)),
          category: Type.Optional(Nullable(Type.Union(RETENTION_CATEGORIES.map((c) => Type.Literal(c))))),
          reason: Type.String({ minLength: 3, maxLength: 1000 }),
          reference: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: { 201: HoldOut, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'privacy.retention');
      const b = req.body as {
        employeeId?: string | null;
        category?: string | null;
        reason: string;
        reference?: string;
      };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.legal_holds (tenant_id, employee_id, category, reason, reference, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [b.employeeId ?? null, b.category ?? null, b.reason, b.reference ?? null, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'privacy.legal_hold_created',
          targetType: 'legal_hold',
          targetId: r.id,
          diff: { employeeId: b.employeeId ?? null, category: b.category ?? null },
        });
        return tx.one<HoldRow>(
          `SELECT h.*, e.display_name FROM app.legal_holds h LEFT JOIN app.employees e ON e.tenant_id = h.tenant_id AND e.id = h.employee_id WHERE h.id = $1`,
          [r.id],
        );
      });
      return reply.status(201).send(mapHold(row));
    },
  );
  app.post(
    '/v1/privacy/legal-holds/:id/release',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        params: Type.Object({ id: Uuid }),
        response: { 200: HoldOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.retention');
      const { id } = req.params as { id: string };
      const row = await app.tenantTx(req, async (tx) => {
        const n = await tx.exec(
          `UPDATE app.legal_holds SET released_at = now(), released_by = $2 WHERE id = $1 AND released_at IS NULL`,
          [id, auth.userId],
        );
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'privacy.legal_hold_released',
          targetType: 'legal_hold',
          targetId: id,
        });
        return tx.one<HoldRow>(
          `SELECT h.*, e.display_name FROM app.legal_holds h LEFT JOIN app.employees e ON e.tenant_id = h.tenant_id AND e.id = h.employee_id WHERE h.id = $1`,
          [id],
        );
      });
      return mapHold(row);
    },
  );

  // ---- Retention -----------------------------------------------------------------------------------------------
  const PolicyOut = Type.Object({
    category: Type.String(),
    jurisdiction: Type.String(),
    period: Nullable(Type.String()),
    anchor: Type.String(),
    action: Type.String(),
    enabled: Type.Boolean(),
  });
  const RunOut = Type.Object({
    category: Type.String(),
    jurisdiction: Type.String(),
    action: Type.String(),
    rows: Type.Integer(),
    files: Type.Integer(),
    cutoff: Nullable(Type.String()),
    rules: Type.Array(RuleRefSchema),
    policy: Nullable(Type.Object({ period: Nullable(Type.String()), anchor: Type.String() })),
  });
  const jurisdictionsInUse = async (tx: Tx) => {
    const home = REGIONS[await homeRegion(tx)].jurisdiction;
    const rows = await tx.query<{ j: string }>(
      `SELECT DISTINCT CASE WHEN country = 'US' AND region_code ~ '^US-[A-Z]{2}$' THEN region_code ELSE trim(country) END AS j FROM app.employees WHERE country IS NOT NULL`,
    );
    return [...new Set([home === 'UK' ? 'GB' : home, ...rows.map((r) => r.j)])].sort();
  };

  app.get(
    '/v1/privacy/retention',
    {
      schema: {
        tags: ['privacy'],
        summary:
          'Retention rules per category and jurisdiction (pack defaults with sources) and tenant policies',
        response: {
          200: Type.Object({
            jurisdictions: Type.Array(Type.String()),
            categories: Type.Array(
              Type.Object({
                category: Type.String(),
                rules: Type.Array(
                  Type.Object({
                    jurisdiction: Type.String(),
                    key: Type.String(),
                    period: Type.String(),
                    from: Type.String(),
                    statutoryMinimum: Type.Boolean(),
                    legalReview: Type.String(),
                    afterEmploymentEnds: Nullable(Type.String()),
                    rule: RuleRefSchema,
                  }),
                ),
              }),
            ),
            policies: Type.Array(PolicyOut),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'privacy.read');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const jurisdictions = await jurisdictionsInUse(tx);
          const categories = RETENTION_CATEGORIES.map((category) => ({
            category,
            rules: jurisdictions.flatMap((j) =>
              retentionRules(book, j, category, today()).map((r) => ({
                jurisdiction: j,
                key: r.key,
                period: r.value.period,
                from: r.value.from,
                statutoryMinimum: r.value.statutoryMinimum,
                legalReview: r.value.legalReview,
                afterEmploymentEnds: r.value.afterEmploymentEnds ?? null,
                rule: r.rule,
              })),
            ),
          }));
          return { jurisdictions, categories, policies: await tenantPolicies(tx) };
        },
        { readOnly: true },
      );
    },
  );

  app.put(
    '/v1/privacy/retention/policies',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Set a tenant retention policy (never shorter than a statutory minimum)',
        body: Type.Object({
          category: Type.Union(RETENTION_CATEGORIES.map((c) => Type.Literal(c))),
          jurisdiction: Type.Optional(Type.String({ pattern: '^(\\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$' })),
          period: Nullable(Type.String({ pattern: '^P(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?$', minLength: 3 })),
          anchor: Type.Optional(Type.Union([Type.Literal('record_date'), Type.Literal('employment_end')])),
          action: Type.Optional(Type.Union([Type.Literal('delete'), Type.Literal('anonymise')])),
          enabled: Type.Boolean(),
        }),
        response: { 200: PolicyOut, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.retention');
      const b = req.body as {
        category: RetentionCategory;
        jurisdiction?: string;
        period: string | null;
        anchor?: 'record_date' | 'employment_end';
        action?: 'delete' | 'anonymise';
        enabled: boolean;
      };
      const p = {
        category: b.category,
        jurisdiction: b.jurisdiction ?? '*',
        period: b.period,
        anchor:
          b.anchor ??
          (b.category === 'personnel_records' || b.category === 'immigration_records'
            ? 'employment_end'
            : 'record_date'),
        action: b.action ?? 'delete',
        enabled: b.enabled,
      } as const;
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const problems = validatePolicy(book, p, await jurisdictionsInUse(tx), today());
        if (problems.length)
          throw new ApiError('unprocessable', 'The period is shorter than a statutory minimum', {
            minimums: problems,
          });
        const row = await tx.one<{
          category: string;
          jurisdiction: string;
          period: string | null;
          anchor: string;
          action: string;
          enabled: boolean;
        }>(
          `INSERT INTO app.retention_policies (tenant_id, category, jurisdiction, period, anchor, action, enabled, updated_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, category, jurisdiction) DO UPDATE SET period = EXCLUDED.period, anchor = EXCLUDED.anchor, action = EXCLUDED.action, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING category, jurisdiction, period, anchor, action, enabled`,
          [p.category, p.jurisdiction, p.period, p.anchor, p.action, p.enabled, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'privacy.retention_policy_set',
          targetType: 'retention_policy',
          targetId: `${p.category}:${p.jurisdiction}`,
          diff: p,
        });
        return row;
      });
    },
  );

  app.post(
    '/v1/privacy/retention/dry-run',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Show what retention would delete today (logged, nothing deleted)',
        body: Type.Object({
          categories: Type.Optional(Type.Array(Type.Union(RETENTION_CATEGORIES.map((c) => Type.Literal(c))))),
        }),
        response: { 200: Type.Array(RunOut), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.retention');
      const b = req.body as { categories?: RetentionCategory[] };
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const lines = await runRetention(tx, {
          book,
          today: today(),
          dryRun: true,
          categories: b.categories,
          vault,
          actor: vaultActor(req),
          deleteFiles: () => undefined,
        });
        await logRun(tx, lines, { trigger: 'manual', dryRun: true });
        await app.audit(tx, req, { action: 'privacy.retention_dry_run', diff: { lines: lines.length } });
        return lines;
      });
    },
  );

  app.post(
    '/v1/privacy/retention/run',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Apply enabled retention policies now (background job)',
        response: { 202: Type.Object({ jobId: Uuid, status: Type.String() }), 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'privacy.retention');
      const job = await app.tenantTx(req, async (tx) => {
        const j = await enqueueJob(
          tx,
          'privacy.retention',
          `manual:${deps.now().toISOString()}`,
          { trigger: 'manual', date: today() },
          { createdBy: auth.userId },
        );
        await app.audit(tx, req, {
          action: 'privacy.retention_run_requested',
          targetType: 'job',
          targetId: j.id,
        });
        return j;
      });
      return reply.status(202).send({ jobId: job.id, status: job.status });
    },
  );

  app.get(
    '/v1/privacy/retention/runs',
    {
      schema: {
        tags: ['privacy'],
        summary: 'Deletion log (categories, counts and rule versions only)',
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              runAt: Type.String(),
              trigger: Type.String(),
              dryRun: Type.Boolean(),
              category: Type.String(),
              jurisdiction: Type.String(),
              action: Type.String(),
              rowsAffected: Type.Integer(),
              filesDeleted: Type.Integer(),
              cutoff: Nullable(Type.String()),
              ruleVersions: Type.Any(),
              tenantPolicy: Type.Any(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'privacy.read');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            run_at: string;
            trigger: string;
            dry_run: boolean;
            category: string;
            jurisdiction: string;
            action: string;
            rows_affected: number;
            files_deleted: number;
            cutoff: string | null;
            rule_versions: unknown;
            tenant_policy: unknown;
          }>(`SELECT * FROM app.retention_runs ORDER BY run_at DESC, category LIMIT 500`),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        runAt: r.run_at,
        trigger: r.trigger,
        dryRun: r.dry_run,
        category: r.category,
        jurisdiction: r.jurisdiction,
        action: r.action,
        rowsAffected: r.rows_affected,
        filesDeleted: r.files_deleted,
        cutoff: r.cutoff,
        ruleVersions: r.rule_versions,
        tenantPolicy: r.tenant_policy,
      }));
    },
  );

  // ---- Company export ---------------------------------------------------------------------------------------------
  const ExportOut = Type.Object({
    id: Uuid,
    status: Type.String(),
    createdAt: Type.String(),
    completedAt: Nullable(Type.String()),
    sizeBytes: Nullable(Type.Integer()),
    sha256: Nullable(Type.String()),
    progressDone: Nullable(Type.Integer()),
    progressTotal: Nullable(Type.Integer()),
    tables: Nullable(Type.Integer()),
    files: Nullable(Type.Integer()),
  });
  type ExportRow = {
    id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    size_bytes: string | null;
    sha256: string | null;
    manifest: { tables?: unknown[]; files?: { count: number } } | null;
    progress_done: string | null;
    progress_total: string | null;
  };
  const mapExport = (r: ExportRow) => ({
    id: r.id,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    sha256: r.sha256,
    progressDone: r.progress_done === null ? null : Number(r.progress_done),
    progressTotal: r.progress_total === null ? null : Number(r.progress_total),
    tables: r.manifest?.tables?.length ?? null,
    files: r.manifest?.files?.count ?? null,
  });
  const EXPORT_SQL = `SELECT x.*, j.progress_done, j.progress_total FROM app.company_exports x LEFT JOIN app.jobs j ON j.tenant_id = x.tenant_id AND j.id = x.job_id`;
  app.get(
    '/v1/privacy/company-exports',
    { schema: { tags: ['privacy'], response: { 200: Type.Array(ExportOut), 403: Problem } } },
    async (req) => {
      authorize(req, 'account.export');
      const rows = await app.tenantTx(
        req,
        (tx) => tx.query<ExportRow>(`${EXPORT_SQL} ORDER BY x.created_at DESC LIMIT 50`),
        { readOnly: true },
      );
      return rows.map(mapExport);
    },
  );
  app.post(
    '/v1/privacy/company-exports',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Export all company data (background job with progress)',
        response: { 202: ExportOut, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'account.export');
      const row = await app.tenantTx(req, async (tx) => {
        const x = await tx.one<{ id: string }>(
          `INSERT INTO app.company_exports (tenant_id, requested_by) VALUES (app.current_tenant(), $1) RETURNING id`,
          [auth.userId],
        );
        const j = await enqueueJob(
          tx,
          'privacy.company_export',
          x.id,
          { exportId: x.id },
          { createdBy: auth.userId },
        );
        await tx.exec(`UPDATE app.company_exports SET job_id = $2 WHERE id = $1`, [x.id, j.id]);
        await app.audit(tx, req, {
          action: 'privacy.company_export_requested',
          targetType: 'company_export',
          targetId: x.id,
          sensitive: true,
        });
        return tx.one<ExportRow>(`${EXPORT_SQL} WHERE x.id = $1`, [x.id]);
      });
      return reply.status(202).send(mapExport(row));
    },
  );
  app.get(
    '/v1/privacy/company-exports/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ url: Type.String(), sha256: Type.String() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'account.export');
      const { id } = req.params as { id: string };
      const x = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<{ file_key: string | null; sha256: string | null; status: string }>(
          `SELECT file_key, sha256, status FROM app.company_exports WHERE id = $1`,
          [id],
        );
        if (!r?.file_key || r.status !== 'ready') throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'privacy.company_export_downloaded',
          targetType: 'company_export',
          targetId: id,
          sensitive: true,
        });
        return r;
      });
      return {
        url: await deps.objects.presignGet(x.file_key!, `company-export-${id}.zip`),
        sha256: x.sha256!,
      };
    },
  );

  // ---- Account closure -------------------------------------------------------------------------------------------
  const ClosureOut = Type.Object({
    closure: Nullable(
      Type.Object({
        id: Uuid,
        status: Type.String(),
        requestedAt: Type.String(),
        purgeAfter: Type.String(),
        graceDays: Type.Integer(),
        reason: Nullable(Type.String()),
        cancelledAt: Nullable(Type.String()),
      }),
    ),
    graceDays: Type.Integer(),
    backupRetentionDays: Type.Integer(),
    workspace: Type.String(),
  });
  type ClosureRow = {
    id: string;
    status: string;
    requested_at: string;
    purge_after: string;
    grace_days: number;
    reason: string | null;
    cancelled_at: string | null;
  };
  const closureView = async (tx: Tx) => {
    const c = await tx.maybe<ClosureRow>(
      `SELECT * FROM app.account_closures ORDER BY requested_at DESC LIMIT 1`,
    );
    const slug = (
      await tx.one<{ slug: string }>('SELECT slug FROM app.tenants WHERE tenant_id = app.current_tenant()')
    ).slug;
    return {
      closure: c
        ? {
            id: c.id,
            status: c.status,
            requestedAt: c.requested_at,
            purgeAfter: c.purge_after,
            graceDays: c.grace_days,
            reason: c.reason,
            cancelledAt: c.cancelled_at,
          }
        : null,
      graceDays: LEGAL.closureGraceDays,
      backupRetentionDays: LEGAL.backupRetentionDays[deps.config.env],
      workspace: slug,
    };
  };
  app.get(
    '/v1/privacy/closure',
    { schema: { tags: ['privacy'], response: { 200: ClosureOut, 403: Problem } } },
    async (req) => {
      authorize(req, 'account.close');
      return app.tenantTx(req, closureView, { readOnly: true });
    },
  );
  app.post(
    '/v1/privacy/closure',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Schedule account closure after the grace period (cancellable until then)',
        body: Type.Object({
          confirmWorkspace: Type.String(),
          reason: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 201: ClosureOut, 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'account.close');
      const b = req.body as { confirmWorkspace: string; reason?: string };
      const view = await app.tenantTx(req, async (tx) => {
        const slug = (
          await tx.one<{ slug: string }>(
            'SELECT slug FROM app.tenants WHERE tenant_id = app.current_tenant()',
          )
        ).slug;
        if (b.confirmWorkspace !== slug)
          throw new ApiError('unprocessable', 'Type the workspace name to confirm');
        if (await tx.maybe(`SELECT 1 FROM app.account_closures WHERE status IN ('scheduled', 'purging')`))
          throw new ApiError('conflict', 'Closure already scheduled');
        const purgeAfter = addMinutes(deps.now().toISOString(), LEGAL.closureGraceDays * 24 * 60);
        const c = await tx.one<{ id: string }>(
          `INSERT INTO app.account_closures (tenant_id, requested_by, grace_days, purge_after, reason) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
          [auth.userId, LEGAL.closureGraceDays, purgeAfter, b.reason ?? null],
        );
        await enqueueJob(
          tx,
          'privacy.closure_purge',
          c.id,
          { closureId: c.id },
          { createdBy: auth.userId, runAfter: purgeAfter },
        );
        await notify(tx, {
          userIds: await privacyAdmins(tx),
          kind: 'privacy.closure',
          titleKey: 'notify.closureScheduled',
          params: { date: purgeAfter.slice(0, 10) },
          link: '/app/privacy/exports',
          dedupeKey: `closure:${c.id}:scheduled`,
        });
        await app.audit(tx, req, {
          action: 'privacy.closure_scheduled',
          targetType: 'account_closure',
          targetId: c.id,
          diff: { purgeAfter, graceDays: LEGAL.closureGraceDays },
        });
        return closureView(tx);
      });
      await deps.directory.update(auth.tenantId, { status: 'closing' });
      return reply.status(201).send(view);
    },
  );
  app.post(
    '/v1/privacy/closure/cancel',
    {
      config: { selfAudited: true },
      schema: { tags: ['privacy'], response: { 200: ClosureOut, 403: Problem, 409: Problem } },
    },
    async (req) => {
      const auth = authorize(req, 'account.close');
      const view = await app.tenantTx(req, async (tx) => {
        const c = await tx.maybe<{ id: string }>(
          `UPDATE app.account_closures SET status = 'cancelled', cancelled_by = $1, cancelled_at = now() WHERE status = 'scheduled' RETURNING id`,
          [auth.userId],
        );
        if (!c) throw new ApiError('conflict', 'No scheduled closure');
        await notify(tx, {
          userIds: await privacyAdmins(tx),
          kind: 'privacy.closure',
          titleKey: 'notify.closureCancelled',
          link: '/app/privacy/exports',
          dedupeKey: `closure:${c.id}:cancelled`,
        });
        await app.audit(tx, req, {
          action: 'privacy.closure_cancelled',
          targetType: 'account_closure',
          targetId: c.id,
        });
        return closureView(tx);
      });
      await deps.directory.update(auth.tenantId, { status: 'active' });
      return view;
    },
  );

  // ---- DPA acceptance ------------------------------------------------------------------------------------------------
  const DpaOut = Type.Object({
    template: Type.String(),
    currentVersion: Type.String(),
    documentSha256: Type.String(),
    acceptances: Type.Array(
      Type.Object({
        version: Type.String(),
        acceptedBy: Uuid,
        acceptedByName: Nullable(Type.String()),
        acceptedAt: Type.String(),
      }),
    ),
    reacceptanceRequired: Type.Boolean(),
    legalReview: Type.String(),
  });
  const dpaView = async (tx: Tx) => {
    const template = templateForRegion(await homeRegion(tx));
    const cur = TRUST.dpa[template];
    const acc = await tx.query<{
      dpa_version: string;
      accepted_by: string;
      accepted_by_name: string | null;
      accepted_at: string;
    }>(
      `SELECT dpa_version, accepted_by, accepted_by_name, accepted_at FROM app.dpa_acceptances ORDER BY accepted_at DESC`,
    );
    return {
      template,
      currentVersion: cur.version,
      documentSha256: cur.sha256,
      acceptances: acc.map((a) => ({
        version: a.dpa_version,
        acceptedBy: a.accepted_by,
        acceptedByName: a.accepted_by_name,
        acceptedAt: a.accepted_at,
      })),
      reacceptanceRequired: !acc.some((a) => a.dpa_version === cur.version),
      legalReview: LEGAL.legalReview,
    };
  };
  app.get(
    '/v1/privacy/dpa',
    { schema: { tags: ['privacy'], response: { 200: DpaOut, 403: Problem } } },
    async (req) => {
      authorize(req, 'privacy.read');
      return app.tenantTx(req, dpaView, { readOnly: true });
    },
  );
  app.post(
    '/v1/privacy/dpa/accept',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        body: Type.Object({ version: Type.String() }),
        response: { 201: DpaOut, 403: Problem, 409: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'account.dpa');
      const { version } = req.body as { version: string };
      const view = await app.tenantTx(req, async (tx) => {
        const template = templateForRegion(await homeRegion(tx));
        if (TRUST.dpa[template].version !== version)
          throw new ApiError('unprocessable', 'Only the current DPA version can be accepted');
        const n = await tx.exec(
          `INSERT INTO app.dpa_acceptances (tenant_id, dpa_version, template, accepted_by, accepted_by_name, ip, document_sha256) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, dpa_version) DO NOTHING`,
          [
            version,
            template,
            auth.userId,
            auth.user.displayName ?? null,
            req.ctx.ip,
            TRUST.dpa[template].sha256,
          ],
        );
        if (!n) throw new ApiError('conflict', 'This version is already accepted');
        await app.audit(tx, req, {
          action: 'privacy.dpa_accepted',
          targetType: 'dpa',
          targetId: version,
          diff: { template, sha256: TRUST.dpa[template].sha256 },
        });
        return dpaView(tx);
      });
      return reply.status(201).send(view);
    },
  );

  // ---- Sub-processors -------------------------------------------------------------------------------------------------
  const SubOut = Type.Object({
    region: Type.String(),
    noticeDays: Type.Integer(),
    sections: Type.Array(
      Type.Object({
        title: Type.String(),
        columns: Type.Array(Type.String()),
        rows: Type.Array(Type.Array(Type.String())),
      }),
    ),
    changes: Type.Array(
      Type.Object({
        id: Type.String(),
        type: Type.String(),
        announced: Type.String(),
        effectiveFrom: Type.String(),
        regions: Type.Array(Type.String()),
        change: Type.String(),
      }),
    ),
    subscribed: Type.Boolean(),
  });
  const subView = async (tx: Tx, userId: string) => {
    const region = await homeRegion(tx);
    const subscribed = !!(await tx.maybe('SELECT 1 FROM app.subprocessor_subscriptions WHERE user_id = $1', [
      userId,
    ]));
    return {
      region,
      noticeDays: LEGAL.subprocessorNoticeDays,
      sections: TRUST.subprocessors.sections,
      changes: TRUST.subprocessors.changes.filter((c) => c.regions.includes(region)),
      subscribed,
    };
  };
  app.get(
    '/v1/privacy/subprocessors',
    { schema: { tags: ['privacy'], response: { 200: SubOut, 403: Problem } } },
    async (req) => {
      const auth = authorize(req, 'privacy.read');
      return app.tenantTx(req, (tx) => subView(tx, auth.userId), { readOnly: true });
    },
  );
  app.put(
    '/v1/privacy/subprocessors/subscription',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Subscribe to sub-processor change notices',
        body: Type.Object({ subscribed: Type.Boolean() }),
        response: { 200: SubOut, 403: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.read');
      const { subscribed } = req.body as { subscribed: boolean };
      return app.tenantTx(req, async (tx) => {
        if (subscribed)
          await tx.exec(
            `INSERT INTO app.subprocessor_subscriptions (tenant_id, user_id) VALUES (app.current_tenant(), $1) ON CONFLICT DO NOTHING`,
            [auth.userId],
          );
        else await tx.exec(`DELETE FROM app.subprocessor_subscriptions WHERE user_id = $1`, [auth.userId]);
        await app.audit(tx, req, {
          action: subscribed ? 'privacy.subprocessors_subscribed' : 'privacy.subprocessors_unsubscribed',
        });
        return subView(tx, auth.userId);
      });
    },
  );

  // ---- Privacy notice templates ------------------------------------------------------------------------------------------
  const NoticeOut = Type.Object({
    template: Type.String(),
    templateVersion: Type.String(),
    title: Type.String(),
    body: Type.String(),
    legalReview: Type.String(),
    tenantCopy: Nullable(
      Type.Object({
        title: Type.String(),
        body: Type.String(),
        templateVersion: Type.String(),
        status: Type.String(),
        publishedAt: Nullable(Type.String()),
        updatedAt: Type.String(),
        outdated: Type.Boolean(),
      }),
    ),
  });
  type NoticeRow = {
    template: LegalTemplate;
    template_version: string;
    title: string;
    body: string;
    status: string;
    published_at: string | null;
    updated_at: string;
  };
  const noticeView = (t: LegalTemplate, copy: NoticeRow | undefined) => ({
    template: t,
    templateVersion: TRUST.notices[t].version,
    title: TRUST.notices[t].title,
    body: TRUST.notices[t].body,
    legalReview: LEGAL.legalReview,
    tenantCopy: copy
      ? {
          title: copy.title,
          body: copy.body,
          templateVersion: copy.template_version,
          status: copy.status,
          publishedAt: copy.published_at,
          updatedAt: copy.updated_at,
          outdated: copy.template_version !== TRUST.notices[t].version,
        }
      : null,
  });
  app.get(
    '/v1/privacy/notices',
    {
      schema: {
        tags: ['privacy'],
        summary:
          'Privacy notice templates per jurisdiction (for legal review) and the tenant editable copies',
        response: { 200: Type.Array(NoticeOut), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.read');
      const copies = await app.tenantTx(
        req,
        (tx) => tx.query<NoticeRow>(`SELECT * FROM app.privacy_notices`),
        { readOnly: true },
      );
      return (['uk', 'eu', 'us'] as const).map((t) =>
        noticeView(
          t,
          copies.find((c) => c.template === t),
        ),
      );
    },
  );
  app.put(
    '/v1/privacy/notices/:template',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        params: Type.Object({
          template: Type.Union([Type.Literal('uk'), Type.Literal('eu'), Type.Literal('us')]),
        }),
        body: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 200_000 }),
          publish: Type.Boolean(),
        }),
        response: { 200: NoticeOut, 403: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'privacy.notices');
      const { template } = req.params as { template: LegalTemplate };
      const b = req.body as { title: string; body: string; publish: boolean };
      const copy = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<NoticeRow>(
          `INSERT INTO app.privacy_notices (tenant_id, template, template_version, title, body, status, published_at, updated_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, CASE WHEN $5 = 'published' THEN now() END, $6)
           ON CONFLICT (tenant_id, template) DO UPDATE SET template_version = EXCLUDED.template_version, title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status,
             published_at = CASE WHEN EXCLUDED.status = 'published' THEN now() ELSE app.privacy_notices.published_at END, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
          [
            template,
            TRUST.notices[template].version,
            b.title,
            b.body,
            b.publish ? 'published' : 'draft',
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: b.publish ? 'privacy.notice_published' : 'privacy.notice_saved',
          targetType: 'privacy_notice',
          targetId: template,
        });
        return r;
      });
      return noticeView(template, copy);
    },
  );

  // ---- Incident and breach log -----------------------------------------------------------------------------------------
  const IncidentBody = {
    title: Type.String({ minLength: 3, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 10_000 })),
    severity: Type.Optional(Type.Union(['low', 'medium', 'high', 'critical'].map((s) => Type.Literal(s)))),
    personalDataBreach: Type.Boolean(),
    riskLevel: Type.Optional(
      Nullable(Type.Union(['unlikely', 'risk', 'high_risk'].map((s) => Type.Literal(s)))),
    ),
    awareAt: Type.String({ format: 'date-time' }),
    occurredAt: Type.Optional(Nullable(Type.String({ format: 'date-time' }))),
    affected: Type.Optional(
      Type.Record(Type.String({ pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' }), Type.Integer({ minimum: 0 })),
    ),
    dataCategories: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 30 })),
  };
  app.get(
    '/v1/privacy/incidents',
    { schema: { tags: ['privacy'], response: { 200: Type.Array(IncidentOut), 403: Problem } } },
    async (req) => {
      authorize(req, 'privacy.read');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<IncidentRow>(
            `SELECT * FROM app.incidents ORDER BY (status = 'closed'), aware_at DESC LIMIT 500`,
          ),
        { readOnly: true },
      );
      return rows.map((r) => mapIncident(r, deps.now().toISOString()));
    },
  );
  app.post(
    '/v1/privacy/incidents',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Log an incident; breach deadlines come from the jurisdiction packs',
        body: Type.Object(IncidentBody),
        response: { 201: IncidentOut, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'privacy.incidents');
      const b = req.body as {
        title: string;
        description?: string;
        severity?: string;
        personalDataBreach: boolean;
        riskLevel?: string | null;
        awareAt: string;
        occurredAt?: string | null;
        affected?: Record<string, number>;
        dataCategories?: string[];
      };
      const book = await ruleBook(app);
      const awareAt = new Date(b.awareAt).toISOString();
      const { deadlines } = incidentDeadlines(book, {
        aware_at: awareAt,
        affected: b.affected ?? {},
        personal_data_breach: b.personalDataBreach,
        source: 'customer',
      });
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<IncidentRow>(
          `INSERT INTO app.incidents (tenant_id, title, description, severity, personal_data_breach, risk_level, aware_at, occurred_at, affected, data_categories, deadlines, created_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            b.title,
            b.description ?? null,
            b.severity ?? 'medium',
            b.personalDataBreach,
            b.riskLevel ?? null,
            awareAt,
            b.occurredAt ?? null,
            JSON.stringify(b.affected ?? {}),
            b.dataCategories ?? [],
            JSON.stringify(deadlines),
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'privacy.incident_created',
          targetType: 'incident',
          targetId: r.id,
          diff: {
            personalDataBreach: b.personalDataBreach,
            jurisdictions: Object.keys(b.affected ?? {}),
            deadlines: deadlines.length,
          },
        });
        return r;
      });
      return reply.status(201).send(mapIncident(row, deps.now().toISOString()));
    },
  );
  app.patch(
    '/v1/privacy/incidents/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        params: Type.Object({ id: Uuid }),
        body: Type.Partial(
          Type.Object({
            ...IncidentBody,
            status: Type.Union([Type.Literal('open'), Type.Literal('contained'), Type.Literal('closed')]),
          }),
        ),
        response: { 200: IncidentOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.incidents');
      const { id } = req.params as { id: string };
      const b = req.body as Partial<{
        title: string;
        description: string;
        severity: string;
        personalDataBreach: boolean;
        riskLevel: string | null;
        awareAt: string;
        occurredAt: string | null;
        affected: Record<string, number>;
        dataCategories: string[];
        status: string;
      }>;
      const book = await ruleBook(app);
      const row = await app.tenantTx(req, async (tx) => {
        const cur = await tx.maybe<IncidentRow>(`SELECT * FROM app.incidents WHERE id = $1 FOR UPDATE`, [id]);
        if (!cur) throw new ApiError('notFound');
        const next = {
          ...cur,
          title: b.title ?? cur.title,
          description: b.description ?? cur.description,
          severity: b.severity ?? cur.severity,
          personal_data_breach: b.personalDataBreach ?? cur.personal_data_breach,
          risk_level: b.riskLevel === undefined ? cur.risk_level : b.riskLevel,
          aware_at: b.awareAt ? new Date(b.awareAt).toISOString() : cur.aware_at,
          occurred_at: b.occurredAt === undefined ? cur.occurred_at : b.occurredAt,
          affected: b.affected ?? cur.affected,
          data_categories: b.dataCategories ?? cur.data_categories,
          status: b.status ?? cur.status,
        };
        const { deadlines } = incidentDeadlines(book, next);
        const r = await tx.one<IncidentRow>(
          `UPDATE app.incidents SET title = $2, description = $3, severity = $4, personal_data_breach = $5, risk_level = $6, aware_at = $7, occurred_at = $8, affected = $9, data_categories = $10, deadlines = $11, status = $12,
             contained_at = CASE WHEN $12 = 'contained' AND contained_at IS NULL THEN now() ELSE contained_at END, closed_at = CASE WHEN $12 = 'closed' THEN coalesce(closed_at, now()) ELSE NULL END WHERE id = $1 RETURNING *`,
          [
            id,
            next.title,
            next.description,
            next.severity,
            next.personal_data_breach,
            next.risk_level,
            next.aware_at,
            next.occurred_at,
            JSON.stringify(next.affected),
            next.data_categories,
            JSON.stringify(deadlines),
            next.status,
          ],
        );
        await app.audit(tx, req, {
          action: 'privacy.incident_updated',
          targetType: 'incident',
          targetId: id,
          diff: { fields: Object.keys(b) },
        });
        return r;
      });
      return mapIncident(row, deps.now().toISOString());
    },
  );
  app.post(
    '/v1/privacy/incidents/:id/notifications',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['privacy'],
        summary: 'Record that a regulator, individuals or agencies were notified',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          jurisdiction: Type.String({ pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' }),
          audience: Type.Union(
            ['regulator', 'individuals', 'consumerReportingAgencies'].map((a) => Type.Literal(a)),
          ),
          notifiedAt: Type.String({ format: 'date-time' }),
          reference: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: { 200: IncidentOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'privacy.incidents');
      const { id } = req.params as { id: string };
      const b = req.body as {
        jurisdiction: string;
        audience: string;
        notifiedAt: string;
        reference?: string;
      };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<IncidentRow>(
          `UPDATE app.incidents SET notifications = notifications || jsonb_build_object($2::text, jsonb_build_object('notifiedAt', $3::text, 'reference', $4::text)) WHERE id = $1 RETURNING *`,
          [id, `${b.jurisdiction}:${b.audience}`, new Date(b.notifiedAt).toISOString(), b.reference ?? null],
        );
        if (!r) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'privacy.incident_notification_recorded',
          targetType: 'incident',
          targetId: id,
          diff: { jurisdiction: b.jurisdiction, audience: b.audience },
        });
        return r;
      });
      return mapIncident(row, deps.now().toISOString());
    },
  );
}

// ---- Background jobs ---------------------------------------------------------------------------------------------------------
/**
 * Builds the access export for a request as the given user (vault permissions and audit apply to
 * them), stores JSON and PDF under the tenant's prefix in the home-region object store and records
 * the keys and hashes on the request.
 */
export async function generateAccessExport(
  deps: Deps,
  tenantId: string,
  requestId: string,
  userId: string,
  requestRef: string,
) {
  const vault = new Vault(deps.keys);
  const built = await withTenant(
    deps.router,
    tenantId,
    async (tx) => {
      const r = await tx.maybe<DsrRow>('SELECT * FROM app.dsr_requests WHERE id = $1', [requestId]);
      if (!r || r.kind !== 'access') return undefined;
      const principal = await loadPrincipal(tx, userId);
      const actor: VaultActor = { principal, actorType: 'user', requestId: requestRef };
      const locale = (
        await tx.maybe<{ locale: string | null }>('SELECT locale FROM app.users WHERE id = $1', [userId])
      )?.locale;
      return buildAccessExport(tx, {
        vault,
        actor,
        tenantId,
        request: r,
        locale: locale === 'en-US' ? 'en-US' : 'en-GB',
        now: deps.now(),
      });
    },
    { actorId: userId },
  );
  if (!built) return undefined;
  const base = `${tenantId}/privacy/dsr/${requestId}`;
  await deps.objects.put(`${base}/export.json`, built.json, 'application/json');
  await deps.objects.put(`${base}/summary.pdf`, Buffer.from(built.pdf), 'application/pdf');
  await withTenant(
    deps.router,
    tenantId,
    async (tx) => {
      const exp = {
        json: { key: `${base}/export.json`, sha256: sha256(built.json) },
        pdf: { key: `${base}/summary.pdf`, sha256: sha256(built.pdf) },
        generatedAt: deps.now().toISOString(),
        summary: built.summary,
      };
      await tx.exec(
        `UPDATE app.dsr_requests SET outcome = coalesce(outcome, '{}'::jsonb) || jsonb_build_object('export', $2::jsonb) WHERE id = $1`,
        [requestId, JSON.stringify(exp)],
      );
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'privacy.dsr_export_generated',
        targetType: 'dsr_request',
        targetId: requestId,
        diff: {
          tables: Object.keys(built.summary.tables).length,
          sensitiveValues: built.summary.sensitiveValues,
        },
        sensitive: true,
        requestId: requestRef,
      });
      await notify(tx, {
        userIds: [userId],
        kind: 'privacy.dsr',
        titleKey: 'notify.dsrExportReady',
        link: `/app/privacy?request=${requestId}`,
        dedupeKey: `dsr-export:${requestId}:${exp.generatedAt}`,
      });
    },
    { actorId: userId },
  );
  return built.summary;
}

registerJob('privacy.dsr_export', async (ctx) => {
  const requestId = String(ctx.job.input.requestId);
  const userId =
    ctx.job.created_by ??
    (
      await ctx.tx((tx) =>
        tx.maybe<{ created_by: string | null }>('SELECT created_by FROM app.dsr_requests WHERE id = $1', [
          requestId,
        ]),
      )
    )?.created_by;
  if (!userId) return { skipped: true };
  const summary = await generateAccessExport(ctx.deps, ctx.tenantId, requestId, userId, `job:${ctx.job.id}`);
  return summary ? { requestId, ...summary } : { skipped: true };
});

registerJob('privacy.company_export', async (ctx) => {
  const exportId = String(ctx.job.input.exportId);
  await ctx.tx((tx) =>
    tx.exec(`UPDATE app.company_exports SET status = 'running' WHERE id = $1`, [exportId]),
  );
  const r = await buildCompanyExport(ctx, exportId);
  await ctx.tx(async (tx) => {
    await tx.exec(
      `UPDATE app.company_exports SET status = 'ready', file_key = $2, size_bytes = $3, sha256 = $4, manifest = $5, completed_at = now() WHERE id = $1`,
      [
        exportId,
        r.key,
        r.size,
        r.sha256,
        JSON.stringify({
          ...r.manifest,
          tables: r.manifest.tables.map((x) => ({ table: x.table, rows: x.rows })),
        }),
      ],
    );
    await writeAudit(tx, {
      actorType: 'system',
      actorId: ctx.job.created_by,
      action: 'privacy.company_export_generated',
      targetType: 'company_export',
      targetId: exportId,
      diff: { tables: r.manifest.tables.length, files: r.manifest.files.count, bytes: r.size },
    });
    if (ctx.job.created_by)
      await notify(tx, {
        userIds: [ctx.job.created_by],
        kind: 'privacy.export',
        titleKey: 'notify.companyExportReady',
        link: '/app/privacy/exports',
        dedupeKey: `company-export:${exportId}`,
      });
  });
  return { exportId, bytes: r.size, tables: r.manifest.tables.length, files: r.manifest.files.count };
});

registerJob('privacy.closure_purge', async (ctx) => {
  const r = await purgeTenant(ctx.deps, ctx.tenantId, String(ctx.job.input.closureId));
  return r.skipped ? { skipped: r.skipped } : { sha256: r.sha256, completedAt: r.certificate!.completedAt };
});

registerJob('privacy.retention', async (ctx) => {
  const book = await bookFor(ctx.deps);
  const vault = new Vault(ctx.deps.keys);
  const date = String(ctx.job.input.date);
  const files: string[] = [];
  const lines = await ctx.tx(async (tx) => {
    const principal = ctx.job.created_by
      ? await loadPrincipal(tx, ctx.job.created_by, 'system')
      : { userId: '00000000-0000-0000-0000-000000000000', grants: [], kind: 'system' as const };
    const out = await runRetention(tx, {
      book,
      today: date,
      dryRun: false,
      vault,
      actor: { principal, actorType: 'system', requestId: `job:${ctx.job.id}` },
      deleteFiles: (k) => files.push(...k),
    });
    await logRun(tx, out, {
      trigger: ctx.job.input.trigger === 'manual' ? 'manual' : 'schedule',
      dryRun: false,
      jobId: ctx.job.id,
    });
    await writeAudit(tx, {
      actorType: 'system',
      actorId: ctx.job.created_by,
      action: 'privacy.retention_applied',
      diff: { lines: out.length, rows: out.reduce((a, l) => a + (l.action === 'retain' ? 0 : l.rows), 0) },
    });
    return out;
  });
  for (const k of files) await ctx.deps.objects.delete(k).catch(() => undefined);
  return {
    date,
    rows: lines.reduce((a, l) => a + (l.action === 'retain' ? 0 : l.rows), 0),
    files: files.length,
  };
});

/** Daily reminders: DSR deadlines, closure countdown and DPA re-acceptance. Idempotent through dedupe keys. */
registerJob('privacy.reminders', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    let sent = 0;
    const admins = await privacyAdmins(tx);
    const open = await tx.query<DsrRow>(
      `SELECT * FROM app.dsr_requests WHERE status IN ('received', 'in_progress')`,
    );
    for (const r of open) {
      const due = effectiveDue(r);
      if (!due) continue;
      const left = daysBetween(date, due);
      const recipients = [...new Set([...admins, ...(r.created_by ? [r.created_by] : [])])];
      if (left < 0)
        sent += (
          await notify(tx, {
            userIds: recipients,
            kind: 'privacy.dsr',
            titleKey: 'notify.dsrOverdue',
            params: { date: due },
            link: `/app/privacy?request=${r.id}`,
            dedupeKey: `dsr:${r.id}:overdue:${due}`,
          })
        ).length;
      else if (LEGAL.dsrReminderDaysBefore.includes(left))
        sent += (
          await notify(tx, {
            userIds: recipients,
            kind: 'privacy.dsr',
            titleKey: 'notify.dsrDue',
            params: { days: left, count: left, date: due },
            link: `/app/privacy?request=${r.id}`,
            dedupeKey: `dsr:${r.id}:${due}:${left}`,
          })
        ).length;
    }
    const closure = await tx.maybe<{ id: string; purge_after: string }>(
      `SELECT id, purge_after FROM app.account_closures WHERE status = 'scheduled'`,
    );
    if (closure) {
      const left = daysBetween(date, instantToDate(closure.purge_after, 'UTC'));
      if (left === 7 || left === 1)
        sent += (
          await notify(tx, {
            userIds: admins,
            kind: 'privacy.closure',
            titleKey: 'notify.closureReminder',
            params: { days: left, count: left },
            link: '/app/privacy/exports',
            dedupeKey: `closure:${closure.id}:${left}`,
          })
        ).length;
    }
    const region = await homeRegion(tx);
    const current = TRUST.dpa[templateForRegion(region)].version;
    if (!(await tx.maybe(`SELECT 1 FROM app.dpa_acceptances WHERE dpa_version = $1`, [current]))) {
      sent += (
        await notify(tx, {
          userIds: await usersWithRole(tx, 'owner'),
          kind: 'privacy.dpa',
          titleKey: 'notify.dpaReaccept',
          params: { version: current },
          link: '/app/privacy/legal',
          dedupeKey: `dpa:${current}`,
        })
      ).length;
    }
    return { date, sent };
  });
});

/** Hourly: breach-notification deadline reminders for open personal data breaches. */
registerJob('privacy.incident_reminders', async (ctx) => {
  const at = String(ctx.job.input.at);
  return ctx.tx(async (tx) => {
    let sent = 0;
    const admins = await privacyAdmins(tx);
    const rows = await tx.query<IncidentRow>(
      `SELECT * FROM app.incidents WHERE status <> 'closed' AND personal_data_breach`,
    );
    for (const r of rows) {
      for (const d of r.deadlines) {
        if (!d.dueAt || !d.required || r.notifications[`${d.jurisdiction}:${d.audience}`]) continue;
        const hoursLeft = Math.floor(minutesBetween(at, d.dueAt) / 60);
        const within = LEGAL.incidentReminderHoursBefore.filter((h) => hoursLeft <= h);
        const threshold = hoursLeft < 0 ? 'overdue' : within.length ? Math.min(...within) : undefined;
        if (threshold === undefined) continue;
        sent += (
          await notify(tx, {
            userIds: admins,
            kind: 'privacy.incident',
            titleKey: threshold === 'overdue' ? 'notify.incidentOverdue' : 'notify.incidentDeadline',
            params: {
              title: r.title,
              jurisdiction: d.jurisdiction,
              hours: Math.max(0, hoursLeft),
              count: Math.max(0, hoursLeft),
            },
            link: '/app/privacy/incidents',
            dedupeKey: `incident:${r.id}:${d.jurisdiction}:${d.audience}:${threshold}`,
          })
        ).length;
      }
    }
    return { at, sent };
  });
});

/** Sub-processor change notices to subscribed administrators (once per change, region-filtered). */
registerJob('privacy.subprocessor_notices', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    const region = await homeRegion(tx);
    const subscribers = (
      await tx.query<{ user_id: string }>(
        `SELECT s.user_id FROM app.subprocessor_subscriptions s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id WHERE u.status = 'active'`,
      )
    ).map((r) => r.user_id);
    let sent = 0;
    for (const c of TRUST.subprocessors.changes) {
      if (c.type === 'baseline' || !c.regions.includes(region) || compareDates(c.announced, date) > 0)
        continue;
      sent += (
        await notify(tx, {
          userIds: subscribers,
          kind: 'privacy.subprocessors',
          titleKey: 'notify.subprocessorChange',
          params: { change: c.change, date: c.effectiveFrom },
          link: '/app/privacy/legal',
          dedupeKey: `subprocessor:${c.id}`,
        })
      ).length;
    }
    return { date, sent };
  });
});

periodic.push(async (tx, now) => {
  const date = instantToDate(now.toISOString(), 'UTC');
  await enqueueJob(tx, 'privacy.reminders', date, { date });
  await enqueueJob(tx, 'privacy.subprocessor_notices', date, { date });
  await enqueueJob(tx, 'privacy.incident_reminders', now.toISOString().slice(0, 13), {
    at: `${now.toISOString().slice(0, 13)}:00:00Z`,
  });
  if (await tx.maybe(`SELECT 1 FROM app.retention_policies WHERE enabled`))
    await enqueueJob(tx, 'privacy.retention', `schedule:${date}`, { trigger: 'schedule', date });
  // Closure purge is enqueued with run_after at scheduling time; this re-enqueue covers a lost job.
  const due = await tx.maybe<{ id: string }>(
    `SELECT id FROM app.account_closures WHERE status = 'scheduled' AND purge_after <= $1`,
    [now.toISOString()],
  );
  if (due) await enqueueJob(tx, 'privacy.closure_purge', due.id, { closureId: due.id });
});
