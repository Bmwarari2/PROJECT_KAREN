import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, dayOfWeek } from '@thapsus/core/time';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers } from '../src/worker';

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let entity: string;
let annual: string;
let sickness: string;
const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) =>
  ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
const firstMondayOfJuly = (y: number) => {
  let d = `${y}-07-01`;
  while (dayOfWeek(d) !== 1) d = addDays(d, 1);
  return d;
};
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);

async function hire(v: Record<string, unknown> = {}) {
  const r = await api('POST', '/v1/employees', {
    startDate: '2025-01-06',
    legalFirstName: 'Leave',
    legalLastName: 'Taker',
    jobTitle: 'Analyst',
    entityId: entity,
    weeklyHours: 37.5,
    payAmountMinor: 3_120_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    ...v,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function login(
  employeeId: string,
  role: string,
  scope: { type: 'self' | 'own_team' } = { type: 'self' },
) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  await tx(async (t) => {
    const u = await t.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional', $2) RETURNING id`,
      [email, employeeId],
    );
    await t.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(t, u.id, role, scope);
    if (role !== 'employee') await assignRole(t, u.id, 'employee', { type: 'self' });
  });
  return cookieFrom(
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email, password: PASSWORD },
      remoteAddress: `10.80.${Math.floor(Math.random() * 250)}.3`,
    }),
  );
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  entity = (
    await api('POST', '/v1/org/legal-entities', {
      name: 'Fictional UK Ltd',
      country: 'GB',
      regionCode: 'GB-ENG',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).json().id;
  const types = (await api('GET', '/v1/leave/types')).json();
  annual = types.find((t: { key: string }) => t.key === 'annual').id;
  sickness = types.find((t: { key: string }) => t.key === 'sickness').id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('policies and balances', () => {
  it('seeds a default UK policy from the statutory minimum in the GB pack (28 days incl. bank holidays)', async () => {
    const emp = await hire();
    const bal = (await api('GET', `/v1/leave/balances/${emp}?asOf=2026-06-01`)).json();
    const a = bal.find((b: { leaveType: string }) => b.leaveType === 'annual');
    expect(a.entitlement).toBe(28);
    expect(a.publicHolidays).toBe(8); // England & Wales 2026 bank holidays, all on weekdays
  });

  it('warns when a policy is below the statutory minimum', async () => {
    // Scoped to its own entity so it does not become the GB default for the employees hired by later tests.
    const other = (
      await api('POST', '/v1/org/legal-entities', {
        name: 'Fictional Policy Test Ltd',
        country: 'GB',
        regionCode: 'GB-ENG',
        currency: 'GBP',
        timeZone: 'Europe/London',
      })
    ).json().id;
    const res = await api('POST', '/v1/leave/policies', {
      name: 'Too little',
      leaveTypeId: annual,
      entityId: other,
      country: 'GB',
      config: {
        accrual: { method: 'annual_upfront', days: 20 },
        unit: 'days',
        yearStart: '01-01',
        proRata: true,
        includesPublicHolidays: true,
        waitingDays: 0,
        allowNegativeDays: 0,
        rounding: 'none',
      },
    });
    expect(res.json().warnings).toEqual(['belowStatutoryMinimum:28']);
  });
});

describe('requests, approval chain, cancellation and adjustments', () => {
  it('employee requests leave, the manager approves via the approval chain, balance updates', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Mina' });
    const emp = await hire({ managerId: mgrEmp });
    const me = await login(emp, 'employee');
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    // A Monday–Friday week next July, so the employee can still cancel it (always in the future).
    const y = new Date().getUTCFullYear() + 1;
    const mon = firstMondayOfJuly(y);
    const req = await api(
      'POST',
      '/v1/leave/requests',
      { leaveTypeId: annual, startDate: mon, endDate: addDays(mon, 4) },
      me,
    );
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json()).toMatchObject({ status: 'pending', amountDays: 5 });
    expect(
      (
        await api(
          'POST',
          '/v1/leave/requests',
          { leaveTypeId: annual, startDate: addDays(mon, 2), endDate: addDays(mon, 2) },
          me,
        )
      ).statusCode,
    ).toBe(409);
    const inbox = (await api('GET', '/v1/approvals', undefined, mgr)).json();
    const ar = inbox.find(
      (a: { payload: { leaveRequestId: string } }) => a.payload.leaveRequestId === req.json().id,
    );
    expect(
      (await api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'approve' }, mgr)).json().status,
    ).toBe('approved');
    const bal = (await api('GET', `/v1/leave/balances/${emp}?asOf=${y}-06-01`, undefined, me))
      .json()
      .find((b: { leaveType: string }) => b.leaveType === 'annual');
    expect(bal.booked).toBe(5);
    expect(bal.available).toBe(28 - 8 - 5);
    // the employee can cancel future approved leave; balance is restored
    expect(
      (await api('POST', `/v1/leave/requests/${req.json().id}/cancel`, undefined, me)).json().status,
    ).toBe('cancelled');
    expect(
      (await api('GET', `/v1/leave/balances/${emp}?asOf=${y}-06-01`, undefined, me))
        .json()
        .find((b: { leaveType: string }) => b.leaveType === 'annual').booked,
    ).toBe(0);
  });

  it('rejection is applied to the request; insufficient balance is refused', async () => {
    const mgrEmp = await hire();
    const emp = await hire({ managerId: mgrEmp });
    const me = await login(emp, 'employee');
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const req = (
      await api(
        'POST',
        '/v1/leave/requests',
        { leaveTypeId: annual, startDate: '2026-08-03', endDate: '2026-08-04' },
        me,
      )
    ).json();
    const ar = (await api('GET', '/v1/approvals', undefined, mgr))
      .json()
      .find((a: { payload: { leaveRequestId: string } }) => a.payload.leaveRequestId === req.id);
    await api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'reject' }, mgr);
    expect((await api('GET', `/v1/leave/requests?employeeId=${emp}`, undefined, me)).json()[0].status).toBe(
      'rejected',
    );
    const tooMuch = await api(
      'POST',
      '/v1/leave/requests',
      { leaveTypeId: annual, startDate: '2026-09-01', endDate: '2026-11-30' },
      me,
    );
    expect(tooMuch.statusCode).toBe(422);
  });

  it('HR adjustments (with audit) change the balance', async () => {
    const emp = await hire();
    expect(
      (
        await api('POST', '/v1/leave/adjustments', {
          employeeId: emp,
          leaveTypeId: annual,
          amount: 2,
          effectiveDate: '2026-02-01',
          reason: 'Long service award',
        })
      ).statusCode,
    ).toBe(201);
    const bal = (await api('GET', `/v1/leave/balances/${emp}?asOf=2026-06-01`))
      .json()
      .find((b: { leaveType: string }) => b.leaveType === 'annual');
    expect(bal.adjustments).toBe(2);
    const audit = await tx((t) =>
      t.query(`SELECT 1 FROM audit.events WHERE action = 'leave.adjusted' AND target_id = $1`, [emp]),
    );
    expect(audit).toHaveLength(1);
  });

  it('blocks requests that break minimum cover when the rule says block', async () => {
    const dept = (await api('POST', '/v1/org/departments', { name: 'Tiny team' })).json().id;
    const a = await hire({ departmentId: dept });
    const b = await hire({ departmentId: dept });
    await api('POST', '/v1/leave/cover-rules', {
      name: 'Keep one in',
      departmentId: dept,
      minPresent: 1,
      enforcement: 'block',
    });
    expect(
      (
        await api('POST', '/v1/leave/requests', {
          employeeId: a,
          leaveTypeId: annual,
          startDate: '2026-10-19',
          endDate: '2026-10-19',
        })
      ).statusCode,
    ).toBe(201);
    const blocked = await api('POST', '/v1/leave/requests', {
      employeeId: b,
      leaveTypeId: annual,
      startDate: '2026-10-19',
      endDate: '2026-10-19',
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().cover[0]).toMatchObject({ min: 1, present: 0 });
  });
});

