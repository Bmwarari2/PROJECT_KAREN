import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can, fieldAccess } from '@thapsus/core/permissions';
import { isLocale, t, type Locale } from '@thapsus/core/i18n';
import { isTargetType, notificationHref } from '@thapsus/core/links';
import { isValidTimeZone, today } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, decodeCursor, encodeCursor, Nullable, Problem, Uuid } from '../../http/schemas';
import { expandPrefs, NOTIFICATION_CATEGORIES, type NotificationPrefs } from '../../lib/notification-prefs';
import { usersWithRole } from '../../lib/notify';
import { approvalHandlers, requestApproval } from '../approvals/service';
import { FIELDS } from '../employees/model';
import { applyEmployeeChange, employeeAsOf, filterFields, loadTarget } from '../employees/service';
import { balanceFor, leaveContext, policyFor } from '../leave/service';
import { ruleBook } from '../rules/routes';

/**
 * Employee self-service (BUILD_BRIEF 6.8; PROGRESS 7.4): the "Me" hub summary, own details with change
 * requests through the approval flow, in-app notifications and notification preferences (email / web push).
 * Everything here is the caller's own data; leave, rota, clock, documents, tasks and payslips keep their own
 * modules and endpoints, which the hub links to.
 */
/** Personal facts an employee cannot edit directly; changes go to HR for approval (subject employee.self_change). */
export const REQUESTABLE_FIELDS = ['legalFirstName', 'legalLastName', 'dateOfBirth', 'nationality'] as const;

approvalHandlers['employee.self_change'] = async (tx, r) => {
  const { reason: _reason, ...change } = r.payload as Record<string, unknown> & { effectiveDate: string };
  void _reason;
  await applyEmployeeChange(tx, r.subject_employee_id!, change as never, r.requested_by, 'employee.changed');
};

async function ensureSelfChangePolicy(tx: Tx) {
  const has = await tx.maybe(
    `SELECT 1 FROM app.approval_policies WHERE subject = 'employee.self_change' AND enabled LIMIT 1`,
  );
  if (has) return;
  // HR decides; small companies without an HR admin fall back to the owner (as absence alerts do)
  const role = (await usersWithRole(tx, 'hr_admin')).length ? 'hr_admin' : 'owner';
  await tx.exec(
    `INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), 'employee.self_change', 'Personal details change', $1)`,
    [JSON.stringify([{ approver: { type: 'role', value: role } }])],
  );
}

