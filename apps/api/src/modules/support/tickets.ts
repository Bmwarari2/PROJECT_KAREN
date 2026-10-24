import type { FastifyInstance, FastifyRequest } from 'fastify';
import { matchesMagic } from '../../lib/file-types';
import multipart from '@fastify/multipart';
import { Type, type Static } from 'typebox';
import {
  contactChannels,
  planById,
  PRIORITIES,
  type ContactChannel,
  type Priority,
} from '@thapsus/core/billing';
import type { HomeRegion } from '@thapsus/core';
import { articlesForContext, helpArticle, helpArticles, searchHelp } from '@thapsus/core/help';
import { helpReaderFor } from './help-reader';
import { can } from '@thapsus/core/permissions';
import type { TenantRouter } from '@thapsus/db';
import { authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { activeContract, billingConfig } from '../billing/service';
import {
  ATTACHMENT_TYPES,
  CATEGORIES,
  MAX_ATTACHMENT_BYTES,
  deadlinesFor,
  lastAuthorOf,
  newReference,
  slaView,
  supportPlanId,
  syncQueueEntry,
  type TicketRow,
} from './service';
import './jobs';

/** Newest back-office override of the contact channels (per region and plan), if any. */
export async function contactOverrides(
  router: TenantRouter,
): Promise<Partial<Record<HomeRegion, Record<string, ContactChannel[]>>> | null> {
  const { rows } = await router
    .registryPool()
    .query<{ value: Partial<Record<HomeRegion, Record<string, ContactChannel[]>>> }>(
      `SELECT value FROM backoffice.settings_versions WHERE key = 'support.contact_channels' ORDER BY created_at DESC LIMIT 1`,
    );
  return rows[0]?.value ?? null;
}

const SlaT = Type.Object({
  firstResponse: Type.Object({ dueAt: Type.String(), state: Type.String() }),
  resolution: Type.Object({ dueAt: Type.String(), state: Type.String() }),
  flag: Type.String(),
});
export const TicketT = Type.Object({
  id: Uuid,
  reference: Type.String(),
  subject: Type.String(),
  category: Type.String(),
  priority: Type.String(),
  status: Type.String(),
  planId: Type.String(),
  requesterUserId: Uuid,
  requesterName: Nullable(Type.String()),
  contextPath: Nullable(Type.String()),
  sla: SlaT,
  createdAt: Type.String(),
  lastActivityAt: Type.String(),
});
export const ThreadT = Type.Object({
  ticket: TicketT,
  messages: Type.Array(
    Type.Object({
      id: Uuid,
      authorType: Type.String(),
      authorName: Nullable(Type.String()),
      body: Type.String(),
      createdAt: Type.String(),
    }),
  ),
  attachments: Type.Array(
    Type.Object({
      id: Uuid,
      messageId: Nullable(Uuid),
      fileName: Type.String(),
      contentType: Type.String(),
      sizeBytes: Type.Integer(),
      createdAt: Type.String(),
    }),
  ),
});

export function ticketJson(t: TicketRow & { requester_name?: string | null }, now: string) {
  return {
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    planId: t.plan_id,
    requesterUserId: t.requester_user_id,
    requesterName: t.requester_name ?? null,
    contextPath: t.context_path,
    sla: slaView(t, now),
    createdAt: t.created_at,
    lastActivityAt: t.last_activity_at,
  };
}

export async function threadJson(
  tx: import('@thapsus/db').Tx,
  t: TicketRow & { requester_name?: string | null },
  now: string,
) {
  const messages = await tx.query<{
    id: string;
    author_type: string;
    display_name: string | null;
    body: string;
    created_at: string;
  }>(
    `SELECT m.id, m.author_type, u.display_name, m.body, m.created_at FROM app.support_ticket_messages m LEFT JOIN app.users u ON u.tenant_id = m.tenant_id AND u.id = m.author_user_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
    [t.id],
  );
  const attachments = await tx.query<{
    id: string;
    message_id: string | null;
    file_name: string;
    content_type: string;
    size_bytes: string;
    created_at: string;
  }>(
    'SELECT id, message_id, file_name, content_type, size_bytes, created_at FROM app.support_ticket_attachments WHERE ticket_id = $1 ORDER BY created_at',
    [t.id],
  );
  return {
    ticket: ticketJson(t, now),
    messages: messages.map((m) => ({
      id: m.id,
      authorType: m.author_type,
      authorName: m.author_type === 'user' ? m.display_name : null,
      body: m.body,
      createdAt: m.created_at,
    })),
    attachments: attachments.map((a) => ({
      id: a.id,
      messageId: a.message_id,
      fileName: a.file_name,
      contentType: a.content_type,
      sizeBytes: Number(a.size_bytes),
      createdAt: a.created_at,
    })),
  };
}

const TICKET_SELECT = `SELECT t.*, u.display_name AS requester_name FROM app.support_tickets t JOIN app.users u ON u.tenant_id = t.tenant_id AND u.id = t.requester_user_id`;

/** Help centre and customer support tickets (admins see all tenant tickets, employees their own). */
export async function supportTicketRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const now = () => deps.now().toISOString();
  const isSupportAdmin = (req: FastifyRequest) => can(requireAuth(req).principal, 'support.manage');

  // ---- help centre ------------------------------------------------------------------------------------
  const Article = Type.Object({
    slug: Type.String(),
    version: Type.Integer(),
    updatedOn: Type.String(),
    contexts: Type.Array(Type.String()),
    title: Type.String(),
    summary: Type.String(),
    body: Type.Array(Type.String()),
  });
  app.get(
    '/v1/help/articles',
    {
      schema: {
        tags: ['support'],
        summary: 'Help centre articles: search (q), contextual (context = app path) or all',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          context: Type.Optional(Type.String({ maxLength: 300, pattern: '^/app' })),
        }),
        response: { 200: Type.Array(Article), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'help.read');
      // only articles about features the reader can see, on for the workspace, in its countries (ADR-0190)
      const reader = await app.tenantTx(req, (tx) => helpReaderFor(tx, auth.principal), { readOnly: true });
      const q = req.query as { q?: string; context?: string };
      const locale = req.ctx.locale;
      if (q.q?.trim()) return searchHelp(q.q, locale, 10, reader);
      if (q.context) return articlesForContext(q.context, locale, reader);
      return helpArticles(locale, reader);
    },
  );
  app.get(
    '/v1/help/articles/:slug',
    {
      schema: {
        tags: ['support'],
        params: Type.Object({ slug: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }) }),
        response: { 200: Article, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'help.read');
      // an article that is not for this reader is not found, like one that does not exist
      const reader = await app.tenantTx(req, (tx) => helpReaderFor(tx, auth.principal), { readOnly: true });
      const a = helpArticle((req.params as { slug: string }).slug, req.ctx.locale, reader);
      if (!a) throw new ApiError('notFound');
      return a;
    },
  );

  // ---- contact channels and SLA targets for the tenant's plan and region ---------------------------------
  app.get(
    '/v1/support/contact',
    {
      schema: {
        tags: ['support'],
        response: {
          200: Type.Object({
            planId: Type.String(),
            region: Type.String(),
            coverage: Type.String(),
            hours: Nullable(
              Type.Object({
                timeZone: Type.String(),
                days: Type.Array(Type.Integer()),
                start: Type.String(),
                end: Type.String(),
              }),
            ),
            channels: Type.Array(
              Type.Object({
                kind: Type.String(),
                value: Type.Optional(Nullable(Type.String())),
                hours: Type.Optional(Type.String()),
              }),
            ),
            sla: Type.Record(
              Type.String(),
              Type.Object({ firstResponseMinutes: Type.Integer(), resolutionMinutes: Type.Integer() }),
            ),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'support.ticket');
      const cfg = billingConfig();
      const contract = await activeContract(deps.router, auth.tenantId);
      const planId = await app.tenantTx(req, (tx) => supportPlanId(tx, cfg, contract), { readOnly: true });
      const plan = planById(cfg, planId) ?? planById(cfg, cfg.trial.planId)!;
      return {
        planId: plan.id,
        region: deps.config.cell,
        coverage: plan.support.coverage,
        hours: plan.support.coverage === 'always' ? null : cfg.support.hours[deps.config.cell],
        channels: contactChannels(
          cfg,
          plan.id,
          deps.config.cell,
          deps.config.domain,
          await contactOverrides(deps.router),
        ),
        sla: plan.support.sla,
      };
    },
  );

  // ---- tickets ---------------------------------------------------------------------------------------
  app.get(
    '/v1/support/tickets',
    {
      schema: {
        tags: ['support'],
        querystring: Type.Object({
          scope: Type.Optional(Type.Union([Type.Literal('mine'), Type.Literal('all')])),
          status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed')])),
        }),
        response: { 200: Type.Array(TicketT), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'support.ticket');
      const q = req.query as { scope?: 'mine' | 'all'; status?: 'open' | 'closed' };
      const all = q.scope === 'all';
      if (all && !isSupportAdmin(req)) throw new ApiError('forbidden');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<TicketRow & { requester_name: string }>(
            `${TICKET_SELECT} WHERE ($1 OR t.requester_user_id = $2) AND ($3::text IS NULL OR ($3 = 'open' AND t.status IN ('open', 'awaiting_customer')) OR ($3 = 'closed' AND t.status IN ('resolved', 'closed')))
              ORDER BY t.last_activity_at DESC LIMIT 200`,
            [all, auth.userId, q.status ?? null],
          ),
        { readOnly: true },
      );
      return rows.map((r) => ticketJson(r, now()));
    },
  );

  const NewTicket = Type.Object({
    subject: Type.String({ minLength: 3, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 20000 }),
    category: Type.Union(CATEGORIES.map((c) => Type.Literal(c))),
    priority: Type.Union(PRIORITIES.map((p) => Type.Literal(p))),
    contextPath: Type.Optional(Nullable(Type.String({ maxLength: 300, pattern: '^/app' }))),
  });
  app.post(
    '/v1/support/tickets',
    {
      config: { selfAudited: true, capability: 'help.support' },
      schema: {
        tags: ['support'],
        summary: 'Raise a support ticket (stored in the home region; SLA targets from the plan)',
        body: NewTicket,
        response: { 201: TicketT, 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'support.ticket');
      const b = req.body as Static<typeof NewTicket>;
      // Urgent (service unusable for the company) is reserved for admins.
      if (b.priority === 'urgent' && !isSupportAdmin(req))
        throw new ApiError('forbidden', 'Only admins can raise urgent tickets');
      const cfg = billingConfig();
      const contract = await activeContract(deps.router, auth.tenantId);
      const at = now();
      const row = await app.tenantTx(req, async (tx) => {
        const planId = await supportPlanId(tx, cfg, contract);
        const d = deadlinesFor(cfg, planId, b.priority as Priority, deps.config.cell, at);
        const t = await tx.one<TicketRow>(
          `INSERT INTO app.support_tickets (tenant_id, reference, requester_user_id, subject, category, priority, plan_id, context_path, first_response_due_at, first_response_at_risk_at, resolution_due_at, resolution_at_risk_at, last_activity_at, created_at)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING *`,
          [
            newReference(),
            auth.userId,
            b.subject,
            b.category,
            b.priority,
            planId,
            b.contextPath ?? null,
            d.firstResponseDueAt,
            d.firstResponseAtRiskAt,
            d.resolutionDueAt,
            d.resolutionAtRiskAt,
            at,
          ],
        );
        await tx.exec(
          `INSERT INTO app.support_ticket_messages (tenant_id, ticket_id, author_type, author_user_id, body, created_at) VALUES (app.current_tenant(), $1, 'user', $2, $3, $4)`,
          [t.id, auth.userId, b.body, at],
        );
        // Audit records the change, not the ticket text.
        await app.audit(tx, req, {
          action: 'support_ticket.created',
          targetType: 'support_ticket',
          targetId: t.id,
          diff: { reference: t.reference, category: b.category, priority: b.priority, planId },
        });
        return { ...t, requester_name: auth.user.displayName };
      });
      await syncQueueEntry(deps.router, auth.tenantId, row, 'user');
      return reply.status(201).send(ticketJson(row, at));
    },
  );

  async function loadOwnOrAdmin(req: FastifyRequest, tx: import('@thapsus/db').Tx, id: string) {
    const auth = requireAuth(req);
    const t = await tx.maybe<TicketRow & { requester_name: string }>(`${TICKET_SELECT} WHERE t.id = $1`, [
      id,
    ]);
    if (!t || (t.requester_user_id !== auth.userId && !isSupportAdmin(req))) throw new ApiError('notFound');
    return t;
  }

  app.get(
    '/v1/support/tickets/:id',
    {
      schema: {
        tags: ['support'],
        params: Type.Object({ id: Uuid }),
        response: { 200: ThreadT, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'support.ticket');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => threadJson(tx, await loadOwnOrAdmin(req, tx, id), now()), {
        readOnly: true,
      });
    },
  );

  app.post(
    '/v1/support/tickets/:id/messages',
    {
      config: { selfAudited: true, capability: 'help.support' },
      schema: {
        tags: ['support'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 20000 }) }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'support.ticket');
      const { id } = req.params as { id: string };
      const at = now();
      const { msg, t } = await app.tenantTx(req, async (tx) => {
        const cur = await loadOwnOrAdmin(req, tx, id);
        if (cur.status === 'closed') throw new ApiError('conflict', 'This ticket is closed; raise a new one');
        const m = await tx.one<{ id: string }>(
          `INSERT INTO app.support_ticket_messages (tenant_id, ticket_id, author_type, author_user_id, body, created_at) VALUES (app.current_tenant(), $1, 'user', $2, $3, $4) RETURNING id`,
          [id, auth.userId, (req.body as { body: string }).body, at],
        );
        // A customer reply re-opens a ticket that was waiting for them or marked resolved.
        const updated = await tx.one<TicketRow>(
          `UPDATE app.support_tickets SET status = 'open', resolved_at = NULL, last_activity_at = $2 WHERE id = $1 RETURNING *`,
          [id, at],
        );
        await app.audit(tx, req, {
          action: 'support_ticket.replied',
          targetType: 'support_ticket',
          targetId: id,
          diff: { messageId: m.id, reopened: cur.status !== 'open' },
        });
        return { msg: m, t: updated };
      });
      await syncQueueEntry(deps.router, auth.tenantId, t, 'user');
      return reply.status(201).send(msg);
    },
  );

  app.post(
    '/v1/support/tickets/:id/close',
    {
      config: { selfAudited: true, capability: 'help.support' },
      schema: {
        tags: ['support'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'support.ticket');
      const { id } = req.params as { id: string };
      const at = now();
      const t = await app.tenantTx(req, async (tx) => {
        await loadOwnOrAdmin(req, tx, id);
        const u = await tx.one<TicketRow>(
          `UPDATE app.support_tickets SET status = 'closed', closed_at = $2, resolved_at = coalesce(resolved_at, $2), last_activity_at = $2 WHERE id = $1 RETURNING *`,
          [id, at],
        );
        await app.audit(tx, req, {
          action: 'support_ticket.closed',
          targetType: 'support_ticket',
          targetId: id,
        });
        return { u, last: await lastAuthorOf(tx, id) };
      });
      await syncQueueEntry(deps.router, auth.tenantId, t.u, t.last);
      return reply.status(204).send(null);
    },
  );

  // ---- attachments (home-region object store; served by short-lived presigned URLs) ----------------------
  await app.register(async (sub) => {
    await sub.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
    sub.post(
      '/v1/support/tickets/:id/attachments',
      {
        config: { selfAudited: true, capability: 'help.support' },
        schema: {
          tags: ['support'],
          consumes: ['multipart/form-data'],
          params: Type.Object({ id: Uuid }),
          response: {
            201: Type.Object({ id: Uuid }),
            400: Problem,
            403: Problem,
            404: Problem,
            413: Problem,
          },
        },
      },
      async (req, reply) => {
        const auth = authorizeSome(req, 'support.ticket');
        const { id } = req.params as { id: string };
        const file = await req.file();
        if (!file || !ATTACHMENT_TYPES.has(file.mimetype))
          throw new ApiError('validation', 'Attach a PNG, JPEG, PDF, text or CSV file');
        const buf = await file.toBuffer();
        if (!matchesMagic(file.mimetype, buf))
          throw new ApiError('validation', 'The file content does not match its type');
        if (file.file.truncated || buf.length > MAX_ATTACHMENT_BYTES)
          throw new ApiError('validation', 'File too large');
        if (!buf.length) throw new ApiError('validation', 'Empty file');
        const name = file.filename.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200) || 'attachment';
        const out = await app.tenantTx(req, async (tx) => {
          const t = await loadOwnOrAdmin(req, tx, id);
          const count = await tx.one<{ n: number }>(
            'SELECT count(*)::int AS n FROM app.support_ticket_attachments WHERE ticket_id = $1',
            [id],
          );
          if (count.n >= 20) throw new ApiError('validation', 'Too many attachments on this ticket');
          const key = objectKey(auth.tenantId, `support/${t.id}`);
          await deps.objects.put(key, buf, file.mimetype);
          const a = await tx.one<{ id: string }>(
            `INSERT INTO app.support_ticket_attachments (tenant_id, ticket_id, object_key, file_name, content_type, size_bytes, uploaded_by_type, uploaded_by_user_id) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, 'user', $6) RETURNING id`,
            [id, key, name, file.mimetype, buf.length, auth.userId],
          );
          await tx.exec('UPDATE app.support_tickets SET last_activity_at = $2 WHERE id = $1', [id, now()]);
          await app.audit(tx, req, {
            action: 'support_ticket.attachment_added',
            targetType: 'support_ticket',
            targetId: id,
            diff: { attachmentId: a.id, contentType: file.mimetype, sizeBytes: buf.length },
          });
          return a;
        });
        return reply.status(201).send(out);
      },
    );
  });

  app.get(
    '/v1/support/tickets/:id/attachments/:attachmentId',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['support'],
        params: Type.Object({ id: Uuid, attachmentId: Uuid }),
        response: { 200: Type.Object({ url: Type.String() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'support.ticket');
      const { id, attachmentId } = req.params as { id: string; attachmentId: string };
      return app.tenantTx(req, async (tx) => {
        await loadOwnOrAdmin(req, tx, id);
        const a = await tx.maybe<{ object_key: string; file_name: string }>(
          'SELECT object_key, file_name FROM app.support_ticket_attachments WHERE id = $1 AND ticket_id = $2',
          [attachmentId, id],
        );
        if (!a) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'support_ticket.attachment_downloaded',
          targetType: 'support_ticket',
          targetId: id,
          diff: { attachmentId },
        });
        return { url: await deps.objects.presignGet(a.object_key, a.file_name) };
      });
    },
  );
}
