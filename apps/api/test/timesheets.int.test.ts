import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, zonedToInstant } from '@thapsus/core/time';
import { closeDb, enrolTotp, startTestApp, type TestContext } from './helpers';
import { NOW, timeCompany, type TimeCompany } from './time-fixtures';

/**
 * Timesheets (PROGRESS 4.4) and working-time rules (4.3): recorded time vs rota with variances,
 * overtime from the US/California packs, the GB 48-hour average with opt-out records, daily time
 * recording where a pack requires it (ES/DE), approval, and the audited, reproducible payroll CSV.
 */
let ctx: TestContext;
let c: TimeCompany;
const WEEK = '2026-06-01'; // Monday; "now" is Wednesday 10 June
let seq = 0;
const eid = () => `ts-${Date.now().toString(36)}-${++seq}`;
const local = (date: string, time: string, zone: string) => zonedToInstant(date, time, zone);

async function clock(cookie: string, zone: string, days: Array<[string, string, string]>) {
  const events = days.flatMap(([d, from, to]) => [
    { clientEventId: eid(), kind: 'in', occurredAt: local(d, from, zone) },
    { clientEventId: eid(), kind: 'out', occurredAt: local(to < from ? addDays(d, 1) : d, to, zone) },
  ]);
  const r = await c.api('POST', '/v1/clock/events', { events }, cookie);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().results.every((x: { status: string }) => x.status === 'created'), r.body).toBe(true);
}
async function historyGb(employeeId: string, from: string, weeks: number) {
  // recorded time imported for earlier weeks: 6 × (07:00–17:00 with a 30-minute break) = 57 h a week
  await c.tx(async (t) => {
    for (let w = 0; w < weeks; w++)
      for (let d = 0; d < 6; d++) {
        const day = addDays(from, w * 7 + d);
        for (const [kind, time] of [['in', '07:00'], ['break_start', '12:00'], ['break_end', '12:30'], ['out', '17:00']] as const)
          await t.exec(`INSERT INTO app.clock_events (tenant_id, employee_id, kind, occurred_at, zone, source, client_event_id) VALUES (app.current_tenant(), $1, $2, $3, 'Europe/London', 'import', $4)`, [employeeId, kind, local(day, time, 'Europe/London'), `import:${day}:${kind}`]);
      }
  });
}
const sheet = async (employeeId: string, cookie?: string) => {
  const r = await c.api('GET', `/v1/timesheets/employees/${employeeId}/weeks/${WEEK}`, undefined, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  ctx.clock.now = new Date(NOW);
  c = await timeCompany(ctx);
  // allow syncing last week's punches from the offline queue in these tests
  await c.api('PUT', '/v1/settings/time', { clock: { maxOfflineHours: 24 * 14 } });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

let caEmp: string;
let caCookie: string;
let mgrCookie: string;

describe('US-CA timesheet: overtime from the packs and variances against the rota', () => {
  it('a 13-hour Monday plus four 8-hour days: 40 h regular, 4 h overtime, 1 h double time; Monday variance flagged', async () => {
    const mgrEmp = await c.hire(c.sanJose, { legalFirstName: 'Mara' });
    caEmp = await c.hire(c.sanJose, { managerId: mgrEmp });
    caCookie = await c.login(caEmp);
    mgrCookie = await c.login(mgrEmp, 'manager');
    for (let d = 0; d < 5; d++) expect((await c.api('POST', '/v1/shifts', { employeeId: caEmp, date: addDays(WEEK, d), start: '09:00', end: '17:00', breakMinutes: 0 })).statusCode).toBe(201);
    await c.api('POST', '/v1/rota/publish', { from: WEEK, to: addDays(WEEK, 6), locationId: c.sanJose });
    await clock(caCookie, 'America/Los_Angeles', [[WEEK, '06:00', '19:00'], ...[1, 2, 3, 4].map((d) => [addDays(WEEK, d), '09:00', '17:00'] as [string, string, string])]);
    const ts = await sheet(caEmp, caCookie);
    expect(ts).toMatchObject({ status: 'open', workedMinutes: 2700, scheduledMinutes: 2400, regularMinutes: 2400, overtimeMinutes: 240, doubleMinutes: 60, timeRecordingRequired: false, openClock: false });
    expect(ts.days[0]).toEqual({ date: WEEK, workedMinutes: 780, scheduledMinutes: 480, varianceMinutes: 300, flagged: true });
    expect(ts.days[1]).toMatchObject({ varianceMinutes: 0, flagged: false });
    expect(ts.sources).toEqual(expect.arrayContaining(['https://www.dol.gov/agencies/whd/overtime', 'https://www.dir.ca.gov/dlse/faq_overtime.htm']));
  });

  it('employee submits; the manager approves through the approval inbox; the snapshot is frozen', async () => {
    const sub = await c.api('POST', `/v1/timesheets/employees/${caEmp}/weeks/${WEEK}/submit`, undefined, caCookie);
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json()).toMatchObject({ status: 'submitted', overtimeMinutes: 240 });
    expect((await c.api('POST', `/v1/timesheets/employees/${caEmp}/weeks/${WEEK}/submit`, undefined, caCookie)).statusCode).toBe(409);
    const list = (await c.api('GET', `/v1/timesheets?weekStart=${WEEK}`, undefined, mgrCookie)).json().data;
    expect(list.map((r: { employeeId: string }) => r.employeeId)).toEqual([caEmp]); // only the manager's team
    const ar = (await c.api('GET', '/v1/approvals', undefined, mgrCookie)).json().find((a: { payload: { timesheetId: string } }) => a.payload.timesheetId === sub.json().id);
    expect((await c.api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'approve' }, mgrCookie)).json().status).toBe('approved');
    expect((await sheet(caEmp, caCookie)).status).toBe('approved');
    // corrections can no longer change an approved week
    const fix = await c.api('POST', '/v1/clock/corrections', { employeeId: caEmp, kind: 'out', occurredAt: local(addDays(WEEK, 2), '18:00', 'America/Los_Angeles'), reason: 'Late finish' }, mgrCookie);
    expect(fix.statusCode).toBe(409);
    const notes = await c.tx((t) => t.query(`SELECT 1 FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE u.employee_id = $1 AND n.kind = 'time.timesheet_approved'`, [caEmp]));
    expect(notes).toHaveLength(1);
  });

  it('payroll export feed: CSV of approved timesheets, reproducible, audited, exported_at set; permission enforced', async () => {
    const r1 = await c.api('GET', `/v1/timesheets/export?weekStart=${WEEK}`);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.headers['content-type']).toContain('text/csv');
    const lines = r1.body.split('\r\n');
    expect(lines[0]).toBe('employee_number,employee_name,week_start,worked_hours,scheduled_hours,regular_hours,overtime_hours,double_time_hours,violations,approved_at');
    const number = (await c.tx((t) => t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [caEmp]))).employee_number;
    expect(lines.find((l) => l.startsWith(`${number},`))).toMatch(new RegExp(`^${number},Shift\\d+ Worker,2026-06-01,45\\.00,40\\.00,40\\.00,4\\.00,1\\.00,0,\\d{4}-`));
    const r2 = await c.api('GET', `/v1/timesheets/export?weekStart=${addDays(WEEK, 3)}`); // any day in the week
    expect(r2.body).toBe(r1.body);
    expect(r2.headers['x-content-sha256']).toBe(r1.headers['x-content-sha256']);
    const audits = await c.tx((t) => t.query<{ diff: { checksum: string; rows: number } }>(`SELECT diff FROM audit.events WHERE action = 'timesheets.exported' ORDER BY id`));
    expect(audits).toHaveLength(2);
    expect(audits[0]!.diff).toMatchObject({ rows: 1, checksum: r1.headers['x-content-sha256'] });
    expect((await c.tx((t) => t.one<{ exported_at: string | null }>('SELECT exported_at FROM app.timesheets WHERE employee_id = $1', [caEmp]))).exported_at).not.toBeNull();
    expect((await c.api('GET', `/v1/timesheets/export?weekStart=${WEEK}`, undefined, caCookie)).statusCode).toBe(403);
    expect((await c.api('GET', `/v1/timesheets/export?weekStart=${WEEK}`, undefined, mgrCookie)).statusCode).toBe(403);
    // the payroll admin role may export
    const payroll = await c.login(await c.hire(c.sanJose), 'payroll_admin', { type: 'all' });
    await enrolTotp(ctx, payroll);
    expect((await c.api('GET', `/v1/timesheets/export?weekStart=${WEEK}`, undefined, payroll)).body).toBe(r1.body);
    // once sent to payroll the week cannot be reopened
    const id = (await sheet(caEmp)).id;
    expect((await c.api('POST', `/v1/timesheets/${id}/reopen`, { reason: 'Mistake found' })).statusCode).toBe(409);
  });
});

