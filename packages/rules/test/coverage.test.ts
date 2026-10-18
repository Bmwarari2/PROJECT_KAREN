import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { coverageMarkdown } from '../scripts/coverage-doc';

describe('jurisdiction packs', () => {
  it('docs/COVERAGE.md is generated from the current pack data', () => {
    const onDisk = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'COVERAGE.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(coverageMarkdown());
  });
  it('every pack passes the validator (official https sources, verification dates, no overlapping versions)', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'scripts', 'validate.ts')], { encoding: 'utf8' });
    expect(out).toMatch(/^OK: \d+ pack file\(s\) valid/);
  });
});
