import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  closeAllPools,
  getPool,
  runInTransaction,
  withTenant,
  withTenantReader,
  type TenantRouter,
} from '@thapsus/db';
import { createTestTenant, ownerUrl, readerUrl, testRouter, TEST_DBS, uniqueSlug } from '@thapsus/db/testing';

/**
 * Tenant isolation on the REPORTING READER (PROGRESS 7.2): the role reports run as has no BYPASSRLS, owns
 * nothing, cannot write, never reads the vault or authentication secrets, and forced RLS hides every other
 * tenant's rows in every table it can read — with and without a tenant context.
 */
let owner: pg.Client;
let router: TenantRouter;
let a: string;
let b: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await owner.connect();
  router = testRouter(undefined, { readers: { shared: readerUrl(TEST_DBS.shared) } });
  a = await createTestTenant(router, uniqueSlug('rpt-a'));
  b = await createTestTenant(router, uniqueSlug('rpt-b'));
  for (const t of [a, b]) {
    await withTenant(router, t, async (tx) => {
      await tx.exec(
        `INSERT INTO app.users (tenant_id, email, display_name) VALUES ($1, $2, 'Fictional Reporter')`,
        [t, `r@${t.slice(0, 8)}.example.test`],
      );
      await tx.one<{ id: string }>(
        `INSERT INTO app.employees (tenant_id, employee_number, start_date, display_name) VALUES ($1, 'R1', '2026-01-05', 'Fictional Person') RETURNING id`,
        [t],
      );
      const u = await tx.one<{ id: string }>(`SELECT id FROM app.users LIMIT 1`);
      await tx.exec(
        `INSERT INTO app.saved_reports (tenant_id, name, kind, report_key, spec, owner_user_id) VALUES ($1, 'Fictional', 'ready', 'headcount', '{}', $2)`,
        [t, u.id],
      );
      await tx.exec(
        `INSERT INTO app.report_runs (tenant_id, source, title, format, requested_by) VALUES ($1, '{}', 'Fictional', 'csv', $2)`,
        [t, u.id],
      );
    });
  }
});
afterAll(async () => {
  await owner.end();
  await closeAllPools();
});

async function readable(): Promise<string[]> {
  const { rows } = await owner.query<{ t: string }>(`
    SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('app', 'vault', 'audit') AND has_table_privilege('thapsus_reporting', c.oid, 'SELECT') ORDER BY 1`);
  return rows.map((r) => r.t);
}

describe('reporting reader role', () => {
  it('has no BYPASSRLS, is not superuser, owns no tables and has no write privilege anywhere', async () => {
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'thapsus_reporting'`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'thapsus_reporting'::regrole`,
        )
      ).rows[0].n,
    ).toBe(0);
    const writable = await owner.query(`
      SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND (has_table_privilege('thapsus_reporting', c.oid, 'INSERT') OR has_table_privilege('thapsus_reporting', c.oid, 'UPDATE') OR has_table_privilege('thapsus_reporting', c.oid, 'DELETE'))`);
    expect(writable.rows).toEqual([]);
  });

  it('cannot read the vault, authentication secrets, device tokens or export credentials', async () => {
    const tables = await readable();
    for (const t of [
      'vault.records',
      'app.password_credentials',
      'app.totp_factors',
      'app.sessions',
      'app.magic_links',
      'app.scim_tokens',
      'app.kiosk_pins',
      'app.export_destinations',
      'app.integration_credentials',
    ])
      expect(tables, t).not.toContain(t);
    expect(tables).toEqual(
      expect.arrayContaining([
        'app.employees',
        'app.employee_jobs',
        'app.leave_requests',
        'app.timesheets',
        'app.saved_reports',
        'app.report_runs',
      ]),
    );
  });

  it('without a tenant context sees zero rows in every table it can read', async () => {
    const pool = getPool(readerUrl(TEST_DBS.shared));
    const counts = await runInTransaction(
      pool,
      async (tx) => {
        const out: Record<string, number> = {};
        for (const t of await readable())
          out[t] = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).n;
        return out;
      },
      undefined,
      true,
    );
    for (const [t, n] of Object.entries(counts)) expect(n, t).toBe(0);
  });

  it('in tenant A sees only tenant A rows in every table it can read', async () => {
    const leaks = await withTenantReader(router, a, async (tx, info) => {
      expect(info.reader).toBe(true);
      const out: string[] = [];
      for (const t of await readable()) {
        const n = (
          await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> $1`, [a])
        ).n;
        if (n) out.push(`${t}: ${n}`);
      }
      return out;
    });
    expect(leaks).toEqual([]);
    const mine = await withTenantReader(router, a, (tx) =>
      tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.report_runs'),
    );
    expect(mine.n).toBe(1);
    void b;
  });
});