describe('GB: 48-hour average with opt-out, rejection and resubmission', () => {
  it('flags an average over 48 hours across 17 weeks (WTR reg. 4) unless the worker opted out', async () => {
    const mgrEmp = await c.hire(c.leeds);
    const emp = await c.hire(c.leeds, { managerId: mgrEmp });
    const me = await c.login(emp);
    const mgr = await c.login(mgrEmp, 'manager');
    await historyGb(emp, addDays(WEEK, -16 * 7), 17);
    const before = await sheet(emp, me);
    expect(before.workedMinutes).toBe(6 * 570);
    expect(before.violations.find((v: { rule: string }) => v.rule === 'working_time.max_weekly_hours')).toMatchObject({ detail: { averageHours: 57, maxHours: 48, referenceWeeks: 17 }, source: 'https://www.legislation.gov.uk/uksi/1998/1833/regulation/4' });
    expect(before).toMatchObject({ timeRecordingRequired: false, timeRecordingJurisdiction: null, optedOut: false });
    const opt = await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2026-01-01' });
    expect(opt.statusCode, opt.body).toBe(201);
    const after = await sheet(emp, me);
    expect(after.optedOut).toBe(true);
    expect(after.violations.map((v: { rule: string }) => v.rule)).not.toContain('working_time.max_weekly_hours');

    // submit → manager rejects → employee resubmits
    const sub = (await c.api('POST', `/v1/timesheets/employees/${emp}/weeks/${WEEK}/submit`, undefined, me)).json();
    const ar = (await c.api('GET', '/v1/approvals', undefined, mgr)).json().find((a: { payload: { timesheetId: string } }) => a.payload.timesheetId === sub.id);
    await c.api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'reject', comment: 'Check Thursday' }, mgr);
    expect((await sheet(emp, me)).status).toBe('rejected');
    expect((await c.api('POST', `/v1/timesheets/employees/${emp}/weeks/${WEEK}/submit`, undefined, me)).json().status).toBe('submitted');
    // the manager can reopen a submitted (not yet exported) week
    expect((await c.api('POST', `/v1/timesheets/${sub.id}/reopen`, { reason: 'Fix Thursday' }, mgr)).json().status).toBe('open');
  });

  it('opt-out records: notice ends them; not available outside GB; notice capped by the pack', async () => {
    const emp = await c.hire(c.leeds);
    const me = await c.login(emp);
    const created = (await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2026-02-01', noticeDays: 30 })).json();
    expect((await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2026-03-01' })).statusCode).toBe(409); // overlapping record
    const ended = await c.api('POST', `/v1/working-time/opt-outs/${created.id}/end`, { noticeGivenOn: '2026-06-01' }, me);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ validTo: '2026-07-01', noticeGivenOn: '2026-06-01' });
    expect((await c.api('GET', `/v1/working-time/opt-outs?employeeId=${emp}`, undefined, me)).json()).toHaveLength(1);
    expect((await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2026-08-01', noticeDays: 120 })).statusCode).toBe(422); // > 3 months (reg. 5(3))
    const de = await c.hire(c.berlin);
    expect((await c.api('POST', '/v1/working-time/opt-outs', { employeeId: de, validFrom: '2026-02-01' })).statusCode).toBe(422);
    expect((await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2026-08-01' }, me)).statusCode).toBe(403); // HR records the signed agreement
  });
});

describe('daily time recording where the pack requires it', () => {
  it('Spain (ET art. 34.9) and Germany (BAG 1 ABR 22/21): scheduled days without recorded time are flagged', async () => {
    const es = await c.hire(c.madrid);
    const esMe = await c.login(es);
    await c.api('POST', '/v1/shifts', { employeeId: es, date: WEEK, start: '09:00', end: '17:00', breakMinutes: 30 });
    await c.api('POST', '/v1/shifts', { employeeId: es, date: addDays(WEEK, 1), start: '09:00', end: '17:00', breakMinutes: 30 });
    await c.api('POST', '/v1/rota/publish', { from: WEEK, to: addDays(WEEK, 6), locationId: c.madrid });
    await clock(esMe, 'Europe/Madrid', [[WEEK, '09:00', '17:00']]);
    const ts = await sheet(es, esMe);
    expect(ts).toMatchObject({ timeRecordingRequired: true, timeRecordingJurisdiction: 'ES' });
    expect(ts.violations.filter((v: { rule: string }) => v.rule === 'working_time.time_recording')).toEqual([{ rule: 'working_time.time_recording', date: addDays(WEEK, 1), detail: { scheduledMinutes: 450 }, source: 'https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430' }]);
    const de = await c.hire(c.berlin);
    expect((await sheet(de)).timeRecordingJurisdiction).toBe('DE');
  });
});

describe('submission rules and access', () => {
  it('cannot submit an unfinished week or with an open clock; colleagues cannot read each other’s timesheets', async () => {
    const emp = await c.hire(c.leeds);
    const me = await c.login(emp);
    expect((await c.api('POST', `/v1/timesheets/employees/${emp}/weeks/${addDays(WEEK, 7)}/submit`, undefined, me)).statusCode).toBe(409);
    await c.api('POST', '/v1/clock/events', { events: [{ clientEventId: eid(), kind: 'in', occurredAt: local(addDays(WEEK, 4), '09:00', 'Europe/London') }] }, me);
    expect((await c.api('POST', `/v1/timesheets/employees/${emp}/weeks/${WEEK}/submit`, undefined, me)).statusCode).toBe(422);
    const other = await c.login(await c.hire(c.leeds));
    expect((await c.api('GET', `/v1/timesheets/employees/${emp}/weeks/${WEEK}`, undefined, other)).statusCode).toBe(403);
    expect((await c.api('GET', `/v1/timesheets?weekStart=${WEEK}`, undefined, other)).statusCode).toBe(403);
  });
});
