import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { coverageMarkdown, US_STATES } from '../scripts/coverage-doc';

describe('jurisdiction packs', () => {
  it('docs/COVERAGE.md is generated from the current pack data', () => {
    const onDisk = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'COVERAGE.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(coverageMarkdown());
  });
  it('lists every US state and DC with its coverage status, and every EU member state with its Pay Transparency status', () => {
    const md = coverageMarkdown();
    const us = md.slice(md.indexOf('## US state coverage'), md.indexOf('## EU Pay Transparency'));
    expect(US_STATES).toHaveLength(51);
    for (const s of US_STATES) expect(us).toMatch(new RegExp(`\\| US-${s} \\|`));
    expect(us).toMatch(/\| US-CA \| \d+ \| ✔ \| ✔ \| ✔ \| ✔ \| — \| state layer modelled \|/);
    expect(us).toMatch(/\| US-AL \| — \|.*federal rules only/);
    const eu = md.slice(md.indexOf('## EU Pay Transparency'), md.indexOf('## Verification log'));
    const rows = eu.split('\n').filter((l) => /^\| [A-Z]{2} \|/.test(l));
    expect(rows).toHaveLength(27);
    expect(rows.every((r) => /\| (transposed|partially_transposed|draft|not_transposed) \|/.test(r))).toBe(true);
  });
  it('every pack passes the validator (official https sources, verification dates, no overlapping versions)', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'scripts', 'validate.ts')], { encoding: 'utf8' });
    expect(out).toMatch(/^OK: \d+ pack file\(s\) valid/);
  });
  it('the validator rejects unscoped rules in subdivided packs, bad codes and wrong parents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    const v = { effectiveFrom: '2020-01-01', effectiveTo: null, value: 1, source: { url: 'https://www.legislation.gov.uk/fictional', title: 'Fictional' }, verifiedOn: '2026-10-18', reviewer: 'test' };
    const write = (name: string, pack: object) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), JSON.stringify({ version: 1, updatedOn: '2026-10-18', holidays: [], ...pack }));
    };
    write('zk.json', { jurisdiction: 'ZK', parent: null, name: 'Fictional kingdom', subdivisions: ['ZK-NTH', 'QQ-X'], rules: [{ key: 'minimum_wage.rates', description: '', versions: [v, { ...v, effectiveFrom: '2030-01-01', regions: ['ZK-STH'] }] }] });
    write('zk-nth.json', { jurisdiction: 'ZK-NTH', parent: 'ZK-OTHER', name: 'Fictional north', rules: [{ key: 'minimum_wage.rates', description: '', versions: [{ ...v, regions: ['ZK-NTH'] }] }] });
    write('zc-a-b-c.json', { jurisdiction: 'ZC-A-B-C', parent: 'ZC-A-B', name: 'Too deep', rules: [] });
    try {
      let out = '';
      try {
        execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'scripts', 'validate.ts'), dir], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        out = String((e as { stderr?: string }).stderr);
      }
      expect(out).toMatch(/zk\.json minimum_wage\.rates v0: pack declares subdivisions, so the version must list the regions/);
      expect(out).toMatch(/zk\.json minimum_wage\.rates v1: region ZK-STH is not one of the pack's subdivisions/);
      expect(out).toMatch(/zk\.json: subdivision QQ-X must be an ISO 3166-2 code under ZK/);
      expect(out).toMatch(/zk-nth\.json: parent must be ZK/);
      expect(out).toMatch(/zk-nth\.json minimum_wage\.rates v0: regions are only allowed in packs that declare subdivisions/);
      expect(out).toMatch(/zc-a-b-c\.json: jurisdiction code ZC-A-B-C is not/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
