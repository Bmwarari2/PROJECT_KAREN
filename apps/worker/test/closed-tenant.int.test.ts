import { afterAll, describe, expect, it } from 'vitest';
import { closeAllPools, enqueueJob, withRegistry, withTenant } from '@thapsus/db';
import { createTestTenant, testRouter, uniqueSlug } from '@thapsus/db/testing';
import { Engine, MemoryPublisher } from '../src/engine';

afterAll(closeAllPools);

/**
 * Account closure deletes the tenant, including the job row that is running the purge. The engine
 * must finish cleanly, stop processing that tenant and keep serving the others.
 */
describe('a job that deletes its own tenant', () => {
  it('finishes without errors and the tenant is no longer processed', async () => {
    const router = testRouter();
    const closing = await createTestTenant(router, uniqueSlug('closing'));
    const other = await createTestTenant(router, uniqueSlug('other'));
    const errors: unknown[] = [];
    let otherRuns = 0;
    const engine = new Engine({
      router,
      deps: {},
      publisher: new MemoryPublisher(),
      subscribers: {},
      log: { info: () => undefined, warn: () => undefined, error: (o: unknown) => void errors.push(o) },
      handlers: {
        'test.purge': async (ctx) => {
          await ctx.tx((tx) => tx.exec('DELETE FROM app.jobs'));
          await withRegistry(router, (tx) =>
            tx.exec(`UPDATE registry.tenants SET status = 'deleted' WHERE tenant_id = $1`, [ctx.tenantId]),
          );
          return { purged: true };
        },
        'test.other': async () => {
          otherRuns++;
        },
      },
    });
    await withTenant(router, closing, async (tx) => {
      await enqueueJob(tx, 'test.purge', 'purge-1', {});
      await enqueueJob(
        tx,
        'test.other',
        'after-purge',
        {},
        { runAfter: new Date(Date.now() + 1000).toISOString() },
      );
    });
    await withTenant(router, other, (tx) => enqueueJob(tx, 'test.other', 'other-1', {}));
    await engine.tick();
    expect(errors).toEqual([]);
    expect(otherRuns).toBe(1);
    await expect(withTenant(router, closing, (tx) => tx.query('SELECT 1'))).rejects.toThrow(/deleted/);
  });
});
