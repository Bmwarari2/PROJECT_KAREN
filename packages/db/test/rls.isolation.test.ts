import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeAllPools, getPool, runInTransaction, withTenant, type TenantRouter } from '../src/index';
import { appUrl, createTestTenant, ownerUrl, testRouter, TEST_DBS, uniqueSlug } from '../src/testing';

/**
 * Tenant isolation suite. Enumerates every table from the catalog, so a new table without RLS, a
 * forced policy or a tenant-leading index fails the build.
 */
const TENANT_SCHEMAS = ['app', 'vault', 'audit'];
/** Schemas that hold no tenant personal data, with the reason. Every table in them must lack tenant_id. */
const NON_TENANT_SCHEMAS: Record<string, string> = {
  registry: 'regional routing registry: tenant id, slug, region, db key, status only',
  backoffice:
    'Thapsus staff accounts and the staff action trail; tenants referenced only by subject_tenant_id',
  public: 'schema_migrations bookkeeping only',
  platform:
    'per-cell request and queue counters by route group and database key (ADR-0176); no tenant id, no personal data',
};

/** Registry tables are routing metadata; any new column must be added here deliberately (no personal data). */
const REGISTRY_COLUMNS = new Set([
  'tenant_id',
  'slug',
  'home_region',
  'db_key',
  'status',
  'created_at',
  'updated_at',
  'kind',
  'signalled_at',
  'issued_at',
  'certificate',
  'certificate_sha256',
]);

let owner: pg.Client;
let router: TenantRouter;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await owner.connect();
  router = testRouter();
  tenantA = await createTestTenant(router, uniqueSlug('iso-a'));
  tenantB = await createTestTenant(router, uniqueSlug('iso-b'));
  for (const [t, email] of [
    [tenantA, 'a.person@a.example.test'],
    [tenantB, 'b.person@b.example.test'],
  ] as const) {
    await withTenant(router, t, (tx) =>
      tx.exec(`INSERT INTO app.users (tenant_id, email, display_name) VALUES ($1, $2, 'Fictional Person')`, [
        t,
        email,
      ]),
    );
  }
});
afterAll(async () => {
  await owner.end();
  await closeAllPools();
});

async function catalog() {
  const { rows } = await owner.query<{
    schema: string;
    table: string;
    rls: boolean;
    forced: boolean;
    has_tenant: boolean;
    policies: string[];
    owner: string;
    tenant_leading_index: boolean;
  }>(`
    SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      pg_get_userbyid(c.relowner) AS owner,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
      coalesce((SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid), '{}') AS policies,
      EXISTS (
        SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = c.oid AND a.attname = 'tenant_id'
      ) AS tenant_leading_index
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1, 2`);
  return rows;
}

