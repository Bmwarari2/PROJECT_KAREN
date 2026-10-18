import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers } from '../src/worker';

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let entityUk: string;
let entityDe: string;
let dept: string;
let h: { cookie: string };

const api = (method: string, url: string, payload?: unknown, cookie = h.cookie) => ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });

async function hire(values: Record<string, unknown>) {
  const res = await api('POST', '/v1/employees', {
    startDate: '2026-01-05',
    legalFirstName: 'Avery',
    legalLastName: 'Example',
    jobTitle: 'Analyst',
    entityId: entityUk,
    departmentId: dept,
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    ...values,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function userFor(employeeId: string, role: string, scope: { type: 'all' | 'self' | 'own_team' | 'entity'; values?: string[] }) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`, [email, employeeId]);
    await tx.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
    await assignRole(tx, u.id, role, scope);
    if (role !== 'employee') await assignRole(tx, u.id, 'employee', { type: 'self' });
  });
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: `10.60.${Math.floor(Math.random() * 250)}.1` });
  return cookieFrom(res);
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  h = { cookie: owner.cookie };
  entityUk = (await api('POST', '/v1/org/legal-entities', { name: 'Fictional UK Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' })).json().id;
  entityDe = (await api('POST', '/v1/org/legal-entities', { name: 'Fictional GmbH', country: 'DE', currency: 'EUR', timeZone: 'Europe/Berlin' })).json().id;
  dept = (await api('POST', '/v1/org/departments', { name: 'Engineering' })).json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('effective-dated employee records', () => {
  it('hires with personal, job, pay and contract records and answers as-of queries', async () => {
    const id = await hire({ startDate: '2026-01-05' });
    const before = await api('GET', `/v1/employees/${id}?asOf=2026-01-04`);
    expect(before.json().employee.jobTitle).toBeNull();
    const now = await api('GET', `/v1/employees/${id}?asOf=2026-02-01`);
    expect(now.json().employee).toMatchObject({ jobTitle: 'Analyst', payAmountMinor: '4000000', payCurrency: 'GBP', contractType: 'permanent', status: 'active' });
  });

  it('supports past, present and future-dated changes, keeping full history', async () => {
    const id = await hire({});
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-04-01', jobTitle: 'Senior analyst', payAmountMinor: 4_800_000 })).statusCode).toBe(200);
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2027-01-01', jobTitle: 'Lead analyst' })).statusCode).toBe(200);
    // a change in between the two keeps the later future-dated record intact
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-09-01', weeklyHours: 30 })).statusCode).toBe(200);
    const at = async (d: string) => (await api('GET', `/v1/employees/${id}?asOf=${d}`)).json().employee;
    expect(await at('2026-03-31')).toMatchObject({ jobTitle: 'Analyst', payAmountMinor: '4000000' });
    expect(await at('2026-04-01')).toMatchObject({ jobTitle: 'Senior analyst', payAmountMinor: '4800000' });
    expect(await at('2026-09-01')).toMatchObject({ jobTitle: 'Senior analyst', weeklyHours: '30.00' });
    expect(await at('2027-01-01')).toMatchObject({ jobTitle: 'Lead analyst', weeklyHours: '30.00' });
    const hist = (await api('GET', `/v1/employees/${id}/history`)).json();
    expect(hist.job.map((j: { job_title: string }) => j.job_title)).toEqual(['Analyst', 'Senior analyst', 'Senior analyst', 'Lead analyst']);
    expect(hist.pay).toHaveLength(2);
  });

  it('a correction on the record start date updates in place', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-01-05', jobTitle: 'Data analyst' });
    const hist = (await api('GET', `/v1/employees/${id}/history`)).json();
    expect(hist.job).toHaveLength(1);
    expect(hist.job[0].job_title).toBe('Data analyst');
  });

  it('overlapping periods are rejected by the database', async () => {
    const id = await hire({});
    await expect(
      withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.exec(`INSERT INTO app.employee_jobs (tenant_id, employee_id, valid_from, job_title, entity_id) VALUES (app.current_tenant(), $1, '2026-03-01', 'Overlap', $2)`, [id, entityUk]),
      ),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
  });

  it('future-dated changes take effect on their date via an idempotent daily job', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2030-06-01', jobTitle: 'Principal analyst' });
    const listed = async () => (await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.one<{ job_title: string }>('SELECT job_title FROM app.employees WHERE id = $1', [id]))).job_title;
    expect(await listed()).toBe('Analyst');
    const run = (date: string) =>
      jobHandlers['employees.refresh_effective']!({
        tenantId: owner.tenantId,
        job: { id: 'x', tenant_id: owner.tenantId, kind: 'employees.refresh_effective', idempotency_key: date, input: { date }, attempts: 1, created_by: null },
        deps: ctx.deps,
        tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn),
        progress: async () => undefined,
      });
    await run('2030-06-01');
    expect(await listed()).toBe('Principal analyst');
    await run('2030-06-01'); // idempotent
    expect(await listed()).toBe('Principal analyst');
  });
});

describe('reporting lines and org chart', () => {
  it('rejects cycles and requires reassignment when terminating a manager with reports', async () => {
    const boss = await hire({ legalFirstName: 'Blake', jobTitle: 'Head' });
    const mid = await hire({ legalFirstName: 'Casey', managerId: boss });
    const leaf = await hire({ legalFirstName: 'Devon', managerId: mid });
    const cyc = await api('POST', `/v1/employees/${boss}/changes`, { effectiveDate: '2026-03-01', managerId: leaf });
    expect(cyc.statusCode).toBe(422);
    const term = await api('POST', `/v1/employees/${mid}/terminate`, { endDate: '2027-06-30', reason: 'Resignation' });
    expect(term.statusCode).toBe(422);
    expect(term.json().reports).toBe(1);
    const ok = await api('POST', `/v1/employees/${mid}/terminate`, { endDate: '2027-06-30', reason: 'Resignation', reassignReportsTo: boss });
    expect(ok.statusCode).toBe(200);
    const after = (await api('GET', `/v1/employees/${leaf}?asOf=2027-07-01`)).json().employee;
    expect(after.managerId).toBe(boss);
    const children = (await api('GET', `/v1/org-chart/${boss}/children`)).json();
    expect(children.map((c: { id: string }) => c.id)).toContain(mid); // still active until end date passes
    const focus = (await api('GET', `/v1/org-chart/${leaf}/focus`)).json();
    expect(focus.node.id).toBe(leaf);
  });

  it('supports dotted and matrix lines alongside one solid line', async () => {
    const a = await hire({});
    const b = await hire({});
    const c = await hire({ managerId: a });
    expect((await api('POST', `/v1/employees/${c}/reporting-lines`, { managerId: b, kind: 'dotted', effectiveDate: '2026-02-01' })).statusCode).toBe(201);
    expect((await api('POST', `/v1/employees/${c}/reporting-lines`, { managerId: b, kind: 'dotted', effectiveDate: '2026-02-01' })).statusCode).toBe(409);
  });
});

describe('field-level permissions and scope', () => {
  it('managers see their team with limited fields and cannot see pay; employees see themselves', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Morgan', jobTitle: 'Manager' });
    const report = await hire({ legalFirstName: 'Reese', managerId: mgrEmp, dateOfBirth: '1990-02-03' });
    const outsider = await hire({ legalFirstName: 'Sage' });
    const mgr = await userFor(mgrEmp, 'manager', { type: 'own_team' });
    const r = (await api('GET', `/v1/employees/${report}`, undefined, mgr)).json();
    expect(r.employee.jobTitle).toBe('Analyst');
    expect(r.employee.payAmountMinor).toBeUndefined();
    expect(r.employee.dateOfBirth).toBeUndefined();
    expect(r.access.payAmountMinor).toBe('none'); // the UI renders exactly what the API allows
    expect((await api('GET', `/v1/employees/${outsider}`, undefined, mgr)).statusCode).toBe(403);
    const list = (await api('GET', '/v1/employees', undefined, mgr)).json().data.map((e: { id: string }) => e.id);
    expect(list).toContain(report);
    expect(list).not.toContain(outsider);
    expect((await api('POST', `/v1/employees/${report}/changes`, { effectiveDate: '2026-05-01', jobTitle: 'Hacked' }, mgr)).statusCode).toBe(403);

    const self = await userFor(report, 'employee', { type: 'self' });
    const me = (await api('GET', `/v1/employees/${report}`, undefined, self)).json();
    expect(me.employee.payAmountMinor).toBe('4000000');
    expect((await api('POST', `/v1/employees/${report}/changes`, { effectiveDate: '2026-05-01', personalEmail: 'reese@personal.example.test' }, self)).statusCode).toBe(200);
    expect((await api('POST', `/v1/employees/${report}/changes`, { effectiveDate: '2026-05-01', payAmountMinor: 9_000_000 }, self)).statusCode).toBe(403);
    expect((await api('GET', `/v1/employees/${outsider}`, undefined, self)).statusCode).toBe(403);
  });

  it('entity-scoped HR admins only see and change their entity', async () => {
    const de = await hire({ entityId: entityDe, payCurrency: 'EUR' });
    const uk = await hire({});
    const hr = await userFor(uk, 'entity_hr_admin', { type: 'entity', values: [entityDe] });
    // admins must pass MFA before admin routes: enrol TOTP for this session
    const { enrolTotp } = await import('./helpers');
    await enrolTotp(ctx, hr);
    const list = (await api('GET', '/v1/employees?status=all', undefined, hr)).json().data.map((e: { id: string }) => e.id);
    expect(list).toContain(de);
    expect(list).not.toContain(uk);
    expect((await api('POST', `/v1/employees/${uk}/changes`, { effectiveDate: '2026-05-01', jobTitle: 'X' }, hr)).statusCode).toBe(403);
    expect((await api('POST', `/v1/employees/${de}/changes`, { effectiveDate: '2026-05-01', jobTitle: 'Ingenieur' }, hr)).statusCode).toBe(200);
  });

  it('searches by name, number and email', async () => {
    const id = await hire({ legalFirstName: 'Quillon', legalLastName: 'Searchable', workEmail: 'quillon@x.example.test' });
    for (const q of ['Quillon', 'searchable', 'quillon@x.example.test']) {
      const ids = (await api('GET', `/v1/employees?q=${encodeURIComponent(q)}`)).json().data.map((e: { id: string }) => e.id);
      expect(ids, q).toContain(id);
    }
  });

  it('paginates with a stable cursor', async () => {
    const first = (await api('GET', '/v1/employees?limit=3')).json();
    const second = (await api('GET', `/v1/employees?limit=3&cursor=${first.nextCursor}`)).json();
    expect(first.data).toHaveLength(3);
    expect(new Set([...first.data, ...second.data].map((e: { id: string }) => e.id)).size).toBe(first.data.length + second.data.length);
  });
});

describe('custom fields and objects', () => {
  it('validates custom field values by type and stores them (with audit)', async () => {
    await api('POST', '/v1/settings/custom-fields', { key: 'tshirtSize', label: { 'en-GB': 'T-shirt size' }, fieldType: 'select', options: [{ value: 'M', label: { 'en-GB': 'M' } }, { value: 'L', label: { 'en-GB': 'L' } }] });
    await api('POST', '/v1/settings/custom-fields', { key: 'badgeNumber', label: { 'en-GB': 'Badge' }, fieldType: 'number', validation: { min: 1, max: 9999 } });
    const id = await hire({ custom: { tshirtSize: 'M', badgeNumber: 42 } });
    expect((await api('GET', `/v1/employees/${id}`)).json().employee.custom).toEqual({ tshirtSize: 'M', badgeNumber: 42 });
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-02-01', custom: { tshirtSize: 'XXL' } })).statusCode).toBe(400);
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-02-01', custom: { badgeNumber: 0 } })).statusCode).toBe(400);
    expect((await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-02-01', custom: { nope: 1 } })).statusCode).toBe(400);
  });

  it('custom objects validate against their field definitions', async () => {
    await api('POST', '/v1/settings/custom-objects', { key: 'certifications', label: { 'en-GB': 'Certifications' }, fields: [{ key: 'name', label: { 'en-GB': 'Name' }, fieldType: 'text', required: true }, { key: 'expires', label: { 'en-GB': 'Expires' }, fieldType: 'date' }] });
    const id = await hire({});
    expect((await api('POST', `/v1/employees/${id}/custom-objects/certifications`, { data: { name: 'First aid', expires: '2027-01-01' } })).statusCode).toBe(201);
    expect((await api('POST', `/v1/employees/${id}/custom-objects/certifications`, { data: { expires: '2027-01-01' } })).statusCode).toBe(400);
  });

  it('every change is audited with a before/after diff', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-02-01', jobTitle: 'Audited title' });
    const rows = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.query<{ diff: { changes: Record<string, unknown> } }>(`SELECT diff FROM audit.events WHERE action = 'employee.changed' AND target_id = $1`, [id]));
    expect(rows[0]!.diff.changes).toEqual({ jobTitle: { from: 'Analyst', to: 'Audited title' } });
  });
});
