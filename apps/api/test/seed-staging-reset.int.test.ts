import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantRouter, withRegistry } from '@thapsus/db';
import { appUrl, resetDatabase } from '@thapsus/db/testing';
import { InMemoryDirectory } from '../src/lib/directory';
import { LocalKeyProvider } from '../src/lib/kms';
import { MemoryObjectStore } from '../src/lib/object-store';
import {
  LOGIN_ROLES,
  MIN_SIZE,
  StagingConfigError,
  stagingConfigFromEnv,
  type StagingLogin,
} from '../src/cli/staging/config';
import { resetStagingWorkspace } from '../src/cli/staging/reset';
import type { PurgeDeps } from '../src/modules/privacy/company';
import { seedStaging, type StagingSeedResult } from '../src/cli/staging/seed';
import { closeDb, randomIp, signup, startTestApp, type TestContext } from './helpers';

/**
 * The staging reset (ADR-0185): the seeded fictional workspace is deleted through the verified purge and
 * seeded again under the same name; a workspace the seed did not create is never deleted.
 */
const DB = 'thapsus_seed_staging_reset';
const SIZE = MIN_SIZE;
const logins: StagingLogin[] = stagingConfigFromEnv({
  APP_ENV: 'staging',
  STAGING_SEED_EMPLOYEES: String(SIZE),
  STAGING_LOGINS: JSON.stringify({
    workspace: 'kestrel',
    logins: LOGIN_ROLES.map((role) => ({
      role,
      email: `${role.replace('_', '-')}@reset.example.test`,
      password: `Quarry-Beacon-${role.length}-Moss-Qz`,
    })),
  }),
}).logins;

let router: TenantRouter;
let directory: InMemoryDirectory;
let objects: MemoryObjectStore;
let ctx: TestContext;
let first: StagingSeedResult;
// only what the purge uses, as the seed job builds it (cli/staging/deps.ts): not the API's dependencies
let purge: PurgeDeps;
const noLog = () => {};
const seed = () =>
  seedStaging(
    { router, directory, keys: new LocalKeyProvider('6b'.repeat(32)), objects },
    { workspace: 'kestrel', logins, size: SIZE },
  );

beforeAll(async () => {
  await resetDatabase(DB);
  router = new TenantRouter({ databases: { shared: appUrl(DB) }, cacheTtlMs: 0, cell: 'uk' });
  directory = new InMemoryDirectory();
  objects = new MemoryObjectStore();
  first = await seed();
  ctx = await startTestApp({
    listen: false,
    directory,
    overrides: { router, keys: new LocalKeyProvider('6b'.repeat(32)), objects },
  });
  purge = {
    router,
    directory,
    objects,
    limiter: ctx.deps.limiter,
    mailer: ctx.deps.mailer,
    now: () => new Date(),
    config: { env: 'test' },
  };
}, 600_000);
afterAll(async () => {
  await ctx?.close();
  await closeDb();
});

describe('staging reset', () => {
  it('never deletes a workspace the staging seed did not create', async () => {
    const other = await signup(ctx, 'kestrel-lookalike');
    await expect(resetStagingWorkspace(purge, 'kestrel-lookalike', noLog)).rejects.toBeInstanceOf(
      StagingConfigError,
    );
    expect((await directory.byId(other.tenantId))?.status).toBe('active');
  });

  it('reports nothing to do for a name that is not in use', async () => {
    expect(await resetStagingWorkspace(purge, 'kestrel-unused', noLog)).toBe('nothing to reset');
  });

  it('deletes the seeded workspace everywhere, then the seed builds it again under the same name', async () => {
    expect(first.dataSeeded).toBe(true);
    expect((await objects.list(`${first.tenantId}/`)).length).toBeGreaterThan(0);
    expect(await resetStagingWorkspace(purge, 'kestrel', noLog)).toBe('reset');

    // the old workspace: purged, certified, and its name retired
    const old = await withRegistry(router, (tx) =>
      tx.one<{ slug: string; status: string }>(
        'SELECT slug, status FROM registry.tenants WHERE tenant_id = $1',
        [first.tenantId],
      ),
    );
    expect(old.status).toBe('deleted');
    expect(old.slug).toMatch(/^kestrel-r\d{12}$/);
    expect((await directory.byId(first.tenantId))?.slug).toBe(old.slug);
    expect(await directory.bySlug('kestrel')).toBeUndefined();
    // the purge verified every table, file and cache key empty and recorded one certificate
    const certificates = await withRegistry(router, (tx) =>
      tx.query<{ certificate: { database: { verifiedEmpty: boolean }; files: { verifiedEmpty: boolean } } }>(
        'SELECT certificate FROM registry.deletion_certificates WHERE tenant_id = $1',
        [first.tenantId],
      ),
    );
    expect(certificates).toHaveLength(1);
    expect(certificates[0]!.certificate.database.verifiedEmpty).toBe(true);
    expect(certificates[0]!.certificate.files.verifiedEmpty).toBe(true);
    expect(await objects.list(`${first.tenantId}/`)).toEqual([]);

    // a fresh workspace with the same name and the same sign-ins
    const again = await seed();
    expect(again).toMatchObject({ tenantCreated: true, dataSeeded: true });
    expect(again.tenantId).not.toBe(first.tenantId);
    expect((await directory.bySlug('kestrel'))?.tenantId).toBe(again.tenantId);
    const owner = logins.find((l) => l.role === 'owner')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: randomIp(),
      payload: { tenant: 'kestrel', email: owner.email, password: owner.password },
    });
    expect(res.statusCode, res.body).toBe(200);
  }, 600_000);
});
