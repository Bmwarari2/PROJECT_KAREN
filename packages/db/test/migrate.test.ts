import { describe, expect, it } from 'vitest';
import { lintMigration, loadMigrations, MIGRATION_NAME } from '../src/migrate';

describe('migration files', () => {
  it('accepts NNNN_ and NNNNx_ names and orders a letter suffix between its neighbours', () => {
    expect(MIGRATION_NAME.test('0010_rotas_time.sql')).toBe(true);
    expect(MIGRATION_NAME.test('0010b_rotas_time_ext.sql')).toBe(true);
    expect(MIGRATION_NAME.test('10_bad.sql')).toBe(false);
    expect(['0011_next.sql', '0010b_mid.sql', '0010_first.sql'].sort()).toEqual(['0010_first.sql', '0010b_mid.sql', '0011_next.sql']);
  });

  it('every migration in the repository is picked up (none silently ignored) and passes the expand-and-contract lint', () => {
    const names = loadMigrations().map((m) => m.name);
    expect(names).toContain('0010b_rotas_time_ext.sql');
    expect(names.indexOf('0010b_rotas_time_ext.sql')).toBe(names.indexOf('0010_rotas_time.sql') + 1);
    for (const m of loadMigrations()) expect(lintMigration(m)).toEqual([]);
  });
});
