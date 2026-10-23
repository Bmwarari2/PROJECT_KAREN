import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintMigration, loadMigrations } from './migrate';

describe('migration files', () => {
  it('loads lettered migrations between their neighbours (0007 < 0007b < 0008)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thr-mig-'));
    for (const f of [
      '0008_next.sql',
      '0007b_inserted.sql',
      '0007_base.sql',
      '0007_base.txt',
      'notes.sql',
      '0007B_upper.sql',
    ])
      writeFileSync(join(dir, f), 'SELECT 1;');
    expect(loadMigrations(dir).map((m) => m.name)).toEqual([
      '0007_base.sql',
      '0007b_inserted.sql',
      '0008_next.sql',
    ]);
  });

  it('every repository migration is picked up and passes the expand-and-contract lint', () => {
    const all = loadMigrations();
    expect(all.map((m) => m.name)).toContain('0007b_emergency_contacts_effective_dating.sql');
    expect(all.flatMap(lintMigration)).toEqual([]);
  });
});
