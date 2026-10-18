import { withRegistry, withTenant, type EventSubscriber, type JobHandler, type JobRow, type OutboxEvent, type TenantRouter, type Tx } from '@thapsus/db';
import type { Logger } from '@thapsus/core/logger';

/** Publishes domain events beyond the cell database (SQS/EventBridge in AWS). Must tolerate redelivery. */
export interface EventPublisher {
  publish(events: OutboxEvent[]): Promise<void>;
}

export class MemoryPublisher implements EventPublisher {
  readonly published: OutboxEvent[] = [];
  async publish(events: OutboxEvent[]) {
    this.published.push(...events);
  }
}

export interface EngineOptions<D> {
  router: TenantRouter;
  deps: D;
  handlers: Record<string, JobHandler<D>>;
  subscribers: Record<string, EventSubscriber[]>;
  publisher: EventPublisher;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
  maxAttempts?: number;
  now?: () => Date;
  /** Idempotent enqueuers run for each tenant whenever it is processed (date-driven work). */
  periodic?: Array<(tx: Tx, now: Date) => Promise<void>>;
}

/**
 * Worker engine. Work discovery uses registry.work_signals (no scan of tenant data), then every
 * step runs inside the tenant's own context:
 *  1. outbox → in-process subscribers (same transaction) → external publisher → mark published
 *  2. audit hash-chain sealing
 *  3. due jobs, claimed with FOR UPDATE SKIP LOCKED, retried with exponential backoff
 * All steps are idempotent so the engine can run in any number of tasks concurrently.
 */
export class Engine<D> {
  constructor(private readonly o: EngineOptions<D>) {}

  /** Processes every tenant that has signalled work. Returns the number of tenants processed. */
  async tick(): Promise<number> {
    const signals = await withRegistry(this.o.router, (tx) =>
      tx.query<{ tenant_id: string }>(
        `DELETE FROM registry.work_signals WHERE (tenant_id, kind) IN (
           SELECT tenant_id, kind FROM registry.work_signals ORDER BY signalled_at FOR UPDATE SKIP LOCKED LIMIT 200)
         RETURNING tenant_id`,
      ),
    );
    const tenants = [...new Set(signals.map((s) => s.tenant_id))];
    for (const t of tenants) await this.processTenant(t).catch((err) => this.o.log?.error({ err, tenantId: t }, 'tenant processing failed'));
    return tenants.length;
  }

  /** Signals every active tenant (used by the periodic scheduler for date-driven work). */
  async signalAll(kind = 'jobs') {
    await withRegistry(this.o.router, (tx) =>
      tx.exec(
        `INSERT INTO registry.work_signals (tenant_id, kind) SELECT tenant_id, $1 FROM registry.tenants WHERE status = 'active'
         ON CONFLICT (tenant_id, kind) DO UPDATE SET signalled_at = now()`,
        [kind],
      ),
    );
  }

  async processTenant(tenantId: string) {
    if (this.o.periodic?.length) {
      const now = this.o.now?.() ?? new Date();
      await withTenant(this.o.router, tenantId, async (tx) => {
        for (const p of this.o.periodic!) await p(tx, now);
      });
    }
    let more = true;
    let rounds = 0;
    while (more && rounds++ < 20) {
      more = (await this.dispatchOutbox(tenantId)) > 0;
      await withTenant(this.o.router, tenantId, (tx) => tx.query('SELECT audit.seal_pending(5000)'));
      more = (await this.runDueJobs(tenantId)) > 0 || more;
    }
  }

  async dispatchOutbox(tenantId: string, batch = 200): Promise<number> {
    return withTenant(this.o.router, tenantId, async (tx) => {
      const rows = await tx.query<{ id: string; topic: string; aggregate_type: string | null; aggregate_id: string | null; payload: Record<string, unknown>; created_at: string }>(
        `SELECT id, topic, aggregate_type, aggregate_id, payload, created_at FROM app.outbox
          WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT ${batch}`,
      );
      if (!rows.length) return 0;
      const events: OutboxEvent[] = rows.map((r) => ({
        tenantId,
        id: r.id,
        topic: r.topic,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        payload: r.payload,
        createdAt: r.created_at,
      }));
      for (const e of events) {
        for (const [pattern, subs] of Object.entries(this.o.subscribers)) {
          if (pattern === '*' || pattern === e.topic || (pattern.endsWith('.*') && e.topic.startsWith(pattern.slice(0, -1)))) {
            for (const s of subs) await s(tx, e);
          }
        }
      }
      await this.o.publisher.publish(events);
      await tx.exec(`UPDATE app.outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
      return rows.length;
    });
  }

  async runDueJobs(tenantId: string, max = 50): Promise<number> {
    let ran = 0;
    for (; ran < max; ran++) {
      const job = await withTenant(this.o.router, tenantId, (tx) =>
        tx.maybe<JobRow>(
          `UPDATE app.jobs SET status = 'running', started_at = now(), attempts = attempts + 1
            WHERE id = (SELECT id FROM app.jobs WHERE status = 'queued' AND run_after <= $1 ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`,
          [this.o.now?.() ?? new Date()],
        ),
      );
      if (!job) break;
      await this.runJob(tenantId, job);
    }
    return ran;
  }

  private async runJob(tenantId: string, job: JobRow) {
    const handler = this.o.handlers[job.kind];
    const finish = (status: string, result: unknown, error: string | null, retryAt?: Date) =>
      withTenant(this.o.router, tenantId, (tx) =>
        tx.exec(
          `UPDATE app.jobs SET status = $2, result = $3, error = $4, finished_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() END,
             run_after = coalesce($5, run_after) WHERE id = $1`,
          [job.id, status, result === undefined ? null : JSON.stringify(result), error, retryAt ?? null],
        ),
      );
    if (!handler) {
      await finish('failed', null, `No handler for ${job.kind}`);
      return;
    }
    try {
      const result = await handler({
        tenantId,
        job,
        deps: this.o.deps,
        tx: (fn) => withTenant(this.o.router, tenantId, fn, { actorId: job.created_by }),
        progress: (done, total) =>
          withTenant(this.o.router, tenantId, (tx) =>
            tx.exec('UPDATE app.jobs SET progress_done = $2, progress_total = coalesce($3, progress_total) WHERE id = $1', [job.id, done, total ?? null]),
          ).then(() => undefined),
      });
      await finish('succeeded', result ?? {}, null);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 1000) ?? 'error';
      const maxAttempts = this.o.maxAttempts ?? 5;
      if (job.attempts >= maxAttempts) {
        await finish('failed', null, message);
        this.o.log?.warn({ jobId: job.id, kind: job.kind }, 'job failed permanently');
      } else {
        const backoffMs = Math.min(15 * 60_000, 2 ** job.attempts * 1000);
        await finish('queued', null, message, new Date((this.o.now?.() ?? new Date()).getTime() + backoffMs));
      }
    }
  }
}
