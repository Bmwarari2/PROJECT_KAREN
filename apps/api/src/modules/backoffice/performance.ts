import type { FastifyInstance } from 'fastify';
import { Type, type Static } from 'typebox';
import { addHistograms, histogramQuantile, HISTOGRAM_SIZE } from '@thapsus/core/metrics';
import type { Deps } from '../../deps';
import { registerCellTask } from '../../jobs/registry';
import { Nullable, Problem } from '../../http/schemas';
import { backofficePool, requireStaff } from './auth';

/**
 * Platform performance per cell (ADR-0176): request volume, server errors and latency by route group from
 * platform.request_metrics (written once a minute by each API process), the worker's queue sample and the
 * database size from platform.queue_metrics, the worker heartbeat and the status-page incidents. No tenant
 * ids and no personal data anywhere in it.
 */
export const METRICS_RETENTION_DAYS = 30;

/** Samples every database of the cell (counts and ages only) into the shared database, once a minute. */
export async function sampleQueues(deps: Pick<Deps, 'router'>, now: Date) {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  for (const key of Object.keys(deps.router.config.databases)) {
    const { rows } = await deps.router
      .pool(key)
      .query<Record<string, number | string | null>>('SELECT * FROM platform.queue_snapshot($1)', [
        now.toISOString(),
      ]);
    const s = rows[0]!;
    await deps.router.registryPool().query(
      `INSERT INTO platform.queue_metrics (at, db_key, outbox_pending, outbox_oldest_seconds, jobs_queued, jobs_due, jobs_oldest_due_seconds, jobs_running, jobs_failed_1h, jobs_failed_24h, database_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (at, db_key) DO NOTHING`,
      [
        minute,
        key,
        s.outbox_pending,
        s.outbox_oldest_seconds,
        s.jobs_queued,
        s.jobs_due,
        s.jobs_oldest_due_seconds,
        s.jobs_running,
        s.jobs_failed_1h,
        s.jobs_failed_24h,
        s.database_bytes,
      ],
    );
  }
}

/** Metrics older than the retention window are removed (they are operational counters, not customer data). */
export async function purgeOldMetrics(deps: Pick<Deps, 'router'>, now: Date) {
  const before = new Date(now.getTime() - METRICS_RETENTION_DAYS * 86_400_000).toISOString();
  const pool = deps.router.registryPool();
  await pool.query('DELETE FROM platform.request_metrics WHERE bucket_start < $1', [before]);
  await pool.query('DELETE FROM platform.queue_metrics WHERE at < $1', [before]);
}

registerCellTask({ name: 'platform.queue_sample', everyMs: 60_000, run: sampleQueues });
registerCellTask({ name: 'platform.metrics_retention', everyMs: 3_600_000, run: purgeOldMetrics });

const PerfQ = Type.Object({ window: Type.Optional(Type.Union([Type.Literal('24h'), Type.Literal('7d')])) });
const PointT = Type.Object({
  start: Type.String(),
  requests: Type.Integer(),
  errors5xx: Type.Integer(),
  p50Ms: Nullable(Type.Integer()),
  p95Ms: Nullable(Type.Integer()),
});
const QueueT = Type.Object({
  dbKey: Type.String(),
  at: Type.String(),
  outboxPending: Type.Integer(),
  outboxOldestSeconds: Nullable(Type.Integer()),
  jobsQueued: Type.Integer(),
  jobsDue: Type.Integer(),
  jobsOldestDueSeconds: Nullable(Type.Integer()),
  jobsRunning: Type.Integer(),
  jobsFailed1h: Type.Integer(),
  jobsFailed24h: Type.Integer(),
  databaseBytes: Type.Integer(),
});
export const PerformanceT = Type.Object({
  cell: Type.String(),
  window: Type.String(),
  generatedAt: Type.String(),
  bucket: Type.Union([Type.Literal('hour'), Type.Literal('day')]),
  totals: Type.Object({
    requests: Type.Integer(),
    errors5xx: Type.Integer(),
    errorRateBasisPoints: Nullable(Type.Integer()),
    p50Ms: Nullable(Type.Integer()),
    p95Ms: Nullable(Type.Integer()),
  }),
  series: Type.Array(PointT),
  routes: Type.Array(
    Type.Object({
      group: Type.String(),
      requests: Type.Integer(),
      errors5xx: Type.Integer(),
      errors4xx: Type.Integer(),
      p50Ms: Nullable(Type.Integer()),
      p95Ms: Nullable(Type.Integer()),
    }),
  ),
  queues: Type.Array(QueueT),
  queueSeries: Type.Array(
    Type.Object({
      start: Type.String(),
      outboxPending: Type.Integer(),
      jobsDue: Type.Integer(),
      jobsOldestDueSeconds: Nullable(Type.Integer()),
      jobsFailed: Type.Integer(),
    }),
  ),
  worker: Type.Object({ beatAt: Nullable(Type.String()) }),
  incidents: Type.Array(
    Type.Object({
      id: Type.String(),
      kind: Type.String(),
      impact: Type.String(),
      title: Type.String(),
      status: Type.String(),
      startedAt: Type.String(),
      resolvedAt: Nullable(Type.String()),
    }),
  ),
});

