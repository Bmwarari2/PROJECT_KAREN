import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, MIGRATIONS_DIR } from '../src/migrate';

const dir = mkdtempSync(join(tmpdir(), 'thapsus-migrations-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('migration files', () => {
  it('loads letter-suffixed follow-up migrations (0009b_…) after their base and before the next number', () => {
    for (const f of ['0010_next.sql', '0009b_follow_up.sql', '0009_base.sql', '0009c_second_follow_up.sql', 'README.md', '9_bad.sql']) writeFileSync(join(dir, f), '-- fictional\n');
    expect(loadMigrations(dir).map((m) => m.name)).toEqual(['0009_base.sql', '0009b_follow_up.sql', '0009c_second_follow_up.sql', '0010_next.sql']);
  });
  it('every file in the migrations directory is picked up (none silently skipped by the name filter)', async () => {
    const { readdirSync } = await import('node:fs');
    const sql = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(loadMigrations().map((m) => m.name)).toEqual(sql);
  });
});
