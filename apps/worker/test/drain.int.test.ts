import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, enqueueJob, withTenant, type TenantRouter } from '@thapsus/db';
import { createTestTenant, testRouter, uniqueSlug } from '@thapsus/db/testing';
import { Drainer, WorkerCycle } from '../src/drain';
import { Engine, MemoryPublisher } from '../src/engine';
import { createWorkerServer } from '../src/http';

/** POST /drain with the real engine and database (WORKER_MODE=http, ADR-0156). Fictional tenants only. */
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let router: TenantRouter;
let tenant: string;
beforeAll(async () => {
  router = testRouter();
  tenant = await createTestTenant(router, uniqueSlug('drain'));
});
afterAll(closeAllPools);

describe('worker drain over HTTP', () => {
  it('runs the due jobs of every signalled tenant and answers with counts only', async () => {
    const ran: string[] = [];
    const engine = new Engine({
      router,
      deps: {},
      handlers: {
        'test.drain': async (ctx) => {
          ran.push(ctx.job.idempotency_key);
          return { ok: true };
        },
      },
      subscribers: {},
      publisher: new MemoryPublisher(),
    });
    const { id } = await withTenant(router, tenant, (tx) => enqueueJob(tx, 'test.drain', 'drain-1', {}));
    let beats = 0;
    const cycle = new WorkerCycle({
      engine,
      heartbeat: async () => {
        beats++;
      },
      log: silent,
      // no sweep of every tenant in the shared test database; the enqueue signalled this tenant
      sweepMs: Number.POSITIVE_INFINITY,
      beatMs: 30_000,
    });
    const server = createWorkerServer({
      drainer: new Drainer(cycle, { budgetMs: 50_000, log: silent }),
      log: silent,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const [a, b] = await Promise.all([
        fetch(`${base}/drain`, { method: 'POST' }),
        fetch(`${base}/drain`, { method: 'POST' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const text = await a.text();
      expect(text).not.toContain(tenant);
      const body = JSON.parse(text) as { tenants: number; rounds: number; errors: number; swept: boolean };
      expect(body.tenants).toBeGreaterThanOrEqual(1);
      expect(body).toMatchObject({ errors: 0, swept: false, heartbeat: true });
      expect(ran).toEqual(['drain-1']);
      expect(beats).toBe(1);
      const job = await withTenant(router, tenant, (tx) =>
        tx.one<{ status: string }>('SELECT status FROM app.jobs WHERE id = $1', [id]),
      );
      expect(job.status).toBe('succeeded');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
