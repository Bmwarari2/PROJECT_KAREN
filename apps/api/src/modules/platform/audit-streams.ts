import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { REGIONS } from '@thapsus/core';
import { enqueueJob, featureEnabled, type JobContext, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { decodeCursor, encodeCursor, Nullable, Page, Problem, Uuid } from '../../http/schemas';
import { requireFeature } from '../../lib/features';
import { open, seal, type Envelope } from '../../lib/kms';
import { assertSafeUrl, OutboundBlockedError, postOutbound, STRICT_OUTBOUND } from '../../lib/outbound';
import { newSigningSecret, signatureHeader } from '../../lib/signing';
import { newToken } from '../auth/tokens';
import { periodic, registerJob } from '../../jobs/registry';
import { platformConfig } from './config';
import { AUDIT_STREAM_ROLE_PREFIX, crossAccountS3FromEnv, isAuditStreamRoleArn } from './siem-s3';
import { urlOrigin } from './webhooks';

/**
 * Audit log streaming to customer SIEMs (brief §6.10): an incremental cursor over SEALED audit rows
 * (audit.seal_pending runs first, so every streamed event carries its chain hash), customer filters,
 * idempotent batches (same range → same batch id and, for S3, the same object key), and a delivery log.
 * Sensitive events are streamed without their diff (the change is recorded, never the value).
 */
const ACTOR_TYPES = ['user', 'support', 'system', 'api_client', 'scim'] as const;
const Filters = Type.Object(
  {
    actions: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9_.]+$' }), {
        maxItems: 50,
        description: 'Action prefixes, e.g. "auth." or "employee.changed"',
      }),
    ),
    sensitiveOnly: Type.Optional(Type.Boolean()),
    actorTypes: Type.Optional(
      Type.Array(Type.Union(ACTOR_TYPES.map((a) => Type.Literal(a))), { maxItems: 5, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);
type FiltersT = { actions?: string[]; sensitiveOnly?: boolean; actorTypes?: string[] };

export const AuditStream = Type.Object({
  id: Uuid,
  name: Type.String(),
  kind: Type.Union([Type.Literal('https'), Type.Literal('s3')]),
  url: Nullable(Type.String()),
  s3: Nullable(
    Type.Object({
      bucket: Type.String(),
      prefix: Type.String(),
      region: Type.String(),
      roleArn: Type.String(),
      externalId: Type.String(),
    }),
  ),
  filters: Filters,
  cursorSeq: Type.String({ description: 'Last sealed audit sequence delivered' }),
  status: Type.Union([Type.Literal('active'), Type.Literal('paused')]),
  lastDeliveredAt: Nullable(Type.String()),
  lastError: Nullable(Type.String()),
  createdAt: Type.String(),
});
const Batch = Type.Object({
  id: Uuid,
  fromSeq: Type.String(),
  toSeq: Type.String(),
  eventCount: Type.Integer(),
  status: Type.Union(['pending', 'delivered', 'failed'].map((s) => Type.Literal(s))),
  attempts: Type.Integer(),
  responseStatus: Nullable(Type.Integer()),
  durationMs: Nullable(Type.Integer()),
  objectKey: Nullable(Type.String()),
  error: Nullable(Type.String()),
  createdAt: Type.String(),
  deliveredAt: Nullable(Type.String()),
});

interface StreamRow {
  id: string;
  name: string;
  kind: 'https' | 's3';
  config: {
    url?: string;
    bucket?: string;
    prefix?: string;
    region?: string;
    roleArn?: string;
    externalId?: string;
  };
  secret: Envelope | null;
  filters: FiltersT;
  cursor_seq: string;
  status: 'active' | 'paused';
  last_delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}
const streamOut = (r: StreamRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.kind === 'https' ? r.config.url! : null,
  s3:
    r.kind === 's3'
      ? {
          bucket: r.config.bucket!,
          prefix: r.config.prefix ?? '',
          region: r.config.region!,
          roleArn: r.config.roleArn!,
          externalId: r.config.externalId!,
        }
      : null,
  filters: r.filters,
  cursorSeq: String(r.cursor_seq),
  status: r.status,
  lastDeliveredAt: r.last_delivered_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});
interface BatchRow {
  id: string;
  from_seq: string;
  to_seq: string;
  event_count: number;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  response_status: number | null;
  duration_ms: number | null;
  object_key: string | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}
const batchOut = (b: BatchRow) => ({
  id: b.id,
  fromSeq: String(b.from_seq),
  toSeq: String(b.to_seq),
  eventCount: b.event_count,
  status: b.status,
  attempts: b.attempts,
  responseStatus: b.response_status,
  durationMs: b.duration_ms,
  objectKey: b.object_key,
  error: b.error,
  createdAt: b.created_at,
  deliveredAt: b.delivered_at,
});

const secretContext = (tenantId: string, streamId: string) => ({
  tenant: tenantId,
  purpose: 'audit-stream-secret',
  stream: streamId,
});
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const BUCKET = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

interface AuditRow {
  id: string;
  seq: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  diff: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  sensitive: boolean;
  hash: string;
}
export function streamEvent(r: AuditRow) {
  return {
    id: r.id,
    seq: String(r.seq),
    at: r.at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    diff: r.sensitive ? null : r.diff,
    ip: r.ip,
    userAgent: r.user_agent,
    requestId: r.request_id,
    sensitive: r.sensitive,
    hash: r.hash,
  };
}
export function matchesFilters(
  r: Pick<AuditRow, 'action' | 'sensitive' | 'actor_type'>,
  f: FiltersT,
): boolean {
  if (f.sensitiveOnly && !r.sensitive) return false;
  if (f.actorTypes?.length && !f.actorTypes.includes(r.actor_type)) return false;
  if (f.actions?.length && !f.actions.some((a) => r.action === a || r.action.startsWith(a))) return false;
  return true;
}

function s3Key(prefix: string, fromSeq: string, toSeq: string, firstAt: string) {
  const d = firstAt.slice(0, 10).split('-');
  const pad = (s: string) => s.padStart(12, '0');
  return `${prefix}${d[0]}/${d[1]}/${d[2]}/${pad(fromSeq)}-${pad(toSeq)}.ndjson`;
}

/** Delivers at most one batch. Returns whether it made progress (so the job can continue). */
async function syncOnce(
  ctx: JobContext<Deps>,
  streamId: string,
): Promise<'delivered' | 'skipped' | 'idle' | 'failed'> {
  const cfg = platformConfig.auditStreams;
  const prepared = await ctx.tx(async (tx) => {
    await tx.query('SELECT audit.seal_pending(5000)');
    const s = await tx.maybe<StreamRow>('SELECT * FROM app.audit_streams WHERE id = $1', [streamId]);
    if (!s || s.status !== 'active') return undefined;
    const from = BigInt(s.cursor_seq) + 1n;
    const existing = await tx.maybe<BatchRow>(
      `SELECT * FROM app.audit_stream_batches WHERE stream_id = $1 AND from_seq = $2 AND status <> 'delivered'`,
      [streamId, String(from)],
    );
    const rows = await tx.query<AuditRow>(
      `SELECT id, seq, at, actor_type, actor_id, action, target_type, target_id, diff, host(ip) AS ip, user_agent, request_id, sensitive, encode(hash, 'hex') AS hash
         FROM audit.events WHERE seq >= $1 ${existing ? 'AND seq <= $2' : ''} AND seq IS NOT NULL ORDER BY seq LIMIT ${cfg.batchSize}`,
      existing ? [String(from), existing.to_seq] : [String(from)],
    );
    if (!rows.length) return { stream: s, idle: true as const };
    const toSeq = existing?.to_seq ?? rows.at(-1)!.seq;
    const events = rows.filter((r) => matchesFilters(r, s.filters)).map(streamEvent);
    if (!events.length) {
      await tx.exec('UPDATE app.audit_streams SET cursor_seq = greatest(cursor_seq, $2) WHERE id = $1', [
        streamId,
        toSeq,
      ]);
      return { stream: s, skipped: true as const };
    }
    const batch =
      existing ??
      (await tx.one<BatchRow>(
        `INSERT INTO app.audit_stream_batches (tenant_id, stream_id, from_seq, to_seq, event_count, object_key)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, stream_id, from_seq) DO UPDATE SET event_count = EXCLUDED.event_count RETURNING *`,
        [
          streamId,
          String(from),
          toSeq,
          events.length,
          s.kind === 's3' ? s3Key(s.config.prefix ?? '', String(from), String(toSeq), events[0]!.at) : null,
        ],
      ));
    return { stream: s, batch, events };
  });
  if (!prepared) return 'idle';
  if ('idle' in prepared) return 'idle';
  if ('skipped' in prepared) return 'skipped';
  const { stream, batch, events } = prepared;
  const started = performance.now();
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    if (stream.kind === 'https') {
      const body = JSON.stringify({
        streamId: stream.id,
        batchId: batch.id,
        fromSeq: String(batch.from_seq),
        toSeq: String(batch.to_seq),
        count: events.length,
        events,
      });
      const secret = await open(ctx.deps.keys, stream.secret!, secretContext(ctx.tenantId, stream.id));
      const res = await postOutbound(
        stream.config.url!,
        body,
        {
          'content-type': 'application/json',
          'user-agent': 'Thapsus-HR-Audit-Stream/1.0',
          'thapsus-signature': signatureHeader([secret], body, Math.floor(ctx.deps.now().getTime() / 1000)),
          'thapsus-batch-id': batch.id,
          'idempotency-key': batch.id,
        },
        { policy: ctx.deps.outbound, timeoutMs: cfg.timeoutMs },
      );
      responseStatus = res.status;
      if (res.status < 200 || res.status >= 300) error = `http_${res.status}`;
    } else {
      const s3 = ctx.deps.siemS3 ?? crossAccountS3FromEnv(ctx.deps.config.cell);
      await s3.put({
        region: stream.config.region!,
        roleArn: stream.config.roleArn!,
        externalId: stream.config.externalId!,
        bucket: stream.config.bucket!,
        key: batch.object_key!,
        body: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        contentType: 'application/x-ndjson',
        sessionName: `thapsus-audit-${stream.id.slice(0, 8)}`,
      });
      responseStatus = 200;
    }
  } catch (err) {
    error = (
      (err as Error).name === 'ResidencyViolationError'
        ? 'region_not_allowed'
        : (err as Error).message || 'delivery_failed'
    ).slice(0, 100);
  }
  const durationMs = Math.round(performance.now() - started);
  await ctx.tx(async (tx) => {
    await tx.exec(
      `UPDATE app.audit_stream_batches SET status = $2, attempts = attempts + 1, response_status = $3, duration_ms = $4, error = $5,
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END WHERE id = $1`,
      [batch.id, error ? 'failed' : 'delivered', responseStatus, durationMs, error],
    );
    if (error)
      await tx.exec('UPDATE app.audit_streams SET last_error = $2 WHERE id = $1', [stream.id, error]);
    else
      await tx.exec(
        'UPDATE app.audit_streams SET cursor_seq = greatest(cursor_seq, $2), last_delivered_at = now(), last_error = NULL WHERE id = $1',
        [stream.id, batch.to_seq],
      );
  });
  return error ? 'failed' : 'delivered';
}

