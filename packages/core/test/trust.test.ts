import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATED, serialise, trustData } from '../scripts/trust-data';
import { LEGAL, TRUST } from '../src/trust';

const ROOT = join(__dirname, '..', '..', '..');

describe('trust data', () => {
  it('generated.json matches docs/SUBPROCESSORS.md and docs/legal (run pnpm --filter @thapsus/core trust-data)', () => {
    expect(readFileSync(GENERATED, 'utf8').replace(/\r\n/g, '\n')).toBe(serialise(trustData()));
  });

  it('lists the core sub-processor for every region and a change log', () => {
    const core = TRUST.subprocessors.sections.find((s) => s.title.startsWith('Core infrastructure'))!;
    expect(core.columns).toEqual(expect.arrayContaining(['UK tenants', 'EU tenants', 'US tenants']));
    expect(core.rows.length).toBeGreaterThan(0);
    expect(TRUST.subprocessors.changes[0]).toMatchObject({ type: 'baseline' });
  });

  it('every sub-processor change gives at least the configured notice (except the baseline)', () => {
    for (const c of TRUST.subprocessors.changes.filter((x) => x.type !== 'baseline')) {
      const days = (Date.parse(c.effectiveFrom) - Date.parse(c.announced)) / 86_400_000;
      expect(days, c.id).toBeGreaterThanOrEqual(LEGAL.subprocessorNoticeDays);
    }
  });

  it('legal templates carry the DRAFT banner and a version', () => {
    for (const t of ['uk', 'eu', 'us'] as const) {
      expect(TRUST.notices[t].body).toContain('DRAFT — for legal review');
      expect(TRUST.dpa[t].version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const f of [
      'dpia-template',
      'records-of-processing',
      'dpa-uk',
      'dpa-eu',
      'dpa-us',
      'privacy-notice-uk',
      'privacy-notice-eu',
      'privacy-notice-us',
    ]) {
      expect(
        readFileSync(join(ROOT, 'docs', 'legal', `${f}.md`), 'utf8')
          .split('\n')
          .slice(0, 4)
          .join('\n'),
        f,
      ).toContain('DRAFT — for legal review');
    }
  });

  it('the backup expiry stated to customers matches the longest backup retention in the infrastructure config', () => {
    for (const env of ['dev', 'staging', 'prod'] as const) {
      const cfg = JSON.parse(readFileSync(join(ROOT, 'infra', 'config', `${env}.json`), 'utf8')) as {
        aurora: { backupRetentionDays: number };
        backup: Record<string, number>;
        logRetentionDays: number;
      };
      const longest = Math.max(cfg.aurora.backupRetentionDays, ...Object.values(cfg.backup));
      expect(LEGAL.backupRetentionDays[env], env).toBe(longest);
      expect(LEGAL.logRetentionDays[env], env).toBe(cfg.logRetentionDays);
    }
  });
});