const bp = (part: number, whole: number) => (whole ? Math.round((part * 10000) / whole) : null);

export async function backofficePerformanceRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.get(
    '/v1/backoffice/performance',
    {
      config: { auth: 'public', selfAudited: true },
      // read-only operational counters: every permitted staff member, elevated or not
      preHandler: requireStaff(app, ['support', 'billing', 'security_analyst'], { noElevation: true }),
      schema: {
        tags: ['backoffice'],
        summary:
          "This cell's request volume, server errors and latency by route group, queue depth, database size and incidents",
        querystring: PerfQ,
        response: { 200: PerformanceT, 401: Problem, 403: Problem },
      },
    },
    async (req) => {
      const window = (req.query as Static<typeof PerfQ>).window ?? '24h';
      // this process's counters for the current minute, so the page is never a minute behind itself
      await app.requestMetrics?.flush(true).catch(() => undefined);
      const now = deps.now();
      const day = window === '7d';
      const unit = day ? 'day' : 'hour';
      const slots = day ? 7 : 24;
      const unitMs = day ? 86_400_000 : 3_600_000;
      const end = Math.floor(now.getTime() / unitMs) * unitMs + unitMs;
      const start = end - slots * unitMs;
      const from = new Date(start).toISOString();
      const pool = backofficePool(app);
      const [series, seriesHist, routes, routeHist, queues, queueSeries, beat, incidents] = await Promise.all(
        [
          pool.query<{ slot: string; requests: string; e5: string }>(
            `SELECT floor(extract(epoch FROM bucket_start) * 1000 / $2)::bigint::text AS slot, sum(requests)::text AS requests, sum(errors_5xx)::text AS e5
             FROM platform.request_metrics WHERE bucket_start >= $1 GROUP BY 1`,
            [from, unitMs],
          ),
          // histograms are summed element by element: one row per (slot, bucket position)
          pool.query<{ slot: string; i: number; n: string }>(
            `SELECT floor(extract(epoch FROM m.bucket_start) * 1000 / $2)::bigint::text AS slot, u.i::int AS i, sum(u.x)::text AS n
             FROM platform.request_metrics m CROSS JOIN LATERAL unnest(m.latency_buckets) WITH ORDINALITY AS u(x, i)
            WHERE m.bucket_start >= $1 GROUP BY 1, 2`,
            [from, unitMs],
          ),
          pool.query<{ grp: string; requests: string; e5: string; e4: string }>(
            `SELECT route_group AS grp, sum(requests)::text AS requests, sum(errors_5xx)::text AS e5, sum(errors_4xx)::text AS e4
             FROM platform.request_metrics WHERE bucket_start >= $1 GROUP BY 1`,
            [from],
          ),
          pool.query<{ grp: string; i: number; n: string }>(
            `SELECT m.route_group AS grp, u.i::int AS i, sum(u.x)::text AS n
             FROM platform.request_metrics m CROSS JOIN LATERAL unnest(m.latency_buckets) WITH ORDINALITY AS u(x, i)
            WHERE m.bucket_start >= $1 GROUP BY 1, 2`,
            [from],
          ),
          pool.query<Record<string, string | number | null>>(
            `SELECT DISTINCT ON (db_key) * FROM platform.queue_metrics WHERE at >= $1 ORDER BY db_key, at DESC`,
            [from],
          ),
          pool.query<{ slot: string; outbox: number; due: number; oldest: number | null; failed: number }>(
            `SELECT slot, max(outbox)::int AS outbox, max(due)::int AS due, max(oldest)::int AS oldest, max(failed)::int AS failed FROM (
             SELECT floor(extract(epoch FROM at) * 1000 / $2)::bigint::text AS slot, at, sum(outbox_pending) AS outbox, sum(jobs_due) AS due,
                    max(jobs_oldest_due_seconds) AS oldest, sum(jobs_failed_1h) AS failed
               FROM platform.queue_metrics WHERE at >= $1 GROUP BY 1, 2) s GROUP BY slot`,
            [from, unitMs],
          ),
          pool.query<{ beat_at: string | null }>(
            `SELECT beat_at FROM backoffice.service_heartbeats WHERE service = 'worker'`,
          ),
          pool.query<{
            id: string;
            kind: string;
            impact: string;
            title: string;
            status: string;
            started_at: string;
            resolved_at: string | null;
          }>(
            `SELECT id, kind, impact, title, status, started_at, resolved_at FROM backoffice.status_incidents
            WHERE resolved_at IS NULL OR resolved_at >= $1 OR started_at >= $1 ORDER BY started_at DESC LIMIT 50`,
            [from],
          ),
        ],
      );
      const histOf = <K extends string>(
        rows: Array<{ i: number; n: string } & Record<K, string>>,
        key: K,
      ) => {
        const out = new Map<string, number[]>();
        for (const r of rows) {
          const h = out.get(r[key]) ?? new Array<number>(HISTOGRAM_SIZE).fill(0);
          h[r.i - 1] = (h[r.i - 1] ?? 0) + Number(r.n);
          out.set(r[key], h);
        }
        return out;
      };
      const slotHist = histOf(seriesHist.rows, 'slot');
      const groupHist = histOf(routeHist.rows, 'grp');
      const bySlot = new Map(
        series.rows.map((r) => [Number(r.slot), { ...r, hist: slotHist.get(r.slot) ?? [] }]),
      );
      let total = 0;
      let total5 = 0;
      let totalHist = new Array<number>(HISTOGRAM_SIZE).fill(0);
      const points = Array.from({ length: slots }, (_, i) => {
        const slot = start / unitMs + i;
        const r = bySlot.get(slot);
        const requests = Number(r?.requests ?? 0);
        const e5 = Number(r?.e5 ?? 0);
        total += requests;
        total5 += e5;
        if (r) totalHist = addHistograms(totalHist, r.hist);
        return {
          start: new Date(slot * unitMs).toISOString(),
          requests,
          errors5xx: e5,
          p50Ms: r ? histogramQuantile(r.hist, 0.5) : null,
          p95Ms: r ? histogramQuantile(r.hist, 0.95) : null,
        };
      });
      const qBySlot = new Map(queueSeries.rows.map((r) => [Number(r.slot), r]));
      return {
        cell: deps.config.cell,
        window,
        generatedAt: now.toISOString(),
        bucket: unit,
        totals: {
          requests: total,
          errors5xx: total5,
          errorRateBasisPoints: bp(total5, total),
          p50Ms: histogramQuantile(totalHist, 0.5),
          p95Ms: histogramQuantile(totalHist, 0.95),
        },
        series: points,
        routes: routes.rows
          .map((r) => ({
            group: r.grp,
            requests: Number(r.requests),
            errors5xx: Number(r.e5),
            errors4xx: Number(r.e4),
            p50Ms: histogramQuantile(groupHist.get(r.grp) ?? [], 0.5),
            p95Ms: histogramQuantile(groupHist.get(r.grp) ?? [], 0.95),
          }))
          .sort((a, b) => b.requests - a.requests || a.group.localeCompare(b.group)),
        queues: queues.rows.map((q) => ({
          dbKey: String(q.db_key),
          at: String(q.at),
          outboxPending: Number(q.outbox_pending),
          outboxOldestSeconds: q.outbox_oldest_seconds === null ? null : Number(q.outbox_oldest_seconds),
          jobsQueued: Number(q.jobs_queued),
          jobsDue: Number(q.jobs_due),
          jobsOldestDueSeconds: q.jobs_oldest_due_seconds === null ? null : Number(q.jobs_oldest_due_seconds),
          jobsRunning: Number(q.jobs_running),
          jobsFailed1h: Number(q.jobs_failed_1h),
          jobsFailed24h: Number(q.jobs_failed_24h),
          databaseBytes: Number(q.database_bytes),
        })),
        queueSeries: Array.from({ length: slots }, (_, i) => {
          const slot = start / unitMs + i;
          const r = qBySlot.get(slot);
          return {
            start: new Date(slot * unitMs).toISOString(),
            outboxPending: r?.outbox ?? 0,
            jobsDue: r?.due ?? 0,
            jobsOldestDueSeconds: r?.oldest ?? null,
            jobsFailed: r?.failed ?? 0,
          };
        }),
        worker: { beatAt: beat.rows[0]?.beat_at ?? null },
        incidents: incidents.rows.map((i) => ({
          id: i.id,
          kind: i.kind,
          impact: i.impact,
          title: i.title,
          status: i.status,
          startedAt: i.started_at,
          resolvedAt: i.resolved_at,
        })),
      };
    },
  );
}
