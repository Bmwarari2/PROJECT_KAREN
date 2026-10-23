import pg from 'pg';
import { migrate } from './migrate';
import { TenantRouter } from './router';
import { withRegistry } from './context';

export const TEST_OWNER_BASE =
  process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
// Roles are cluster-wide, so dev, tests, e2e and Lighthouse share one local-only password (Docker Postgres only).
export const TEST_APP_PASSWORD = 'local_dev_only_password';
export const TEST_DBS = { shared: 'thapsus_test', dedicated: 'thapsus_test_dedicated' } as const;

export const ownerUrl = (db: string) => `${TEST_OWNER_BASE}/${db}`;
export const appUrl = (db: string, role = 'thapsus_app', password = TEST_APP_PASSWORD) => {
  const u = new URL(TEST_OWNER_BASE);
  return `postgres://${role}:${password}@${u.host}/${db}`;
};

/** Drops and recreates a database, then applies every migration. */
export async function resetDatabase(db: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ownerUrl('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
  await migrate({
    ownerUrl: ownerUrl(db),
    rolePasswords: {
      thapsus_app: TEST_APP_PASSWORD,
      thapsus_backoffice: TEST_APP_PASSWORD,
      thapsus_reporting: TEST_APP_PASSWORD,
    },
  });
}

export function testRouter(cell?: string, opts: { readers?: Record<string, string> } = {}): TenantRouter {
  return new TenantRouter({
    cell,
    databases: { shared: appUrl(TEST_DBS.shared), dedicated: appUrl(TEST_DBS.dedicated) },
    readers: opts.readers,
    cacheTtlMs: 0,
  });
}

/** Reader URL for a test database: the reporting role (read-only grants, no vault, no BYPASSRLS). */
export const readerUrl = (db: string) => appUrl(db, 'thapsus_reporting');

/** Creates a tenant row in the registry and the tenant database (as the app role; RLS applies). */
export async function createTestTenant(
  router: TenantRouter,
  slug: string,
  region: 'uk' | 'eu' | 'us' = 'uk',
): Promise<string> {
  const id = crypto.randomUUID();
  await withRegistry(router, async (tx) => {
    await tx.exec(`INSERT INTO registry.tenants (tenant_id, slug, home_region) VALUES ($1, $2, $3)`, [
      id,
      slug,
      region,
    ]);
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    await tx.exec(`INSERT INTO app.tenants (tenant_id, slug, name, home_region) VALUES ($1, $2, $3, $4)`, [
      id,
      slug,
      `Fictional ${slug}`,
      region,
    ]);
  });
  return id;
}

export const uniqueSlug = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
