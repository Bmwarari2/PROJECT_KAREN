import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { mockProviders, phase6Company, type MockProviders, type Phase6Company } from './phase6-fixtures';
import type { MemoryObjectStore } from '../src/lib/object-store';
import { getCredentials } from '../src/modules/integrations/credentials';

/**
 * PROGRESS 6.1 + 6.2: per-tenant field mapping; pay-period exports of hours, absences, sick pay, pay
 * changes, starters and leavers; reproducible (byte-identical) exports of a closed period; delivery by
 * download and API push with a delivery log; every export audited. Xero is a mock that checks the
 * request shapes of the official Payroll UK API. (SFTP delivery is in payroll-sftp.int.test.ts.)
 */
let ctx: TestContext;
let c: Phase6Company;
let xero: MockProviders;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PERIOD = { name: 'May 2026', frequency: 'monthly', startDate: '2026-05-01', endDate: '2026-05-31', payDate: '2026-05-29' };

type Who = 'hourly' | 'starter' | 'leaver' | 'raise' | 'spans';
const people = {} as Record<Who, string>;
const numbers = {} as Record<Who, string>;
let periodId: string;
let csvConnector: string;

async function stored(url: string) {
  const key = decodeURIComponent(url.replace('memory://get/', ''));
  return (ctx.deps.objects as MemoryObjectStore).get(key);
}
async function exportAndDownload(connectorId: string, period = periodId) {
  const e = await c.api('POST', `/v1/payroll/periods/${period}/exports`, { connectorId });
  expect(e.statusCode, e.body).toBe(201);
  const d = await c.api('GET', `/v1/payroll/exports/${e.json().id}/download`);
  expect(d.statusCode, d.body).toBe(200);
  return { export: e.json(), download: d.json(), body: await stored(d.json().url) };
}
async function csvFiles(body: Buffer) {
  const zip = await JSZip.loadAsync(body);
  const out: Record<string, string[]> = {};
  for (const n of Object.keys(zip.files)) out[n] = (await zip.files[n]!.async('string')).split('\r\n').filter(Boolean);
  return out;
}