export async function essRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const zoneOf = (req: FastifyRequest) => {
    const z = req.auth?.user.timeZone;
    return z && isValidTimeZone(z) ? z : 'UTC';
  };
  const localeOf = (req: FastifyRequest): Locale =>
    isLocale(req.auth?.user.locale) ? (req.auth!.user.locale as Locale) : req.ctx.locale;

  // ---- hub summary -------------------------------------------------------------------------------------------
  const Summary = Type.Object({
    employee: Nullable(
      Type.Object({ id: Uuid, displayName: Type.String(), jobTitle: Nullable(Type.String()) }),
    ),
    leave: Nullable(
      Type.Object({
        available: Nullable(Type.String()),
        unit: Nullable(Type.String()),
        pending: Type.Integer(),
        next: Nullable(Type.Object({ start: Type.String(), end: Type.String() })),
      }),
    ),
    rota: Nullable(
      Type.Object({
        nextShift: Nullable(
          Type.Object({ date: Type.String(), start: Type.String(), end: Type.String(), zone: Type.String() }),
        ),
        pendingSwaps: Type.Integer(),
      }),
    ),
    clock: Nullable(Type.Object({ clockedIn: Type.Boolean(), since: Nullable(Type.String()) })),
    documents: Type.Object({ toSign: Type.Integer() }),
    tasks: Type.Object({ open: Type.Integer(), overdue: Type.Integer() }),
    notifications: Type.Object({ unread: Type.Integer() }),
    payslips: Nullable(
      Type.Object({
        total: Type.Integer(),
        unviewed: Type.Integer(),
        latest: Nullable(Type.Object({ label: Type.String(), payDate: Nullable(Type.String()) })),
      }),
    ),
    changeRequests: Type.Object({ pending: Type.Integer() }),
  });

  app.get(
    '/v1/me/summary',
    {
      schema: {
        tags: ['me'],
        summary:
          'Self-service hub: my leave, next shift, clock status, documents to sign, tasks, notifications and payslips',
        response: { 200: Summary },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const me = auth.principal.employeeId;
      const date = today(zoneOf(req));
      const now = deps.now().toISOString();
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const n = async (sql: string, params: unknown[]) => (await tx.one<{ n: number }>(sql, params)).n;
          const out: Record<string, unknown> = {
            employee: null,
            leave: null,
            rota: null,
            clock: null,
            payslips: null,
            documents: {
              toSign: me
                ? await n(
                    `SELECT count(*)::int AS n FROM app.signature_requests WHERE signer_employee_id = $1 AND status = 'pending'`,
                    [me],
                  )
                : 0,
            },
            tasks: {
              open: await n(
                `SELECT count(*)::int AS n FROM app.tasks WHERE assignee_user_id = $1 AND status = 'open'`,
                [auth.userId],
              ),
              overdue: await n(
                `SELECT count(*)::int AS n FROM app.tasks WHERE assignee_user_id = $1 AND status = 'open' AND due_on < $2`,
                [auth.userId, date],
              ),
            },
            notifications: {
              unread: await n(
                `SELECT count(*)::int AS n FROM app.notifications WHERE user_id = $1 AND read_at IS NULL`,
                [auth.userId],
              ),
            },
            changeRequests: {
              pending: await n(
                `SELECT count(*)::int AS n FROM app.approval_requests WHERE requested_by = $1 AND status = 'pending' AND subject IN ('employee.self_change', 'employee.change')`,
                [auth.userId],
              ),
            },
          };
          if (!me) return out;
          const e = await tx.maybe<{ id: string; display_name: string; job_title: string | null }>(
            'SELECT id, display_name, job_title FROM app.employees WHERE id = $1',
            [me],
          );
          if (!e) return out;
          out.employee = { id: e.id, displayName: e.display_name, jobTitle: e.job_title };
          if (can(auth.principal, 'leave.request', { employeeId: me })) {
            const annual = await tx.maybe<{ id: string }>(
              `SELECT id FROM app.leave_types WHERE category = 'annual' AND active ORDER BY key LIMIT 1`,
            );
            let available: string | null = null;
            let unit: string | null = null;
            if (annual) {
              const lc = await leaveContext(tx, me, date);
              const policy = await policyFor(tx, lc, annual.id, date);
              const b = policy ? await balanceFor(tx, book, me, annual.id, date) : undefined;
              if (b && policy) {
                available = b.available.toFixed(policy.config.unit === 'hours' ? 2 : 1);
                unit = policy.config.unit;
              }
            }
            const next = await tx.maybe<{ start_date: string; end_date: string }>(
              `SELECT start_date, end_date FROM app.leave_requests WHERE employee_id = $1 AND status = 'approved' AND end_date >= $2 ORDER BY start_date LIMIT 1`,
              [me, date],
            );
            out.leave = {
              available,
              unit,
              pending: await n(
                `SELECT count(*)::int AS n FROM app.leave_requests WHERE employee_id = $1 AND status = 'pending'`,
                [me],
              ),
              next: next ? { start: next.start_date, end: next.end_date } : null,
            };
          }
          if (can(auth.principal, 'rota.view_own', { employeeId: me })) {
            const s = await tx.maybe<{
              shift_date: string;
              start_local: string;
              end_local: string;
              zone: string;
            }>(
              `SELECT shift_date, start_local, end_local, zone FROM app.shifts WHERE employee_id = $1 AND status = 'published' AND ends_at > $2 ORDER BY starts_at LIMIT 1`,
              [me, now],
            );
            out.rota = {
              nextShift: s
                ? { date: s.shift_date, start: s.start_local, end: s.end_local, zone: s.zone }
                : null,
              pendingSwaps: await n(
                `SELECT count(*)::int AS n FROM app.shift_swaps WHERE (from_employee_id = $1 OR to_employee_id = $1) AND status = 'pending'`,
                [me],
              ),
            };
          }
          if (can(auth.principal, 'time.clock', { employeeId: me })) {
            const last = await tx.maybe<{ kind: string; occurred_at: string }>(
              `SELECT kind, occurred_at FROM app.clock_events WHERE employee_id = $1 AND occurred_at <= $2 ORDER BY occurred_at DESC LIMIT 1`,
              [me, now],
            );
            out.clock = {
              clockedIn: !!last && last.kind !== 'out',
              since: last && last.kind !== 'out' ? last.occurred_at : null,
            };
          }
          if (can(auth.principal, 'payslips.read_own', { employeeId: me })) {
            const p = await tx.one<{ total: number; unviewed: number }>(
              `SELECT count(*)::int AS total, count(*) FILTER (WHERE first_viewed_at IS NULL)::int AS unviewed FROM app.payslips WHERE employee_id = $1 AND status = 'published'`,
              [me],
            );
            const latest = await tx.maybe<{ label: string; pay_date: string | null }>(
              `SELECT b.label, b.pay_date FROM app.payslips p JOIN app.payslip_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id WHERE p.employee_id = $1 AND p.status = 'published' ORDER BY coalesce(b.pay_date, p.published_at::date) DESC, p.published_at DESC LIMIT 1`,
              [me],
            );
            out.payslips = {
              total: p.total,
              unviewed: p.unviewed,
              latest: latest ? { label: latest.label, payDate: latest.pay_date } : null,
            };
          }
          return out;
        },
        { readOnly: true },
      );
    },
  );

  // ---- own details ---------------------------------------------------------------------------------------------
  app.get(
    '/v1/me/profile',
    {
      schema: {
        tags: ['me'],
        summary:
          'My own record (field-filtered as for the employee API) and which fields I can change or request',
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({
            employee: Type.Object({ id: Uuid }, { additionalProperties: true }),
            asOf: Type.String(),
            access: Type.Record(Type.String(), Type.String()),
            requestable: Type.Array(Type.String()),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const me = auth.principal.employeeId;
      if (!me) throw new ApiError('notFound', 'Your account is not linked to an employee record');
      const asOf = (req.query as { asOf?: string }).asOf ?? today(zoneOf(req));
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, me);
          if (!can(auth.principal, 'self.read', target)) throw new ApiError('forbidden');
          const view = filterFields(auth.principal, await employeeAsOf(tx, me, asOf), target);
          const access: Record<string, string> = {};
          for (const k of Object.keys(FIELDS))
            access[k] = fieldAccess(auth.principal, 'employee', FIELDS[k]!.perm, target);
          access.emergencyContacts = fieldAccess(auth.principal, 'employee', 'emergencyContacts', target);
          return {
            employee: view,
            asOf,
            access,
            requestable: REQUESTABLE_FIELDS.filter((f) => access[f] !== 'write'),
          };
        },
        { readOnly: true },
      );
    },
  );

  const ChangeBody = Type.Object(
    {
      effectiveDate: Type.Optional(CivilDate),
      legalFirstName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      legalLastName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      dateOfBirth: Type.Optional(CivilDate),
      nationality: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    },
    { additionalProperties: false },
  );
  app.post(
    '/v1/me/change-requests',
    {
      config: { selfAudited: true, capability: 'me.details.request' },
      schema: {
        tags: ['me'],
        summary: 'Ask HR to change personal details I cannot edit myself (approval flow)',
        body: ChangeBody,
        response: {
          202: Type.Object({ approvalRequestId: Uuid, fields: Type.Array(Type.String()) }),
          400: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const me = auth.principal.employeeId;
      if (!me) throw new ApiError('notFound');
      const b = req.body as Record<string, string | undefined> & { effectiveDate?: string; reason?: string };
      const fields = REQUESTABLE_FIELDS.filter((f) => b[f] !== undefined);
      if (!fields.length) throw new ApiError('validation', 'Nothing to change');
      const id = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, me);
        if (!can(auth.principal, 'self.read', target)) throw new ApiError('forbidden');
        await ensureSelfChangePolicy(tx);
        const payload = {
          effectiveDate: b.effectiveDate ?? today(zoneOf(req)),
          ...Object.fromEntries(fields.map((f) => [f, b[f]])),
          ...(b.reason ? { reason: b.reason } : {}),
        };
        const requestId = await requestApproval(tx, 'employee.self_change', me, auth.userId, payload);
        if (!requestId) throw new ApiError('unprocessable', 'No approver is available');
        // values are personal data: the audit records which fields were requested, not their values
        await app.audit(tx, req, {
          action: 'employee.self_change_requested',
          targetType: 'employee',
          targetId: me,
          diff: { approvalRequestId: requestId, fields },
        });
        return requestId;
      });
      return reply.status(202).send({ approvalRequestId: id, fields });
    },
  );

  app.get(
    '/v1/me/change-requests',
    {
      schema: {
        tags: ['me'],
        summary: 'My requests to change my details and their status',
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              status: Type.String(),
              fields: Type.Array(Type.String()),
              effectiveDate: Nullable(Type.String()),
              createdAt: Type.String(),
              decidedAt: Nullable(Type.String()),
            }),
          ),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            status: string;
            payload: Record<string, unknown>;
            created_at: string;
            decided_at: string | null;
          }>(
            `SELECT id, status, payload, created_at, decided_at FROM app.approval_requests WHERE requested_by = $1 AND subject IN ('employee.self_change', 'employee.change') ORDER BY created_at DESC LIMIT 50`,
            [auth.userId],
          ),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        fields: Object.keys(r.payload).filter((k) => k in FIELDS),
        effectiveDate: typeof r.payload.effectiveDate === 'string' ? r.payload.effectiveDate : null,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
      }));
    },
  );

  // ---- notifications ---------------------------------------------------------------------------------------------
  const Note = Type.Object({
    id: Uuid,
    kind: Type.String(),
    category: Type.String(),
    title: Type.String(),
    link: Nullable(Type.String()),
    /** What the notification is about (ADR-0160); null for older notifications. */
    target: Nullable(Type.Object({ type: Type.String(), id: Uuid })),
    /** The page it opens: the target's page, else its stored link, else the list page for its kind. */
    href: Type.String(),
    createdAt: Type.String(),
    read: Type.Boolean(),
  });
  app.get(
    '/v1/me/notifications',
    {
      schema: {
        tags: ['me'],
        summary: 'My in-app notifications (newest first, keyset-paginated)',
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
          unread: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({
            data: Type.Array(Note),
            unread: Type.Integer(),
            nextCursor: Nullable(Type.String()),
          }),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { cursor?: string; limit?: number; unread?: boolean };
      const limit = q.limit ?? 30;
      const after = decodeCursor<[string, string]>(q.cursor);
      const locale = localeOf(req);
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [auth.userId];
          let where = 'user_id = $1';
          if (q.unread) where += ' AND read_at IS NULL';
          if (after) {
            params.push(after[0], after[1]);
            where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
          }
          const rows = await tx.query<{
            id: string;
            kind: string;
            title_key: string;
            params: Record<string, string>;
            link: string | null;
            target_type: string | null;
            target_id: string | null;
            dedupe_key: string | null;
            created_at: string;
            read_at: string | null;
          }>(
            `SELECT id, kind, title_key, params, link, target_type, target_id, dedupe_key, created_at, read_at FROM app.notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
            params,
          );
          const unread = (
            await tx.one<{ n: number }>(
              'SELECT count(*)::int AS n FROM app.notifications WHERE user_id = $1 AND read_at IS NULL',
              [auth.userId],
            )
          ).n;
          const page = rows.slice(0, limit);
          return {
            data: page.map((r) => ({
              id: r.id,
              kind: r.kind,
              category: r.kind.split('.')[0]!,
              title: t(locale, r.title_key, r.params),
              link: r.link,
              target:
                r.target_type && r.target_id && isTargetType(r.target_type)
                  ? { type: r.target_type, id: r.target_id }
                  : null,
              href: notificationHref({
                kind: r.kind,
                targetType: r.target_type,
                targetId: r.target_id,
                link: r.link,
                dedupeKey: r.dedupe_key,
              }),
              createdAt: r.created_at,
              read: !!r.read_at,
            })),
            unread,
            nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/me/notifications/read',
    {
      config: { selfAudited: true, capability: 'me.notifications' },
      schema: {
        tags: ['me'],
        summary: 'Mark notifications as read (some, or all)',
        body: Type.Object(
          { ids: Type.Optional(Type.Array(Uuid, { maxItems: 200 })), all: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ updated: Type.Integer() }), 400: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const b = req.body as { ids?: string[]; all?: boolean };
      if (!b.all && !b.ids?.length) throw new ApiError('validation');
      return app.tenantTx(req, async (tx) => {
        const updated = b.all
          ? await tx.exec(
              'UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
              [auth.userId],
            )
          : await tx.exec(
              'UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])',
              [auth.userId, b.ids],
            );
        req.auditWritten = true; // reading one's own notifications is not an auditable change of business data
        return { updated };
      });
    },
  );

  const ChannelPrefs = Type.Object({ email: Type.Boolean(), push: Type.Boolean() });
  const Prefs = Type.Object({
    email: Type.Boolean(),
    push: Type.Boolean(),
    categories: Type.Record(Type.String(), ChannelPrefs),
  });
  app.get(
    '/v1/me/notification-preferences',
    {
      schema: {
        tags: ['me'],
        summary: 'Which notifications reach me by email and web push',
        response: {
          200: Type.Intersect([
            Prefs,
            Type.Object({ available: Type.Array(Type.String()), pushConfigured: Type.Boolean() }),
          ]),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const row = await app.tenantTx(
        req,
        (tx) =>
          tx.one<{ prefs: NotificationPrefs }>(
            'SELECT notification_prefs AS prefs FROM app.users WHERE id = $1',
            [auth.userId],
          ),
        { readOnly: true },
      );
      return {
        ...expandPrefs(row.prefs),
        available: [...NOTIFICATION_CATEGORIES],
        pushConfigured: !!deps.webPush,
      };
    },
  );

  app.put(
    '/v1/me/notification-preferences',
    {
      config: { selfAudited: true, capability: 'me.notifications' },
      schema: {
        tags: ['me'],
        body: Type.Object(
          {
            email: Type.Optional(Type.Boolean()),
            push: Type.Optional(Type.Boolean()),
            categories: Type.Optional(
              Type.Record(Type.String({ maxLength: 30 }), Type.Partial(ChannelPrefs)),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: Prefs, 400: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const b = req.body as NotificationPrefs;
      const unknown = Object.keys(b.categories ?? {}).filter(
        (c) => !(NOTIFICATION_CATEGORIES as readonly string[]).includes(c),
      );
      if (unknown.length) throw new ApiError('validation', `Unknown categories: ${unknown.join(', ')}`);
      return app.tenantTx(req, async (tx) => {
        const cur =
          (
            await tx.one<{ prefs: NotificationPrefs }>(
              'SELECT notification_prefs AS prefs FROM app.users WHERE id = $1',
              [auth.userId],
            )
          ).prefs ?? {};
        const categories = { ...(cur.categories ?? {}) };
        for (const [c, v] of Object.entries(b.categories ?? {}))
          categories[c] = { ...(categories[c] ?? {}), ...v };
        const next: NotificationPrefs = {
          ...cur,
          ...(b.email !== undefined ? { email: b.email } : {}),
          ...(b.push !== undefined ? { push: b.push } : {}),
          categories,
        };
        await tx.exec('UPDATE app.users SET notification_prefs = $2 WHERE id = $1', [
          auth.userId,
          JSON.stringify(next),
        ]);
        await app.audit(tx, req, {
          action: 'user.notification_preferences_updated',
          targetType: 'user',
          targetId: auth.userId,
          diff: next,
        });
        return expandPrefs(next);
      });
    },
  );
}
