import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { emitEvent, enqueueJob, featureEnabled, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { decodeCursor, encodeCursor, Nullable, Page, Problem, Uuid } from '../../http/schemas';
import { requireFeature } from '../../lib/features';
import { open, seal, type Envelope } from '../../lib/kms';
import { assertSafeUrl, OutboundBlockedError, postOutbound, STRICT_OUTBOUND } from '../../lib/outbound';
import { newSigningSecret, signatureHeader } from '../../lib/signing';
import { registerJob, subscribe } from '../../jobs/registry';
import { platformConfig, webhookRetryDelaySeconds } from './config';
import { isValidSubscription, subscriptionMatches, WEBHOOK_EVENT_TYPES } from './events';

/**
 * Webhooks (brief §6.10): per-tenant endpoints, HMAC-SHA256 signed payloads with secret rotation,
 * delivery driven by the transactional outbox (subscriber → idempotent delivery job per attempt),
 * exponential backoff up to a maximum, replay, and a delivery log. Destinations are configured by
 * the customer (controller) and called from the tenant's home region through the SSRF-guarded client.
 */
interface StoredSecret {
  id: string;
  envelope: Envelope;
  createdAt: string;
  expiresAt: string | null;
}
interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  event_types: string[];
  status: string;
  secrets: StoredSecret[];
  created_at: string;
  updated_at: string;
}

