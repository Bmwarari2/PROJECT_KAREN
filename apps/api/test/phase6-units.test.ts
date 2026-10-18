import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { canonicalJson, type PayrollInputs } from '../src/modules/payroll/inputs';
import { cellFor, defaultMapping, formatDate, mapInputs, ratioToDecimal, validateMapping, type FieldMapping } from '../src/modules/payroll/mapping';
import { renderCsv, renderCsvBundle, safeText } from '../src/modules/payroll/render';
import { xeroDocument } from '../src/modules/payroll/connectors/xero';
import { CONNECTORS, CONNECTOR_KINDS } from '../src/modules/payroll/connectors';
import { assertIntegrationUrl, INTEGRATION_HOSTS, providerErrorCode } from '../src/modules/integrations/http';
import { buildPlan, principalNameFor, ruleMatches, type PlanEmployee, type PlanRule } from '../src/modules/it/plan';
import { candidates, decide, expandUploads, MAX_FILE_BYTES } from '../src/modules/payslips/matching';

const inputs: PayrollInputs = {
  version: 1,
  period: { id: 'p', name: 'June 2026', entityId: null, frequency: 'monthly', startDate: '2026-06-01', endDate: '2026-06-30', payDate: '2026-06-26' },
  employees: [{ employeeId: 'e1', employeeNumber: 'E1', firstName: 'Ada', lastName: '=Fictional', displayName: 'Ada =Fictional', entityId: null, country: 'GB' }],
  hours: [{ employeeId: 'e1', employeeNumber: 'E1', weekStart: '2026-06-01', weekEnd: '2026-06-07', workedMinutes: 2401, regularMinutes: 2400, overtimeMinutes: 1, doubleMinutes: 0, approvedAt: '2026-06-08T10:00:00.000Z' }],
  absences: [{ employeeId: 'e1', employeeNumber: 'E1', leaveRequestId: 'l1', leaveType: 'annual', leaveCategory: 'annual', paid: true, startDate: '2026-06-10', endDate: '2026-06-10', days: 0.5, hours: 4 }],
  sickPay: [],
  payChanges: [{ employeeId: 'e1', employeeNumber: 'E1', effectiveDate: '2026-06-15', amountMinor: 3_150_050, currency: 'GBP', frequency: 'annual', previousAmountMinor: null, previousCurrency: null, previousFrequency: null }],
  starters: [],
  leavers: [],
};

