import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { leaveFixtures } from './leave-fixtures';
import { composeToken, newToken } from '../src/modules/auth/tokens';
import { jobHandlers } from '../src/worker';

/**
 * Absence (phases 3.3–3.5) through the API: sensitive-category masking, ICS feeds, trigger alerts,
 * sickness records and medical detail, statutory sick pay per region and US FMLA. Fictional data only;
 * outcomes never depend on today's date (fixed dates and explicit asOf).
 */
let ctx: TestContext;
let f: Awaited<ReturnType<typeof leaveFixtures>>;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  f = await leaveFixtures(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const runTriggers = (date: string) =>
  jobHandlers['absence.triggers']!({
    tenantId: f.owner.tenantId,
    job: {
      id: randomUUID(),
      tenant_id: f.owner.tenantId,
      kind: 'absence.triggers',
      idempotency_key: date,
      input: { date },
      attempts: 1,
      created_by: null,
    },
    deps: ctx.deps,
    tx: (fn) => f.tx(fn),
    progress: async () => undefined,
  });

describe('team calendar and requests list', () => {
  it('masks sensitive categories as "away" for colleagues who can see the calendar but not absence detail', async () => {
    const mgrEmp = await f.hire();
    const report = await f.hire({ managerId: mgrEmp });
    const outsider = await f.hire();
    await f.created('POST', '/v1/sickness', {
      employeeId: report,
      startDate: '2026-11-02',
      endDate: '2026-11-03',
    });
    await f.created('POST', '/v1/sickness', {
      employeeId: outsider,
      startDate: '2026-11-04',
      endDate: '2026-11-04',
    });
    await f.created('POST', '/v1/leave/requests', {
      employeeId: report,
      leaveTypeId: f.types.annual,
      startDate: '2026-11-09',
      endDate: '2026-11-09',
      note: 'Fictional trip',
    });
    await f.customRole('calendar_viewer', ['leave.read']);
    const viewer = await f.login(await f.hire(), 'calendar_viewer', { type: 'all' });
    const kinds = (entries: Array<{ employeeId: string; kind: string }>, who: string) =>
      entries
        .filter((e) => e.employeeId === who)
        .map((e) => e.kind)
        .sort();
    const cal = (
      await f.api('GET', '/v1/leave/calendar?from=2026-11-01&to=2026-11-30', undefined, viewer.cookie)
    ).json();
    expect(kinds(cal.entries, report)).toEqual(['annual', 'away']);
    expect(kinds(cal.entries, outsider)).toEqual(['away']);
    const list = (await f.api('GET', '/v1/leave/requests', undefined, viewer.cookie)).json() as Array<{
      employeeId: string;
      leaveType: string;
      note: string | null;
    }>;
    expect(
      list
        .filter((r) => r.employeeId === report)
        .map((r) => r.leaveType)
        .sort(),
    ).toEqual(['annual', 'away']);
    // A manager who can also see the whole calendar sees sickness only for their own team.
    const mgr = await f.login(mgrEmp, 'manager', { type: 'own_team' });
    await f.tx(async (t) => {
      const { assignRole } = await import('../src/modules/authz/principal');
      await assignRole(t, mgr.userId, 'calendar_viewer', { type: 'all' });
    });
    const mgrRes = await f.api(
      'GET',
      '/v1/leave/calendar?from=2026-11-01&to=2026-11-30',
      undefined,
      mgr.cookie,
    );
    expect(mgrRes.statusCode, mgrRes.body).toBe(200);
    const mgrCal = mgrRes.json();
    expect(kinds(mgrCal.entries, report)).toEqual(['annual', 'sickness']);
    expect(kinds(mgrCal.entries, outsider)).toEqual(['away']);
  });
});

describe('ICS feeds', () => {
  it('"me" feeds only my leave; another user’s token cannot be revoked; tokens are tenant-bound', async () => {
    const mgrEmp = await f.hire({ legalFirstName: 'Mona' });
    const report = await f.hire({ legalFirstName: 'Rafe', managerId: mgrEmp });
    const mgr = await f.login(mgrEmp, 'manager', { type: 'own_team' });
    const other = await f.login(report, 'employee');
    const mine = await f.created('POST', '/v1/leave/requests', {
      employeeId: mgrEmp,
      leaveTypeId: f.types.annual,
      startDate: '2026-12-14',
      endDate: '2026-12-14',
    });
    const theirs = await f.created('POST', '/v1/leave/requests', {
      employeeId: report,
      leaveTypeId: f.types.annual,
      startDate: '2026-12-15',
      endDate: '2026-12-15',
    });
    await f.tx((t) =>
      t.exec(`UPDATE app.leave_requests SET status = 'approved' WHERE id = ANY($1::uuid[])`, [
        [mine.id, theirs.id],
      ]),
    );
    const me = await f.created('POST', '/v1/leave/ics-tokens', { scope: 'me' }, mgr.cookie);
    const team = await f.created('POST', '/v1/leave/ics-tokens', { scope: 'team' }, mgr.cookie);
    const feed = async (url: string) =>
      (await ctx.app.inject({ method: 'GET', url: new URL(url).pathname })).body;
    expect(await feed(me.url)).toContain(`UID:${mine.id}@thapsus-hr`);
    expect(await feed(me.url)).not.toContain(theirs.id);
    expect(await feed(team.url)).toContain(`UID:${theirs.id}@thapsus-hr`);
    // another user cannot revoke the manager's token (404, nothing changes, no false audit row)
    expect((await f.api('DELETE', `/v1/leave/ics-tokens/${me.id}`, undefined, other.cookie)).statusCode).toBe(
      404,
    );
    expect(await feed(me.url)).toContain('BEGIN:VEVENT');
    expect(await f.auditRows('ics.token_revoked', me.id)).toHaveLength(0);
    // a token secret presented with another tenant's id, or an unknown tenant, is not found
    const secret = new URL(me.url).pathname.split('.')[1]!;
    const otherTenant = await ownerSession(ctx);
    for (const tenantId of [otherTenant.tenantId, randomUUID()]) {
      expect(
        (
          await ctx.app.inject({
            method: 'GET',
            url: `/v1/ics/${composeToken('ics_', tenantId, secret)}.ics`,
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/ics/${composeToken('ics_', f.owner.tenantId, newToken())}.ics`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.api('DELETE', `/v1/leave/ics-tokens/${me.id}`, undefined, mgr.cookie)).statusCode).toBe(
      204,
    );
    expect((await ctx.app.inject({ method: 'GET', url: new URL(me.url).pathname })).statusCode).toBe(404);
  });
});

describe('absence trigger alerts', () => {
  it('spells thresholds honour the window; notify_manager controls whether the manager is told', async () => {
    const mgrEmp = await f.hire();
    const emp = await f.hire({ managerId: mgrEmp });
    const mgr = await f.login(mgrEmp, 'manager', { type: 'own_team' });
    for (const [s, e] of [
      ['2026-03-02', '2026-03-02'],
      ['2026-05-04', '2026-05-04'],
      ['2026-05-18', '2026-05-19'],
    ])
      await f.created('POST', '/v1/sickness', { employeeId: emp, startDate: s, endDate: e });
    await f.created('POST', '/v1/absence/triggers', {
      name: 'Fictional two in 30 days',
      spellsThreshold: 2,
      windowDays: 30,
      notifyManager: true,
    });
    await f.created('POST', '/v1/absence/triggers', {
      name: 'Fictional three in 30 days',
      spellsThreshold: 3,
      windowDays: 30,
    });
    await f.created('POST', '/v1/absence/triggers', {
      name: 'Fictional three in a year',
      spellsThreshold: 3,
      windowDays: 365,
      notifyManager: false,
    });
    expect((await f.api('POST', '/v1/absence/triggers', { name: 'No threshold' })).statusCode).toBe(422);
    await runTriggers('2026-05-29');
    const alerts = await f.tx((t) =>
      t.query<{ user_id: string; params: { trigger: string } }>(
        `SELECT user_id, params FROM app.notifications WHERE kind = 'absence.trigger' AND link = $1 AND target_type = 'employee' AND target_id = $2`,
        [`/app/people/${emp}?tab=time-off`, emp],
      ),
    );
    const byTrigger = (name: string) =>
      alerts
        .filter((a) => a.params.trigger === name)
        .map((a) => a.user_id)
        .sort();
    expect(byTrigger('Fictional two in 30 days')).toEqual([f.owner.userId, mgr.userId].sort()); // no HR admin → owner, plus the manager
    expect(byTrigger('Fictional three in 30 days')).toEqual([]); // the March spell is outside the 30-day window
    expect(byTrigger('Fictional three in a year')).toEqual([f.owner.userId]); // manager not notified
  });
});

describe('sickness records and medical detail', () => {
  it('fit notes are required after the company threshold', async () => {
    expect(
      (await f.api('PUT', '/v1/settings/absence', { fitNoteAfterCalendarDays: 7 })).json(),
    ).toMatchObject({ fitNoteAfterCalendarDays: 7 });
    const emp = await f.hire();
    expect(
      (
        await f.created('POST', '/v1/sickness', {
          employeeId: emp,
          startDate: '2026-02-02',
          endDate: '2026-02-08',
        })
      ).fitNoteRequired,
    ).toBe(false); // 7 days
    expect(
      (
        await f.created('POST', '/v1/sickness', {
          employeeId: emp,
          startDate: '2026-03-02',
          endDate: '2026-03-09',
        })
      ).fitNoteRequired,
    ).toBe(true); // 8 days
    expect(
      (await f.created('POST', '/v1/sickness', { employeeId: emp, startDate: '2026-04-06' })).fitNoteRequired,
    ).toBe(false); // open-ended
    const list = (await f.api('GET', `/v1/sickness?employeeId=${emp}`)).json() as Array<{
      startDate: string;
      fitNoteRequired: boolean;
      rtwStatus: string;
    }>;
    expect(list.map((r) => [r.startDate, r.fitNoteRequired, r.rtwStatus])).toEqual([
      ['2026-04-06', false, 'not_required'],
      ['2026-03-02', true, 'due'],
      ['2026-02-02', false, 'due'],
    ]);
    expect(
      (await f.api('PUT', '/v1/settings/absence', { fitNoteAfterCalendarDays: null })).json()
        .fitNoteAfterCalendarDays,
    ).toBeUndefined();
  });

  it('HR and the employee read medical detail from the vault; a manager cannot (and the refusal is audited)', async () => {
    const mgrEmp = await f.hire();
    const emp = await f.hire({ managerId: mgrEmp });
    const mgr = await f.login(mgrEmp, 'manager', { type: 'own_team' });
    const self = await f.login(emp, 'employee');
    const rec = await f.created('POST', '/v1/sickness', {
      employeeId: emp,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      reason: 'Fictional migraine',
    });
    expect(
      (
        await f.api(
          'POST',
          `/v1/sickness/${rec.id}/return-to-work`,
          { answers: { feeling: 'Fictional: better' }, fitForWork: true },
          mgr.cookie,
        )
      ).json().rtwStatus,
    ).toBe('completed');
    const denied = await f.api('GET', `/v1/sickness/${rec.id}/medical`, undefined, mgr.cookie);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('migraine');
    const refusals = await f.tx((t) =>
      t.query(
        `SELECT 1 FROM audit.events WHERE action = 'vault.read_denied' AND sensitive AND actor_id = $1 AND diff->>'record' = $2`,
        [mgr.userId, rec.id],
      ),
    );
    expect(refusals).toHaveLength(1);
    // the manager can still see dates and status, without medical detail
    expect(
      (await f.api('GET', `/v1/sickness?employeeId=${emp}`, undefined, mgr.cookie)).json()[0],
    ).toMatchObject({ id: rec.id, rtwStatus: 'completed' });
    const hr = (await f.api('GET', `/v1/sickness/${rec.id}/medical`)).json();
    expect(hr).toMatchObject({ reason: 'Fictional migraine', returnToWork: { fitForWork: true } });
    expect((await f.api('GET', `/v1/sickness/${rec.id}/medical`, undefined, self.cookie)).json().reason).toBe(
      'Fictional migraine',
    );
    const reads = await f.tx((t) =>
      t.query(
        `SELECT 1 FROM audit.events WHERE action = 'vault.read' AND sensitive AND diff->>'subjectId' = $1`,
        [emp],
      ),
    );
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });
});

describe('statutory sick pay per region (route)', () => {
  it('UK SSP before 6 April 2026 uses the 2025-26 rule: waiting days, flat rate, no NaN', async () => {
    const emp = await f.hire({ payAmountMinor: 3_120_000 }); // £600/week
    await f.created('POST', '/v1/sickness', {
      employeeId: emp,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
    });
    const ssp = (await f.api('GET', `/v1/sickness/${emp}/statutory-pay?asOf=2026-03-31`)).json();
    expect(ssp).toMatchObject({
      jurisdiction: 'GB',
      scheme: 'uk_ssp',
      result: { payableMinor: 4750, daysPaid: 2, waitingDaysApplied: 3, weeklyRateMinor: 11875 },
    });
    expect(ssp.source.url).toBe(
      'https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026',
    );
    // after the change the same spell keeps its 2025-26 days; a new spell is paid from day 1 at the 2026 rate
    await f.created('POST', '/v1/sickness', {
      employeeId: emp,
      startDate: '2026-06-01',
      endDate: '2026-06-05',
    });
    const later = (await f.api('GET', `/v1/sickness/${emp}/statutory-pay?asOf=2026-06-30`)).json();
    expect(later.result).toMatchObject({ payableMinor: 4750 + 12325, waitingDaysApplied: 3 });
  });

  it('EU: Germany continued pay and the French employer complement from the member-state packs', async () => {
    const de = await f.entity({
      name: 'Fictional GmbH',
      country: 'DE',
      regionCode: 'DE-BE',
      currency: 'EUR',
      timeZone: 'Europe/Berlin',
    });
    const deEmp = await f.hire({ entityId: de, payAmountMinor: 5_200_000, payCurrency: 'EUR' }); // €1,000/week
    await f.created('POST', '/v1/sickness', {
      employeeId: deEmp,
      startDate: '2026-03-02',
      endDate: '2026-03-13',
    });
    expect((await f.api('GET', `/v1/sickness/${deEmp}/statutory-pay?asOf=2026-03-31`)).json()).toMatchObject({
      jurisdiction: 'DE',
      scheme: 'employer_continued_pay',
      result: {
        scheme: 'continued_pay',
        percent: 100,
        paidCalendarDays: 12,
        paidDays: 10,
        totalMinor: 200_000,
      },
    });
    const fr = await f.entity({
      name: 'Fictional SAS',
      country: 'FR',
      regionCode: 'FR-IDF',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    });
    const frEmp = await f.hire({
      entityId: fr,
      startDate: '2023-01-02',
      payAmountMinor: 5_200_000,
      payCurrency: 'EUR',
    });
    await f.created('POST', '/v1/sickness', {
      employeeId: frEmp,
      startDate: '2026-03-02',
      endDate: '2026-03-31',
    });
    const frPay = (await f.api('GET', `/v1/sickness/${frEmp}/statutory-pay?asOf=2026-03-31`)).json();
    expect(frPay).toMatchObject({
      jurisdiction: 'FR',
      result: { scheme: 'employer_complement', eligible: true, paidDays: 23, percent: 90 },
    });
    expect(frPay.source.url).toMatch(/service-public\.gouv\.fr/);
  });

  it('US: state paid sick leave from recorded hours (CA); no statewide law (TX); federal only without a state', async () => {
    const ca = await f.entity({
      name: 'Fictional West Inc',
      country: 'US',
      regionCode: 'US-CA',
      currency: 'USD',
      timeZone: 'America/Los_Angeles',
    });
    const tx = await f.entity({
      name: 'Fictional South Inc',
      country: 'US',
      regionCode: 'US-TX',
      currency: 'USD',
      timeZone: 'America/Chicago',
    });
    const caEmp = await f.hire({
      entityId: ca,
      startDate: '2026-01-05',
      weeklyHours: 40,
      payCurrency: 'USD',
    });
    await f.created('POST', '/v1/leave/worked-hours', {
      employeeId: caEmp,
      startDate: '2026-01-05',
      endDate: '2026-06-26',
      hours: 600,
    });
    const r = (await f.api('GET', `/v1/sickness/${caEmp}/statutory-pay?asOf=2026-06-30`)).json();
    expect(r).toMatchObject({
      jurisdiction: 'US-CA',
      scheme: 'us_paid_sick_leave',
      result: {
        required: true,
        accruedHours: 20,
        hoursWorked: 600,
        hoursSource: 'recorded',
        capHours: 80,
        usableFrom: '2026-04-05',
        canUse: true,
        eligible: true,
      },
    });
    expect(r.source.url).toMatch(/dir\.ca\.gov/);
    const txEmp = await f.hire({ entityId: tx, weeklyHours: 40, payCurrency: 'USD' });
    expect((await f.api('GET', `/v1/sickness/${txEmp}/statutory-pay?asOf=2026-06-30`)).json()).toMatchObject({
      jurisdiction: 'US-TX',
      scheme: 'no_statutory_requirement',
      result: { required: false },
    });
    const us = await f.entity({
      name: 'Fictional Nowhere Inc',
      country: 'US',
      currency: 'USD',
      timeZone: 'America/New_York',
    });
    const usEmp = await f.hire({ entityId: us, weeklyHours: 40, payCurrency: 'USD' });
    expect((await f.api('GET', `/v1/sickness/${usEmp}/statutory-pay?asOf=2026-06-30`)).json()).toMatchObject({
      jurisdiction: 'US',
      scheme: 'no_statutory_requirement',
    });
  });
});

describe('US FMLA', () => {
  let us: string;
  let near: string;
  let far: string;
  const ids: { a: string[]; b: string[]; c: string[] } = { a: [], b: [], c: [] };

  beforeAll(async () => {
    us = await f.entity({
      name: 'Fictional FMLA Inc',
      country: 'US',
      regionCode: 'US-CA',
      currency: 'USD',
      timeZone: 'America/Los_Angeles',
    });
    // A at 37.33 N; B 0.9° (≈62 mi) north of A; C 2° (≈138 mi) north of A and 1.1° (≈76 mi) from B
    const a = await f.location({
      name: 'Fictional A',
      country: 'US',
      regionCode: 'US-CA',
      timeZone: 'America/Los_Angeles',
      entityId: us,
      geofence: { lat: 37.33, lng: -121.89, radiusMetres: 100 },
    });
    near = await f.location({
      name: 'Fictional B',
      country: 'US',
      regionCode: 'US-CA',
      timeZone: 'America/Los_Angeles',
      entityId: us,
      geofence: { lat: 38.23, lng: -121.89, radiusMetres: 100 },
    });
    far = await f.location({
      name: 'Fictional C',
      country: 'US',
      regionCode: 'US-CA',
      timeZone: 'America/Los_Angeles',
      entityId: us,
      geofence: { lat: 39.33, lng: -121.89, radiusMetres: 100 },
    });
    const add = async (list: string[], locationId: string, n: number) => {
      for (let i = 0; i < n; i++)
        list.push(
          await f.hire({
            entityId: us,
            locationId,
            startDate: '2024-01-08',
            payCurrency: 'USD',
            weeklyHours: 40,
          }),
        );
    };
    await add(ids.a, a, 30);
    await add(ids.b, near, 25);
    await add(ids.c, far, 30);
  });

  it('the leave-year method comes from the pack and must be uniform', async () => {
    const bad = await f.api('POST', '/v1/fmla/cases', {
      employeeId: ids.a[0],
      reason: 'own_health',
      leaveYearMethod: 'rolling_backward',
      startDate: '2026-03-02',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().allowed).toEqual([
      'calendar_year',
      'fixed_12_month_period',
      'forward_from_first_leave_date',
      'rolling_backward_from_leave_date',
    ]);
    expect(
      (
        await f.api('POST', '/v1/fmla/cases', {
          employeeId: ids.a[0],
          reason: 'own_health',
          startDate: '2026-03-02',
        })
      ).statusCode,
    ).toBe(422); // no method chosen yet
    expect(
      (await f.api('PUT', '/v1/settings/absence', { fmla: { leaveYearMethod: 'rolling_backward' } }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await f.api('PUT', '/v1/settings/absence', {
          fmla: { leaveYearMethod: 'rolling_backward_from_leave_date' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.api('POST', '/v1/fmla/cases', {
          employeeId: ids.a[0],
          reason: 'own_health',
          leaveYearMethod: 'calendar_year',
          startDate: '2026-03-02',
        })
      ).statusCode,
    ).toBe(422);
  });

  it('counts employees within 75 miles of the worksite (inside vs outside the radius)', async () => {
    const atA = (await f.created('POST', '/v1/fmla/cases', {
      employeeId: ids.a[1],
      reason: 'own_health',
      startDate: '2026-03-02',
    })) as Record<string, unknown>;
    expect(atA).toMatchObject({
      eligible: true,
      failed: [],
      employeesWithinRadius: 55,
      employerCovered: true,
      leaveYearMethod: 'rolling_backward_from_leave_date',
      hoursSource: 'estimated',
    });
    const atC = (await f.created('POST', '/v1/fmla/cases', {
      employeeId: ids.c[0],
      reason: 'own_health',
      startDate: '2026-03-02',
    })) as Record<string, unknown>;
    expect(atC).toMatchObject({ eligible: false, failed: ['worksite'], employeesWithinRadius: 30 });
    void near;
    void far;
  });

  it('uses actual recorded hours when available; HR can provide a figure', async () => {
    await f.created('POST', '/v1/leave/worked-hours', {
      employeeId: ids.a[2],
      startDate: '2025-03-02',
      endDate: '2026-03-01',
      hours: 1200,
    });
    expect(
      await f.created('POST', '/v1/fmla/cases', {
        employeeId: ids.a[2],
        reason: 'family_care',
        startDate: '2026-03-02',
      }),
    ).toMatchObject({
      eligible: false,
      failed: ['hours'],
      hoursPrior12Months: 1200,
      hoursSource: 'recorded',
    });
    expect(
      await f.created('POST', '/v1/fmla/cases', {
        employeeId: ids.a[3],
        reason: 'family_care',
        startDate: '2026-03-02',
        hoursPrior12Months: 1300,
      }),
    ).toMatchObject({ eligible: true, hoursPrior12Months: 1300, hoursSource: 'provided' });
  });

  it('tracks intermittent usage (hours) in the rolling 12-month period; GET /v1/fmla/cases/:id', async () => {
    const mgrEmp = await f.hire({ entityId: us, payCurrency: 'USD', weeklyHours: 40 });
    const emp = ids.a[4]!;
    await f.created('POST', `/v1/employees/${emp}/changes`, {
      effectiveDate: '2025-01-06',
      managerId: mgrEmp,
    });
    const mgr = await f.login(mgrEmp, 'manager', { type: 'own_team' });
    const c = await f.created('POST', '/v1/fmla/cases', {
      employeeId: emp,
      reason: 'own_health',
      startDate: '2026-03-02',
      intermittent: true,
    });
    expect(c).toMatchObject({ eligible: true, entitlementHours: 480 });
    const fmlaType = (
      (await f.api('GET', '/v1/leave/types')).json() as Array<{ key: string; id: string }>
    ).find((t) => t.key === 'fmla')!.id;
    const take = async (payload: Record<string, unknown>) => {
      const r = await f.api('POST', '/v1/leave/requests', {
        employeeId: emp,
        leaveTypeId: fmlaType,
        fmlaCaseId: c.id,
        ...payload,
      });
      expect(r.statusCode, r.body).toBe(201);
      await f.approve(r.json().id, mgr.cookie);
      return r.json();
    };
    expect(await take({ startDate: '2026-03-02', endDate: '2026-03-06' })).toMatchObject({ amountHours: 40 });
    expect(await take({ startDate: '2026-04-07', endDate: '2026-04-07', hours: 2 })).toMatchObject({
      amountHours: 2,
    });
    await take({ startDate: '2026-05-05', endDate: '2026-05-05', startHalf: 'pm' });
    const status = (await f.api('GET', `/v1/fmla/cases/${c.id}?asOf=2026-06-01`)).json();
    expect(status).toMatchObject({
      intermittent: true,
      leaveYearMethod: 'rolling_backward_from_leave_date',
      entitlementHours: 480,
      usedHours: 46,
      remainingHours: 434,
      requests: 3,
      leaveYear: ['2025-06-02', '2026-06-02'],
    });
    // leave rolls off the backward-looking window after 12 months
    expect((await f.api('GET', `/v1/fmla/cases/${c.id}?asOf=2027-03-10`)).json()).toMatchObject({
      usedHours: 6,
      leaveYear: ['2026-03-11', '2027-03-11'],
    });
    // a non-intermittent case refuses part-day leave; another employee's case cannot be used
    const block = await f.created('POST', '/v1/fmla/cases', {
      employeeId: ids.a[5],
      reason: 'own_health',
      startDate: '2026-03-02',
    });
    expect(
      (
        await f.api('POST', '/v1/leave/requests', {
          employeeId: ids.a[5],
          leaveTypeId: fmlaType,
          fmlaCaseId: block.id,
          startDate: '2026-04-07',
          endDate: '2026-04-07',
          hours: 2,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await f.api('POST', '/v1/leave/requests', {
          employeeId: ids.a[6],
          leaveTypeId: fmlaType,
          fmlaCaseId: block.id,
          startDate: '2026-04-07',
          endDate: '2026-04-07',
        })
      ).statusCode,
    ).toBe(422);
    // usage beyond the entitlement is refused
    expect(
      (
        await f.api('POST', '/v1/leave/requests', {
          employeeId: emp,
          leaveTypeId: fmlaType,
          fmlaCaseId: c.id,
          startDate: '2026-06-01',
          endDate: '2026-09-30',
        })
      ).statusCode,
    ).toBe(422);
    // only absence readers see the case
    expect(
      (await f.api('GET', `/v1/fmla/cases/${c.id}`, undefined, (await f.login(ids.a[7]!, 'employee')).cookie))
        .statusCode,
    ).toBe(403);
  });

  it('employer coverage comes from headcount history: 50 employees in 20+ workweeks, not today’s headcount', async () => {
    const g = await leaveFixtures(ctx); // a separate fictional tenant
    const ent = await g.entity({
      name: 'Fictional Growing Inc',
      country: 'US',
      regionCode: 'US-WA',
      currency: 'USD',
      timeZone: 'America/Los_Angeles',
    });
    const loc = await g.location({
      name: 'Fictional HQ',
      country: 'US',
      regionCode: 'US-WA',
      timeZone: 'America/Los_Angeles',
      entityId: ent,
    });
    const staff: string[] = [];
    for (let i = 0; i < 52; i++)
      staff.push(
        await g.hire({
          entityId: ent,
          locationId: loc,
          startDate: '2026-08-03',
          payCurrency: 'USD',
          weeklyHours: 40,
        }),
      );
    await g.created('PUT', '/v1/settings/absence', { fmla: { leaveYearMethod: 'calendar_year' } });
    const early = await g.created('POST', '/v1/fmla/cases', {
      employeeId: staff[0],
      reason: 'own_health',
      startDate: '2026-09-14',
      hoursPrior12Months: 2000,
    });
    expect(early).toMatchObject({ employerCovered: false });
    expect(early.failed).toContain('employer');
    const later = await g.created('POST', '/v1/fmla/cases', {
      employeeId: staff[1],
      reason: 'own_health',
      startDate: '2026-12-28',
      hoursPrior12Months: 2000,
    });
    expect(later.employerCovered).toBe(true); // 22 qualifying workweeks (weeks starting 3 Aug – 28 Dec 2026)
    expect(later.failed).not.toContain('employer');
  });
});
