import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * Tenant isolation for the compliance centre: another tenant can neither see nor change company A's
 * right-to-work checks, I-9 records, matrix, attestations, pay-report inputs or law-change acknowledgements,
 * through the API or directly in the database (forced RLS).
 */
let ctx: TestContext;
let a: Awaited<ReturnType<typeof ownerSession>>;
let b: Awaited<ReturnType<typeof ownerSession>>;
const ids: Record<string, string> = {};
const as = (s: { cookie: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => ctx.app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie } });
const TABLES = ['app.rtw_checks', 'app.i9_records', 'app.compliance_requirements', 'app.compliance_records', 'app.flsa_attestations', 'app.eeo_job_categories', 'app.pay_report_inputs', 'app.law_change_reads'];

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  a = await ownerSession(ctx);
  b = await ownerSession(ctx);
  const ent = async (s: typeof a, country: string, regionCode: string | null, currency: string) => (await as(s, 'POST', '/v1/org/legal-entities', { name: `Fictional ${country}`, country, regionCode, currency, timeZone: 'Europe/London' })).json().id as string;
  const gb = await ent(a, 'GB', 'GB-ENG', 'GBP');
  const us = await ent(a, 'US', 'US-TX', 'USD');
  await ent(b, 'GB', 'GB-ENG', 'GBP');
  const hire = async (entityId: string, extra: Record<string, unknown> = {}) => (await as(a, 'POST', '/v1/employees', { startDate: '2026-03-02', legalFirstName: 'Fictional', legalLastName: 'Isolated', jobTitle: 'Analyst', entityId, weeklyHours: 40, payAmountMinor: 4_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent', ...extra })).json().id as string;
  ids.uk = await hire(gb);
  ids.us = await hire(us, { payCurrency: 'USD', flsaStatus: 'exempt' });
  ids.check = (await as(a, 'POST', '/v1/compliance/right-to-work/checks', { employeeId: ids.uk, checkMethod: 'manual_document_check', listType: 'list_a', checkedOn: '2026-10-05' })).json().id;
  ids.i9 = (await as(a, 'POST', '/v1/compliance/i9', { employeeId: ids.us, section1CompletedOn: '2026-03-02' })).json().id;
  ids.req = (await as(a, 'POST', '/v1/compliance/requirements', { kind: 'training', name: 'Fictional induction' })).json().id;
  ids.rec = (await as(a, 'POST', '/v1/compliance/records', { requirementId: ids.req, employeeId: ids.uk, issuedOn: '2026-03-02' })).json().id;
  await as(a, 'POST', '/v1/compliance/flsa/attestations', { employeeId: ids.us, exemption: 'outside_sales', duties: ['primary_duty_making_sales_or_obtaining_orders_or_contracts'], validFrom: '2026-03-02' });
  await as(a, 'PUT', '/v1/compliance/eeo/job-categories', { mappings: [{ jobTitle: 'Analyst', category: 'professionals' }] });
  await as(a, 'PUT', '/v1/compliance/pay-report-inputs', { kind: 'uk_gpg', snapshotDate: '2026-04-05', rows: [{ employeeId: ids.uk, currency: 'GBP', ordinaryPayMinor: 300_000, weeklyHours: 40 }] });
  await withTenant(ctx.deps.router, a.tenantId, (tx) => tx.exec(`INSERT INTO app.law_change_reads (tenant_id, law_change_id, user_id) VALUES (app.current_tenant(), gen_random_uuid(), $1)`, [a.userId]));
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('compliance data is isolated between tenants', () => {
  it('company A has a row in every compliance table', async () => {
    for (const t of TABLES) expect((await withTenant(ctx.deps.router, a.tenantId, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))).n, t).toBeGreaterThan(0);
  });

  it('company B sees none of them in the database and cannot write rows for company A', async () => {
    for (const t of TABLES) {
      expect((await withTenant(ctx.deps.router, b.tenantId, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))).n, t).toBe(0);
      expect(await withTenant(ctx.deps.router, b.tenantId, (tx) => tx.exec(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [a.tenantId])), t).toBe(0);
    }
    await expect(withTenant(ctx.deps.router, b.tenantId, (tx) => tx.exec(`INSERT INTO app.compliance_requirements (tenant_id, kind, name) VALUES ($1, 'other', 'Fictional intrusion')`, [a.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it('company B gets 404 for company A records and empty lists through the API', async () => {
    expect((await as(b, 'GET', `/v1/compliance/right-to-work/checks/${ids.check}`)).statusCode).toBe(404);
    expect((await as(b, 'PATCH', `/v1/compliance/i9/${ids.i9}`, { section2CompletedOn: '2026-03-03' })).statusCode).toBe(404);
    expect((await as(b, 'PATCH', `/v1/compliance/requirements/${ids.req}`, { name: 'Hijacked' })).statusCode).toBe(404);
    expect((await as(b, 'POST', `/v1/compliance/records/${ids.rec}/revoke`, { reason: 'Fictional intrusion' })).statusCode).toBe(404);
    expect((await as(b, 'POST', '/v1/compliance/records', { requirementId: ids.req, employeeId: ids.uk, issuedOn: '2026-03-02' })).statusCode).toBe(404);
    expect((await as(b, 'POST', '/v1/compliance/right-to-work/checks', { employeeId: ids.uk, checkMethod: 'manual_document_check', listType: 'list_a', checkedOn: '2026-10-05' })).statusCode).toBe(404);
    expect((await as(b, 'GET', `/v1/compliance/eeo/self-identification/${ids.us}`)).statusCode).toBe(404);
    expect((await as(b, 'GET', '/v1/compliance/right-to-work?asOf=2026-10-18')).json()).toEqual([]);
    expect((await as(b, 'GET', '/v1/compliance/i9?asOf=2026-10-18')).json()).toEqual([]);
    expect((await as(b, 'GET', '/v1/compliance/requirements')).json()).toEqual([]);
    expect((await as(b, 'GET', '/v1/compliance/matrix?asOf=2026-10-18')).json().total).toBe(0);
    expect((await as(b, 'GET', '/v1/compliance/eeo/job-categories')).json().mappings).toEqual([]);
    const dash = (await as(b, 'GET', '/v1/compliance/dashboard?asOf=2026-10-18')).json();
    expect(dash.rightToWork.total + dash.i9.total).toBe(0);
  });
});
