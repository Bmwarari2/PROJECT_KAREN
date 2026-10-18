import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { getPool, runInTransaction, withTenantReader } from '@thapsus/db';
import { createTestTenant, ownerUrl, readerUrl, testRouter, TEST_DBS, uniqueSlug } from '@thapsus/db/testing';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { widgets, type Widgets } from './reports-fixtures';
import { enqueueDueSchedules } from '../src/modules/reports/runs';
import type { MemoryMailer } from '../src/lib/mailer';

/**
 * PROGRESS 7.1 and 7.2 end to end: ready-made reports, the permission-aware report builder, background runs
 * with progress, short-lived downloads and expiry, saved reports and scheduled delivery — all on the
 * reporting READER (thapsus_reporting) with explicit as-of dates on a fictional company.
 */
let ctx: TestContext;
let w: Widgets;
const reportsRouter = () => testRouter('uk', { readers: { shared: readerUrl(TEST_DBS.shared) } });

beforeAll(async () => {
  ctx = await startTestApp({ listen: false, overrides: { router: reportsRouter() } });
  w = await widgets(ctx);
  // absences: Ada off sick Mon 4 – Wed 6 May 2026 (4 May is an England bank holiday)
  const sick = await w.api('POST', '/v1/sickness', { employeeId: w.people.ada, startDate: '2026-05-04', endDate: '2026-05-06', reason: 'Fictional migraine' });
  expect(sick.statusCode, sick.body).toBe(201);
  // approved timesheets for the overtime report
  await w.tx(async (t) => {
    for (const [emp, week, worked, ot] of [[w.people.ada, '2026-06-01', 2550, 300], [w.people.ada, '2026-06-08', 2400, 150], [w.people.mona, '2026-06-01', 2250, 0]] as const) {
      await t.exec(
        `INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, overtime_minutes, worked_minutes, scheduled_minutes) VALUES (app.current_tenant(), $1, $2, 'approved', $3, $4, $5, 2250)`,
        [emp, week, worked - ot, ot, worked],
      );
    }
  });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const run = async (id: string, params: Record<string, unknown>, cookie = w.owner.cookie) => {
  const r = await w.api('POST', `/v1/reports/ready/${id}/run`, { params }, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { title: string; columns: Array<{ key: string; type: string }>; rows: Array<Record<string, unknown>>; totals?: Array<Record<string, unknown>>; notes: string[]; restricted?: number; facts?: Array<{ key: string; value: unknown }> };
};
const preview = async (spec: Record<string, unknown>, cookie = w.owner.cookie) => {
  const r = await w.api('POST', '/v1/reports/builder/preview', spec, cookie);
  return r;
};
const byGroup = (rows: Array<Record<string, unknown>>, group: string) => rows.find((r) => r.group === group);

describe('7.1 ready-made reports (explicit as-of dates)', () => {
  it('headcount by entity is effective-dated: transfers and leavers move between dates', async () => {
    const march = await run('headcount', { asOf: '2026-03-31', groupBy: 'entity' });
    expect(byGroup(march.rows, 'Fictional Widgets Ltd')).toMatchObject({ headcount: 5 }); // Mona, Ada, Ben (last day), Cleo, Eve
    expect(byGroup(march.rows, 'Fictional Widgets Inc')).toMatchObject({ headcount: 1 });
    expect(march.totals?.[0]).toMatchObject({ headcount: 6 });
    const june = await run('headcount', { asOf: '2026-06-30', groupBy: 'entity' });
    expect(byGroup(june.rows, 'Fictional Widgets Ltd')).toMatchObject({ headcount: 3 });
    expect(byGroup(june.rows, 'Fictional Widgets Inc')).toMatchObject({ headcount: 2 }); // Dan on his last day, Eve after transfer
    const byCountry = await run('headcount', { asOf: '2026-06-30', groupBy: 'country' });
    expect(byCountry.rows.map((r) => [r.group, r.headcount]).sort()).toEqual([['GB', 3], ['US', 2]]);
  });

  it('headcount history at month ends', async () => {
    const h = await run('headcount-history', { from: '2026-01-01', to: '2026-06-30' });
    expect(h.rows.map((r) => [r.date, r.headcount])).toEqual([['2026-01-31', 5], ['2026-02-28', 6], ['2026-03-31', 6], ['2026-04-30', 5], ['2026-05-31', 5], ['2026-06-30', 5]]);
  });

  it('turnover: 2 leavers over an average headcount of 5 = 40 %, split voluntary / involuntary', async () => {
    const t = await run('turnover', { from: '2026-01-01', to: '2026-06-30' });
    expect(t.totals?.[0]).toMatchObject({ headcountStart: 5, headcountEnd: 5, leavers: 2, voluntary: 1, involuntary: 1, turnoverRate: '40.00', voluntaryRate: '20.00' });
  });

  it('absence: working days lost by type (bank holiday excluded); Bradford factor only when the tenant enables it', async () => {
    const a = await run('absence', { from: '2026-05-01', to: '2026-05-31' });
    expect(a.rows).toEqual([expect.objectContaining({ spells: 1, employees: 1, daysLost: '2.00', hoursLost: '15.00' })]);
    const byEmployee = await run('absence', { from: '2026-05-01', to: '2026-05-31', groupBy: 'employee' });
    expect(byEmployee.columns.map((c) => c.key)).not.toContain('bradfordFactor');
    expect((await w.api('PUT', '/v1/settings/reports', { bradfordFactor: true })).statusCode).toBe(200);
    const withBf = await run('absence', { from: '2026-05-01', to: '2026-05-31', groupBy: 'employee' });
    expect(withBf.columns.map((c) => c.key)).toContain('bradfordFactor');
    expect(withBf.rows[0]).toMatchObject({ bradfordFactor: '3.00' }); // one spell of 3 working days: 1² × 3
    expect((await w.api('PUT', '/v1/settings/reports', { bradfordFactor: false })).statusCode).toBe(200);
    // sickness reports are special-category data: the view is audited as sensitive
    const audit = await w.tx((t) => t.query<{ sensitive: boolean }>(`SELECT sensitive FROM audit.events WHERE action = 'report.viewed' AND target_type = 'report:absence'`));
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(audit.every((e) => e.sensitive)).toBe(true);
  });

  it('holiday liability: integer minor units per currency, never mixed; totals per currency', async () => {
    const l = await run('holiday-liability', { asOf: '2026-06-30', groupBy: 'entity' });
    const money = l.rows.map((r) => r.liability as { amountMinor: string; currency: string } | null).filter(Boolean);
    expect(money.length).toBeGreaterThan(0);
    for (const m of money) {
      expect(m!.amountMinor).toMatch(/^-?\d+$/);
      expect(['GBP', 'USD']).toContain(m!.currency);
    }
    expect(new Set(l.totals!.map((t) => (t.liability as { currency: string }).currency))).toEqual(new Set(money.map((m) => m!.currency)));
  });

  it('overtime from approved timesheets', async () => {
    const o = await run('overtime', { from: '2026-06-01', to: '2026-06-14', groupBy: 'department' });
    expect(byGroup(o.rows, 'Engineering')).toMatchObject({ timesheets: 3, employees: 2, workedMinutes: 7200, overtimeMinutes: 450, overtimeShare: '6.25' });
  });

  it('a manager sees only their team, and dimensions hidden by field permissions are grouped as restricted', async () => {
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    const byEntity = await run('headcount', { asOf: '2026-03-31', groupBy: 'entity' }, mona.cookie);
    // scope is the manager's current team (Ada and Cleo; Ben left, so his reporting line ended); managers cannot read the entity field
    expect(byEntity.rows).toEqual([{ group: 'Restricted', headcount: 2, fte: '2.00' }]);
    expect(byEntity.notes).toContain('reports.note.restricted');
    const byDept = await run('headcount', { asOf: '2026-03-31', groupBy: 'department' }, mona.cookie);
    expect(byDept.rows.map((r) => [r.group, r.headcount]).sort()).toEqual([['Engineering', 1], ['Sales', 1]]);
    const liability = await run('holiday-liability', { asOf: '2026-06-30', groupBy: 'department' }, mona.cookie);
    expect(liability.rows.every((r) => r.liability === null)).toBe(true); // pay is hidden from managers
    expect(liability.restricted).toBeGreaterThan(0);
  });
});

describe('7.2 report builder: permission-aware rows and fields', () => {
  it('the catalogue lists datasets by row permission and vault fields only with the category permission', async () => {
    const own = (await w.api('GET', '/v1/reports/catalogue')).json();
    expect(own.datasets.map((d: { key: string }) => d.key).sort()).toEqual(['absence', 'employees', 'leave', 'timesheets']);
    expect(own.datasets.find((d: { key: string }) => d.key === 'absence').fields.map((f: { key: string }) => f.key)).toContain('sicknessReason');
    expect(own.ready.find((r: { id: string }) => r.id === 'eeo-1')).toMatchObject({ applicable: true });
    expect(own.ready.find((r: { id: string }) => r.id === 'pay-transparency')).toMatchObject({ applicable: false });
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    const m = (await w.api('GET', '/v1/reports/catalogue', undefined, mona.cookie)).json();
    expect(m.datasets.find((d: { key: string }) => d.key === 'absence').fields.map((f: { key: string }) => f.key)).not.toContain('sicknessReason');
    const emp = await w.login(w.people.ada, 'employee', { type: 'self' });
    expect((await w.api('GET', '/v1/reports/catalogue', undefined, emp.cookie)).statusCode).toBe(403);
  });

  it('a manager: team rows only; hidden fields are null, cannot be filtered on, and group as restricted', async () => {
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    const detail = await preview({ dataset: 'employees', asOf: '2026-03-31', columns: ['displayName', 'department', 'entity', 'payAmount'] }, mona.cookie);
    expect(detail.statusCode, detail.body).toBe(200);
    const d = detail.json();
    expect(d.rows.map((r: { displayName: string }) => r.displayName).sort()).toEqual(['Ada Fictional', 'Cleo Fictional']);
    expect(d.rows.every((r: { entity: unknown; payAmount: unknown; department: unknown }) => r.entity === null && r.payAmount === null && r.department !== null)).toBe(true);
    expect(d.restricted).toBe(2);
    // filtering on a hidden value must not reveal anything
    const filtered = (await preview({ dataset: 'employees', asOf: '2026-03-31', columns: ['displayName'], filters: [{ field: 'payAmount', op: 'gt', value: '0' }] }, mona.cookie)).json();
    expect(filtered.rows).toEqual([]);
    const empty = (await preview({ dataset: 'employees', asOf: '2026-03-31', columns: ['displayName'], filters: [{ field: 'payAmount', op: 'isEmpty' }] }, mona.cookie)).json();
    expect(empty.rows).toEqual([]);
    const grouped = (await preview({ dataset: 'employees', asOf: '2026-03-31', groupBy: [{ field: 'entity' }], measures: [{ fn: 'count' }, { fn: 'sum', field: 'payAmount' }] }, mona.cookie)).json();
    expect(grouped.rows).toEqual([{ entity: 'Restricted', currency: null, count_rows: 2, sum_payAmount: null }]);
  });

  it('an entity HR admin: entity-scoped rows with pay; money sums are grouped by currency', async () => {
    const hr = await w.login(null, 'entity_hr_admin', { type: 'entity', values: [w.gb] });
    const r = await preview({ dataset: 'employees', asOf: '2026-06-30', groupBy: [{ field: 'department' }], measures: [{ fn: 'count' }, { fn: 'sum', field: 'payAmount' }], sort: { key: 'department', dir: 'asc' } }, hr.cookie);
    expect(r.statusCode, r.body).toBe(200);
    // current GB entity: Mona, Ada (Engineering) and Cleo (Sales); Eve moved to the US entity
    expect(r.json().rows).toEqual([
      { department: 'Engineering', currency: 'GBP', count_rows: 2, sum_payAmount: { amountMinor: '9640000', currency: 'GBP' } },
      { department: 'Sales', currency: 'GBP', count_rows: 1, sum_payAmount: { amountMinor: '3200000', currency: 'GBP' } },
    ]);
    expect(r.json().chart).toMatchObject({ type: 'bar', x: 'department' });
  });

  it('a vault-backed field is decrypted only with the category permission, and every value read is audited', async () => {
    const before = await w.tx((t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit.events WHERE action = 'vault.read' AND diff->>'via' = 'report_preview'`));
    const r = await preview({ dataset: 'absence', from: '2026-05-01', to: '2026-05-31', columns: ['displayName', 'startDate', 'sicknessReason'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows).toEqual([{ displayName: 'Ada Fictional', startDate: '2026-05-04', sicknessReason: 'Fictional migraine' }]);
    expect(r.json().sensitive).toBe(true);
    const after = await w.tx((t) => t.query<{ sensitive: boolean; target_type: string }>(`SELECT sensitive, target_type FROM audit.events WHERE action = 'vault.read' AND diff->>'via' = 'report_preview'`));
    expect(after.length).toBe(before.n + 1);
    expect(after.every((a) => a.sensitive && a.target_type === 'vault:sickness')).toBe(true);
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    expect((await preview({ dataset: 'absence', from: '2026-05-01', to: '2026-05-31', columns: ['displayName', 'sicknessReason'] }, mona.cookie)).statusCode).toBe(400);
    const ok = (await preview({ dataset: 'absence', from: '2026-05-01', to: '2026-05-31', columns: ['displayName', 'startDate'] }, mona.cookie)).json();
    expect(ok.rows).toEqual([{ displayName: 'Ada Fictional', startDate: '2026-05-04' }]);
  });

  it('refuses unknown fields, invalid aggregations and datasets without the row permission', async () => {
    expect((await preview({ dataset: 'employees', columns: ['nope'] })).statusCode).toBe(400);
    expect((await preview({ dataset: 'employees', measures: [{ fn: 'sum', field: 'displayName' }] })).statusCode).toBe(400);
    expect((await preview({ dataset: 'leave', columns: ['displayName'] })).statusCode).toBe(400); // period required
    const payroll = await w.login(null, 'payroll_admin', { type: 'all' });
    expect((await preview({ dataset: 'absence', from: '2026-05-01', to: '2026-05-31', columns: ['displayName'] }, payroll.cookie)).statusCode).toBe(200);
    expect((await preview({ dataset: 'timesheets', from: '2026-06-01', to: '2026-06-30', columns: ['displayName'] }, payroll.cookie)).statusCode).toBe(200);
  });
});

describe('7.2 reports run on the read replica', () => {
  it('report SQL executes on the reader pool as thapsus_reporting, and forced RLS still applies there', async () => {
    const spy = vi.spyOn(ctx.deps.router, 'readerPoolFor');
    await run('headcount', { asOf: '2026-03-31', groupBy: 'none' });
    expect(spy).toHaveBeenCalledWith(w.owner.tenantId, { allowMoving: true });
    expect((await spy.mock.results[0]!.value).reader).toBe(true);
    spy.mockRestore();
    const other = await createTestTenant(ctx.deps.router, uniqueSlug('rep-other'));
    await withTenantReader(ctx.deps.router, w.owner.tenantId, async (tx, info) => {
      expect(info).toEqual({ reader: true, dbKey: 'shared' });
      expect((await tx.one<{ u: string }>('SELECT current_user AS u')).u).toBe('thapsus_reporting');
      expect((await tx.query('SELECT 1 FROM app.tenants WHERE tenant_id = $1', [other]))).toHaveLength(0);
      expect((await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.employees')).n).toBe(6);
    });
    // the reporting role never reads the vault or authentication secrets, and cannot write
    await expect(withTenantReader(ctx.deps.router, w.owner.tenantId, (tx) => tx.query('SELECT 1 FROM vault.records LIMIT 1'))).rejects.toThrow(/permission denied/);
    await expect(withTenantReader(ctx.deps.router, w.owner.tenantId, (tx) => tx.query('SELECT 1 FROM app.password_credentials LIMIT 1'))).rejects.toThrow(/permission denied/);
    await expect(withTenantReader(ctx.deps.router, w.owner.tenantId, (tx) => tx.exec(`UPDATE app.employees SET display_name = 'x'`))).rejects.toThrow(/read-only|permission denied/);
    // without tenant context the reader sees nothing
    const none = await runInTransaction(getPool(readerUrl(TEST_DBS.shared)), (tx) => tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.employees'));
    expect(none.n).toBe(0);
  });

  it('the result comes from the reader: a replica holding different rows answers the report (and RLS filters other tenants there)', async () => {
    // Simulate a replica: a separate database (as the reporting role) with this tenant's row and one fictional employee, plus another tenant's employee.
    const owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.dedicated) });
    await owner.connect();
    const intruder = crypto.randomUUID();
    try {
      for (const [id, slug] of [[w.owner.tenantId, w.owner.slug], [intruder, uniqueSlug('replica-x')]] as const) {
        await owner.query(`INSERT INTO app.tenants (tenant_id, slug, name, home_region) VALUES ($1, $2, 'Fictional replica', 'uk') ON CONFLICT DO NOTHING`, [id, slug]);
        await owner.query(`INSERT INTO app.employees (tenant_id, employee_number, start_date, display_name) VALUES ($1, $2, '2020-01-01', 'Replica Fictional')`, [id, `R-${Math.random().toString(36).slice(2, 8)}`]);
      }
    } finally {
      await owner.end();
    }
    const replica = await startTestApp({ listen: false, overrides: { router: testRouter('uk', { readers: { shared: readerUrl(TEST_DBS.dedicated) } }) } });
    try {
      const r = await replica.app.inject({ method: 'POST', url: '/v1/reports/ready/headcount/run', headers: { cookie: w.owner.cookie }, payload: { params: { asOf: '2026-03-31', groupBy: 'none' } } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().totals[0].headcount).toBe(1); // the writer has 6; the replica's single row for this tenant answered
    } finally {
      await replica.close();
    }
  });

  it('falls back to the writer when no reader is configured for the tenant database (never another database\'s reader)', async () => {
    const router = testRouter('uk', { readers: { shared: readerUrl(TEST_DBS.shared) } });
    expect(router.readerPool('shared').reader).toBe(true);
    expect(router.readerPool('dedicated').reader).toBe(false);
    expect(router.readerPool('dedicated').pool).toBe(router.pool('dedicated'));
  });
});

describe('7.2 background runs, exports, downloads and expiry', () => {
  const startRun = async (body: unknown, cookie = w.owner.cookie) => {
    const r = await w.api('POST', '/v1/reports/runs', body, cookie);
    expect(r.statusCode, r.body).toBe(202);
    return r.json() as { id: string; status: string; progressPercent: number };
  };
  const fileOf = async (id: string) => {
    const row = await w.tx((t) => t.one<{ result_key: string }>('SELECT result_key FROM app.report_runs WHERE id = $1', [id]));
    return ctx.deps.objects.get(row.result_key);
  };

  it('runs in the background with progress, stores the file in the home-region store and gives a short-lived link', async () => {
    const queued = await startRun({ source: { kind: 'ready', reportId: 'headcount', params: { asOf: '2026-03-31', groupBy: 'entity' } }, format: 'csv' });
    expect(queued).toMatchObject({ status: 'queued', progressPercent: 0 });
    const jobs = await w.drain();
    expect(jobs.map((j) => j.kind)).toContain('reports.run');
    const done = (await w.api('GET', `/v1/reports/runs/${queued.id}`)).json();
    expect(done).toMatchObject({ status: 'succeeded', progressPercent: 100, rowCount: 2, format: 'csv' });
    expect(done.fileName).toMatch(/^headcount-\d{4}-\d{2}-\d{2}\.csv$/);
    const job = await w.tx((t) => t.one<{ progress_done: string; progress_total: string }>(`SELECT progress_done, progress_total FROM app.jobs WHERE kind = 'reports.run' AND idempotency_key = $1`, [queued.id]));
    expect(Number(job.progress_done)).toBeGreaterThanOrEqual(90);
    const csv = (await fileOf(queued.id)).toString('utf8');
    expect(csv.replace(/^\ufeff/, '').split('\r\n').slice(0, 1)).toEqual(['Legal entity,Headcount,FTE']);
    expect(csv).toContain('Fictional Widgets Ltd,5,');
    const dl = await w.api('GET', `/v1/reports/runs/${queued.id}/download`);
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.json()).toMatchObject({ expiresInSeconds: 300, fileName: done.fileName });
    // only the requester can see the run
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    expect((await w.api('GET', `/v1/reports/runs/${queued.id}`, undefined, mona.cookie)).statusCode).toBe(404);
    expect((await w.api('GET', `/v1/reports/runs/${queued.id}/download`, undefined, mona.cookie)).statusCode).toBe(404);
  });

  it('exports Excel with typed cells and PDF with title, parameters and generated-at time zone', async () => {
    const x = await startRun({ source: { kind: 'builder', spec: { dataset: 'employees', asOf: '2026-03-31', columns: ['displayName', 'startDate', 'payAmount'], sort: { key: 'displayName', dir: 'asc' } } }, format: 'xlsx' });
    const p = await startRun({ source: { kind: 'ready', reportId: 'turnover', params: { from: '2026-01-01', to: '2026-06-30', groupBy: 'entity' } }, format: 'pdf' });
    await w.drain();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await fileOf(x.id)) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    let headerRow = 0;
    ws.eachRow((row, n) => {
      if ((row.values as unknown[])[1] === 'Name') headerRow = n;
    });
    expect(ws.getRow(1).values).toContain('People');
    const header = ws.getRow(headerRow).values as unknown[];
    expect(header.slice(1)).toEqual(['Name', 'Start date', 'Pay', 'Pay (Currency)']);
    const ada = ws.getRow(headerRow + 1).values as unknown[];
    expect(ada[1]).toBe('Ada Fictional');
    expect(ada[2]).toBeInstanceOf(Date);
    expect(ada[3]).toBe(36400);
    expect(ada[4]).toBe('GBP');
    const pdf = await PDFDocument.load(await fileOf(p.id));
    expect(pdf.getTitle()).toBe('Turnover');
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('expired results are deleted and can no longer be downloaded', async () => {
    const r = await startRun({ source: { kind: 'ready', reportId: 'headcount', params: { asOf: '2026-03-31' } }, format: 'csv' });
    await w.drain();
    const key = (await w.tx((t) => t.one<{ result_key: string }>('SELECT result_key FROM app.report_runs WHERE id = $1', [r.id]))).result_key;
    await w.tx((t) => t.exec(`UPDATE app.report_runs SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]));
    expect((await w.api('GET', `/v1/reports/runs/${r.id}/download`)).statusCode).toBe(410);
    await w.tx((t) => t.exec(`INSERT INTO app.jobs (tenant_id, kind, idempotency_key, input) VALUES (app.current_tenant(), 'reports.cleanup', $1, '{}')`, [`test-${r.id}`]));
    await w.drain();
    expect((await w.api('GET', `/v1/reports/runs/${r.id}`)).json().status).toBe('expired');
    await expect(ctx.deps.objects.get(key)).rejects.toThrow();
  });
});

describe('7.2 saved reports and scheduled delivery', () => {
  it('saves, lists and shares reports; only the owner edits or deletes', async () => {
    const saved = await w.post('/v1/reports/saved', { name: 'Team headcount', kind: 'ready', reportId: 'headcount', params: { groupBy: 'department' }, relative: 'today', shared: true });
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    const list = (await w.api('GET', '/v1/reports/saved', undefined, mona.cookie)).json();
    expect(list.find((s: { id: string }) => s.id === saved)).toMatchObject({ name: 'Team headcount', mine: false, shared: true });
    expect((await w.api('DELETE', `/v1/reports/saved/${saved}`, undefined, mona.cookie)).statusCode).toBe(404);
    const r = await w.api('POST', '/v1/reports/runs', { source: { kind: 'saved', savedReportId: saved }, format: 'json' }, mona.cookie);
    expect(r.statusCode, r.body).toBe(202);
    await w.drain();
    const res = await w.api('GET', `/v1/reports/runs/${r.json().id}/result`, undefined, mona.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rows.map((x: { group: string }) => x.group).sort()).toEqual(['Engineering', 'Sales']); // Mona's team only
  });

  it('delivers per recipient once per period, each limited to their own permissions, by email with no personal data', async () => {
    const mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
    const saved = await w.post('/v1/reports/saved', { name: 'Monthly headcount', kind: 'ready', reportId: 'headcount', params: { groupBy: 'entity' }, relative: 'previousMonth' });
    const sched = await w.api('POST', '/v1/reports/schedules', { savedReportId: saved, frequency: 'monthly', dayOfMonth: 1, timeOfDay: '07:00', timeZone: 'Europe/London', format: 'pdf', recipientUserIds: [w.owner.userId, mona.userId] });
    expect(sched.statusCode, sched.body).toBe(201);
    const employee = await w.login(w.people.cleo, 'employee', { type: 'self' });
    expect((await w.api('POST', '/v1/reports/schedules', { savedReportId: saved, frequency: 'daily', timeOfDay: '07:00', timeZone: 'Europe/London', format: 'pdf', recipientUserIds: [employee.userId] })).statusCode).toBe(422);
    const due = new Date('2026-11-01T07:30:00Z');
    expect(await w.tx((t) => enqueueDueSchedules(t, due))).toBe(2);
    expect(await w.tx((t) => enqueueDueSchedules(t, due))).toBe(0); // idempotent per schedule + period
    expect(await w.tx((t) => enqueueDueSchedules(t, new Date('2026-11-01T06:30:00Z')))).toBe(0);
    const mailer = ctx.deps.mailer as MemoryMailer;
    const sentBefore = mailer.sent.length;
    await w.drain();
    const runs = await w.tx((t) => t.query<{ requested_by: string; status: string; period_key: string; source: { params: { asOf: string } } }>(`SELECT requested_by, status, period_key, source FROM app.report_runs WHERE schedule_id = $1`, [sched.json().id]));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'succeeded' && r.period_key === '2026-11-01' && r.source.params.asOf === '2026-10-31')).toBe(true);
    const mails = mailer.sent.slice(sentBefore);
    expect(mails.map((m) => m.to).sort()).toEqual([w.owner.email, expect.stringContaining('manager.')].sort());
    for (const m of mails) {
      expect(m.text).toMatch(/\/app\/reports\/runs\/[0-9a-f-]{36}/);
      expect(`${m.subject} ${m.text}`).not.toMatch(/Ada|Ben|Cleo|Mona|Dan|Eve|Fictional Widgets|Monthly headcount/);
    }
  });

  it('the recipient picker lists only active users who may use reports, and needs the schedule permission', async () => {
    const employee = await w.login(w.people.eve, 'employee', { type: 'self' });
    const list = await w.api('GET', '/v1/reports/recipients');
    expect(list.statusCode, list.body).toBe(200);
    const ids = list.json().map((r: { id: string }) => r.id);
    expect(ids).toContain(w.owner.userId);
    expect(ids).not.toContain(employee.userId);
    expect((await w.api('GET', '/v1/reports/recipients', undefined, employee.cookie)).statusCode).toBe(403);
  });
});