describe('catalog-wide isolation checks', () => {
  it('every table in tenant schemas has tenant_id, forced RLS, the tenant policy and a tenant-leading index', async () => {
    const tables = await catalog();
    const problems: string[] = [];
    for (const t of tables) {
      const name = `${t.schema}.${t.table}`;
      if (TENANT_SCHEMAS.includes(t.schema)) {
        if (!t.has_tenant) problems.push(`${name}: missing tenant_id`);
        if (!t.rls) problems.push(`${name}: RLS not enabled`);
        if (!t.forced) problems.push(`${name}: RLS not forced`);
        if (!t.policies.includes('tenant_isolation')) problems.push(`${name}: no tenant_isolation policy`);
        if (!t.tenant_leading_index) problems.push(`${name}: no index leading with tenant_id`);
      } else if (t.schema === 'registry') {
        const cols = await owner.query<{ c: string }>(
          `SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
          [name],
        );
        for (const { c } of cols.rows)
          if (!REGISTRY_COLUMNS.has(c)) problems.push(`${name}.${c}: not on the registry allowlist`);
      } else if (t.schema in NON_TENANT_SCHEMAS) {
        if (t.has_tenant)
          problems.push(`${name}: tenant_id column in a non-tenant schema — move it or add RLS`);
      } else {
        problems.push(`${name}: table in unclassified schema ${t.schema}`);
      }
    }
    expect(problems).toEqual([]);
    expect(tables.filter((t) => TENANT_SCHEMAS.includes(t.schema)).length).toBeGreaterThan(15);
  });

  it('the application role has no BYPASSRLS, is not superuser and owns no tables', async () => {
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'thapsus_app'`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      `SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'thapsus_app'::regrole`,
    );
    expect(owned.rows[0].n).toBe(0);
    // extension operators resolve (USAGE on public), but nothing can be created there and the
    // migration bookkeeping table stays unreadable
    const pub = await owner.query(
      `SELECT has_schema_privilege('thapsus_app', 'public', 'USAGE') AS usage, has_schema_privilege('thapsus_app', 'public', 'CREATE') AS create,
              has_table_privilege('thapsus_app', 'public.schema_migrations', 'SELECT') AS read_migrations`,
    );
    expect(pub.rows[0]).toEqual({ usage: true, create: false, read_migrations: false });
  });

  it('policies granted to other roles are limited to the reviewed allowlist', async () => {
    const { rows } = await owner.query<{ policy: string }>(`
      SELECT n.nspname || '.' || c.relname || ':' || p.polname AS policy
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polname <> 'tenant_isolation' ORDER BY 1`);
    expect(rows.map((r) => r.policy)).toEqual([
      // the queue sample counts across tenants through platform.queue_snapshot() only (ADR-0176)
      'app.jobs:metrics_queue_counts',
      'app.outbox:metrics_queue_counts',
      'app.support_grants:backoffice_grants_read',
      'app.users:lookup_by_email',
    ]);
  });

  it('SECURITY DEFINER functions (which run with owner rights) are limited to the reviewed allowlist', async () => {
    const { rows } = await owner.query<{ fn: string; public: boolean }>(`
      SELECT n.nspname || '.' || p.proname AS fn, has_function_privilege('public', p.oid, 'EXECUTE') AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
    expect(rows.map((r) => r.fn)).toEqual([
      'app.analyze_core_hr',
      'app.tenants_for_email',
      'app.trgm_word_similarity',
      'audit.purge_closed_tenant',
      'audit.seal_pending',
      'platform.queue_snapshot',
    ]);
    // the worker's queue sample (ADR-0176): counts and ages only, for the application role only, owned by a
    // NOLOGIN role that may read four columns of the two queue tables and nothing else
    expect(rows.find((r) => r.fn === 'platform.queue_snapshot')!.public).toBe(false);
    const snapshot = await owner.query<{
      app: boolean;
      backoffice: boolean;
      reporting: boolean;
      owner: string;
      payload: boolean;
      input: boolean;
    }>(
      `SELECT has_function_privilege('thapsus_app', 'platform.queue_snapshot(timestamptz)', 'EXECUTE') AS app,
              has_function_privilege('thapsus_backoffice', 'platform.queue_snapshot(timestamptz)', 'EXECUTE') AS backoffice,
              has_function_privilege('thapsus_reporting', 'platform.queue_snapshot(timestamptz)', 'EXECUTE') AS reporting,
              pg_get_userbyid(proowner) AS owner,
              has_column_privilege('thapsus_metrics', 'app.outbox', 'payload', 'SELECT') AS payload,
              has_column_privilege('thapsus_metrics', 'app.jobs', 'input', 'SELECT') AS input
         FROM pg_proc WHERE oid = 'platform.queue_snapshot(timestamptz)'::regprocedure`,
    );
    expect(snapshot.rows[0]).toEqual({
      app: true,
      backoffice: false,
      reporting: false,
      owner: 'thapsus_metrics',
      payload: false,
      input: false,
    });
    const columns = await owner.query<{ c: string }>(
      `SELECT unnest(proargnames) AS c FROM pg_proc WHERE oid = 'platform.queue_snapshot(timestamptz)'::regprocedure`,
    );
    expect(columns.rows.map((r) => r.c)).not.toContain('tenant_id');
    // Ask HR retrieval (ADR-0111): a pure, pinned-search-path wrapper over pg_trgm's word_similarity(), for the application role only
    expect(rows.find((r) => r.fn === 'app.trgm_word_similarity')!.public).toBe(false);
    const trgm = await owner.query<{
      app: boolean;
      backoffice: boolean;
      volatility: string;
      config: string[];
    }>(
      `SELECT has_function_privilege('thapsus_app', 'app.trgm_word_similarity(text, text)', 'EXECUTE') AS app, has_function_privilege('thapsus_backoffice', 'app.trgm_word_similarity(text, text)', 'EXECUTE') AS backoffice, provolatile AS volatility, proconfig AS config FROM pg_proc WHERE oid = 'app.trgm_word_similarity(text, text)'::regprocedure`,
    );
    expect(trgm.rows[0]).toEqual({
      app: true,
      backoffice: false,
      volatility: 'i',
      config: ['search_path=pg_catalog, public'],
    });
    // verified deletion at account closure (ADR-0085): only the application role, and only for its own tenant once closing
    expect(rows.find((r) => r.fn === 'audit.purge_closed_tenant')!.public).toBe(false);
    const purge = await owner.query<{ app: boolean; backoffice: boolean; reporting: boolean }>(
      `SELECT has_function_privilege('thapsus_app', 'audit.purge_closed_tenant()', 'EXECUTE') AS app, has_function_privilege('thapsus_backoffice', 'audit.purge_closed_tenant()', 'EXECUTE') AS backoffice, has_function_privilege('thapsus_reporting', 'audit.purge_closed_tenant()', 'EXECUTE') AS reporting`,
    );
    expect(purge.rows[0]).toEqual({ app: true, backoffice: false, reporting: false });
    await expect(
      withTenant(router, tenantA, (tx) => tx.query('SELECT audit.purge_closed_tenant()')),
    ).rejects.toThrow(/not being closed/);
    // statistics refresh after bulk imports: the application role only, nobody else
    expect(rows.find((r) => r.fn === 'app.analyze_core_hr')!.public).toBe(false);
    const roles = await owner.query<{ app: boolean; backoffice: boolean }>(
      `SELECT has_function_privilege('thapsus_app', 'app.analyze_core_hr()', 'EXECUTE') AS app, has_function_privilege('thapsus_backoffice', 'app.analyze_core_hr()', 'EXECUTE') AS backoffice`,
    );
    expect(roles.rows[0]).toEqual({ app: true, backoffice: false });
    await withTenant(router, tenantA, (tx) => tx.query('SELECT app.analyze_core_hr()'));
    // the role itself still cannot maintain (ANALYZE, VACUUM, REINDEX…) the shared tables
    const maintain = await owner.query<{ m: boolean }>(
      `SELECT has_table_privilege('thapsus_app', 'app.employees', 'MAINTAIN') AS m`,
    );
    expect(maintain.rows[0]!.m).toBe(false);
  });
});

describe('cross-tenant access is impossible', () => {
  it('tenant A cannot select tenant B rows', async () => {
    const rows = await withTenant(router, tenantA, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM app.users'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    const direct = await withTenant(router, tenantA, (tx) =>
      tx.query('SELECT * FROM app.users WHERE tenant_id = $1', [tenantB]),
    );
    expect(direct).toHaveLength(0);
  });

  it('tenant A cannot insert rows for tenant B', async () => {
    await expect(
      withTenant(router, tenantA, (tx) =>
        tx.exec(
          `INSERT INTO app.users (tenant_id, email, display_name) VALUES ($1, 'x@b.example.test', 'X')`,
          [tenantB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('tenant A cannot update or delete tenant B rows', async () => {
    const updated = await withTenant(router, tenantA, (tx) =>
      tx.exec(`UPDATE app.users SET display_name = 'Hijacked' WHERE tenant_id = $1`, [tenantB]),
    );
    const deleted = await withTenant(router, tenantA, (tx) =>
      tx.exec(`DELETE FROM app.users WHERE tenant_id = $1`, [tenantB]),
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    const stillThere = await withTenant(router, tenantB, (tx) =>
      tx.query(`SELECT display_name FROM app.users`),
    );
    expect(stillThere.map((r) => r.display_name)).toEqual(['Fictional Person']);
  });

  it('tenant A cannot move its own row into tenant B', async () => {
    await expect(
      withTenant(router, tenantA, (tx) => tx.exec(`UPDATE app.users SET tenant_id = $1`, [tenantB])),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('a session without tenant context sees zero rows in every tenant-scoped table', async () => {
    const tables = (await catalog()).filter((t) => TENANT_SCHEMAS.includes(t.schema));
    const pool = getPool(appUrl(TEST_DBS.shared));
    const counts = await runInTransaction(pool, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of tables) {
        const r = await tx
          .one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.schema}.${t.table}`)
          .catch(() => ({ n: -1 }));
        out[`${t.schema}.${t.table}`] = r.n;
      }
      return out;
    });
    for (const [name, n] of Object.entries(counts)) expect(n, name).toBeLessThanOrEqual(0);
    // sanity: the owner (bypassing RLS as superuser) does see rows
    const all = await owner.query('SELECT count(*)::int AS n FROM app.users');
    expect(all.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('tenant context does not leak between pooled transactions', async () => {
    const pool = new pg.Pool({ connectionString: appUrl(TEST_DBS.shared), max: 1 });
    try {
      await runInTransaction(pool, async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        expect((await tx.query('SELECT 1 FROM app.users')).length).toBeGreaterThan(0);
      });
      const after = await runInTransaction(pool, async (tx) => {
        const setting = await tx.one<{ v: string | null }>(
          "SELECT current_setting('app.tenant_id', true) AS v",
        );
        const rows = await tx.query('SELECT 1 FROM app.users');
        return { setting: setting.v, rows: rows.length };
      });
      expect(after.setting ?? '').toBe('');
      expect(after.rows).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('the closed-tenant audit purge refuses active tenants and never touches another tenant', async () => {
    for (const t of [tenantA, tenantB]) {
      await withTenant(router, t, (tx) =>
        tx.exec(
          `INSERT INTO audit.events (tenant_id, actor_type, action) VALUES (app.current_tenant(), 'system', 'test.event')`,
        ),
      );
    }
    await expect(
      withTenant(router, tenantA, (tx) => tx.query('SELECT audit.purge_closed_tenant()')),
    ).rejects.toThrow(/not being closed/);
    await expect(withTenant(router, tenantA, (tx) => tx.exec('DELETE FROM audit.events'))).rejects.toThrow(
      /permission denied/,
    );
    // Even with the purge flag set by hand the app role has no DELETE privilege on the audit log.
    await expect(
      withTenant(router, tenantA, async (tx) => {
        await tx.query(`SELECT set_config('audit.purging', $1, true)`, [tenantB]);
        return tx.exec('DELETE FROM audit.events');
      }),
    ).rejects.toThrow(/permission denied/);
    const b = await withTenant(router, tenantB, (tx) =>
      tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit.events WHERE action = 'test.event'`),
    );
    expect(b.n).toBe(1);
  });

  it('the find-my-workspace lookup reveals tenant ids only', async () => {
    const pool = getPool(appUrl(TEST_DBS.shared));
    const res = await pool.query('SELECT * FROM app.tenants_for_email($1)', ['b.person@b.example.test']);
    expect(res.rows).toEqual([{ tenant_id: tenantB }]);
    await expect(pool.query('SET ROLE thapsus_lookup')).rejects.toThrow();
  });
});
