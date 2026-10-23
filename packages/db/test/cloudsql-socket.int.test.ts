import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeAllPools, migrate, readersFromEnv, secretToUrl, TenantRouter } from '../src';
import { TEST_APP_PASSWORD, TEST_DBS, TEST_OWNER_BASE } from '../src/testing';

/**
 * Cloud SQL on Cloud Run (ADR-0156): the service reaches Postgres only through the unix socket the Cloud SQL
 * connector mounts at /cloudsql/<project>:<region>:<instance>/.s.PGSQL.5432. Here a local relay plays the
 * connector: it listens on a real unix socket with that layout and forwards to the test Postgres. Every
 * connection below therefore goes through the socket, built from AWS-shaped JSON secrets and a socket host.
 */
const CONN = 'thapsus-hr-staging:europe-west2:thapsus-pg';
let root: string;
let socketDir: string;
let relay: net.Server;
let relayed = 0;

const target = new URL(TEST_OWNER_BASE);
const secret = (username: string, password: string, dbname: string = TEST_DBS.shared) =>
  JSON.stringify({ username, password, dbname, port: 5432 });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'thr-sock-'));
  socketDir = join(root, 'cloudsql', CONN);
  mkdirSync(socketDir, { recursive: true });
  relay = net.createServer((client) => {
    relayed++;
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(join(socketDir, '.s.PGSQL.5432'), resolve);
  });
});

afterAll(async () => {
  await closeAllPools();
  await new Promise((r) => relay.close(r));
  rmSync(root, { recursive: true, force: true });
});

const whoAmI = async (url: string) => {
  const before = relayed;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ user: string; db: string; ssl: boolean }>(
      `SELECT current_user AS user, current_database() AS db,
         coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`,
    );
    return { ...rows[0]!, viaSocket: relayed > before };
  } finally {
    await c.end();
  }
};

describe('connections through a Cloud SQL style unix socket', () => {
  it('the app role connects through TenantRouter.fromEnv with DATABASE_SECRET + DATABASE_HOST', async () => {
    const router = TenantRouter.fromEnv({
      CELL_REGION: 'uk',
      DATABASE_SECRET: secret('thapsus_app', TEST_APP_PASSWORD),
      DATABASE_HOST: socketDir,
    });
    const before = relayed;
    const { rows } = await router
      .registryPool()
      .query<{ user: string; db: string }>('SELECT current_user AS user, current_database() AS db');
    expect(rows[0]).toEqual({ user: 'thapsus_app', db: TEST_DBS.shared });
    expect(relayed).toBeGreaterThan(before);
  });

  it('the reporting role connects as the reader with REPORTING_DATABASE_SECRET + REPORTING_DATABASE_HOST', async () => {
    const readers = readersFromEnv({
      REPORTING_DATABASE_SECRET: secret('thapsus_reporting', TEST_APP_PASSWORD),
      REPORTING_DATABASE_HOST: socketDir,
    });
    expect(await whoAmI(readers.shared!)).toEqual({
      user: 'thapsus_reporting',
      db: TEST_DBS.shared,
      ssl: false,
      viaSocket: true,
    });
  });

  it('the back-office role connects with BACKOFFICE_DATABASE_SECRET + DATABASE_HOST, without TLS on the socket', async () => {
    expect(await whoAmI(secretToUrl(secret('thapsus_backoffice', TEST_APP_PASSWORD), socketDir))).toEqual({
      user: 'thapsus_backoffice',
      db: TEST_DBS.shared,
      ssl: false,
      viaSocket: true,
    });
  });

  it('the migrator runs with OWNER_DATABASE_SECRET + DATABASE_HOST (and the socket file path is accepted)', async () => {
    const owner = secret(decodeURIComponent(target.username), decodeURIComponent(target.password));
    const before = relayed;
    expect(
      await migrate({ ownerUrl: secretToUrl(owner, join(socketDir, '.s.PGSQL.5432')), rolePasswords: {} }),
    ).toEqual([]);
    expect(relayed).toBeGreaterThan(before);
  });
});
