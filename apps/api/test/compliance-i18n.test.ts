import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUES, flatten } from '@thapsus/core/i18n';
import { rules } from '@thapsus/rules';

/**
 * Every message key the compliance centre uses exists in the catalogues — static keys found in the
 * source, and dynamic keys built from pack data (document lists, EEO-1 categories, transposition
 * statuses, qualifying periods) so a new pack value cannot reach the UI untranslated.
 */
const root = join(__dirname, '..', '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) =>
    statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : [],
  );
const sources = [
  ...files(join(root, 'apps/web/app/app/compliance')),
  ...files(join(root, 'apps/api/src/modules/compliance')),
].map((f) => readFileSync(f, 'utf8'));
const gb = flatten(CATALOGUES['en-GB']);
const us = flatten(CATALOGUES['en-US']);

describe('compliance message keys', () => {
  it('static keys used in the pages, jobs and notifications exist in en-GB and en-US', () => {
    const keys = new Set<string>();
    for (const s of sources) {
      for (const m of s.matchAll(/(?:\bt\(|\btext\(\s*locale,\s*)['"`](compliance\.[A-Za-z0-9_.]+)['"`]/g))
        keys.add(m[1]!);
      for (const m of s.matchAll(/['"`](notify\.[A-Za-z0-9_.]+)['"`]/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(100);
    // a plural family (ADR-0151) is used by its base key: compliance.matrix.daysLeft → daysLeft_one / daysLeft_other
    const has = (flat: Record<string, string>, k: string) => k in flat || `${k}_other` in flat;
    const missing = [...keys].filter((k) => !has(gb, k) || !has(us, k));
    expect(missing).toEqual([]);
  });

  it('keys built from pack data and enumerations exist', () => {
    const book = rules();
    const rtw = book.resolve<{
      methods: Array<{ id: string }>;
      listTypes: string[];
      documentCatalogue: Record<string, string[]>;
    }>('GB', 'right_to_work.document_rules', '2026-10-18').value;
    const eeo = book.resolve<{
      jobCategories: string[];
      raceEthnicityCategories: string[];
      sexCategories: string[];
    }>('US', 'reporting.eeo1', '2026-10-18').value;
    const statuses = book
      .jurisdictions()
      .flatMap((p) =>
        p.rules
          .filter((r) => r.key === 'reporting.pay_transparency')
          .flatMap((r) => r.versions.map((v) => (v.value as { status?: string }).status)),
      )
      .filter((s): s is string => !!s);
    const periods = book
      .jurisdictions()
      .flatMap((p) =>
        p.rules
          .filter((r) => r.key === 'employment.unfair_dismissal_qualifying_period')
          .flatMap((r) => r.versions.map((v) => (v.value as { qualifyingPeriod: string }).qualifyingPeriod)),
      );
    const expected = [
      ...rtw.methods.map((m) => `compliance.rtw.methodName.${m.id}`),
      ...rtw.listTypes.map((l) => `compliance.rtw.list.${l}`),
      ...Object.values(rtw.documentCatalogue)
        .flat()
        .map((d) => `compliance.rtw.document.${d}`),
      ...eeo.jobCategories.map((j) => `compliance.job.${j}`),
      ...eeo.raceEthnicityCategories.map((r) => `compliance.race.${r}`),
      ...eeo.sexCategories.map((s) => `compliance.sex.${s}`),
      ...statuses.map((s) => `compliance.ptStatus.${s}`),
      ...periods.map((p) => `compliance.period.${p}`),
      ...[
        'missing',
        'valid',
        'follow_up_due',
        'expired',
        'retention',
        'compliant',
        'expiring',
        'section1_due',
        'section2_due',
        'section2_overdue',
        'complete',
        'reverification_due',
        'reverification_overdue',
        'exempt',
        'exempt_at_risk',
        'non_exempt',
        'unclassified',
      ].map((s) => `compliance.status.${s}`),
      ...['licence', 'certification', 'background_check', 'training', 'other'].map(
        (k) => `compliance.kind.${k}`,
      ),
      ...['lower', 'lower_middle', 'upper_middle', 'upper'].map((b) => `compliance.band.${b}`),
      ...['probation_ending', 'unfair_dismissal_qualifying_period'].map((a) => `compliance.alert.${a}`),
      ...['pay_report_inputs', 'employee_pay'].map((d) => `compliance.gpg.dataSource.${d}`),
      ...[
        'overview',
        'rightToWork',
        'i9',
        'matrix',
        'genderPayGap',
        'eeo1',
        'payTransparency',
        'lawChanges',
      ].map((n) => `compliance.nav.${n}`),
      ...['gap', 'medianGap', 'variableGap', 'medianVariableGap', 'variableWomen', 'variableMen'].map(
        (k) => `compliance.pt.${k}`,
      ),
      'app.nav.compliance',
      'tasks.source.compliance',
    ];
    expect(expected.filter((k) => !(k in gb) || !(k in us))).toEqual([]);
  });

  it('en-US uses US spelling where it differs', () => {
    expect(us['compliance.title']).toBe('Compliance center');
    expect(us['compliance.kind.licence']).toBe('License');
    expect(gb['compliance.title']).toBe('Compliance centre');
  });
});