const SecretMeta = Type.Object({ id: Type.String(), createdAt: Type.String(), expiresAt: Nullable(Type.String()) });
export const WebhookEndpoint = Type.Object({
  id: Uuid,
  url: Type.String(),
  description: Nullable(Type.String()),
  eventTypes: Type.Array(Type.String()),
  status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
  secrets: Type.Array(SecretMeta, { description: 'Signing secrets (values are never shown again). Two are active during a rotation.' }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export const WebhookDelivery = Type.Object({
  id: Uuid,
  endpointId: Uuid,
  eventId: Type.String(),
  eventType: Type.String(),
  status: Type.Union(['pending', 'retrying', 'succeeded', 'failed'].map((s) => Type.Literal(s))),
  attempts: Type.Integer(),
  nextAttemptAt: Nullable(Type.String()),
  lastResponseStatus: Nullable(Type.Integer()),
  lastDurationMs: Nullable(Type.Integer()),
  lastError: Nullable(Type.String()),
  replayOf: Nullable(Type.String()),
  createdAt: Type.String(),
  deliveredAt: Nullable(Type.String()),
});
const Attempt = Type.Object({ attempt: Type.Integer(), at: Type.String(), responseStatus: Nullable(Type.Integer()), durationMs: Type.Integer(), error: Nullable(Type.String()) });

const endpointOut = (r: EndpointRow) => ({
  id: r.id,
  url: r.url,
  description: r.description,
  eventTypes: r.event_types,
  status: r.status as 'active' | 'disabled',
  secrets: r.secrets.map((s) => ({ id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt })),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_response_status: number | null;
  last_duration_ms: number | null;
  last_error: string | null;
  replay_of: string | null;
  created_at: string;
  delivered_at: string | null;
}
const deliveryOut = (r: DeliveryRow) => ({
  id: r.id,
  endpointId: r.endpoint_id,
  eventId: r.event_id,
  eventType: r.event_type,
  status: r.status as 'pending',
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastResponseStatus: r.last_response_status,
  lastDurationMs: r.last_duration_ms,
  lastError: r.last_error,
  replayOf: r.replay_of,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

const secretContext = (tenantId: string, endpointId: string, secretId: string) => ({ tenant: tenantId, purpose: 'webhook-secret', endpoint: endpointId, secret: secretId });

async function newSecret(deps: Deps, tenantId: string, endpointId: string, now: Date) {
  const value = newSigningSecret();
  const id = crypto.randomUUID();
  const envelope = await seal(deps.keys, value, secretContext(tenantId, endpointId, id));
  return { value, stored: { id, envelope, createdAt: now.toISOString(), expiresAt: null } satisfies StoredSecret };
}

export function activeSecrets(secrets: StoredSecret[], now: Date): StoredSecret[] {
  return secrets.filter((s) => !s.expiresAt || new Date(s.expiresAt) > now);
}

function validateUrl(deps: Deps, url: string) {
  try {
    assertSafeUrl(url, deps.outbound ?? STRICT_OUTBOUND);
  } catch (err) {
    if (err instanceof OutboundBlockedError) throw new ApiError('unprocessable', 'unsafeUrl', { reason: err.reason });
    throw err;
  }
}

/** Audit entries record only the destination origin: customer URLs may embed their own tokens. */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}

function validateEventTypes(types: string[]) {
  const bad = types.filter((t) => !isValidSubscription(t));
  if (bad.length) throw new ApiError('validation', 'unknownEventType', { eventTypes: bad });
}

// ---- Outbox subscriber → one delivery and one idempotent job per (endpoint, event) -----------------
subscribe('*', async (tx, ev) => {
  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(ev.topic)) return;
  if (!(await featureEnabled(tx, 'webhooks'))) return;
  const endpoints = await tx.query<{ id: string; event_types: string[] }>(`SELECT id, event_types FROM app.webhook_endpoints WHERE status = 'active'`);
  for (const ep of endpoints) {
    const wanted = ev.topic === 'webhook.ping' ? ev.payload.endpointId === ep.id : subscriptionMatches(ep.event_types, ev.topic);
    if (!wanted) continue;
    const payload = { id: `evt_${ev.id}`, type: ev.topic, createdAt: ev.createdAt, data: ev.payload };
    const d = await tx.maybe<{ id: string }>(
      `INSERT INTO app.webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, next_attempt_at)
       VALUES (app.current_tenant(), $1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, endpoint_id, event_id) WHERE replay_of IS NULL DO NOTHING RETURNING id`,
      [ep.id, payload.id, ev.topic, JSON.stringify(payload)],
    );
    if (d) await enqueueJob(tx, 'webhooks.deliver', `${d.id}:1`, { deliveryId: d.id, attempt: 1 });
  }
});

// ---- Delivery job: one HTTP attempt; schedules the next attempt itself (exponential backoff) ----------
registerJob('webhooks.deliver', async (ctx) => {
  const { deliveryId, attempt } = ctx.job.input as { deliveryId: string; attempt: number };
  const cfg = platformConfig.webhooks;
  const d = await ctx.tx((tx) =>
    tx.maybe<DeliveryRow & { payload: unknown; url: string; secrets: StoredSecret[]; endpoint_status: string }>(
      `SELECT d.*, e.url, e.secrets, e.status AS endpoint_status FROM app.webhook_deliveries d
         JOIN app.webhook_endpoints e ON e.tenant_id = d.tenant_id AND e.id = d.endpoint_id WHERE d.id = $1`,
      [deliveryId],
    ),
  );
  if (!d) return { skipped: 'missing' };
  if (d.status === 'succeeded' || d.status === 'failed' || d.attempts >= attempt) return { skipped: 'alreadyAttempted' };
  const now = ctx.deps.now();
  let responseStatus: number | null = null;
  let durationMs = 0;
  let error: string | null = null;
  if (d.endpoint_status !== 'active') error = 'endpoint_disabled';
  else {
    const secrets = await Promise.all(activeSecrets(d.secrets, now).map((s) => open(ctx.deps.keys, s.envelope, secretContext(ctx.tenantId, d.endpoint_id, s.id))));
    const body = JSON.stringify(d.payload);
    const started = performance.now();
    try {
      const res = await postOutbound(
        d.url,
        body,
        {
          'content-type': 'application/json',
          'user-agent': 'Thapsus-HR-Webhooks/1.0',
          'thapsus-signature': signatureHeader(secrets, body, Math.floor(now.getTime() / 1000)),
          'thapsus-event-id': d.event_id,
          'thapsus-event-type': d.event_type,
          'thapsus-delivery-id': d.id,
          'thapsus-delivery-attempt': String(attempt),
        },
        { policy: ctx.deps.outbound, timeoutMs: cfg.timeoutMs },
      );
      responseStatus = res.status;
      durationMs = res.durationMs;
      if (res.status < 200 || res.status >= 300) error = `http_${res.status}`;
    } catch (err) {
      durationMs = Math.round(performance.now() - started);
      error = (err as Error).message.slice(0, 100);
    }
  }
  const ok = error === null;
  const final = ok ? 'succeeded' : attempt >= cfg.maxAttempts || error === 'endpoint_disabled' ? 'failed' : 'retrying';
  const next = final === 'retrying' ? new Date(now.getTime() + webhookRetryDelaySeconds(attempt, cfg) * 1000) : null;
  await ctx.tx(async (tx) => {
    await tx.exec(
      `INSERT INTO app.webhook_attempts (tenant_id, delivery_id, attempt, at, response_status, duration_ms, error)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, delivery_id, attempt) DO NOTHING`,
      [d.id, attempt, now, responseStatus, durationMs, error],
    );
    await tx.exec(
      `UPDATE app.webhook_deliveries SET status = $2, attempts = $3, next_attempt_at = $4, last_response_status = $5, last_duration_ms = $6,
         last_error = $7, delivered_at = CASE WHEN $2 = 'succeeded' THEN $8::timestamptz ELSE delivered_at END WHERE id = $1`,
      [d.id, final, attempt, next, responseStatus, durationMs, error, now],
    );
    if (next) await enqueueJob(tx, 'webhooks.deliver', `${d.id}:${attempt + 1}`, { deliveryId: d.id, attempt: attempt + 1 }, { runAfter: next.toISOString() });
  });
  return { status: final, responseStatus };
});

export async function webhookRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const SELECT = 'SELECT id, url, description, event_types, status, secrets, created_at, updated_at FROM app.webhook_endpoints';

  const guard = async (tx: Tx, req: Parameters<typeof authorize>[0]) => {
    const auth = authorize(req, 'webhooks.manage');
    await requireFeature(tx, 'webhooks');
    return auth;
  };

  app.get('/v1/webhooks/event-types', { schema: { tags: ['webhooks'], summary: 'Event types an endpoint can subscribe to', response: { 200: Type.Array(Type.String()) } } }, async (req) => {
    authorize(req, 'webhooks.manage');
    return [...WEBHOOK_EVENT_TYPES];
  });

  app.get(
    '/v1/webhooks',
    { schema: { tags: ['webhooks'], summary: 'List webhook endpoints', querystring: Type.Object({ cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }), response: { 200: Page(WebhookEndpoint), 403: Problem } } },
    async (req) => {
      const q = req.query as { cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const after = decodeCursor<[string, string]>(q.cursor);
      const rows = await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        return tx.query<EndpointRow>(`${SELECT} ${after ? 'WHERE (created_at, id) < ($1::timestamptz, $2::uuid)' : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`, after ?? []);
      });
      const page = rows.slice(0, limit);
      return { data: page.map(endpointOut), nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null };
    },
  );

  app.post(
    '/v1/webhooks',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['webhooks'],
        summary: 'Create a webhook endpoint (https only); the signing secret is returned once',
        body: Type.Object({ url: Type.String({ maxLength: 2048 }), eventTypes: Type.Array(Type.String({ maxLength: 100 }), { minItems: 1, maxItems: 50, uniqueItems: true }), description: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false }),
        response: { 201: Type.Object({ ...WebhookEndpoint.properties, secret: Type.String({ description: 'whsec_… — store it now; it cannot be shown again' }) }), 400: Problem, 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as { url: string; eventTypes: string[]; description?: string };
      validateUrl(deps, b.url);
      validateEventTypes(b.eventTypes);
      const out = await app.tenantTx(req, async (tx) => {
        const auth = await guard(tx, req);
        const id = crypto.randomUUID();
        const s = await newSecret(deps, auth.tenantId, id, deps.now());
        const row = await tx.one<EndpointRow>(
          `INSERT INTO app.webhook_endpoints (tenant_id, id, url, description, event_types, secrets, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [id, b.url, b.description ?? null, b.eventTypes, JSON.stringify([s.stored]), auth.userId],
        );
        await app.audit(tx, req, { action: 'webhook.created', targetType: 'webhook_endpoint', targetId: id, diff: { destination: urlOrigin(b.url), eventTypes: b.eventTypes } });
        return { row, secret: s.value };
      });
      return reply.status(201).send({ ...endpointOut(out.row), secret: out.secret });
    },
  );

  app.patch(
    '/v1/webhooks/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['webhooks'],
        summary: 'Update an endpoint (URL, event types, description, or disable/enable it)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ url: Type.Optional(Type.String({ maxLength: 2048 })), eventTypes: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { minItems: 1, maxItems: 50, uniqueItems: true })), description: Type.Optional(Nullable(Type.String({ maxLength: 300 }))), status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('disabled')])) }, { additionalProperties: false }),
        response: { 200: WebhookEndpoint, 400: Problem, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as { url?: string; eventTypes?: string[]; description?: string | null; status?: string };
      if (b.url) validateUrl(deps, b.url);
      if (b.eventTypes) validateEventTypes(b.eventTypes);
      return app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        const row = await tx.maybe<EndpointRow>(
          `UPDATE app.webhook_endpoints SET url = coalesce($2, url), event_types = coalesce($3, event_types),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END, status = coalesce($6, status) WHERE id = $1 RETURNING *`,
          [id, b.url ?? null, b.eventTypes ?? null, 'description' in b, b.description ?? null, b.status ?? null],
        );
        if (!row) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'webhook.updated', targetType: 'webhook_endpoint', targetId: id, diff: { ...b, url: b.url ? urlOrigin(b.url) : undefined } });
        return endpointOut(row);
      });
    },
  );

  app.delete(
    '/v1/webhooks/:id',
    { config: { selfAudited: true }, schema: { tags: ['webhooks'], summary: 'Delete an endpoint and its delivery log', params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        if (!(await tx.exec('DELETE FROM app.webhook_endpoints WHERE id = $1', [id]))) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'webhook.deleted', targetType: 'webhook_endpoint', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/webhooks/:id/rotate-secret',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['webhooks'],
        summary: 'Rotate the signing secret; the old secret keeps signing (a second v1) for graceHours',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ graceHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 168 })) }),
        response: { 200: Type.Object({ ...WebhookEndpoint.properties, secret: Type.String() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const grace = (req.body as { graceHours?: number } | undefined)?.graceHours ?? platformConfig.webhooks.secretGraceHours;
      const now = deps.now();
      const out = await app.tenantTx(req, async (tx) => {
        const auth = await guard(tx, req);
        const ep = await tx.maybe<EndpointRow>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id]);
        if (!ep) throw new ApiError('notFound');
        const until = new Date(now.getTime() + grace * 3_600_000).toISOString();
        // keep only the newest still-active secret, now expiring after the grace period, plus the new one
        const kept = activeSecrets(ep.secrets, now)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, grace > 0 ? 1 : 0)
          .map((s) => ({ ...s, expiresAt: s.expiresAt && s.expiresAt < until ? s.expiresAt : until }));
        const s = await newSecret(deps, auth.tenantId, id, now);
        const row = await tx.one<EndpointRow>('UPDATE app.webhook_endpoints SET secrets = $2 WHERE id = $1 RETURNING *', [id, JSON.stringify([...kept, s.stored])]);
        await app.audit(tx, req, { action: 'webhook.secret_rotated', targetType: 'webhook_endpoint', targetId: id, diff: { graceHours: grace } });
        return { row, secret: s.value };
      });
      return { ...endpointOut(out.row), secret: out.secret };
    },
  );

  app.post(
    '/v1/webhooks/:id/ping',
    { config: { selfAudited: true }, schema: { tags: ['webhooks'], summary: 'Send a signed webhook.ping event to this endpoint', params: Type.Object({ id: Uuid }), response: { 202: Type.Object({ queued: Type.Boolean() }), 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        if (!(await tx.maybe('SELECT 1 FROM app.webhook_endpoints WHERE id = $1', [id]))) throw new ApiError('notFound');
        await emitEvent(tx, 'webhook.ping', { endpointId: id }, { type: 'webhook_endpoint', id });
        await app.audit(tx, req, { action: 'webhook.pinged', targetType: 'webhook_endpoint', targetId: id });
      });
      return reply.status(202).send({ queued: true });
    },
  );

  app.get(
    '/v1/webhooks/:id/deliveries',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Delivery log for an endpoint (newest first, cursor-paginated)',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ status: Type.Optional(Type.Union(['pending', 'retrying', 'succeeded', 'failed'].map((s) => Type.Literal(s)))), cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }),
        response: { 200: Page(WebhookDelivery), 403: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { status?: string; cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const params: unknown[] = [id];
      const where = ['endpoint_id = $1'];
      if (q.status) where.push(`status = $${params.push(q.status)}`);
      const after = decodeCursor<[string, string]>(q.cursor);
      if (after) where.push(`(created_at, id) < ($${params.push(after[0])}::timestamptz, $${params.push(after[1])}::uuid)`);
      const rows = await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        return tx.query<DeliveryRow>(`SELECT * FROM app.webhook_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`, params);
      });
      const page = rows.slice(0, limit);
      return { data: page.map(deliveryOut), nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null };
    },
  );

  app.get(
    '/v1/webhooks/deliveries/:deliveryId',
    { schema: { tags: ['webhooks'], summary: 'One delivery with every attempt (status code, duration, error class) and the signed payload', params: Type.Object({ deliveryId: Uuid }), response: { 200: Type.Object({ ...WebhookDelivery.properties, payload: Type.Any(), attemptLog: Type.Array(Attempt) }), 403: Problem, 404: Problem } } },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      return app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        const d = await tx.maybe<DeliveryRow & { payload: unknown }>('SELECT * FROM app.webhook_deliveries WHERE id = $1', [deliveryId]);
        if (!d) throw new ApiError('notFound');
        const attempts = await tx.query<{ attempt: number; at: string; response_status: number | null; duration_ms: number; error: string | null }>('SELECT attempt, at, response_status, duration_ms, error FROM app.webhook_attempts WHERE delivery_id = $1 ORDER BY attempt', [deliveryId]);
        return { ...deliveryOut(d), payload: d.payload, attemptLog: attempts.map((a) => ({ attempt: a.attempt, at: a.at, responseStatus: a.response_status, durationMs: a.duration_ms, error: a.error })) };
      });
    },
  );

  app.post(
    '/v1/webhooks/deliveries/:deliveryId/replay',
    { config: { selfAudited: true }, schema: { tags: ['webhooks'], summary: 'Replay a delivery (same event id and payload, new signature); receivers de-duplicate on Thapsus-Event-Id', params: Type.Object({ deliveryId: Uuid }), response: { 202: WebhookDelivery, 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const row = await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        const d = await tx.maybe<DeliveryRow>(
          `INSERT INTO app.webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, replay_of, next_attempt_at)
           SELECT tenant_id, endpoint_id, event_id, event_type, payload, id, now() FROM app.webhook_deliveries WHERE id = $1 RETURNING *`,
          [deliveryId],
        );
        if (!d) throw new ApiError('notFound');
        await enqueueJob(tx, 'webhooks.deliver', `${d.id}:1`, { deliveryId: d.id, attempt: 1 });
        await app.audit(tx, req, { action: 'webhook.delivery_replayed', targetType: 'webhook_delivery', targetId: d.id, diff: { replayOf: deliveryId, eventId: d.event_id } });
        return d;
      });
      return reply.status(202).send(deliveryOut(row));
    },
  );
}
