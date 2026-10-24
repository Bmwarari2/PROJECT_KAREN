import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DETECTION_RULES,
  WATCHED_AUDIT_ACTIONS,
  catalogueProblems,
  rulesInForce,
  type DetectionRule,
} from '../src/security';
import { CATALOGUES, flatten } from '../src/i18n/catalogues';

/** The detection rule catalogue (ADR-0177): versioned, effective-dated data with fixtures and tuning notes. */
describe('detection rule catalogue', () => {
  it('is valid: ids, MITRE ATT&CK ids, known signals, fixtures, tuning notes and version chains', () => {
    expect(catalogueProblems()).toEqual([]);
  });

  it('ships at least 20 active rules across every area the plan names, and lists the cloud rules as planned', () => {
    const active = DETECTION_RULES.filter((r) => r.status === 'active');
    expect(active.length).toBeGreaterThanOrEqual(20);
    expect(new Set(active.map((r) => r.area))).toEqual(
      new Set(['credential', 'takeover', 'privilege', 'exfiltration', 'probing', 'staff', 'deception', 'ai']),
    );
    const planned = DETECTION_RULES.filter((r) => r.status === 'planned');
    expect(planned.some((r) => /GuardDuty/.test(r.needs!))).toBe(true);
    expect(planned.some((r) => /Security Hub/.test(r.needs!))).toBe(true);
    expect(planned.every((r) => !r.logic && !r.fixture)).toBe(true);
  });

  it('has a name and summary for every rule in both message catalogues', () => {
    for (const cat of [flatten(CATALOGUES['en-GB']), flatten(CATALOGUES['en-US'])])
      for (const r of DETECTION_RULES)
        for (const k of ['name', 'summary'])
          expect(cat[`backoffice.security.rules.${r.id}.${k}`], `${r.id}.${k}`).toBeTruthy();
  });

  it('picks the version in force on a date (half-open validity)', () => {
    const base = DETECTION_RULES.find((r) => r.id === 'THR-CRED-001')!;
    const v1: DetectionRule = { ...base, effectiveTo: '2027-01-01' };
    const v2: DetectionRule = { ...base, version: 2, effectiveFrom: '2027-01-01' };
    expect(catalogueProblems([v1, v2])).toEqual([]);
    expect(rulesInForce('2026-12-31', [v1, v2]).map((r) => r.version)).toEqual([1]);
    expect(rulesInForce('2027-01-01', [v1, v2]).map((r) => r.version)).toEqual([2]);
    expect(rulesInForce('2026-10-23', [v1, v2])).toEqual([]);
    expect(catalogueProblems([v1, { ...v2, effectiveFrom: '2027-02-01' }])).toEqual([
      'THR-CRED-001: version 1 must end when version 2 starts',
    ]);
  });

  it('agrees with the audit trigger of migration 0027 on the watched actions', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'db', 'migrations', '0027_security_monitoring.sql'),
      'utf8',
    );
    const list = /audit_events_security_signals AFTER INSERT[\s\S]*?ARRAY\[([\s\S]*?)\]\)\)/.exec(sql)![1]!;
    const names = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...WATCHED_AUDIT_ACTIONS].sort());
  });
});