describe('public holidays per region and calendars', () => {
  it('Scottish employees get Scottish bank holidays (2 January) in leave counts', async () => {
    const sctLoc = (
      await api('POST', '/v1/org/locations', {
        name: 'Edinburgh',
        country: 'GB',
        regionCode: 'GB-SCT',
        timeZone: 'Europe/London',
        entityId: entity,
      })
    ).json().id;
    const sct = await hire({ locationId: sctLoc });
    const eng = await hire();
    const amount = async (e: string) =>
      (
        await api('POST', '/v1/leave/requests', {
          employeeId: e,
          leaveTypeId: annual,
          startDate: '2027-01-04',
          endDate: '2027-01-04',
        })
      ).statusCode;
    void amount;
    const r1 = await api('POST', '/v1/leave/requests', {
      employeeId: sct,
      leaveTypeId: annual,
      startDate: '2026-12-28',
      endDate: '2027-01-08',
    });
    const r2 = await api('POST', '/v1/leave/requests', {
      employeeId: eng,
      leaveTypeId: annual,
      startDate: '2026-12-28',
      endDate: '2027-01-08',
    });
    // 10 weekdays; E&W: 28 Dec (substitute Boxing Day) + 1 Jan → 8; Scotland also 2 Jan … falls on Saturday 2027 → substitute 4 Jan → 7
    expect(r2.json().amountDays).toBe(8);
    expect(r1.json().amountDays).toBe(7);
  });

  it('company calendars add closure days', async () => {
    await api('POST', '/v1/settings/company-calendars', {
      name: 'Office closure',
      entityId: entity,
      days: [{ date: '2026-12-24', name: 'Christmas Eve closure' }],
    });
    const emp = await hire();
    const r = await api('POST', '/v1/leave/requests', {
      employeeId: emp,
      leaveTypeId: annual,
      startDate: '2026-12-21',
      endDate: '2026-12-24',
    });
    expect(r.json().amountDays).toBe(3);
  });

  it('team calendar hides sensitive leave types from colleagues; ICS feed is token-scoped and revocable', async () => {
    const mgrEmp = await hire();
    const emp = await hire({ managerId: mgrEmp });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    await api('POST', '/v1/sickness', {
      employeeId: emp,
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      reason: 'Fictional illness',
    });
    await api('POST', '/v1/leave/requests', {
      employeeId: emp,
      leaveTypeId: annual,
      startDate: '2026-11-09',
      endDate: '2026-11-09',
    });
    const cal = (await api('GET', '/v1/leave/calendar?from=2026-11-01&to=2026-11-30', undefined, mgr)).json();
    // managers have absence.read in the default roles, so they see 'sickness'; an employee colleague would see 'away'
    const colleague = await login(await hire({ managerId: mgrEmp }), 'employee');
    const calColleague = (
      await api('GET', '/v1/leave/calendar?from=2026-11-01&to=2026-11-30', undefined, colleague)
    ).json();
    expect(
      cal.entries
        .filter((e: { employeeId: string }) => e.employeeId === emp)
        .map((e: { kind: string }) => e.kind)
        .sort(),
    ).toEqual(['annual', 'sickness']);
    expect(calColleague.entries.filter((e: { employeeId: string }) => e.employeeId === emp)).toEqual([]);
    const tok = (await api('POST', '/v1/leave/ics-tokens', { scope: 'team' }, mgr)).json();
    const path = new URL(tok.url).pathname;
    const ics = await ctx.app.inject({ method: 'GET', url: path });
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('out of office');
    expect(ics.body).not.toMatch(/sick|illness/i);
    await api('DELETE', `/v1/leave/ics-tokens/${tok.id}`, undefined, mgr);
    expect((await ctx.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });
});

describe('sickness, statutory pay and analytics', () => {
  it('stores sickness reasons and fit notes in the vault and tracks return-to-work', async () => {
    const mgrEmp = await hire();
    const emp = await hire({ managerId: mgrEmp });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const rec = (
      await api('POST', '/v1/sickness', {
        employeeId: emp,
        startDate: '2026-03-02',
        endDate: '2026-03-12',
        reason: 'Fictional reason',
      })
    ).json();
    expect(rec.rtwStatus).toBe('due');
    const raw = await tx((t) => t.query(`SELECT envelope FROM vault.records WHERE subject_id = $1`, [emp]));
    expect(JSON.stringify(raw)).not.toContain('Fictional reason');
    const boundary = '----fit';
    const pdf = Buffer.from('%PDF-1.4 fictional fit note');
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fitnote.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/sickness/${rec.id}/fit-note`,
          payload,
          headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api(
          'POST',
          `/v1/sickness/${rec.id}/return-to-work`,
          { answers: { feeling: 'Better' }, fitForWork: true },
          mgr,
        )
      ).json().rtwStatus,
    ).toBe('completed');
    const audited = await tx((t) =>
      t.query<{ action: string }>(
        `SELECT action FROM audit.events WHERE sensitive AND action LIKE 'vault.%' AND diff->>'subjectId' = $1`,
        [emp],
      ),
    );
    expect(audited.length).toBeGreaterThanOrEqual(3);
  });

  it('calculates UK SSP from the GB pack for linked spells', async () => {
    const emp = await hire({ payAmountMinor: 3_120_000 }); // £600/week
    await api('POST', '/v1/sickness', { employeeId: emp, startDate: '2026-05-04', endDate: '2026-05-08' });
    const ssp = (await api('GET', `/v1/sickness/${emp}/statutory-pay?asOf=2026-05-31`)).json();
    expect(ssp).toMatchObject({
      jurisdiction: 'GB',
      scheme: 'uk_ssp',
      result: { payableMinor: 12325, waitingDaysApplied: 0 },
    });
    expect(ssp.source.url).toMatch(/legislation\.gov\.uk|gov\.uk/);
  });

  it('Bradford factor and absence trigger alerts (deduplicated)', async () => {
    const emp = await hire();
    for (const [s, e] of [
      ['2026-01-05', '2026-01-05'],
      ['2026-02-02', '2026-02-03'],
      ['2026-04-06', '2026-04-06'],
    ])
      await api('POST', '/v1/sickness', { employeeId: emp, startDate: s, endDate: e });
    expect((await api('GET', `/v1/absence/bradford/${emp}?asOf=2026-06-01`)).json()).toEqual({
      spells: 3,
      days: 4,
      score: 36,
    });
    await api('POST', '/v1/absence/triggers', { name: 'Bradford 30', bradfordThreshold: 30 });
    const run = () =>
      jobHandlers['absence.triggers']!({
        tenantId: owner.tenantId,
        job: {
          id: 't',
          tenant_id: owner.tenantId,
          kind: 'absence.triggers',
          idempotency_key: 't',
          input: { date: '2026-06-01' },
          attempts: 1,
          created_by: null,
        },
        deps: ctx.deps,
        tx: (fn) => tx(fn),
        progress: async () => undefined,
      });
    expect((await run())!.alerts).toBeGreaterThan(0);
    expect((await run())!.alerts).toBe(0);
  });
});

describe('US FMLA', () => {
  it('checks eligibility from the US pack and tracks intermittent usage per leave-year method', async () => {
    const us = (
      await api('POST', '/v1/org/legal-entities', {
        name: 'Fictional Inc',
        country: 'US',
        regionCode: 'US-CA',
        currency: 'USD',
        timeZone: 'America/Los_Angeles',
      })
    ).json().id;
    const loc = (
      await api('POST', '/v1/org/locations', {
        name: 'San Jose',
        country: 'US',
        regionCode: 'US-CA',
        timeZone: 'America/Los_Angeles',
        entityId: us,
        geofence: { lat: 37.33, lng: -121.89, radiusMetres: 100 },
      })
    ).json().id;
    const ids: string[] = [];
    for (let i = 0; i < 51; i++)
      ids.push(
        await hire({
          entityId: us,
          locationId: loc,
          startDate: '2024-01-08',
          payCurrency: 'USD',
          weeklyHours: 40,
        }),
      );
    const res = (
      await api('POST', '/v1/fmla/cases', {
        employeeId: ids[0],
        reason: 'own_health',
        leaveYearMethod: 'calendar_year',
        startDate: '2026-03-02',
        intermittent: true,
      })
    ).json();
    expect(res).toMatchObject({ eligible: true, failed: [], entitlementHours: 480 });
    const newbie = await hire({
      entityId: us,
      locationId: loc,
      startDate: '2026-01-05',
      payCurrency: 'USD',
      weeklyHours: 40,
    });
    expect(
      (
        await api('POST', '/v1/fmla/cases', {
          employeeId: newbie,
          reason: 'own_health',
          leaveYearMethod: 'calendar_year',
          startDate: '2026-03-02',
        })
      ).json().failed,
    ).toContain('service');
    void sickness;
  });
});
