import { afterAll, describe, expect, it } from 'vitest';
import { regionPairs } from '@thapsus/core';
import { TenantNotFoundError, withTenant, type JobRow } from '@thapsus/db';
import { closeDb, ownerSession, startTestApp } from './helpers';
import { jobHandlers } from '../src/worker';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * Privacy features keep data in the home region for every region pair: access exports are written
 * to the home cell's object store only, the other cell cannot reach the tenant's requests, and its
 * workers cannot run the tenant's privacy jobs.
 */
afterAll(closeDb);

describe.each(regionPairs())('privacy data stays home (%s → %s)', (home, other) => {
  it(`a ${home} access export is stored only in the ${home} cell`, async () => {
    const homeCell = await startTestApp({ cell: home, listen: false });
    const otherCell = await startTestApp({ cell: other, listen: false, directory: homeCell.directory });
    try {
      const o = await ownerSession(homeCell);
      const r = await homeCell.app.inject({
        method: 'POST',
        url: '/v1/privacy/requests',
        headers: { cookie: o.cookie },
        payload: { kind: 'access', subjectUserId: o.userId, receivedOn: '2026-03-10' },
      });
      expect(r.statusCode, r.body).toBe(201);
      const job: JobRow = {
        id: crypto.randomUUID(),
        tenant_id: o.tenantId,
        kind: 'privacy.dsr_export',
        idempotency_key: 'residency',
        input: { requestId: r.json().id },
        attempts: 1,
        created_by: o.userId,
      };
      const run = (cell: typeof homeCell) =>
        jobHandlers['privacy.dsr_export']!({
          tenantId: o.tenantId,
          job,
          deps: cell.deps,
          tx: (fn) => withTenant(cell.deps.router, o.tenantId, fn),
          progress: async () => undefined,
        });
      await run(homeCell);
      const inHome = [...(homeCell.deps.objects as MemoryObjectStore).objects.keys()].filter((k) =>
        k.startsWith(`${o.tenantId}/`),
      );
      expect(inHome.length).toBe(2);
      expect(
        [...(otherCell.deps.objects as MemoryObjectStore).objects.keys()].some((k) =>
          k.startsWith(`${o.tenantId}/`),
        ),
      ).toBe(false);
      // The other cell treats the tenant as unknown: no API access, no job execution.
      const foreign = await otherCell.app.inject({
        method: 'GET',
        url: '/v1/privacy/requests',
        headers: { cookie: o.cookie },
      });
      expect(foreign.statusCode).not.toBe(200);
      await expect(run(otherCell)).rejects.toBeInstanceOf(TenantNotFoundError);
    } finally {
      await homeCell.close();
      await otherCell.close();
    }
  });
});