beforeAll(async () => {
  xero = mockProviders();
  ctx = await startTestApp({ listen: false, overrides: { fetch: xero.fetch, integrations: { xero: { clientId: 'fictional-xero-app', clientSecret: 'fictional-xero-secret' } } } });
  c = await phase6Company(ctx);
  // a month of payroll inputs for a fictional company
  people.hourly = await c.hire({ legalFirstName: 'Hana', legalLastName: 'Hourly', payAmountMinor: 1500, payFrequency: 'hourly', startDate: '2025-01-06' });
  people.starter = await c.hire({ legalFirstName: 'Sam', legalLastName: 'Starter', startDate: '2026-05-18', dateOfBirth: '1990-02-03', workEmail: 'sam.starter@fictional.example.test' });
  people.leaver = await c.hire({ legalFirstName: 'Lee', legalLastName: 'Leaver', startDate: '2024-02-01' });
  people.raise = await c.hire({ legalFirstName: 'Rae', legalLastName: 'Raise', startDate: '2023-01-02' });
  people.spans = await c.hire({ legalFirstName: 'Ola', legalLastName: 'Overlap', startDate: '2023-01-02' });
  const all = await c.tx((t) => t.query<{ id: string; employee_number: string }>('SELECT id, employee_number FROM app.employees'));
  for (const [k, id] of Object.entries(people)) numbers[k as Who] = all.find((x) => x.id === id)!.employee_number;

  expect((await c.api('POST', `/v1/employees/${people.leaver}/terminate`, { endDate: '2026-05-15', reason: 'Resigned' })).statusCode).toBe(200);
  expect((await c.api('POST', `/v1/employees/${people.raise}/changes`, { effectiveDate: '2026-05-10', payAmountMinor: 3_300_000, payCurrency: 'GBP', payFrequency: 'annual', reason: 'Annual review' })).statusCode).toBe(200);
  // approved timesheets (from the time module) for two weeks starting in May, one week starting in April
  await c.tx(async (t) => {
    for (const [week, reg, ot, dbl] of [['2026-04-27', 2400, 0, 0], ['2026-05-04', 2400, 150, 0], ['2026-05-11', 2400, 0, 90]] as const)
      await t.exec(`INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, overtime_minutes, double_minutes, worked_minutes, decided_at) VALUES (app.current_tenant(), $1, $2, 'approved', $3, $4, $5, $6, '2026-05-20T09:00:00Z')`, [people.hourly, week, reg, ot, dbl, reg + ot + dbl]);
    // a submitted (not approved) week is never exported
    await t.exec(`INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, worked_minutes) VALUES (app.current_tenant(), $1, '2026-05-18', 'submitted', 2400, 2400)`, [people.hourly]);
  });
  // annual leave inside May, and leave running past the period end (clipped to the period)
  await c.api('GET', '/v1/leave/types');
  await c.tx(async (t) => {
    const annual = (await t.one<{ id: string }>(`SELECT id FROM app.leave_types WHERE key = 'annual'`)).id;
    await t.exec(`INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, amount_days, amount_hours, status) VALUES (app.current_tenant(), $1, $2, '2026-05-20', '2026-05-22', 3, 24, 'approved')`, [people.hourly, annual]);
    await t.exec(`INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, amount_days, amount_hours, status) VALUES (app.current_tenant(), $1, $2, '2026-05-28', '2026-06-03', 5, 40, 'approved')`, [people.spans, annual]);
    await t.exec(`INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, amount_days, amount_hours, status) VALUES (app.current_tenant(), $1, $2, '2026-05-06', '2026-05-06', 1, 8, 'rejected')`, [people.raise, annual]);
  });
  // sickness Tue 26 – Fri 29 May (UK SSP from the GB pack: no waiting days from 6 April 2026)
  const sick = await c.api('POST', '/v1/sickness', { employeeId: people.raise, startDate: '2026-05-26', endDate: '2026-05-29', reason: 'Fictional illness' });
  expect(sick.statusCode, sick.body).toBe(201);
  periodId = (await c.api('POST', '/v1/payroll/periods', PERIOD)).json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('field mapping and connectors', () => {
  it('validates the mapping: unknown fields, wrong transforms and empty mappings are refused', async () => {
    const base = { dateFormat: 'yyyy-MM-dd', decimalSeparator: '.', delimiter: ',', includeHeader: true };
    const bad = await c.api('POST', '/v1/payroll/connectors', { name: 'Bad', kind: 'csv', mapping: { ...base, sections: { hours: { enabled: true, columns: [{ header: 'X', field: 'salary' }] } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].message).toContain('unknown field salary');
    const wrong = await c.api('POST', '/v1/payroll/connectors', { name: 'Bad', kind: 'csv', mapping: { ...base, sections: { hours: { enabled: true, columns: [{ header: 'X', field: 'employeeNumber', transform: { type: 'money', unit: 'major' } }] } } } });
    expect(wrong.json().errors[0].message).toContain('transform money does not apply');
    const none = await c.api('POST', '/v1/payroll/connectors', { name: 'Bad', kind: 'csv', mapping: { ...base, sections: {} } });
    expect(none.json().errors[0].message).toContain('enable at least one section');
    const cat = (await c.api('GET', '/v1/payroll/catalogue')).json();
    expect(Object.keys(cat.sections)).toEqual(['hours', 'absences', 'sickPay', 'payChanges', 'starters', 'leavers']);
    expect(cat.connectors.find((k: { kind: string }) => k.kind === 'datev')).toMatchObject({ availability: 'stub', docs: 'docs/integrations.md#datev' });
  });

  it('a generic CSV connector with a per-tenant mapping exports hours, absences, sick pay, pay changes, starters and leavers', async () => {
    const r = await c.api('POST', '/v1/payroll/connectors', {
      name: 'Fictional Bureau CSV',
      kind: 'csv',
      mapping: {
        dateFormat: 'dd/MM/yyyy',
        decimalSeparator: '.',
        delimiter: ',',
        includeHeader: true,
        sections: {
          hours: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Week', field: 'weekStart' }, { header: 'Basic', field: 'regularHours', transform: { type: 'hours', decimals: 2 } }, { header: 'OT 1.5', field: 'overtimeHours' }, { header: 'OT 2.0', field: 'doubleTimeHours' }, { header: 'Element', value: 'HRS' }] },
          absences: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Code', field: 'leaveType', transform: { type: 'codeMap', map: { annual: 'HOL', sickness: 'SICK' }, default: 'OTH' } }, { header: 'From', field: 'startDate' }, { header: 'To', field: 'endDate', transform: { type: 'date', format: 'yyyyMMdd' } }, { header: 'Days', field: 'days', transform: { type: 'number', decimals: 1 } }, { header: 'Paid', field: 'paid', transform: { type: 'boolean', true: 'Y', false: 'N' } }] },
          sickPay: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Scheme', field: 'scheme', transform: { type: 'case', case: 'upper' } }, { header: 'Days', field: 'qualifyingDaysPaid' }, { header: 'Waiting', field: 'waitingDays' }, { header: 'SSP', field: 'amount' }, { header: 'SSP pence', field: 'amount', transform: { type: 'money', unit: 'minor' } }] },
          payChanges: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Effective', field: 'effectiveDate' }, { header: 'New salary', field: 'amount' }, { header: 'Old salary', field: 'previousAmount' }, { header: 'Basis', field: 'frequency' }] },
          starters: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Forename', field: 'firstName' }, { header: 'Surname', field: 'lastName' }, { header: 'DOB', field: 'dateOfBirth' }, { header: 'Start', field: 'startDate' }, { header: 'Salary', field: 'payAmount' }] },
          leavers: { enabled: true, columns: [{ header: 'Payroll ID', field: 'employeeNumber' }, { header: 'Name', field: 'employeeName' }, { header: 'Leaving date', field: 'lastWorkingDay' }] },
        },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    csvConnector = r.json().id;
    const { export: e, body } = await exportAndDownload(csvConnector);
    expect(e).toMatchObject({ fileName: 'fictional-bureau-csv-2026-05-01_2026-05-31.zip', contentType: 'application/zip', reproducible: false, counts: { hours: 2, absences: 3, sickPay: 1, payChanges: 1, starters: 1, leavers: 1 } });
    expect(sha(body)).toBe(e.sha256);
    const files = await csvFiles(body);
    expect(Object.keys(files).sort()).toEqual(['absences.csv', 'hours.csv', 'leavers.csv', 'pay_changes.csv', 'sick_pay.csv', 'starters.csv']);
    expect(files['hours.csv']).toEqual(['Payroll ID,Week,Basic,OT 1.5,OT 2.0,Element', `${numbers.hourly},04/05/2026,40.00,2.50,0.00,HRS`, `${numbers.hourly},11/05/2026,40.00,0.00,1.50,HRS`]);
    expect(files['absences.csv']).toEqual(
      expect.arrayContaining([`${numbers.hourly},HOL,20/05/2026,20260522,3.0,Y`, `${numbers.spans},HOL,28/05/2026,20260531,2.0,Y`, `${numbers.raise},SICK,26/05/2026,20260529,4.0,Y`]),
    );
    // SSP: lower of the pack's flat rate (£123.25) and 80% of normal weekly earnings; 4 qualifying days of 5
    const daily = Math.ceil(Math.min(12325, Math.round(((3_300_000 / 52) * 80) / 100)) / 5);
    expect(files['sick_pay.csv']).toEqual(['Payroll ID,Scheme,Days,Waiting,SSP,SSP pence', `${numbers.raise},UK_SSP,4,0,${(daily * 4 / 100).toFixed(2)},${daily * 4}`]);
    expect(files['pay_changes.csv']).toEqual(['Payroll ID,Effective,New salary,Old salary,Basis', `${numbers.raise},10/05/2026,33000.00,30000.00,annual`]);
    expect(files['starters.csv']).toEqual(['Payroll ID,Forename,Surname,DOB,Start,Salary', `${numbers.starter},Sam,Starter,03/02/1990,18/05/2026,30000.00`]);
    expect(files['leavers.csv']).toEqual(['Payroll ID,Name,Leaving date', `${numbers.leaver},Lee Leaver,15/05/2026`]);
    // sickness reasons (vault data) never appear in an export
    expect(body.toString('latin1')).not.toContain('Fictional illness');
  });

  it('a single enabled section gives a plain CSV with a formula-injection guard', async () => {
    const id = (await c.api('POST', '/v1/payroll/connectors', { name: 'Leavers only', kind: 'csv', mapping: { dateFormat: 'yyyy-MM-dd', decimalSeparator: ',', delimiter: ';', includeHeader: false, sections: { leavers: { enabled: true, columns: [{ header: 'n', field: 'employeeNumber' }, { header: 'note', value: '=1+1' }] } } } })).json().id;
    const { export: e, body } = await exportAndDownload(id);
    expect(e).toMatchObject({ fileName: 'leavers-only-2026-05-01_2026-05-31-leavers.csv', contentType: 'text/csv; charset=utf-8' });
    expect(body.toString('utf8')).toBe(`${numbers.leaver};'=1+1\r\n`);
  });
});

describe('closing a period makes exports reproducible', () => {
  it('re-exporting a closed period is byte-identical (same SHA-256) even after live data changes', async () => {
    const close = await c.api('POST', `/v1/payroll/periods/${periodId}/close`);
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json()).toMatchObject({ status: 'closed', counts: { hours: 2, absences: 3, sickPay: 1, payChanges: 1, starters: 1, leavers: 1 } });
    expect(close.json().snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    const first = await exportAndDownload(csvConnector);
    expect(first.export.reproducible).toBe(true);
    // live records change after the close…
    await c.tx(async (t) => {
      await t.exec(`INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, worked_minutes, decided_at) VALUES (app.current_tenant(), $1, '2026-05-25', 'approved', 1200, 1200, now())`, [people.hourly]);
      await t.exec(`UPDATE app.employee_personal SET legal_last_name = 'Renamed' WHERE employee_id = $1`, [people.leaver]);
    });
    // …but the closed period's export is rebuilt from its snapshot, byte for byte
    const again = await exportAndDownload(csvConnector);
    expect(again.export.id).not.toBe(first.export.id);
    expect(again.export.sha256).toBe(first.export.sha256);
    expect(sha(again.body)).toBe(sha(first.body));
    expect(again.body.equals(first.body)).toBe(true);
    expect(again.export.inputsSha256).toBe(close.json().snapshotSha256);
    expect((await c.api('POST', `/v1/payroll/periods/${periodId}/close`)).statusCode).toBe(409);
    const inputs = (await c.api('GET', `/v1/payroll/periods/${periodId}/inputs`)).json();
    expect(inputs.hours).toHaveLength(2);
    expect(inputs.employees.find((e: { employeeNumber: string }) => e.employeeNumber === numbers.leaver).lastName).toBe('Leaver');
  });

  it('snapshots are append-only and closed periods cannot be reopened or moved', async () => {
    await expect(c.tx((t) => t.exec(`UPDATE app.pay_period_snapshots SET sha256 = repeat('0', 64)`))).rejects.toThrow(/append-only/);
    await expect(c.tx((t) => t.exec(`UPDATE app.pay_periods SET status = 'open', snapshot_id = NULL WHERE id = $1`, [periodId]))).rejects.toThrow();
    await expect(c.tx((t) => t.exec(`UPDATE app.pay_periods SET end_date = '2026-06-01' WHERE id = $1`, [periodId]))).rejects.toThrow(/closed pay periods/);
    expect((await c.api('POST', '/v1/payroll/periods', { ...PERIOD, name: 'Overlap', startDate: '2026-05-15', endDate: '2026-06-14' })).statusCode).toBe(409);
  });

  it('an Excel connector writes one typed sheet per section, reproducibly', async () => {
    const id = (await c.api('POST', '/v1/payroll/connectors', { name: 'Fictional Excel', kind: 'excel' })).json().id;
    const a = await exportAndDownload(id);
    const b = await exportAndDownload(id);
    expect(a.export.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(b.export.sha256).toBe(a.export.sha256);
    expect(b.body.equals(a.body)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(a.body as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Hours', 'Absences', 'Sick pay', 'Pay changes', 'Starters', 'Leavers']);
    const hours = wb.getWorksheet('Hours')!;
    expect(hours.getRow(1).values).toEqual([undefined, 'employee_number', 'employee_name', 'week_start', 'week_end', 'worked_hours', 'regular_hours', 'overtime_hours', 'double_time_hours', 'approved_at']);
    expect(hours.getRow(2).getCell(5).value).toBe(42.5); // typed number cells (worked hours)
  });

  it('every export and download is audited and the download is in the delivery log', async () => {
    const audits = await c.tx((t) => t.query<{ action: string; sensitive: boolean }>(`SELECT action, sensitive FROM audit.events WHERE action IN ('payroll.exported', 'payroll.export_downloaded', 'pay_period.closed', 'payroll.inputs_viewed')`));
    const count = (a: string) => audits.filter((x) => x.action === a).length;
    expect(count('payroll.exported')).toBeGreaterThanOrEqual(6);
    expect(count('payroll.export_downloaded')).toBe(count('payroll.exported'));
    expect(count('pay_period.closed')).toBe(1);
    expect(audits.filter((x) => x.action !== 'pay_period.closed').every((x) => x.sensitive)).toBe(true);
    const log = (await c.api('GET', `/v1/payroll/deliveries?periodId=${periodId}`)).json();
    expect(log.length).toBe(count('payroll.export_downloaded'));
    expect(log.every((d: { method: string; status: string }) => d.method === 'download' && d.status === 'succeeded')).toBe(true);
  });
});

describe('permissions', () => {
  it('employees cannot see payroll; HR admins can read but not export; payroll admins can export', async () => {
    const emp = await c.login(people.hourly);
    expect((await c.api('GET', '/v1/payroll/connectors', undefined, emp)).statusCode).toBe(403);
    expect((await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: csvConnector }, emp)).statusCode).toBe(403);
    const hr = await c.login(await c.hire(), 'hr_admin');
    expect((await c.api('GET', '/v1/payroll/periods', undefined, hr)).statusCode).toBe(200);
    expect((await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: csvConnector }, hr)).statusCode).toBe(403);
    const payroll = await c.login(null, 'payroll_admin');
    expect((await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: csvConnector }, payroll)).statusCode).toBe(201);
  });
});

describe('documented stubs', () => {
  it.each(['adp', 'workday', 'ukg'])('%s can be planned for but refuses to run with a clear message', async (kind) => {
    const r = await c.api('POST', '/v1/payroll/connectors', { name: `Fictional ${kind}`, kind });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ enabled: false, availability: 'stub', docs: `docs/integrations.md#${kind}` });
    const ex = await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: r.json().id });
    expect(ex.statusCode).toBe(422); // disabled
    const on = await c.api('PATCH', `/v1/payroll/connectors/${r.json().id}`, { enabled: true });
    expect(on.statusCode).toBe(501);
    expect(on.json()).toMatchObject({ code: 'notImplemented', docs: `docs/integrations.md#${kind}` });
  });
  it('Gusto (US) and DATEV (EU) are not offered to UK workspaces', async () => {
    expect((await c.api('POST', '/v1/payroll/connectors', { name: 'G', kind: 'gusto' })).statusCode).toBe(422);
    expect((await c.api('POST', '/v1/payroll/connectors', { name: 'D', kind: 'datev' })).statusCode).toBe(422);
  });
});

