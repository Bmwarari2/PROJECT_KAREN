import { expect } from 'vitest';
import { withTenant, type JobRow, type Tx } from '@thapsus/db';
import { cookieFrom, enrolTotp, ownerSession, PASSWORD, randomIp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers } from '../src/worker';

/**
 * "Fictional Widgets": a fictional UK + US company for the phase 7 report tests. Every person is invented.
 *
 *   person  start       end / change                         entity on 31 Mar 2026 → 30 Jun 2026
 *   Mona    2024-01-08  manager of Ada, Ben, Cleo            GB · GB
 *   Ada     2025-01-06                                       GB · GB
 *   Ben     2025-06-02  leaves 2026-03-31 (voluntary)        GB (last day) · —
 *   Cleo    2026-02-02                                       GB · GB
 *   Dan     2024-01-08  leaves 2026-06-30 (involuntary)      US · US (last day)
 *   Eve     2025-01-06  transfers to the US 2026-04-01       GB · US
 */
export async function widgets(ctx: TestContext) {
  const owner = await ownerSession(ctx);
  const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) =>
    ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie }, remoteAddress: randomIp() });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(ctx.deps.router, owner.tenantId, fn);
  const post = async (url: string, body: unknown, cookie = owner.cookie) => {
    const r = await api('POST', url, body, cookie);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const gb = await post('/v1/org/legal-entities', { name: 'Fictional Widgets Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });
  const us = await post('/v1/org/legal-entities', { name: 'Fictional Widgets Inc', country: 'US', regionCode: 'US-TX', currency: 'USD', timeZone: 'America/Chicago' });
  const london = await post('/v1/org/locations', { name: 'Fictional Office London', country: 'GB', regionCode: 'GB-ENG', timeZone: 'Europe/London', entityId: gb });
  const austin = await post('/v1/org/locations', { name: 'Fictional Office Austin', country: 'US', regionCode: 'US-TX', timeZone: 'America/Chicago', entityId: us });
  const eng = await post('/v1/org/departments', { name: 'Engineering' });
  const sales = await post('/v1/org/departments', { name: 'Sales' });
  const hire = (first: string, startDate: string, v: Record<string, unknown>) =>
    post('/v1/employees', { startDate, legalFirstName: first, legalLastName: 'Fictional', jobTitle: 'Analyst', weeklyHours: 37.5, contractType: 'permanent', ...v });
  const gbJob = { entityId: gb, locationId: london, payCurrency: 'GBP', payFrequency: 'annual' };
  const mona = await hire('Mona', '2024-01-08', { ...gbJob, departmentId: eng, payAmountMinor: 6_000_000, jobTitle: 'Engineering manager' });
  const ada = await hire('Ada', '2025-01-06', { ...gbJob, departmentId: eng, payAmountMinor: 3_640_000, managerId: mona });
  const ben = await hire('Ben', '2025-06-02', { ...gbJob, departmentId: sales, payAmountMinor: 3_000_000, managerId: mona });
  const cleo = await hire('Cleo', '2026-02-02', { ...gbJob, departmentId: sales, payAmountMinor: 3_200_000, managerId: mona });
  const dan = await hire('Dan', '2024-01-08', { entityId: us, locationId: austin, departmentId: eng, payAmountMinor: 7_500_000, payCurrency: 'USD', payFrequency: 'annual', weeklyHours: 40 });
  const eve = await hire('Eve', '2025-01-06', { ...gbJob, departmentId: eng, payAmountMinor: 4_000_000 });
  const term = async (id: string, endDate: string, leaverType: string) => {
    const r = await api('POST', `/v1/employees/${id}/terminate`, { endDate, reason: 'Fictional leaver', leaverType });
    expect(r.statusCode, r.body).toBe(200);
  };
  await term(ben, '2026-03-31', 'voluntary');
  await term(dan, '2026-06-30', 'involuntary');
  const transfer = await api('POST', `/v1/employees/${eve}/changes`, { effectiveDate: '2026-04-01', entityId: us, locationId: austin, departmentId: sales, payAmountMinor: 9_000_000, payCurrency: 'USD' });
  expect(transfer.statusCode, transfer.body).toBe(200);

  async function login(employeeId: string | null, role: string, scope: { type: 'self' | 'own_team' | 'all' | 'entity'; values?: string[] }) {
    const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
    const userId = await tx(async (t) => {
      const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`, [email, employeeId]);
      await t.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
      await assignRole(t, u.id, role, scope);
      if (role !== 'employee' && employeeId) await assignRole(t, u.id, 'employee', { type: 'self' });
      return u.id;
    });
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: randomIp() });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const cookie = cookieFrom(res);
    if (['hr_admin', 'entity_hr_admin', 'payroll_admin', 'owner'].includes(role)) await enrolTotp(ctx, cookie);
    return { cookie, userId };
  }

  /** Runs every queued job (as the worker would), returning the jobs that ran. */
  async function drain() {
    const ran: JobRow[] = [];
    for (let round = 0; round < 10; round++) {
      const jobs = await tx((t) => t.query<JobRow>(`UPDATE app.jobs SET status = 'running', attempts = attempts + 1 WHERE status = 'queued' RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`));
      if (!jobs.length) return ran;
      for (const job of jobs) {
        const progress = (done: number, total?: number) => tx((t) => t.exec('UPDATE app.jobs SET progress_done = $2, progress_total = coalesce($3, progress_total) WHERE id = $1', [job.id, done, total ?? null])).then(() => undefined);
        const result = await jobHandlers[job.kind]!({ tenantId: owner.tenantId, job, deps: ctx.deps, tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn, { actorId: job.created_by }), progress });
        await tx((t) => t.exec(`UPDATE app.jobs SET status = 'succeeded', result = $2 WHERE id = $1`, [job.id, JSON.stringify(result ?? {})]));
        ran.push(job);
      }
    }
    return ran;
  }
  return { owner, api, tx, post, login, drain, gb, us, london, austin, eng, sales, people: { mona, ada, ben, cleo, dan, eve } };
}
export type Widgets = Awaited<ReturnType<typeof widgets>>;
