import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeAllPools, loadMigrations, migrate, TenantRouter, withTenant } from '../src';
import { appUrl, createTestTenant, ownerUrl, TEST_APP_PASSWORD, TEST_DBS, uniqueSlug } from '../src/testing';

/**
 * Managed Postgres (Cloud SQL on Google Cloud, ADR-0156) has no superuser for us: the migrator is a member of
 * cloudsqlsuperuser, with CREATEROLE and CREATEDB but no SUPERUSER and no BYPASSRLS. Every migration must apply as
 * such a role on a fresh database and leave the same privileges a superuser-run migration leaves.
 *
 * Roles are cluster-wide, and in the test cluster the thapsus_* roles already exist (made by the superuser that
 * ran the global setup). On a fresh Cloud SQL instance the migrator creates them itself, and PostgreSQL 16+ then
 * gives it ADMIN on them but neither INHERIT nor SET; the test grants exactly that so the state matches.
 * When TEST_PG_OWNER_URL is itself such a non-superuser role, the global setup has already migrated the test
 * databases with it, and the checks run against those.
 */
const ROLE = 'thapsus_test_managed_migrator';
const PASSWORD = 'local_test_only_managed_migrator';
const DB = 'thapsus_test_managed';
const APP_ROLES = ['thapsus_app', 'thapsus_backoffice', 'thapsus_reporting', 'thapsus_lookup'];

let admin: pg.Client;
let ownerIsSuperuser: boolean;
let migratedDb: string;
let applied: string[] = [];

const managedUrl = (db: string) => {
  const u = new URL(ownerUrl(db));
  u.username = ROLE;
  u.password = PASSWORD;
  return u.toString();
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ownerUrl('postgres') });
  await admin.connect();
  ownerIsSuperuser = (
    await admin.query<{ s: boolean }>('SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')
  ).rows[0]!.s;
  if (!ownerIsSuperuser) {
    migratedDb = TEST_DBS.shared;
    return;
  }
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE}; END IF;
  END $$`);
  await admin.query(
    `ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB PASSWORD ${pg.escapeLiteral(PASSWORD)}`,
  );
  await admin.query(`GRANT ${APP_ROLES.join(', ')} TO ${ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  migratedDb = DB;
  applied = await migrate({
    ownerUrl: managedUrl(DB),
    rolePasswords: {
      thapsus_app: TEST_APP_PASSWORD,
      thapsus_backoffice: TEST_APP_PASSWORD,
      thapsus_reporting: TEST_APP_PASSWORD,
    },
  });
});

afterAll(async () => {
  await closeAllPools();
  if (ownerIsSuperuser) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    // The role stays (it may have granted memberships in other test databases); it can log in only locally.
  }
  await admin.end();
});

describe('migrations as a managed-Postgres migrator (no SUPERUSER, no BYPASSRLS)', () => {
  it('the migrator really is that role', async () => {
    const c = new pg.Client({
      connectionString: ownerIsSuperuser ? managedUrl(migratedDb) : ownerUrl(migratedDb),
    });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: true,
        rolcreatedb: true,
      });
    } finally {
      await c.end();
    }
  });

  it('applies every migration on a fresh database', () => {
    if (ownerIsSuperuser) expect(applied).toEqual(loadMigrations().map((m) => m.name));
  });

  it('leaves the lookup role owning only its function, without CREATE on schema app (0001b, 0020)', async () => {
    const c = new pg.Client({ connectionString: ownerUrl(migratedDb) });
    await c.connect();
    try {
      const { rows } = await c.query(`SELECT
          pg_get_userbyid(p.proowner) AS owner,
          has_schema_privilege('thapsus_lookup', 'app', 'USAGE') AS usage,
          has_schema_privilege('thapsus_lookup', 'app', 'CREATE') AS create
        FROM pg_proc p WHERE p.oid = 'app.tenants_for_email(citext)'::regprocedure`);
      expect(rows[0]).toEqual({ owner: 'thapsus_lookup', usage: true, create: false });
    } finally {
      await c.end();
    }
  });

  it('row level security holds for the application role on the database it migrated', async () => {
    const router = new TenantRouter({ databases: { shared: appUrl(migratedDb) }, cacheTtlMs: 0 });
    const a = await createTestTenant(router, uniqueSlug('mgd-a'));
    const b = await createTestTenant(router, uniqueSlug('mgd-b'));
    const seen = await withTenant(router, a, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM app.tenants'),
    );
    expect(seen.map((r) => r.tenant_id)).toEqual([a]);
    expect(seen.map((r) => r.tenant_id)).not.toContain(b);
  });
});
