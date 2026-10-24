import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfIsoWeek, today } from '@thapsus/core/time';
import { TenantRouter, withTenant } from '@thapsus/db';
import { appUrl, resetDatabase } from '@thapsus/db/testing';
import { rules } from '@thapsus/rules';
import { InMemoryDirectory } from '../src/lib/directory';
import { LocalKeyProvider } from '../src/lib/kms';
import { MemoryObjectStore } from '../src/lib/object-store';
import { balanceFor } from '../src/modules/leave/service';
import { Vault } from '../src/modules/vault/service';
import {
  LOGIN_ROLES,
  stagingConfigFromEnv,
  type LoginRole,
  type StagingLogin,
} from '../src/cli/staging/config';
import { SYSTEM_PRINCIPAL } from '../src/cli/staging/context';
import { seedStaging, type StagingSeedResult } from '../src/cli/staging/seed';
import { closeDb, cookieFrom, enrolTotp, randomIp, startTestApp, type TestContext } from './helpers';

/**
 * `pnpm db:seed:staging` end to end: the seed runs into a fresh, migrated database as the app role (RLS
 * applies), then the real API (Fastify, injected requests) is used as each login. The full-size roster is
 * used so the UK gender-pay-gap threshold assertion is real (STAGING_SEED_TEST_SIZE overrides it locally).
 */
const DB = 'thapsus_seed_staging';
const SIZE = Number(process.env.STAGING_SEED_TEST_SIZE ?? 300);
const KEY = '5a'.repeat(32);
const stagingLogins = (suffix: string) =>
  stagingConfigFromEnv({
    APP_ENV: 'staging',
    STAGING_SEED_EMPLOYEES: String(SIZE),
    STAGING_LOGINS: JSON.stringify({
      workspace: 'kestrel',
      logins: LOGIN_ROLES.map((role) => ({
        role,
        email: `${role.replace('_', '-')}@qa.example.test`,
        password: `Harbour-Lantern-${role.length}-${suffix}-Qz`,
      })),
    }),
  }).logins;

let router: TenantRouter;
let directory: InMemoryDirectory;
let keys: LocalKeyProvider;
let objects: MemoryObjectStore;
let ctx: TestContext;
let first: StagingSeedResult;
let logins: StagingLogin[];
const login = (role: LoginRole) => logins.find((l) => l.role === role)!;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(router, first.tenantId, fn);