describe('7.1 statutory reports from the compliance centre', () => {
  it('gender pay gap and EEO-1 come from the compliance calculators (vault aggregates, small cells withheld)', async () => {
    for (const [id, sex] of [[w.people.mona, 'female'], [w.people.ada, 'female'], [w.people.cleo, 'male']] as const) {
      expect((await w.api('PUT', `/v1/compliance/demographics/${id}`, { sex })).statusCode).toBe(204);
    }
    const viaReports = await run('gender-pay-gap', { year: 2026 });
    const viaCompliance = (await w.api('GET', '/v1/compliance/reports/gender-pay-gap?year=2026')).json();
    const mean = viaReports.rows[0]!;
    expect(mean.gap).toBe(viaCompliance.figures.meanHourlyPayGap === null ? null : viaCompliance.figures.meanHourlyPayGap.toFixed(1));
    expect(viaReports.facts?.find((f) => f.key === 'headcount')?.value).toBe(viaCompliance.headcount);
    const eeo = await run('eeo-1', { year: 2026 });
    expect(eeo.columns[0]).toMatchObject({ key: 'jobCategory' });
    expect(eeo.facts?.find((f) => f.key === 'suppressionThreshold')?.value).toBeGreaterThan(0);
    const pt = await run('pay-transparency', { year: 2026 });
    expect(pt.rows).toEqual([]); // no EU legal entity
    const status = await run('compliance-status', { asOf: '2026-06-30' });
    expect(status.rows.find((r) => r.status === 'missing' && String(r.area).includes('Right to work'))).toBeDefined();
    const audit = await w.tx((t) => t.query<{ action: string }>(`SELECT action FROM audit.events WHERE action IN ('compliance.gpg_report_viewed', 'compliance.eeo1_report_viewed') AND sensitive`));
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });
});