describe('payroll field mapping (unit)', () => {
  it('formats durations and decimals with integer arithmetic (half away from zero)', () => {
    expect(ratioToDecimal(2550, 60, 2)).toBe('42.50');
    expect(ratioToDecimal(1, 60, 2)).toBe('0.02');
    expect(ratioToDecimal(50, 60, 2)).toBe('0.83');
    expect(ratioToDecimal(90, 60, 0)).toBe('2');
    expect(ratioToDecimal(-90, 60, 1)).toBe('-1.5');
  });
  it('formats civil dates without time zones', () => {
    expect(['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy', 'dd.MM.yyyy', 'yyyyMMdd', 'dd-MM-yyyy'].map((f) => formatDate('2026-03-07', f as never))).toEqual(['2026-03-07', '07/03/2026', '03/07/2026', '07.03.2026', '20260307', '07-03-2026']);
  });
  it('applies money, code map, boolean and decimal-separator transforms', () => {
    const m: FieldMapping = { ...defaultMapping(), decimalSeparator: ',', delimiter: ';' };
    const row = inputs.payChanges[0] as unknown as Record<string, unknown>;
    expect(cellFor('payChanges', { header: 'a', field: 'amount' }, row, inputs.employees[0], inputs, m)).toMatchObject({ text: '31500,50', number: 31500.5 });
    expect(cellFor('payChanges', { header: 'a', field: 'amount', transform: { type: 'money', unit: 'minor' } }, row, inputs.employees[0], inputs, m).text).toBe('3150050');
    const abs = inputs.absences[0] as unknown as Record<string, unknown>;
    expect(cellFor('absences', { header: 'c', field: 'leaveType', transform: { type: 'codeMap', map: { annual: 'HOL' } } }, abs, undefined, inputs, m).text).toBe('HOL');
    expect(cellFor('absences', { header: 'c', field: 'leaveCategory', transform: { type: 'codeMap', map: {}, default: 'OTH' } }, abs, undefined, inputs, m).text).toBe('OTH');
    expect(cellFor('absences', { header: 'd', field: 'days', transform: { type: 'number', decimals: 2 } }, abs, undefined, inputs, m).text).toBe('0,50');
    expect(cellFor('absences', { header: 'p', field: 'paid' }, abs, undefined, inputs, m).text).toBe('true');
    expect(cellFor('absences', { header: 'x', field: 'payDate' }, abs, undefined, inputs, m).text).toBe('2026-06-26');
  });
  it('the default mapping is valid for every section; validation catches mistakes', () => {
    expect(validateMapping(defaultMapping())).toEqual([]);
    expect(validateMapping({ ...defaultMapping(), delimiter: ',', decimalSeparator: ',' })).toContain('delimiter and decimalSeparator must differ');
    expect(validateMapping({ ...defaultMapping(), sections: { hours: { enabled: true, columns: [{ header: 'a', field: 'weekStart' }, { header: 'a', value: 'x' }] } } })).toEqual(['sections.hours.columns[1]: duplicate header a']);
    expect(validateMapping({ ...defaultMapping(), sections: { hours: { enabled: true, columns: [{ header: 'a', field: 'weekStart', value: 'x' }] } } })[0]).toContain('exactly one of field or value');
  });
  it('CSV output quotes, neutralises formulas in text cells and keeps numbers as numbers', () => {
    expect(safeText('=cmd')).toBe("'=cmd");
    expect(safeText('-5')).toBe("'-5");
    const [hours] = mapInputs(inputs, { ...defaultMapping(), sections: { hours: { enabled: true, columns: [{ header: 'Name, full', field: 'employeeName' }, { header: 'Surname', field: 'lastName' }, { header: 'OT', field: 'overtimeHours' }, { header: 'Q', value: 'say "hi"' }] } } });
    expect(renderCsv(hours!, defaultMapping())).toBe(`"Name, full",Surname,OT,Q\r\nAda =Fictional,'=Fictional,0.02,"say ""hi"""\r\n`);
  });
  it('a multi-section CSV zip is byte-identical across runs and canonical JSON ignores key order', async () => {
    const tables = mapInputs(inputs, defaultMapping());
    const a = await renderCsvBundle(tables, defaultMapping(), 'x', '2026-06-30');
    await new Promise((r) => setTimeout(r, 1100)); // a different wall-clock second must not change the bytes
    const b = await renderCsvBundle(tables, defaultMapping(), 'x', '2026-06-30');
    expect(a.body.equals(b.body)).toBe(true);
    const zip = await JSZip.loadAsync(a.body);
    expect(Object.values(zip.files).every((f) => f.date.toISOString() === '2026-06-30T00:00:00.000Z')).toBe(true);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it('Xero document: hours per earnings rate in units of hours; unmapped items are listed, never guessed', () => {
    const doc = xeroDocument(inputs, { payrollCalendarId: 'cal', earningsRates: { regular: 'r' }, leaveTypes: {} });
    expect(doc.timesheets).toEqual([{ employeeNumber: 'E1', payload: { payrollCalendarID: 'cal', employeeID: null, startDate: '2026-06-01', endDate: '2026-06-30', timesheetLines: [{ date: '2026-06-01', earningsRateID: 'r', numberOfUnits: 40 }] } }]);
    expect(doc.unmapped).toEqual([
      { section: 'hours', employeeNumber: 'E1', reason: 'earningsRateNotMapped:overtime', ref: '2026-06-01' },
      { section: 'absences', employeeNumber: 'E1', reason: 'leaveTypeNotMapped:annual', ref: '2026-06-10' },
    ]);
  });
  it('the registry has every connector kind; stubs refuse with a pointer to the docs', async () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual([...CONNECTOR_KINDS].sort());
    for (const k of ['adp', 'workday', 'ukg', 'gusto', 'datev'] as const) {
      expect(CONNECTORS[k].status).toBe('stub');
      await expect(CONNECTORS[k].render(inputs, {} as never)).rejects.toThrow(/not available yet.*docs\/integrations\.md#/);
    }
    const docs = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'integrations.md'), 'utf8');
    for (const k of CONNECTOR_KINDS) expect(docs, `docs/integrations.md documents ${k}`).toContain(`<a id="${CONNECTORS[k].docs.split('#')[1]}"></a>`);
  });
});

describe('outbound integrations allow-list (unit)', () => {
  it('every allowed host is listed in docs/SUBPROCESSORS.md with its integration', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'SUBPROCESSORS.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## Customer-directed integrations'));
    for (const [host, label] of Object.entries(INTEGRATION_HOSTS)) {
      expect(section, host).toContain(`\`${host}\``);
      expect(section, label).toContain(label);
    }
  });
  it('refuses any other host and plain HTTP; error bodies are reduced to a code', () => {
    expect(() => assertIntegrationUrl('https://graph.microsoft.com/v1.0/users')).not.toThrow();
    for (const u of ['http://graph.microsoft.com/v1.0/users', 'https://evil.example/collect', 'https://graph.microsoft.com.evil.example/x']) expect(() => assertIntegrationUrl(u)).toThrow(/not allowed/);
    expect(providerErrorCode({ error: { code: 'Request_BadRequest', message: 'Ada Fictional already exists' } })).toBe('Request_BadRequest');
    expect(providerErrorCode({ error: 'invalid_grant', error_description: 'x' })).toBe('invalid_grant');
  });
});

