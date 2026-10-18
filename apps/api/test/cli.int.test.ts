import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { appUrl, ownerUrl, resetDatabase } from '@thapsus/db/testing';

/** `pnpm db:seed` and `pnpm synth:enterprise` run as real processes against fresh, migrated databases. */
const run = promisify(execFile);
const apiDir = join(import.meta.dirname, '..');
const pools: pg.Pool[] = [];
const db = (name: string) => {
  const p = new pg.Pool({ connectionString: ownerUrl(name), max: 2 });
  pools.push(p);
  return p;
};
const cliEnv = (name: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  DATABASE_URL: appUrl(name),
  MIGRATOR_DATABASE_URL: ownerUrl(name),
  APP_ENV: 'test',
  CELL_REGION: 'uk',
  LOCAL_KMS_KEY: '55'.repeat(32),
  OTEL_SDK_DISABLED: 'true',
  DIRECTORY_DATABASE_URL: '',
  DIRECTORY_TABLE: '',
  ...extra,
});
const tsx = (script: string, env: NodeJS.ProcessEnv) => run('npx', ['tsx', script], { cwd: apiDir, env, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('pnpm db:seed', () => {
  it('creates the small fictional UK demo company (≈25 employees, one legal entity) and is idempotent', async () => {
    await resetDatabase('thapsus_cli_seed');
    await tsx('src/cli/seed.ts', cliEnv('thapsus_cli_seed'));
    const q = db('thapsus_cli_seed');
    const tenant = await q.query<{ tenant_id: string; slug: string; home_region: string }>(`SELECT tenant_id, slug, home_region FROM app.tenants`);
    expect(tenant.rows).toEqual([expect.objectContaining({ slug: 'demo', home_region: 'uk' })]);
    const counts = await q.query<{ employees: number; entities: number; country: string }>(
      `SELECT (SELECT count(*)::int FROM app.employees) AS employees, (SELECT count(*)::int FROM app.legal_entities) AS entities, (SELECT min(country) FROM app.legal_entities) AS country`,
    );
    expect(counts.rows[0]).toEqual({ employees: 25, entities: 1, country: 'GB' });
    const personas = await q.query<{ email: string }>(`SELECT email FROM app.users ORDER BY email`);
    expect(personas.rows.map((r) => r.email.split('@')[0])).toEqual(expect.arrayContaining(['owner', 'hr', 'manager', 'employee', 'payroll']));
    const again = await tsx('src/cli/seed.ts', cliEnv('thapsus_cli_seed'));
    expect(again.stdout).toContain('already seeded');
    expect((await q.query<{ n: number }>('SELECT count(*)::int AS n FROM app.employees')).rows[0]!.n).toBe(25);
  });
});

describe('pnpm synth:enterprise', () => {
  const digest = async (name: string) => {
    const q = db(name);
    const r = await q.query<{ employees: number; entities: number; countries: number; users: number; h: string }>(
      `SELECT (SELECT count(*)::int FROM app.employees) AS employees,
              (SELECT count(*)::int FROM app.legal_entities) AS entities,
              (SELECT count(DISTINCT country)::int FROM app.legal_entities) AS countries,
              (SELECT count(*)::int FROM app.users) AS users,
              (SELECT md5(string_agg(concat_ws('|', id, employee_number, display_name, entity_id, manager_id, start_date, country), ',' ORDER BY id)) FROM app.employees) AS h`,
    );
    return r.rows[0]!;
  };

  it('is deterministic and spans 50 legal entities across the UK, EU and US (small N)', async () => {
    const env = { SYNTH_EMPLOYEES: '400', SYNTH_USERS: '20' };
    for (const name of ['thapsus_cli_synth_a', 'thapsus_cli_synth_b']) {
      await resetDatabase(name);
      await tsx('src/cli/synth-enterprise.ts', cliEnv(name, env));
    }
    const a = await digest('thapsus_cli_synth_a');
    const b = await digest('thapsus_cli_synth_b');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ employees: 400, entities: 50, users: 21 }); // 20 load-test users + the owner
    const regions = await db('thapsus_cli_synth_a').query<{ c: string }>(`SELECT DISTINCT left(country, 2) AS c FROM app.legal_entities`);
    const set = new Set(regions.rows.map((r) => r.c));
    expect(set.has('GB') && set.has('US') && set.has('DE')).toBe(true);
    // every employee has effective-dated history rows
    const missing = await db('thapsus_cli_synth_a').query<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees e WHERE NOT EXISTS (SELECT 1 FROM app.employee_jobs j WHERE j.employee_id = e.id)`);
    expect(missing.rows[0]!.n).toBe(0);
  });
});