describe('Xero Payroll (UK) connector against a mock of the Payroll UK API', () => {
  const XERO_TENANT = '7f3c4a5e-0000-4000-8000-000000000001';
  const CALENDAR = '216d80e6-af55-47b1-b718-9457c3f5d2fe';
  const RATES = { regular: '87f5b43a-cf51-4b74-92de-94c819e82d27', overtime: '87f5b43a-cf51-4b74-92de-94c819e82d28', doubleTime: '87f5b43a-cf51-4b74-92de-94c819e82d29' };
  const LEAVE = { annual: 'a1b2c3d4-0000-4000-8000-00000000aaaa', sickness: 'a1b2c3d4-0000-4000-8000-00000000bbbb' };
  let connectorId: string;
  let refreshCount = 0;

  beforeAll(() => {
    xero.on('POST', /^https:\/\/identity\.xero\.com\/connect\/token$/, (call) => {
      if (call.form?.grant_type === 'authorization_code') return { status: 200, json: { access_token: 'xero-access-1', refresh_token: 'xero-refresh-1', expires_in: 1800, token_type: 'Bearer' } };
      refreshCount++;
      return { status: 200, json: { access_token: `xero-access-r${refreshCount}`, refresh_token: `xero-refresh-r${refreshCount}`, expires_in: 1800 } };
    });
    xero.on('GET', /^https:\/\/api\.xero\.com\/connections$/, () => ({ status: 200, json: [{ id: 'c1', tenantId: XERO_TENANT, tenantType: 'ORGANISATION', tenantName: 'Fictional Payroll UK Ltd' }] }));
    xero.on('GET', /^https:\/\/api\.xero\.com\/payroll\.xro\/2\.0\/Employees\?page=1$/, () => ({ status: 200, json: { employees: [{ employeeID: 'aad6b292-7b94-408b-93f6-e489867e3fb0', firstName: 'Ola', lastName: 'Overlap', employeeNumber: numbers.spans }] } }));
    xero.on('POST', /^https:\/\/api\.xero\.com\/payroll\.xro\/2\.0\/Timesheets$/, (call) => ({ status: 200, json: { id: 'r1', httpStatusCode: 'OK', timesheet: { ...(call.json as object), timesheetID: '88d2038a-06f7-4b8a-bdab-809804c0aa1d', status: 'Draft' } } }));
    xero.on('POST', /^https:\/\/api\.xero\.com\/payroll\.xro\/2\.0\/Employees\/([^/]+)\/Leave$/, (call, m) => ({ status: 200, json: { leave: { ...(call.json as object), leaveID: `leave-${m[1]}-${(call.json as { startDate: string }).startDate}` } } }));
  });

  it('connects with OAuth 2.0 (state checked, refresh token sealed, organisation selected)', async () => {
    const r = await c.api('POST', '/v1/payroll/connectors', { name: 'Fictional Xero', kind: 'xero_uk', settings: { payrollCalendarId: CALENDAR, earningsRates: RATES, leaveTypes: LEAVE, employees: { [numbers.hourly]: 'b5c0f1e2-1111-4000-8000-000000000001', [numbers.raise]: 'b5c0f1e2-1111-4000-8000-000000000002' } } });
    expect(r.statusCode, r.body).toBe(201);
    connectorId = r.json().id;
    expect(r.json().delivery).toEqual({ method: 'api' });
    const auth = (await c.api('POST', `/v1/payroll/connectors/${connectorId}/xero/authorize`)).json();
    const u = new URL(auth.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.xero.com/identity/connect/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'fictional-xero-app', scope: 'offline_access payroll.timesheets payroll.employees', redirect_uri: 'http://localhost:3000/v1/payroll/xero/callback' });
    expect((await c.api('GET', `/v1/payroll/xero/callback?code=abc&state=wrong`)).statusCode).toBe(400);
    const cb = await c.api('GET', `/v1/payroll/xero/callback?code=fictional-code&state=${u.searchParams.get('state')}`);
    expect(cb.statusCode, cb.body).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:3000/app/payroll?xero=connected');
    const exchange = xero.calls.find((x) => x.form?.grant_type === 'authorization_code')!;
    expect(exchange.headers.authorization).toBe(`Basic ${Buffer.from('fictional-xero-app:fictional-xero-secret').toString('base64')}`);
    expect(exchange.form).toMatchObject({ code: 'fictional-code', redirect_uri: 'http://localhost:3000/v1/payroll/xero/callback' });
    // the state is single use
    expect((await c.api('GET', `/v1/payroll/xero/callback?code=fictional-code&state=${u.searchParams.get('state')}`)).statusCode).toBe(400);
    const conn = (await c.api('GET', `/v1/payroll/connectors/${connectorId}`)).json();
    expect(conn.settings.xeroTenantId).toBe(XERO_TENANT);
    expect(conn.credentials).toEqual(['refreshToken']);
    const raw = await c.tx((t) => t.one<{ envelope: unknown }>(`SELECT envelope FROM app.integration_credentials WHERE owner_id = $1`, [connectorId]));
    expect(JSON.stringify(raw.envelope)).not.toContain('xero-refresh-1');
  });

  it('pushes timesheets per earnings rate and leave in the Payroll UK API shapes, with idempotency keys', async () => {
    const e = (await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId })).json();
    expect(e.counts).toMatchObject({ xeroTimesheets: 1, xeroLeave: 3, unmapped: 0 });
    xero.reset();
    const d = await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, { idempotencyKey: 'xero-may-2026' });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json()).toMatchObject({ method: 'api', status: 'queued' });
    // the same idempotency key returns the same delivery
    expect((await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, { idempotencyKey: 'xero-may-2026' })).json().id).toBe(d.json().id);
    await c.drain();
    const token = xero.calls.find((x) => x.url === 'https://identity.xero.com/connect/token')!;
    expect(token.form).toEqual({ grant_type: 'refresh_token', refresh_token: 'xero-refresh-1' });
    const ts = xero.calls.filter((x) => x.url.endsWith('/Timesheets'));
    expect(ts).toHaveLength(1);
    expect(ts[0]!.headers).toMatchObject({ authorization: 'Bearer xero-access-r1', 'xero-tenant-id': XERO_TENANT, 'content-type': 'application/json' });
    expect(ts[0]!.headers['idempotency-key']).toBe(`thr-${e.id}:ts:${numbers.hourly}:2026-05-01`);
    expect(ts[0]!.json).toEqual({
      payrollCalendarID: CALENDAR,
      employeeID: 'b5c0f1e2-1111-4000-8000-000000000001',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      timesheetLines: [
        { date: '2026-05-04', earningsRateID: RATES.regular, numberOfUnits: 40 },
        { date: '2026-05-04', earningsRateID: RATES.overtime, numberOfUnits: 2.5 },
        { date: '2026-05-11', earningsRateID: RATES.regular, numberOfUnits: 40 },
        { date: '2026-05-11', earningsRateID: RATES.doubleTime, numberOfUnits: 1.5 },
      ],
    });
    const leave = xero.calls.filter((x) => x.url.endsWith('/Leave'));
    expect(leave.map((l) => l.url).sort()).toEqual([
      'https://api.xero.com/payroll.xro/2.0/Employees/aad6b292-7b94-408b-93f6-e489867e3fb0/Leave', // matched by employee number in Xero
      'https://api.xero.com/payroll.xro/2.0/Employees/b5c0f1e2-1111-4000-8000-000000000001/Leave',
      'https://api.xero.com/payroll.xro/2.0/Employees/b5c0f1e2-1111-4000-8000-000000000002/Leave',
    ]);
    expect(leave.map((l) => l.json)).toContainEqual({ leaveTypeID: LEAVE.sickness, description: 'Sickness', startDate: '2026-05-26', endDate: '2026-05-29' });
    expect(xero.calls.some((x) => (x.body ?? '').includes('Fictional illness'))).toBe(false);
    const log = (await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`)).json();
    expect(log[0]).toMatchObject({ method: 'api', status: 'succeeded', destination: `xero:${XERO_TENANT}`, attempts: 1, detail: { pushed: 4, failed: 0, skipped: 0 } });
    // the rotated refresh token replaced the old one (sealed)
    const creds = await c.tx((t) => getCredentials(t, ctx.deps.keys, c.owner.tenantId, 'payroll_connector', connectorId));
    expect(creds).toEqual({ refreshToken: 'xero-refresh-r1' });
    const audit = await c.tx((t) => t.query<{ diff: { status: string } }>(`SELECT diff FROM audit.events WHERE action = 'payroll.delivered' AND target_id = $1`, [d.json().id]));
    expect(audit[0]!.diff.status).toBe('succeeded');

    // a second delivery of the same export never sends the items again
    xero.reset();
    const again = await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, { idempotencyKey: 'xero-may-2026-retry' });
    await c.drain();
    expect(xero.calls.filter((x) => x.url.includes('payroll.xro'))).toHaveLength(0);
    expect((await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`)).json().find((x: { id: string }) => x.id === again.json().id)).toMatchObject({ status: 'succeeded', detail: { pushed: 4 } });
  });

  it('unmapped leave types and employees are reported, not guessed', async () => {
    const id = (await c.api('POST', '/v1/payroll/connectors', { name: 'Xero partial', kind: 'xero_uk', settings: { xeroTenantId: XERO_TENANT, payrollCalendarId: CALENDAR, earningsRates: { regular: RATES.regular }, leaveTypes: { annual: LEAVE.annual } } })).json().id;
    await c.api('PUT', `/v1/payroll/connectors/${id}/credentials`, { clientId: 'custom-connection-id', clientSecret: 'custom-connection-secret' });
    const e = (await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: id })).json();
    expect(e.counts).toMatchObject({ xeroLeave: 2, unmapped: 3 }); // overtime + double rates, sickness type
    xero.reset();
    await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, {});
    await c.drain();
    // a Xero custom connection uses the client credentials grant
    expect(xero.calls.find((x) => x.url.endsWith('/connect/token'))!.form).toEqual({ grant_type: 'client_credentials', scope: 'payroll.timesheets payroll.employees' });
    const log = (await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`)).json()[0];
    expect(log.status).toBe('partial'); // the hourly worker is not in Xero's employee list
    expect(log.detail.items.filter((i: { status: string }) => i.status === 'skipped').map((i: { reason: string }) => i.reason)).toContain('employeeNotMapped');
  });

  it('is not offered to EU workspaces', async () => {
    const eu = await startTestApp({ cell: 'eu', listen: false });
    try {
      const euCo = await phase6Company(eu);
      expect((await euCo.api('POST', '/v1/payroll/connectors', { name: 'X', kind: 'xero_uk' })).statusCode).toBe(422);
    } finally {
      await eu.close();
    }
  });
});