registerJob('audit_streams.sync', async (ctx) => {
  const streamId = String(ctx.job.input.streamId);
  let delivered = 0;
  for (let i = 0; i < 50; i++) {
    const r = await syncOnce(ctx, streamId);
    if (r === 'delivered') delivered++;
    if (r === 'idle' || r === 'failed') return { delivered, last: r };
  }
  return { delivered, last: 'more' };
});

// Near-real-time: at most one sync per stream per minute while the tenant is active, and at least one
// per worker sweep (5 minutes) otherwise.
periodic.push(async (tx, now) => {
  const streams = await tx.query<{ id: string }>(`SELECT id FROM app.audit_streams WHERE status = 'active'`);
  if (!streams.length || !(await featureEnabled(tx, 'auditStreaming'))) return;
  const slot = Math.floor(now.getTime() / 60_000);
  for (const s of streams) await enqueueJob(tx, 'audit_streams.sync', `${s.id}:${slot}`, { streamId: s.id });
});

export async function auditStreamRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const homeAws = REGIONS[deps.config.cell].awsRegion;
  const guard = async (tx: Tx, req: Parameters<typeof authorize>[0], action = 'settings.manage') => {
    const auth = authorize(req, action);
    await requireFeature(tx, 'auditStreaming');
    return auth;
  };

  app.get(
    '/v1/settings/audit-streams',
    {
      schema: {
        tags: ['audit-streams'],
        summary: 'List SIEM audit streams',
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
        }),
        response: { 200: Page(AuditStream), 403: Problem },
      },
    },
    async (req) => {
      const q = req.query as { cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const after = decodeCursor<[string, string]>(q.cursor);
      const rows = await app.tenantTx(req, async (tx) => {
        await guard(tx, req, 'audit.read');
        return tx.query<StreamRow>(
          `SELECT * FROM app.audit_streams ${after ? 'WHERE (created_at, id) < ($1::timestamptz, $2::uuid)' : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
          after ?? [],
        );
      });
      const page = rows.slice(0, limit);
      return {
        data: page.map(streamOut),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null,
      };
    },
  );

  app.post(
    '/v1/settings/audit-streams',
    {
      config: { selfAudited: true, capability: 'settings.streams' },
      schema: {
        tags: ['audit-streams'],
        summary:
          'Stream the audit log to a SIEM: a signed HTTPS endpoint, or an S3 bucket in your home region via a cross-account role',
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 120 }),
            kind: Type.Union([Type.Literal('https'), Type.Literal('s3')]),
            url: Type.Optional(Type.String({ maxLength: 2048 })),
            bucket: Type.Optional(Type.String({ maxLength: 63 })),
            prefix: Type.Optional(Type.String({ maxLength: 200, pattern: "^[A-Za-z0-9!_.*'()/-]*$" })),
            region: Type.Optional(Type.String({ maxLength: 30 })),
            roleArn: Type.Optional(
              Type.String({
                maxLength: 600,
                description: `S3 streams: the IAM role in your account; its name must start with ${AUDIT_STREAM_ROLE_PREFIX}`,
              }),
            ),
            filters: Type.Optional(Filters),
            startFrom: Type.Optional(
              Type.Union([Type.Literal('now'), Type.Literal('beginning')], {
                description: 'Stream only new events (default) or back-fill the whole sealed log',
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            ...AuditStream.properties,
            secret: Nullable(
              Type.String({ description: 'HTTPS streams: whsec_… signing secret, shown once' }),
            ),
          }),
          400: Problem,
          403: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        name: string;
        kind: 'https' | 's3';
        url?: string;
        bucket?: string;
        prefix?: string;
        region?: string;
        roleArn?: string;
        filters?: FiltersT;
        startFrom?: 'now' | 'beginning';
      };
      let config: StreamRow['config'];
      if (b.kind === 'https') {
        if (!b.url) throw new ApiError('validation', 'url is required');
        try {
          assertSafeUrl(b.url, deps.outbound ?? STRICT_OUTBOUND);
        } catch (err) {
          if (err instanceof OutboundBlockedError)
            throw new ApiError('unprocessable', 'unsafeUrl', { reason: err.reason });
          throw err;
        }
        config = { url: b.url };
      } else {
        if (!b.bucket || !BUCKET.test(b.bucket)) throw new ApiError('validation', 'bucket is required');
        if (!b.roleArn || !ROLE_ARN.test(b.roleArn))
          throw new ApiError('validation', 'roleArn must be an IAM role ARN');
        // The cell worker may assume only customer roles named thapsus-hr-audit-* (IAM policy in the cell stack, ADR-0069).
        if (!isAuditStreamRoleArn(b.roleArn))
          throw new ApiError('unprocessable', 'roleNotAllowed', { rolePrefix: AUDIT_STREAM_ROLE_PREFIX });
        // Residency: the bucket must be in the tenant's home region (the guarded AWS factory refuses any other).
        if ((b.region ?? homeAws) !== homeAws)
          throw new ApiError('unprocessable', 'regionNotAllowed', { region: b.region, allowed: [homeAws] });
        config = {
          bucket: b.bucket,
          prefix: b.prefix ?? '',
          region: homeAws,
          roleArn: b.roleArn,
          externalId: `thapsus-${newToken(18)}`,
        };
      }
      const out = await app.tenantTx(req, async (tx) => {
        const auth = await guard(tx, req);
        const id = crypto.randomUUID();
        const secret = b.kind === 'https' ? newSigningSecret() : null;
        const envelope = secret ? await seal(deps.keys, secret, secretContext(auth.tenantId, id)) : null;
        await tx.query('SELECT audit.seal_pending(5000)');
        const cursor =
          b.startFrom === 'beginning'
            ? '0'
            : ((await tx.maybe<{ seq: string }>('SELECT seq FROM audit.chain_heads'))?.seq ?? '0');
        const row = await tx.one<StreamRow>(
          `INSERT INTO app.audit_streams (tenant_id, id, name, kind, config, secret, filters, cursor_seq, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            id,
            b.name,
            b.kind,
            JSON.stringify(config),
            envelope ? JSON.stringify(envelope) : null,
            JSON.stringify(b.filters ?? {}),
            cursor,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'audit_stream.created',
          targetType: 'audit_stream',
          targetId: id,
          diff: {
            kind: b.kind,
            destination: b.kind === 'https' ? urlOrigin(b.url!) : `s3://${b.bucket}`,
            filters: b.filters ?? {},
            startFrom: b.startFrom ?? 'now',
          },
        });
        return { row, secret };
      });
      return reply.status(201).send({ ...streamOut(out.row), secret: out.secret });
    },
  );

  app.patch(
    '/v1/settings/audit-streams/:id',
    {
      config: { selfAudited: true, capability: 'settings.streams' },
      schema: {
        tags: ['audit-streams'],
        summary: 'Rename, re-filter, pause or resume a stream',
        params: Type.Object({ id: Uuid }),
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            filters: Type.Optional(Filters),
            status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])),
          },
          { additionalProperties: false },
        ),
        response: { 200: AuditStream, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as { name?: string; filters?: FiltersT; status?: string };
      return app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        const row = await tx.maybe<StreamRow>(
          'UPDATE app.audit_streams SET name = coalesce($2, name), filters = coalesce($3, filters), status = coalesce($4, status) WHERE id = $1 RETURNING *',
          [id, b.name ?? null, b.filters ? JSON.stringify(b.filters) : null, b.status ?? null],
        );
        if (!row) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'audit_stream.updated',
          targetType: 'audit_stream',
          targetId: id,
          diff: b,
        });
        return streamOut(row);
      });
    },
  );

  app.delete(
    '/v1/settings/audit-streams/:id',
    {
      config: { selfAudited: true, capability: 'settings.streams' },
      schema: {
        tags: ['audit-streams'],
        summary: 'Delete a stream and its delivery log',
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        if (!(await tx.exec('DELETE FROM app.audit_streams WHERE id = $1', [id])))
          throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'audit_stream.deleted',
          targetType: 'audit_stream',
          targetId: id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/settings/audit-streams/:id/sync',
    {
      config: { selfAudited: true, capability: 'settings.streams' },
      schema: {
        tags: ['audit-streams'],
        summary: 'Deliver pending audit events now instead of waiting for the next sweep',
        params: Type.Object({ id: Uuid }),
        response: { 202: Type.Object({ jobId: Uuid }), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const job = await app.tenantTx(req, async (tx) => {
        await guard(tx, req);
        if (!(await tx.maybe('SELECT 1 FROM app.audit_streams WHERE id = $1', [id])))
          throw new ApiError('notFound');
        const j = await enqueueJob(
          tx,
          'audit_streams.sync',
          `${id}:manual:${req.id}`,
          { streamId: id },
          { createdBy: req.auth!.userId },
        );
        await app.audit(tx, req, {
          action: 'audit_stream.sync_requested',
          targetType: 'audit_stream',
          targetId: id,
        });
        return j;
      });
      return reply.status(202).send({ jobId: job.id });
    },
  );

  app.get(
    '/v1/settings/audit-streams/:id/batches',
    {
      schema: {
        tags: ['audit-streams'],
        summary: 'Delivery log for a stream (newest first)',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Page(Batch), 403: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const after = decodeCursor<[string, string]>(q.cursor);
      const rows = await app.tenantTx(req, async (tx) => {
        await guard(tx, req, 'audit.read');
        if (!(await tx.maybe('SELECT 1 FROM app.audit_streams WHERE id = $1', [id])))
          throw new ApiError('notFound');
        return tx.query<BatchRow>(
          `SELECT * FROM app.audit_stream_batches WHERE stream_id = $1 ${after ? 'AND (created_at, id) < ($2::timestamptz, $3::uuid)' : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
          after ? [id, ...after] : [id],
        );
      });
      const page = rows.slice(0, limit);
      return {
        data: page.map(batchOut),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null,
      };
    },
  );
}