async function signIn(l: StagingLogin) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    remoteAddress: randomIp(),
    payload: { tenant: 'kestrel', email: l.email, password: l.password },
  });
}
async function session(role: LoginRole) {
  const res = await signIn(login(role));
  expect(res.statusCode, res.body).toBe(200);
  const cookie = cookieFrom(res);
  // admins enrol MFA at first sign-in (the seed never creates a factor); a test-only enrolment here
  if (res.json().mfaEnrollmentRequired) await enrolTotp(ctx, cookie);
  return cookie;
}
const get = (cookie: string, url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

const COUNTS = `SELECT (SELECT count(*)::int FROM app.employees) AS employees,
  (SELECT count(*)::int FROM app.employee_jobs) AS jobs, (SELECT count(*)::int FROM app.employee_pay) AS pay,
  (SELECT count(*)::int FROM app.leave_requests) AS leave, (SELECT count(*)::int FROM app.shifts) AS shifts,
  (SELECT count(*)::int FROM app.clock_events) AS clock, (SELECT count(*)::int FROM app.timesheets) AS timesheets,
  (SELECT count(*)::int FROM vault.records) AS vault, (SELECT count(*)::int FROM app.documents) AS documents,
  (SELECT count(*)::int FROM app.assets) AS assets, (SELECT count(*)::int FROM app.payslips) AS payslips,
  (SELECT count(*)::int FROM app.approval_requests) AS approvals, (SELECT count(*)::int FROM app.tasks) AS tasks,
  (SELECT count(*)::int FROM app.notifications) AS notifications, (SELECT count(*)::int FROM app.users) AS users,
  (SELECT count(*)::int FROM app.role_assignments) AS roles,
  (SELECT count(*)::int FROM audit.events WHERE action = 'staging.seed_completed') AS markers`;

beforeAll(async () => {
  await resetDatabase(DB);
  router = new TenantRouter({ databases: { shared: appUrl(DB) }, cacheTtlMs: 0, cell: 'uk' });
  directory = new InMemoryDirectory();
  keys = new LocalKeyProvider(KEY);
  objects = new MemoryObjectStore();
  logins = stagingLogins('one');
  const started = Date.now();
  first = await seedStaging(
    { router, directory, keys, objects },
    { workspace: 'kestrel', logins, size: SIZE },
  );
  console.log(`staging seed (${SIZE} people): ${((Date.now() - started) / 1000).toFixed(1)}s`);
  ctx = await startTestApp({ listen: false, directory, overrides: { router, keys, objects } });
}, 600_000);
afterAll(async () => {
  await ctx?.close();
  await closeDb();
});

describe('staging seed', () => {
  it('creates the UK workspace with about 300 people across a UK, an Ireland and a US entity', async () => {
    expect(first).toMatchObject({ tenantCreated: true, dataSeeded: true });
    expect(first.passwordsSet.sort()).toEqual([...LOGIN_ROLES].sort());
    expect((await directory.bySlug('kestrel'))?.homeRegion).toBe('uk');
    const t = await tx((x) =>
      x.one<{ name: string; home_region: string }>('SELECT name, home_region FROM app.tenants'),
    );
    expect(t).toEqual({ name: 'Kestrel Fictional Group Ltd', home_region: 'uk' });
    const split = await tx((x) =>
      x.query<{ country: string; currency: string; active: number; all: number }>(
        `SELECT le.country, le.currency, count(*) FILTER (WHERE e.status = 'active')::int AS active, count(*)::int AS all
           FROM app.employees e JOIN LATERAL (SELECT j.entity_id FROM app.employee_jobs j WHERE j.employee_id = e.id ORDER BY j.valid_from DESC LIMIT 1) j ON true
           JOIN app.legal_entities le ON le.id = j.entity_id GROUP BY 1, 2 ORDER BY 1`,
      ),
    );
    const by = Object.fromEntries(split.map((s) => [s.country, s]));
    expect(Object.keys(by)).toEqual(['GB', 'IE', 'US']);
    expect([by.GB!.currency, by.IE!.currency, by.US!.currency]).toEqual(['GBP', 'EUR', 'USD']);
    expect(split.reduce((a, s) => a + s.active, 0)).toBe(SIZE);
    if (SIZE >= 300) {
      expect(by.GB!.active).toBeGreaterThanOrEqual(250); // UK gender pay gap reporting applies
    }
    expect(first.employeesByEntity).toEqual({
      'Kestrel Fictional Group Ltd': by.GB!.all,
      'Kestrel Fictional Inc.': by.US!.all,
      'Kestrel Fictional Ireland Ltd': by.IE!.all,
    });
    // Manchester, London and Scotland locations; leavers and future joiners
    const locs = await tx((x) =>
      x.query<{ region_code: string }>('SELECT DISTINCT region_code FROM app.locations ORDER BY 1'),
    );
    expect(locs.map((l) => l.region_code)).toEqual(['GB-ENG', 'GB-SCT', 'IE', 'US-NY']);
    const statuses = await tx((x) =>
      x.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM app.employees GROUP BY 1`,
      ),
    );
    expect(Object.fromEntries(statuses.map((s) => [s.status, s.n]))).toMatchObject({ active: SIZE });
    expect(statuses.find((s) => s.status === 'leaver')!.n).toBeGreaterThan(0);
    expect(statuses.find((s) => s.status === 'pre_start')!.n).toBeGreaterThan(0);
    // future-dated changes are stored ahead of their date
    const future = await tx((x) =>
      x.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.employee_jobs WHERE valid_from > current_date`,
      ),
    );
    expect(future.n).toBeGreaterThanOrEqual(3);
  });

  it('lets every login sign in with its password; admin roles must enrol MFA first', async () => {
    for (const l of logins) {
      const res = await signIn(l);
      expect(res.statusCode, `${l.role}: ${res.body}`).toBe(200);
      expect(res.json().mfaEnrollmentRequired).toBe(['owner', 'hr_admin', 'payroll_admin'].includes(l.role));
      expect(res.json().mfaRequired).toBe(false);
    }
    const factors = await tx((x) => x.one<{ n: number }>('SELECT count(*)::int AS n FROM app.totp_factors'));
    expect(factors.n).toBe(0);
    const wrong = await signIn({ ...login('employee'), password: 'Not-The-Password-123' });
    expect(wrong.statusCode).toBe(401);
  });

  it('shows the manager only their own team, with requests waiting for them', async () => {
    const cookie = await session('manager');
    const me = (await get(cookie, '/v1/auth/session')).json() as { employeeId: string; roles: string[] };
    expect(me.roles.sort()).toEqual(['employee', 'manager']);
    const list = await get(cookie, '/v1/employees?limit=200');
    expect(list.statusCode, list.body).toBe(200);
    const seen = (list.json().data as Array<{ id: string }>).map((e) => e.id).sort();
    const team = await tx((x) =>
      x.query<{ id: string }>(
        `WITH RECURSIVE down AS (SELECT id FROM app.employees WHERE manager_id = $1 UNION ALL SELECT e.id FROM app.employees e JOIN down ON e.manager_id = down.id)
         SELECT d.id FROM down d JOIN app.employees e ON e.id = d.id WHERE e.status = 'active' ORDER BY 1`,
        [me.employeeId],
      ),
    );
    expect(seen).toEqual(team.map((t) => t.id));
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.length).toBeLessThanOrEqual(10);
    const outsider = await tx((x) =>
      x.one<{ id: string }>(
        `SELECT id FROM app.employees WHERE status = 'active' AND id <> ALL($1::uuid[]) AND id <> $2 LIMIT 1`,
        [seen, me.employeeId],
      ),
    );
    expect((await get(cookie, `/v1/employees/${outsider.id}`)).statusCode).toBe(403);
    const mine = await get(cookie, '/v1/approvals?view=mine');
    expect(mine.statusCode).toBe(200);
    const subjects = (mine.json() as Array<{ subject: string }>).map((a) => a.subject);
    expect(subjects.filter((s) => s === 'leave.request').length).toBeGreaterThanOrEqual(4);
    expect(subjects).toEqual(expect.arrayContaining(['timesheet', 'shift.swap', 'shift.claim']));
    const tasks = await get(cookie, '/v1/tasks?status=open');
    expect(tasks.statusCode).toBe(200);
    expect((tasks.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('keeps the employee to their own record, with their own leave, rota, documents, payslips and assets', async () => {
    const cookie = await session('employee');
    const me = (await get(cookie, '/v1/auth/session')).json() as { employeeId: string; roles: string[] };
    expect(me.roles).toEqual(['employee']);
    expect((await get(cookie, `/v1/employees/${me.employeeId}`)).statusCode).toBe(200);
    const other = await tx((x) =>
      x.one<{ id: string }>(
        `SELECT id FROM app.employees WHERE id <> $1 AND manager_id = (SELECT manager_id FROM app.employees WHERE id = $1) LIMIT 1`,
        [me.employeeId],
      ),
    );
    expect((await get(cookie, `/v1/employees/${other.id}`)).statusCode).toBe(403);
    expect((await get(cookie, '/v1/employees')).statusCode).toBe(403);
    const summary = await get(cookie, '/v1/me/summary');
    expect(summary.statusCode, summary.body).toBe(200);
    const s = summary.json();
    expect(s.employee.id).toBe(me.employeeId);
    expect(Number(s.leave.available)).toBeGreaterThanOrEqual(0);
    expect(s.rota.nextShift).not.toBeNull();
    expect(s.documents.toSign).toBeGreaterThanOrEqual(1);
    expect(s.payslips.total).toBeGreaterThanOrEqual(2);
    // the standard (statutory-minimum) policy applies to them; the senior policy only by assignment
    const balances = await get(cookie, `/v1/leave/balances/${me.employeeId}`);
    expect(balances.statusCode, balances.body).toBe(200);
    const annual = (balances.json() as Array<{ leaveType: string; policy: string; available: number }>).find(
      (b) => b.leaveType === 'annual',
    )!;
    expect(annual.policy).toMatch(/^Standard annual leave/);
    const policies = await tx((x) =>
      x.query<{ name: string; n: number }>(
        `SELECT p.name, count(DISTINCT a.employee_id)::int AS n FROM app.leave_policies p LEFT JOIN app.leave_policy_assignments a ON a.policy_id = p.id GROUP BY p.name ORDER BY p.name`,
      ),
    );
    expect(policies.find((p) => p.name.startsWith('Senior leadership'))!.n).toBeGreaterThan(5);
    expect(policies.find((p) => p.name.startsWith('Irregular hours'))!.n).toBeGreaterThan(0);
    const assets = await get(cookie, '/v1/me/assets');
    expect(assets.statusCode).toBe(200);
    expect(
      (assets.json() as Array<{ acknowledgedAt: string | null }>).some((a) => a.acknowledgedAt === null),
    ).toBe(true);
  });

  it('gives the employee documents in every signing state, documents HR shared, and twelve months of sample payslips', async () => {
    const cookie = await session('employee');
    const me = (await get(cookie, '/v1/auth/session')).json() as { employeeId: string };
    const sigs = (await get(cookie, '/v1/signature-requests')).json() as Array<{
      documentId: string;
      status: string;
      approvalStatus: string | null;
      completedAt: string | null;
    }>;
    const pending = sigs.filter((x) => x.status === 'pending');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(sigs.some((x) => x.status === 'signed' && x.approvalStatus === 'pending')).toBe(true); // awaiting approval
    expect(sigs.some((x) => x.status === 'signed' && x.completedAt)).toBe(true); // completed
    // one waiting document is a multi-page PDF, opened in the viewer
    const pageCounts = await Promise.all(
      pending.map(async (x) => {
        const pdf = await get(cookie, `/v1/documents/${x.documentId}/content`);
        expect(pdf.statusCode).toBe(200);
        return (pdf.rawPayload.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      }),
    );
    expect(Math.max(...pageCounts)).toBeGreaterThan(1);
    const docs = (await get(cookie, `/v1/documents?employeeId=${me.employeeId}`)).json() as Array<{
      attachmentType: string | null;
      visibility: string | null;
    }>;
    const shared = docs.filter((d) => d.attachmentType).map((d) => d.attachmentType);
    expect(shared).toEqual(expect.arrayContaining(['contract', 'driving_licence']));
    expect(shared).not.toContain('background_check'); // HR keeps that one to itself
    const slips = (await get(cookie, '/v1/me/payslips')).json() as Array<{
      kind: string;
      hasStatement: boolean;
      sample: boolean;
      providerName: string | null;
      periodStart: string | null;
      ytd: unknown[] | null;
      id: string;
    }>;
    const monthly = slips.filter((x) => x.kind === 'payslip' && x.hasStatement);
    expect(new Set(monthly.map((x) => x.periodStart)).size).toBeGreaterThanOrEqual(12);
    expect(monthly.every((x) => x.sample && x.providerName === 'Sample Payroll Provider (fictional)')).toBe(
      true,
    );
    expect(monthly.every((x) => x.ytd?.length)).toBe(true);
    const lines = await Promise.all(
      monthly.map(
        async (x) =>
          (await get(cookie, `/v1/payslips/${x.id}`)).json() as {
            statement: { payments: Array<{ kind: string }>; deductions: unknown[]; illustrative: boolean };
          },
      ),
    );
    expect(lines.some((x) => x.statement.payments.some((l) => l.kind === 'overtime'))).toBe(true);
    expect(lines.some((x) => x.statement.payments.some((l) => l.kind === 'bonus'))).toBe(true);
    expect(lines.every((x) => x.statement.deductions.length >= 3 && x.statement.illustrative)).toBe(true);
    // the payslip notification names the period only: "Your payslip for <Month year> is ready"
    const notes = (await get(cookie, '/v1/me/notifications')).json() as { data: Array<{ title: string }> };
    const ready = notes.data.find((n) => /^Your payslip for /.test(n.title));
    expect(ready?.title).toMatch(/^Your payslip for [A-Z][a-z]+ \d{4} is ready$/);
  });

  it('shows HR right-to-work evidence in the vault for several people, one expiring soon and one expired, and a countersignature to give', async () => {
    // checked in the database: signing HR in here would enrol a factor the next test does not expect
    const rtw = await tx((x) =>
      x.query<{ employee_id: string; expires_on: string | null; vault_record_id: string; category: string }>(
        `SELECT employee_id, expires_on::text AS expires_on, vault_record_id, category FROM app.documents WHERE attachment_type = 'right_to_work'`,
      ),
    );
    expect(new Set(rtw.map((r) => r.employee_id)).size).toBeGreaterThanOrEqual(4);
    expect(rtw.every((r) => r.vault_record_id && r.category === 'immigration')).toBe(true);
    const anchor = today('Europe/London');
    expect(rtw.some((r) => r.expires_on && r.expires_on < anchor)).toBe(true);
    expect(
      rtw.some((r) => r.expires_on && r.expires_on >= anchor && r.expires_on <= addDays(anchor, 60)),
    ).toBe(true);
    const waiting = await tx((x) =>
      x.query(
        `SELECT 1 FROM app.approval_requests r JOIN app.approval_steps s ON s.tenant_id = r.tenant_id AND s.request_id = r.id AND s.step_index = r.current_step
           JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = ANY(s.approver_user_ids)
          WHERE r.subject = 'document.countersign' AND r.status = 'pending' AND lower(u.email) = lower($1)`,
        [login('hr_admin').email],
      ),
    );
    expect(waiting.length).toBeGreaterThanOrEqual(1);
  });

  it('gives the admin logins data on every screen they own', async () => {
    const anchor = today('Europe/London');
    const hr = await session('hr_admin');
    const dash = await get(hr, '/v1/compliance/dashboard');
    expect(dash.statusCode, dash.body).toBe(200);
    expect(dash.json().rightToWork.total).toBeGreaterThan(0);
    if (SIZE >= 300) expect(dash.json().reporting.genderPayGap.required).toBe(true);
    const rtw = await get(hr, '/v1/compliance/right-to-work');
    expect(rtw.statusCode).toBe(200);
    expect((rtw.json() as Array<{ status: string }>).map((r) => r.status)).toEqual(
      expect.arrayContaining(['valid', 'missing']),
    );
    const i9 = await get(hr, '/v1/compliance/i9');
    expect(i9.statusCode).toBe(200);
    expect((i9.json() as unknown[]).length).toBeGreaterThan(0);
    const gpg = await get(hr, `/v1/compliance/reports/gender-pay-gap?year=${anchor.slice(0, 4)}`);
    expect(gpg.statusCode, gpg.body).toBe(200);
    expect((await get(hr, '/v1/approvals?view=mine')).json().length).toBeGreaterThan(0);
    expect((await get(hr, '/v1/documents')).json().length).toBeGreaterThan(5);
    expect((await get(hr, '/v1/assets')).statusCode).toBe(200);
    const week = addDays(startOfIsoWeek(anchor), -14);
    const ts = await get(hr, `/v1/timesheets?weekStart=${week}`);
    expect(ts.statusCode).toBe(200);
    expect(ts.json().data.length).toBeGreaterThan(20);
    const shifts = await get(
      hr,
      `/v1/shifts?from=${startOfIsoWeek(anchor)}&to=${addDays(startOfIsoWeek(anchor), 6)}`,
    );
    expect(shifts.statusCode).toBe(200);
    expect(shifts.json().data.length).toBeGreaterThan(50);
    const saved = await get(hr, '/v1/reports/saved');
    expect(saved.json().length).toBeGreaterThanOrEqual(3);
    const payroll = await session('payroll_admin');
    const periods = await get(payroll, '/v1/payroll/periods');
    expect(periods.statusCode).toBe(200);
    expect(
      (periods.json() as Array<{ status: string }>).filter((p) => p.status === 'closed').length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      (await get(payroll, '/v1/approvals?view=mine')).json().map((a: { subject: string }) => a.subject),
    ).toContain('employee.change');
    const owner = await session('owner');
    expect((await get(owner, '/v1/employees?limit=200')).json().data.length).toBe(200);
  });

  it('keeps every booked annual leave within the employee’s balance (leave engine, packs)', async () => {
    const book = rules();
    const asOf = today('Europe/London');
    const negative = await tx(async (x) => {
      const type = await x.one<{ id: string }>(`SELECT id FROM app.leave_types WHERE key = 'annual'`);
      const people = await x.query<{ id: string }>(
        `SELECT e.id FROM app.employees e WHERE e.status = 'active' AND NOT EXISTS (
           SELECT 1 FROM app.employee_jobs j WHERE j.employee_id = e.id AND j.employment_type = 'casual')`,
      );
      const out: string[] = [];
      for (const p of people) {
        const b = await balanceFor(x, book, p.id, type.id, asOf);
        if (!b || b.available < 0) out.push(p.id);
      }
      return out;
    });
    expect(negative).toEqual([]);
  });

  it('stores sensitive data only as ciphertext from the key provider, and audits it', async () => {
    const rows = await tx((x) =>
      x.query<{
        id: string;
        subject_id: string;
        category: string;
        field: string;
        envelope: { ct: string; kid: string };
      }>('SELECT id, subject_id, category, field, envelope FROM vault.records'),
    );
    const cats = new Set(rows.map((r) => r.category));
    expect([...cats].sort()).toEqual(['diversity', 'eeo', 'immigration', 'sickness']);
    const text = JSON.stringify(rows);
    for (const plain of [
      '"sex"',
      'female',
      'Migraine',
      'Seasonal flu',
      'raceEthnicity',
      'us_citizen',
      'SAMPLE-1',
      'passport',
    ])
      expect(text.includes(plain), plain).toBe(false);
    expect(rows.every((r) => r.envelope.kid === 'local-kms' && r.envelope.ct.length > 0)).toBe(true);
    // the same key provider opens them (field-level envelope encryption bound to tenant/subject/category/field)
    const sickness = rows.find((r) => r.category === 'sickness')!;
    const value = await tx((x) =>
      new Vault(keys).read(
        x,
        { principal: SYSTEM_PRINCIPAL, actorType: 'system' },
        first.tenantId,
        { employeeId: sickness.subject_id },
        'sickness',
      ),
    );
    expect(value[0]!.value.length).toBeGreaterThan(3);
    const wrongKey = new Vault(new LocalKeyProvider('6b'.repeat(32)));
    await expect(
      tx((x) =>
        wrongKey.read(
          x,
          { principal: SYSTEM_PRINCIPAL, actorType: 'system' },
          first.tenantId,
          { employeeId: sickness.subject_id },
          'sickness',
        ),
      ),
    ).rejects.toThrow();
    const audited = await tx((x) =>
      x.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit.events WHERE action = 'vault.write' AND sensitive`,
      ),
    );
    expect(audited.n).toBe(rows.length);
    // the audit chain is sealed and intact
    expect(
      await tx((x) => x.one<{ broken: string | null }>('SELECT audit.verify_chain() AS broken')),
    ).toEqual({ broken: null });
  });

  it('stores generated files through the object store under the tenant’s prefix', async () => {
    const keysInDb = await tx((x) =>
      x.query<{ k: string }>(
        `SELECT file_key AS k FROM app.documents UNION ALL SELECT file_key FROM app.payslips WHERE file_key IS NOT NULL UNION ALL SELECT file_key FROM app.payroll_exports`,
      ),
    );
    expect(keysInDb.length).toBeGreaterThan(300);
    for (const { k } of keysInDb) {
      expect(k.startsWith(`${first.tenantId}/`)).toBe(true);
      expect(objects.objects.has(k), k).toBe(true);
    }
  });

  it('does not send email for seeded history', async () => {
    const queued = await tx((x) =>
      x.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.jobs WHERE kind = 'notifications.deliver' AND status = 'queued'`,
      ),
    );
    expect(queued.n).toBe(0);
  });

  it('is idempotent: a second run changes no data and resets the login passwords to the new secret', async () => {
    const before = await tx((x) => x.one(COUNTS));
    const rotated = stagingLogins('two');
    const second = await seedStaging(
      { router, directory, keys, objects },
      { workspace: 'kestrel', logins: rotated, size: SIZE },
    );
    expect(second).toMatchObject({ tenantId: first.tenantId, tenantCreated: false, dataSeeded: false });
    expect(second.passwordsSet.sort()).toEqual([...LOGIN_ROLES].sort());
    expect(await tx((x) => x.one(COUNTS))).toEqual(before);
    expect(before.markers).toBe(1);
    for (const l of rotated) {
      expect((await signIn(l)).statusCode, l.role).toBe(200);
      expect((await signIn(logins.find((o) => o.role === l.role)!)).statusCode, l.role).toBe(401);
    }
    // a third run with the same secret changes nothing at all
    const third = await seedStaging(
      { router, directory, keys, objects },
      { workspace: 'kestrel', logins: rotated, size: SIZE },
    );
    expect(third.passwordsSet).toEqual([]);
    expect(await tx((x) => x.one(COUNTS))).toEqual(before);
    logins = rotated;
  });
});

describe('pnpm db:seed:staging (the process)', () => {
  const run = (env: Record<string, string>) =>
    promisify(execFile)('npx', ['tsx', 'src/cli/seed-staging.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        OTEL_SDK_DISABLED: 'true',
        DATABASE_URL: appUrl(DB),
        STAGING_LOGINS: '',
        ...env,
      },
      timeout: 120_000,
    }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );

  it('refuses production and a staging run without STAGING_LOGINS, before touching the database', async () => {
    const prod = await run({ APP_ENV: 'prod', STAGING_LOGINS: JSON.stringify({ logins: [] }) });
    expect(prod.code).toBe(1);
    expect(prod.out).toContain('staging seed refused: The staging seed never runs when APP_ENV=prod');
    const staging = await run({ APP_ENV: 'staging' });
    expect(staging.code).toBe(1);
    expect(staging.out).toContain('STAGING_LOGINS is required when APP_ENV=staging');
  }, 120_000);

  it('refuses a deployed run without a durable object store, printing no email or password', async () => {
    const res = await run({
      APP_ENV: 'loadtest',
      CELL_REGION: 'uk',
      LOCAL_KMS_KEY: KEY,
      FILES_BUCKET: '',
      STAGING_SEED_EMPLOYEES: String(SIZE),
      STAGING_LOGINS: JSON.stringify({ workspace: 'kestrel', logins }),
    });
    // the memory object store would lose files outside local development, so the run is refused
    expect(res.code).toBe(1);
    expect(res.out).toContain('No object store is configured');
    for (const l of logins) {
      expect(res.out).not.toContain(l.email);
      expect(res.out).not.toContain(l.password);
    }
  }, 120_000);
});
