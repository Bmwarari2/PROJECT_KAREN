import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lintMigration, loadMigrations, MIGRATION_FILE, MIGRATIONS_DIR } from '../src/migrate';

const dir = mkdtempSync(join(tmpdir(), 'thapsus-migrations-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('migration files', () => {
  it('accepts NNNN_ and NNNNx_ names and orders a letter suffix between its neighbours', () => {
    expect(MIGRATION_FILE.test('0010_rotas_time.sql')).toBe(true);
    expect(MIGRATION_FILE.test('0010b_rotas_time_ext.sql')).toBe(true);
    expect(MIGRATION_FILE.test('10_bad.sql')).toBe(false);
    expect(['0011_next.sql', '0010b_mid.sql', '0010_first.sql'].sort()).toEqual([
      '0010_first.sql',
      '0010b_mid.sql',
      '0011_next.sql',
    ]);
  });

  it('loads letter-suffixed follow-up migrations (0009b_…) after their base and before the next number', () => {
    for (const f of [
      '0010_next.sql',
      '0009b_follow_up.sql',
      '0009_base.sql',
      '0009c_second_follow_up.sql',
      'README.md',
      '9_bad.sql',
    ])
      writeFileSync(join(dir, f), '-- fictional\n');
    expect(loadMigrations(dir).map((m) => m.name)).toEqual([
      '0009_base.sql',
      '0009b_follow_up.sql',
      '0009c_second_follow_up.sql',
      '0010_next.sql',
    ]);
  });

  it('every migration in the repository is picked up (none silently ignored) and passes the expand-and-contract lint', () => {
    const sql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const names = loadMigrations().map((m) => m.name);
    expect(names).toEqual(sql);
    expect(names.indexOf('0010b_rotas_time_ext.sql')).toBe(names.indexOf('0010_rotas_time.sql') + 1);
    for (const m of loadMigrations()) expect(lintMigration(m)).toEqual([]);
  });
});