describe('IT plans (unit)', () => {
  const e: PlanEmployee = { employeeId: 'e', employeeNumber: 'E000123', firstName: 'Zoë', lastName: 'de la Fictión', preferredName: null, displayName: 'Zoë de la Fictión', jobTitle: 'Engineer', department: 'R&D', departmentId: 'd1', entityId: 'en1', locationId: 'l1', country: 'GB', workEmail: null };
  it('user names are ASCII-folded from the format, or the work email in the domain', () => {
    expect(principalNameFor(e, 'fictional.example')).toBe('zoe.delafiction@fictional.example');
    expect(principalNameFor(e, 'fictional.example', '{f}{last}')).toBe('zdelafiction@fictional.example');
    expect(principalNameFor(e, 'fictional.example', '{first}.{number}')).toBe('zoe.e000123@fictional.example');
    expect(principalNameFor({ ...e, workEmail: 'Zoe@Fictional.Example' }, 'fictional.example')).toBe('zoe@fictional.example');
    expect(principalNameFor({ ...e, workEmail: 'zoe@other.example' }, 'fictional.example')).toBe('zoe.delafiction@fictional.example');
  });
  it('rules match on entity, department, location and job title', () => {
    const r = (match: PlanRule['match']): PlanRule => ({ id: 'r', name: 'r', priority: 1, match, licences: [], groups: [], org_unit_path: null });
    expect(ruleMatches(r({}), e)).toBe(true);
    expect(ruleMatches(r({ departmentId: 'd1', jobTitleContains: 'ENGIN' }), e)).toBe(true);
    expect(ruleMatches(r({ entityId: 'other' }), e)).toBe(false);
  });
  it('Google licences default to the Google-Apps product; leavers without a known account are skipped', () => {
    const rules: PlanRule[] = [{ id: 'r', name: 'r', priority: 1, match: {}, licences: [{ skuId: '1010020027' }], groups: [], org_unit_path: null }];
    const plan = buildPlan('google_workspace', { domain: 'fictional.example', settings: {} }, rules, e, 'joiner');
    expect(plan.operations.map((o) => o.url)).toEqual(['https://admin.googleapis.com/admin/directory/v1/users', 'https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/sku/1010020027/user']);
    expect(plan.operations[0]!.body).toMatchObject({ orgUnitPath: '/' });
    expect(buildPlan('microsoft365', { domain: 'fictional.example', settings: {} }, rules, e, 'leaver')).toMatchObject({ operations: [], skipped: 'noKnownAccount' });
    expect(buildPlan('microsoft365', { domain: 'fictional.example', settings: {} }, rules, { ...e, workEmail: 'zoe@fictional.example' }, 'leaver').operations.map((o) => o.op)).toEqual(['block_sign_in', 'revoke_sessions', 'remove_licence']);
  });
});

describe('payslip matching (unit)', () => {
  const numbers = new Map([['emp-42', { id: 'a', employeeNumber: 'EMP-42' }], ['100200', { id: 'b', employeeNumber: '100200' }]]);
  it('finds employee numbers as whole tokens, case-insensitively', () => {
    expect(candidates('payslip-EMP-42-march.pdf', 'employee_number')).toContain('emp-42');
    expect(decide('2026_03_EMP-42.pdf', 'employee_number', null, numbers)).toMatchObject({ status: 'matched', employeeId: 'a' });
    expect(decide('1002001.pdf', 'employee_number', null, numbers).status).toBe('unmatched'); // not a whole token
    expect(decide('EMP-42 and 100200.pdf', 'employee_number', null, numbers).status).toBe('ambiguous');
    expect(decide('W2-2025-100200.pdf', 'pattern', '^W2-\\d{4}-(\\d+)$', numbers)).toMatchObject({ status: 'matched', employeeId: 'b' });
  });
  it('expands zips, keeps only real PDFs and stops inflating oversized entries', async () => {
    const zip = new JSZip();
    zip.file('a/EMP-42.pdf', Buffer.from('%PDF-1.4 fictional'));
    zip.file('a/fake.pdf', 'not really a pdf');
    zip.file('a/huge.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_FILE_BYTES + 10, 0x20)]));
    const out = await expandUploads([{ name: 'batch.zip', body: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }]);
    expect(out.accepted.map((f) => f.name)).toEqual(['EMP-42.pdf']);
    expect(out.rejected).toEqual(expect.arrayContaining([{ name: 'fake.pdf', reason: 'notPdf' }, { name: 'huge.pdf', reason: 'tooLarge' }]));
  });
});
