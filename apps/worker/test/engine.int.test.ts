import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, emitEvent, enqueueJob, withTenant, type JobHandler, type TenantRouter } from '@thapsus/db';
import { createTestTenant, testRouter, uniqueSlug } from '@thapsus/db/testing';
import { Engine, MemoryPublisher } from '../src/engine';

let router: TenantRouter;
let tenant: string;
beforeAll(async () => {
  router = testRouter();
  tenant = await createTestTenant(router, uniqueSlug('worker'));
});
afterAll(closeAllPools);

function engine(handlers: Record<string, JobHandler>, publisher = new MemoryPublisher(), subscribers = {}) {
  return { e: new Engine({ router, deps: {}, handlers, subscribers, publisher }), publisher };
}

describe('jobs', () => {
  it('are idempotent per key, report progress and succeed', async () => {
    let runs = 0;
    const { e } = engine({
      'test.count': async (ctx) => {
        runs++;
        for (let i = 1; i <= 4; i++) await ctx.progress(i, 4);
        return { ok: true, n: ctx.job.input.n };
      },
    });
    const ids = await withTenant(router, tenant, async (tx) => [
      await enqueueJob(tx, 'test.count', 'key-1', { n: 1 }),
      await enqueueJob(tx, 'test.count', 'key-1', { n: 2 }),
    ]);
    expect(ids[0]!.id).toBe(ids[1]!.id);
    expect(ids[1]!.created).toBe(false);
    await e.tick();
    expect(runs).toBe(1);
    const job = await withTenant(router, tenant, (tx) => tx.one('SELECT status, result, progress_done, progress_total FROM app.jobs WHERE id = $1', [ids[0]!.id]));
    expect(job).toMatchObject({ status: 'succeeded', result: { ok: true, n: 1 }, progress_done: '4', progress_total: '4' });
  });

  it('retries with backoff and fails permanently after max attempts', async () => {
    let now = new Date(Date.now() + 5_000);
    const e = new Engine({ router, deps: {}, handlers: { 'test.flaky': async () => { throw new Error('boom'); } }, subscribers: {}, publisher: new MemoryPublisher(), maxAttempts: 3, now: () => now });
    const { id } = await withTenant(router, tenant, (tx) => enqueueJob(tx, 'test.flaky', 'flaky-1', {}));
    for (let i = 0; i < 3; i++) {
      await e.runDueJobs(tenant);
      now = new Date(now.getTime() + 60 * 60_000);
    }
    const job = await withTenant(router, tenant, (tx) => tx.one<{ status: string; attempts: number; error: string }>('SELECT status, attempts, error FROM app.jobs WHERE id = $1', [id]));
    expect(job).toMatchObject({ status: 'failed', attempts: 3, error: 'boom' });
  });
});

describe('outbox', () => {
  it('delivers each event exactly once even with concurrent workers, and runs subscribers in-transaction', async () => {
    const seen: string[] = [];
    const subscribers = { 'thing.*': [async (_tx: unknown, ev: { topic: string }) => void seen.push(ev.topic)] };
    const a = engine({}, new MemoryPublisher(), subscribers);
    const b = engine({}, new MemoryPublisher(), subscribers);
    await withTenant(router, tenant, async (tx) => {
      for (let i = 0; i < 50; i++) await emitEvent(tx, i % 2 ? 'thing.created' : 'thing.changed', { i }, { type: 'thing', id: String(i) });
    });
    await Promise.all([a.e.dispatchOutbox(tenant, 10), b.e.dispatchOutbox(tenant, 10), a.e.tick(), b.e.tick()]);
    await a.e.processTenant(tenant);
    const all = [...a.publisher.published, ...b.publisher.published];
    expect(all).toHaveLength(50);
    expect(new Set(all.map((x) => x.id)).size).toBe(50);
    expect(seen).toHaveLength(50);
    expect(JSON.stringify(all[0])).not.toMatch(/@/);
  });

  it('seals the audit chain as part of processing', async () => {
    const { e } = engine({});
    await withTenant(router, tenant, (tx) => tx.exec(`INSERT INTO audit.events (tenant_id, actor_type, action) VALUES (app.current_tenant(), 'system', 'x')`));
    await e.processTenant(tenant);
    const unsealed = await withTenant(router, tenant, (tx) => tx.one<{ n: number }>('SELECT count(*)::int AS n FROM audit.events WHERE hash IS NULL'));
    expect(unsealed.n).toBe(0);
  });
});
