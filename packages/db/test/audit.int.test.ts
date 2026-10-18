import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeAllPools, withTenant, writeAudit, diffObjects, type TenantRouter } from '../src/index';
import { createTestTenant, ownerUrl, testRouter, TEST_DBS, uniqueSlug } from '../src/testing';

let router: TenantRouter;
let tenant: string;
let owner: pg.Client;

beforeAll(async () => {
  router = testRouter();
  tenant = await createTestTenant(router, uniqueSlug('audit'));
  owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await owner.connect();
  await withTenant(router, tenant, async (tx) => {
    for (let i = 0; i < 5; i++) {
      await writeAudit(tx, {
        actorType: 'system',
        action: 'test.event',
        targetType: 'thing',
        targetId: String(i),
        diff: { password: { from: 'a', to: 'b' }, title: { from: 'x', to: 'y' } },
      });
    }
  });
});
afterAll(async () => {
  await owner.end();
  await closeAllPools();
});

describe('append-only audit log', () => {
  it('redacts sensitive fields in diffs', async () => {
    const rows = await withTenant(router, tenant, (tx) => tx.query<{ diff: Record<string, unknown> }>('SELECT diff FROM audit.events LIMIT 1'));
    expect(rows[0]!.diff).toEqual({ password: '[REDACTED]', title: { from: 'x', to: 'y' } });
    expect(diffObjects({ a: 1, ssn: '1' }, { a: 2, ssn: '2' })).toEqual({ a: { from: 1, to: 2 }, ssn: '[REDACTED]' });
  });

  it('the application role cannot UPDATE or DELETE audit rows (no privilege)', async () => {
    await expect(withTenant(router, tenant, (tx) => tx.exec(`UPDATE audit.events SET action = 'forged'`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withTenant(router, tenant, (tx) => tx.exec(`DELETE FROM audit.events`))).rejects.toThrow(/permission denied/);
  });

  it('even the owner is blocked by the trigger', async () => {
    await expect(owner.query(`UPDATE audit.events SET action = 'forged' WHERE tenant_id = $1`, [tenant])).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.query(`DELETE FROM audit.events WHERE tenant_id = $1`, [tenant])).rejects.toThrow(/append-only/);
    await expect(owner.query(`TRUNCATE audit.events`)).rejects.toThrow(/append-only/);
  });

  it('seals entries into a per-tenant hash chain that verifies', async () => {
    const sealed = await withTenant(router, tenant, (tx) => tx.one<{ n: number }>('SELECT audit.seal_pending() AS n'));
    expect(sealed.n).toBe(5);
    const ok = await withTenant(router, tenant, (tx) => tx.one<{ broken: string | null }>('SELECT audit.verify_chain() AS broken'));
    expect(ok.broken).toBeNull();
    // the sealing flag cannot be abused by the app role to rewrite sealed rows
    await expect(
      withTenant(router, tenant, async (tx) => {
        await tx.query("SELECT set_config('audit.sealing', 'on', true)");
        await tx.exec(`UPDATE audit.events SET action = 'forged'`);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('verification detects tampering', async () => {
    await owner.query('ALTER TABLE audit.events DISABLE TRIGGER audit_events_append_only');
    try {
      await owner.query(`UPDATE audit.events SET target_id = 'tampered' WHERE tenant_id = $1 AND seq = 3`, [tenant]);
    } finally {
      await owner.query('ALTER TABLE audit.events ENABLE TRIGGER audit_events_append_only');
    }
    const res = await withTenant(router, tenant, (tx) => tx.one<{ broken: string | null }>('SELECT audit.verify_chain() AS broken'));
    expect(res.broken).toBe('3');
  });
});
