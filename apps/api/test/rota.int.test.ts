import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { NOW, timeCompany, type TimeCompany } from './time-fixtures';

/**
 * Rota builder (PROGRESS 4.1) and working-time checks on assignment (4.3): templates, shifts in local
 * time, availability, warn vs block, the UK 48-hour opt-out, publish + notify once, open shifts,
 * claims and swaps through approvals, keyset pagination and permission/RLS refusals.
 */
let ctx: TestContext;
let c: TimeCompany;
const MON = '2026-06-15'; // the week after "now"
const shift = (employeeId: string | null, date: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ employeeId, date, start, end, breakMinutes: 30, ...extra });

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  ctx.clock.now = new Date(NOW);
  c = await timeCompany(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('shifts in local time', () => {
  it('stores wall-clock times with the zone and derives instants (overnight shift crosses midnight)', async () => {
    const emp = await c.hire(c.london);
    const r = await c.api('POST', '/v1/shifts', shift(emp, MON, '22:00', '06:00'));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().shift).toMatchObject({ date: MON, startLocal: `${MON}T22:00`, endLocal: '2026-06-16T06:00', zone: 'Europe/London', startsAt: '2026-06-15T21:00:00.000Z', endsAt: '2026-06-16T05:00:00.000Z', status: 'draft', locationId: c.london });
    // overlapping shift for the same person is refused by the exclusion constraint
    expect((await c.api('POST', '/v1/shifts', shift(emp, MON, '23:00', '23:30', { breakMinutes: 0 }))).statusCode).toBe(409);
    // a California shift is in Pacific time
    const ca = await c.hire(c.sanJose);
    expect((await c.api('POST', '/v1/shifts', shift(ca, MON, '09:00', '17:00'))).json().shift.startsAt).toBe('2026-06-15T16:00:00.000Z');
  });

  it('rejects a break longer than the shift and an unknown zone', async () => {
    const emp = await c.hire(c.london);
    expect((await c.api('POST', '/v1/shifts', shift(emp, MON, '09:00', '10:00', { breakMinutes: 60 }))).statusCode).toBe(400);
    expect((await c.api('POST', '/v1/shifts', shift(null, MON, '09:00', '10:00', { zone: 'Mars/Olympus' }))).statusCode).toBe(400);
  });

  it('edits and cancels shifts (published changes notify the employee)', async () => {
    const emp = await c.hire(c.leeds);
    const id = (await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 2), '09:00', '17:00'))).json().shift.id;
    const patched = await c.api('PATCH', `/v1/shifts/${id}`, { start: '10:00', end: '18:00' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().shift.startLocal).toBe(`${addDays(MON, 2)}T10:00`);
    const user = await c.login(emp);
    void user;
    await c.api('POST', '/v1/rota/publish', { from: addDays(MON, 2), to: addDays(MON, 2), locationId: c.leeds });
    await c.api('POST', `/v1/shifts/${id}/cancel`);
    const kinds = await c.tx((t) => t.query<{ kind: string }>(`SELECT n.kind FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE u.employee_id = $1 ORDER BY n.created_at`, [emp]));
    expect(kinds.map((k) => k.kind)).toEqual(['rota.published', 'rota.cancelled']);
    expect((await c.api('POST', `/v1/shifts/${id}/cancel`)).statusCode).toBe(409);
  });
});

describe('templates', () => {
  it('CRUD and apply to a week: draft shifts, open or assigned', async () => {
    const emp = await c.hire(c.leeds);
    const t = await c.api('POST', '/v1/rota/templates', { name: 'Leeds weekdays', locationId: c.leeds, slots: [{ weekday: 1, start: '08:00', end: '16:00', breakMinutes: 30, headcount: 2, employeeId: emp }, { weekday: 3, start: '12:00', end: '20:00', breakMinutes: 30 }] });
    expect(t.statusCode, t.body).toBe(201);
    const id = t.json().id;
    expect((await c.api('GET', '/v1/rota/templates')).json().map((x: { id: string }) => x.id)).toContain(id);
    expect((await c.api('PUT', `/v1/rota/templates/${id}`, { name: 'Leeds weekdays v2', locationId: c.leeds, slots: t.json().slots })).json().name).toBe('Leeds weekdays v2');
    const applied = await c.api('POST', `/v1/rota/templates/${id}/apply`, { weekStart: addDays(MON, 7) });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json().created).toBe(3);
    const shifts = (await c.api('GET', `/v1/shifts?from=${addDays(MON, 7)}&to=${addDays(MON, 13)}&locationId=${c.leeds}`)).json().data;
    expect(shifts.filter((s: { employeeId: string | null }) => s.employeeId === emp)).toHaveLength(1);
    expect(shifts.filter((s: { employeeId: string | null }) => s.employeeId === null)).toHaveLength(2);
    expect(shifts.every((s: { status: string }) => s.status === 'draft')).toBe(true);
    expect(shifts.find((s: { date: string }) => s.date === addDays(MON, 9))).toMatchObject({ start: '12:00', end: '20:00' });
    expect((await c.api('DELETE', `/v1/rota/templates/${id}`)).statusCode).toBe(204);
  });
});

describe('working-time checks on assignment (rules from the packs)', () => {
  it('warns (201 + warnings with the official source) or blocks (422 + violations) per tenant setting', async () => {
    const emp = await c.hire(c.london);
    expect((await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 14), '14:00', '23:00'))).statusCode).toBe(201);
    const warned = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 15), '07:00', '15:00'));
    expect(warned.statusCode, warned.body).toBe(201);
    const w = warned.json().warnings.find((x: { rule: string }) => x.rule === 'working_time.daily_rest');
    expect(w).toMatchObject({ detail: { restHours: 8, minHours: 11 }, source: 'https://www.legislation.gov.uk/uksi/1998/1833/regulation/10' });

    expect((await c.api('PUT', '/v1/settings/time', { enforcement: 'block' })).statusCode).toBe(200);
    try {
      const blocked = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 16), '00:30', '06:00')); // 9.5 h after the 15:00 finish
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json().violations.map((v: { rule: string }) => v.rule)).toContain('working_time.daily_rest');
      // a 7-hour shift without a 20-minute break breaks reg. 12
      const noBreak = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 18), '09:00', '16:00', { breakMinutes: 10 }));
      expect(noBreak.statusCode).toBe(422);
      expect(noBreak.json().violations[0]).toMatchObject({ rule: 'working_time.rest_break', detail: { minMinutes: 20 } });
      // a compliant shift is fine under block
      expect((await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 18), '09:00', '16:00'))).statusCode).toBe(201);
    } finally {
      await c.api('PUT', '/v1/settings/time', { enforcement: 'warn' });
    }
  });

  it('48-hour average: flagged over the 17-week reference period unless the GB worker opted out', async () => {
    const emp = await c.hire(c.london);
    // 17 weeks of 6 × 9.5-hour shifts (57 h/week), inserted as rota history
    const start = '2026-03-02';
    await c.tx(async (t) => {
      for (let w = 0; w < 17; w++)
        for (let d = 0; d < 6; d++) {
          const day = addDays(start, w * 7 + d);
          await t.exec(
            `INSERT INTO app.shifts (tenant_id, employee_id, shift_date, start_local, end_local, zone, starts_at, ends_at, break_minutes, status)
             VALUES (app.current_tenant(), $1, $2, $3, $4, 'Europe/London', ($2::date + time '07:00') AT TIME ZONE 'Europe/London', ($2::date + time '17:00') AT TIME ZONE 'Europe/London', 30, 'published')`,
            [emp, day, `${day}T07:00`, `${day}T17:00`],
          );
        }
    });
    const candidateDay = addDays(start, 17 * 7 - 1); // the Sunday closing week 17
    const flagged = await c.api('POST', '/v1/shifts', shift(emp, candidateDay, '09:00', '13:00', { breakMinutes: 0 }));
    expect(flagged.statusCode, flagged.body).toBe(201);
    expect(flagged.json().warnings.find((x: { rule: string }) => x.rule === 'working_time.max_weekly_hours')).toMatchObject({ detail: { maxHours: 48, referenceWeeks: 17 }, source: 'https://www.legislation.gov.uk/uksi/1998/1833/regulation/4' });
    await c.api('POST', `/v1/shifts/${flagged.json().shift.id}/cancel`);

    const optOut = await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: start });
    expect(optOut.statusCode, optOut.body).toBe(201);
    expect(optOut.json()).toMatchObject({ noticeDays: 7, validTo: null, source: 'https://www.legislation.gov.uk/uksi/1998/1833/regulation/5' });
    const after = await c.api('POST', '/v1/shifts', shift(emp, candidateDay, '09:00', '13:00', { breakMinutes: 0 }));
    expect(after.json().warnings.map((x: { rule: string }) => x.rule)).not.toContain('working_time.max_weekly_hours');
  });

  it('US: projected overtime is a warning citing FLSA / California daily overtime', async () => {
    const emp = await c.hire(c.sanJose);
    const r = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 21), '06:00', '17:00')); // 10.5 h worked
    expect(r.json().warnings).toEqual([expect.objectContaining({ rule: 'overtime.projected', detail: expect.objectContaining({ overtimeMinutes: 150 }), source: 'https://www.dir.ca.gov/dlse/faq_overtime.htm' })]);
  });

  it('availability: self-service entry, and assignment warns when the employee is unavailable', async () => {
    const emp = await c.hire(c.leeds);
    const me = await c.login(emp);
    const a = await c.api('POST', '/v1/availability', { weekday: 2, available: false, note: 'Fictional class' }, me);
    expect(a.statusCode, a.body).toBe(201);
    expect((await c.api('POST', '/v1/availability', { weekday: 4, available: true, from: '08:00', to: '14:00' }, me)).statusCode).toBe(201);
    expect((await c.api('GET', `/v1/availability/${emp}`, undefined, me)).json()).toHaveLength(2);
    const tue = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 22), '09:00', '17:00'));
    expect(tue.json().warnings.map((w: { rule: string }) => w.rule)).toEqual(['availability.unavailable']);
    const thu = await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 24), '09:00', '17:00'));
    expect(thu.json().warnings.map((w: { rule: string }) => w.rule)).toEqual(['availability.outside_window']);
    const other = await c.login(await c.hire(c.leeds));
    expect((await c.api('POST', '/v1/availability', { employeeId: emp, weekday: 5, available: false }, other)).statusCode).toBe(403);
    expect((await c.api('DELETE', `/v1/availability/${a.json().id}`, undefined, me)).statusCode).toBe(204);
  });
});

describe('publish and notify', () => {
  it('publishes drafts in range and notifies each affected employee once (email + web push queued), never twice', async () => {
    const week = addDays(MON, 28);
    const a = await c.hire(c.leeds);
    const b = await c.hire(c.leeds);
    await c.login(a);
    await c.login(b);
    for (const d of [0, 1, 2]) await c.api('POST', '/v1/shifts', shift(a, addDays(week, d), '09:00', '17:00'));
    await c.api('POST', '/v1/shifts', shift(b, addDays(week, 3), '09:00', '17:00'));
    await c.api('POST', '/v1/shifts', shift(null, addDays(week, 4), '09:00', '17:00', { locationId: c.leeds }));
    const pub = await c.api('POST', '/v1/rota/publish', { from: week, to: addDays(week, 6), locationId: c.leeds });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toEqual({ published: 5, notified: 2 });
    const notes = await c.tx((t) => t.query<{ employee_id: string; params: { shifts: number }; id: string }>(`SELECT u.employee_id, n.params, n.id FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE n.kind = 'rota.published' AND u.employee_id = ANY($1::uuid[])`, [[a, b]]));
    expect(notes.filter((n) => n.employee_id === a)).toHaveLength(1);
    expect(notes.find((n) => n.employee_id === a)!.params.shifts).toBe(3);
    const jobs = await c.tx((t) => t.query(`SELECT 1 FROM app.jobs WHERE kind = 'notifications.deliver' AND idempotency_key = ANY($1::text[])`, [notes.map((n) => n.id)]));
    expect(jobs).toHaveLength(2);
    // publishing the same range again publishes and notifies nothing
    expect((await c.api('POST', '/v1/rota/publish', { from: week, to: addDays(week, 6), locationId: c.leeds })).json()).toEqual({ published: 0, notified: 0 });
    const audit = await c.tx((t) => t.query<{ diff: { published: number } }>(`SELECT diff FROM audit.events WHERE action = 'rota.published' ORDER BY id DESC LIMIT 2`));
    expect(audit.map((a) => a.diff.published)).toEqual([0, 5]);
  });

  it('employees see their published shifts and the open shifts they are eligible for', async () => {
    const week = addDays(MON, 35);
    const emp = await c.hire(c.leeds);
    const elsewhere = await c.hire(c.london);
    const me = await c.login(emp);
    const them = await c.login(elsewhere);
    await c.api('POST', '/v1/shifts', shift(emp, week, '09:00', '17:00'));
    await c.api('POST', '/v1/shifts', shift(emp, addDays(week, 1), '09:00', '17:00')); // stays draft
    await c.api('POST', '/v1/rota/publish', { from: week, to: week });
    const open = (await c.api('POST', '/v1/shifts', shift(null, addDays(week, 2), '10:00', '18:00', { locationId: c.leeds }))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: addDays(week, 2), to: addDays(week, 2) });
    const mine = (await c.api('GET', `/v1/me/shifts?from=${week}&to=${addDays(week, 6)}`, undefined, me)).json();
    expect(mine.map((s: { date: string }) => s.date)).toEqual([week]);
    expect((await c.api('GET', `/v1/shifts/open?from=${week}&to=${addDays(week, 6)}`, undefined, me)).json().map((s: { id: string }) => s.id)).toContain(open);
    expect((await c.api('GET', `/v1/shifts/open?from=${week}&to=${addDays(week, 6)}`, undefined, them)).json().map((s: { id: string }) => s.id)).not.toContain(open);
  });
});

describe('open-shift claims and swaps through approvals', () => {
  async function team() {
    const mgrEmp = await c.hire(c.leeds, { legalFirstName: 'Manny' });
    const a = await c.hire(c.leeds, { managerId: mgrEmp });
    const b = await c.hire(c.leeds, { managerId: mgrEmp });
    return { mgr: await c.login(mgrEmp, 'manager'), a, b, aCookie: await c.login(a), bCookie: await c.login(b) };
  }
  const inbox = async (cookie: string, key: string, value: string) => (await c.api('GET', '/v1/approvals', undefined, cookie)).json().find((x: { payload: Record<string, string> }) => x.payload[key] === value);

  it('claim → manager approves → shift assigned; the competing claim lapses', async () => {
    const t = await team();
    const day = addDays(MON, 42);
    const open = (await c.api('POST', '/v1/shifts', shift(null, day, '10:00', '18:00', { locationId: c.leeds }))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: day, to: day });
    const claimA = await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.aCookie);
    expect(claimA.statusCode, claimA.body).toBe(201);
    expect(claimA.json().status).toBe('pending');
    expect((await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.aCookie)).statusCode).toBe(409); // one pending claim per person
    const claimB = await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.bCookie);
    const ar = await inbox(t.mgr, 'swapId', claimA.json().id);
    expect(ar).toBeDefined();
    expect((await c.api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'approve' }, t.mgr)).json().status).toBe('approved');
    const s = (await c.api('GET', `/v1/shifts?from=${day}&to=${day}&locationId=${c.leeds}`)).json().data.find((x: { id: string }) => x.id === open);
    expect(s.employeeId).toBe(t.a);
    const swaps = (await c.api('GET', '/v1/shift-swaps', undefined, t.bCookie)).json();
    expect(swaps.find((x: { id: string }) => x.id === claimB.json().id).status).toBe('cancelled');
    expect((await c.api('GET', `/v1/me/shifts?from=${day}&to=${day}`, undefined, t.aCookie)).json()).toHaveLength(1);
  });

  it('rejected claim leaves the shift open; requester can cancel a pending claim', async () => {
    const t = await team();
    const day = addDays(MON, 43);
    const open = (await c.api('POST', '/v1/shifts', shift(null, day, '10:00', '18:00', { locationId: c.leeds }))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: day, to: day });
    const claim = (await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.aCookie)).json();
    await c.api('POST', `/v1/approvals/${(await inbox(t.mgr, 'swapId', claim.id)).id}/decide`, { decision: 'reject' }, t.mgr);
    expect((await c.api('GET', '/v1/shift-swaps', undefined, t.aCookie)).json().find((x: { id: string }) => x.id === claim.id).status).toBe('rejected');
    const again = (await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.bCookie)).json();
    expect((await c.api('POST', `/v1/shift-swaps/${again.id}/cancel`, undefined, t.bCookie)).json().status).toBe('cancelled');
    expect(await inbox(t.mgr, 'swapId', again.id)).toBeUndefined();
  });

  it('working time is re-checked on approval: blocked when the claim would now break a rule', async () => {
    const t = await team();
    const day = addDays(MON, 44);
    const open = (await c.api('POST', '/v1/shifts', shift(null, day, '07:00', '15:00', { locationId: c.leeds }))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: day, to: day });
    const claim = (await c.api('POST', `/v1/shifts/${open}/claim`, {}, t.aCookie)).json();
    // after the claim, A is given a late shift the evening before (8 h rest)
    await c.api('POST', '/v1/shifts', shift(t.a, addDays(day, -1), '14:00', '23:00'));
    await c.api('PUT', '/v1/settings/time', { enforcement: 'block' });
    try {
      const res = await c.api('POST', `/v1/approvals/${(await inbox(t.mgr, 'swapId', claim.id)).id}/decide`, { decision: 'approve' }, t.mgr);
      expect(res.statusCode).toBe(422);
      expect(res.json().violations[0].rule).toBe('working_time.daily_rest');
      expect((await c.api('GET', '/v1/shift-swaps', undefined, t.aCookie)).json().find((x: { id: string }) => x.id === claim.id).status).toBe('pending');
    } finally {
      await c.api('PUT', '/v1/settings/time', { enforcement: 'warn' });
    }
  });

  it('swap: A offers a shift to B in exchange for B’s; B accepts; the manager approves; the shifts are exchanged', async () => {
    const t = await team();
    const day = addDays(MON, 49);
    const sa = (await c.api('POST', '/v1/shifts', shift(t.a, day, '09:00', '17:00'))).json().shift.id;
    const sb = (await c.api('POST', '/v1/shifts', shift(t.b, addDays(day, 1), '09:00', '17:00'))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: day, to: addDays(day, 1) });
    const sw = await c.api('POST', `/v1/shifts/${sa}/swap`, { toEmployeeId: t.b, toShiftId: sb }, t.aCookie);
    expect(sw.statusCode, sw.body).toBe(201);
    expect((await c.api('POST', `/v1/shift-swaps/${sw.json().id}/respond`, { accept: true }, t.aCookie)).statusCode).toBe(403); // only the colleague responds
    expect((await c.api('POST', `/v1/shift-swaps/${sw.json().id}/respond`, { accept: true }, t.bCookie)).json().status).toBe('pending');
    const ar = await inbox(t.mgr, 'swapId', sw.json().id);
    expect((await c.api('POST', `/v1/approvals/${ar.id}/decide`, { decision: 'approve' }, t.mgr)).json().status).toBe('approved');
    const all = (await c.api('GET', `/v1/shifts?from=${day}&to=${addDays(day, 1)}&locationId=${c.leeds}`)).json().data;
    expect(all.find((x: { id: string }) => x.id === sa).employeeId).toBe(t.b);
    expect(all.find((x: { id: string }) => x.id === sb).employeeId).toBe(t.a);
  });

  it('a declined swap is rejected without involving the manager', async () => {
    const t = await team();
    const day = addDays(MON, 50);
    const sa = (await c.api('POST', '/v1/shifts', shift(t.a, day, '09:00', '17:00'))).json().shift.id;
    await c.api('POST', '/v1/rota/publish', { from: day, to: day });
    const sw = (await c.api('POST', `/v1/shifts/${sa}/swap`, { toEmployeeId: t.b }, t.aCookie)).json();
    expect((await c.api('POST', `/v1/shift-swaps/${sw.id}/respond`, { accept: false }, t.bCookie)).json().status).toBe('rejected');
    expect(await inbox(t.mgr, 'swapId', sw.id)).toBeUndefined();
  });
});

describe('rota grid at scale and access control', () => {
  it('grid pages employees by keyset with their week of shifts; total on the first page', async () => {
    const dept = (await c.api('POST', '/v1/org/departments', { name: 'Fictional grid team' })).json().id;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await c.hire(c.leeds, { departmentId: dept, legalFirstName: `Grid${i}` }));
    await c.api('POST', '/v1/shifts', shift(ids[0]!, addDays(MON, 56), '09:00', '17:00'));
    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const url: string = `/v1/rota?weekStart=${addDays(MON, 58)}&departmentId=${dept}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await c.api('GET', url);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.weekStart).toBe(addDays(MON, 56)); // normalised to the workweek start (Monday)
      expect(body.days).toHaveLength(7);
      if (first) expect(body.total).toBe(5);
      first = false;
      seen.push(...body.rows.map((x: { employeeId: string }) => x.employeeId));
      if (body.rows.some((x: { employeeId: string }) => x.employeeId === ids[0])) expect(body.rows.find((x: { employeeId: string }) => x.employeeId === ids[0]).shifts).toHaveLength(1);
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('shift list pages by (date, start, id)', async () => {
    const emp = await c.hire(c.leeds);
    for (let d = 0; d < 5; d++) await c.api('POST', '/v1/shifts', shift(emp, addDays(MON, 63 + d), '09:00', '17:00'));
    const p1 = (await c.api('GET', `/v1/shifts?from=${addDays(MON, 63)}&to=${addDays(MON, 69)}&employeeId=${emp}&limit=3`)).json();
    const p2 = (await c.api('GET', `/v1/shifts?from=${addDays(MON, 63)}&to=${addDays(MON, 69)}&employeeId=${emp}&limit=3&cursor=${p1.nextCursor}`)).json();
    expect([...p1.data, ...p2.data].map((s: { date: string }) => s.date)).toEqual([0, 1, 2, 3, 4].map((d) => addDays(MON, 63 + d)));
    expect(p2.nextCursor).toBeNull();
  });

  it('employees cannot manage or view the rota; managers only manage their own team', async () => {
    const mgrEmp = await c.hire(c.leeds);
    const report = await c.hire(c.leeds, { managerId: mgrEmp });
    const stranger = await c.hire(c.leeds);
    const mgr = await c.login(mgrEmp, 'manager');
    const emp = await c.login(report);
    expect((await c.api('POST', '/v1/shifts', shift(report, addDays(MON, 70), '09:00', '17:00'), emp)).statusCode).toBe(403);
    expect((await c.api('GET', `/v1/rota?weekStart=${MON}`, undefined, emp)).statusCode).toBe(403);
    expect((await c.api('POST', '/v1/rota/publish', { from: MON, to: MON }, emp)).statusCode).toBe(403);
    expect((await c.api('PUT', '/v1/settings/time', { enforcement: 'block' }, emp)).statusCode).toBe(403);
    expect((await c.api('PUT', '/v1/settings/time', { enforcement: 'block' }, mgr)).statusCode).toBe(403);
    expect((await c.api('POST', '/v1/shifts', shift(report, addDays(MON, 70), '09:00', '17:00'), mgr)).statusCode).toBe(201);
    expect((await c.api('POST', '/v1/shifts', shift(stranger, addDays(MON, 70), '09:00', '17:00'), mgr)).statusCode).toBe(403);
    const grid = (await c.api('GET', `/v1/rota?weekStart=${addDays(MON, 70)}&limit=500`, undefined, mgr)).json();
    expect(grid.rows.map((r: { employeeId: string }) => r.employeeId)).toEqual([report]);
  });

  it('tenant isolation: another company sees none of these shifts or templates', async () => {
    const other = await timeCompany(ctx);
    const grid = (await other.api('GET', `/v1/rota?weekStart=${MON}&limit=500`)).json();
    expect(grid.total).toBe(0);
    expect((await other.api('GET', `/v1/shifts?from=${MON}&to=${addDays(MON, 60)}`)).json().data).toEqual([]);
    expect((await other.api('GET', '/v1/rota/templates')).json()).toEqual([]);
    const ours = (await c.api('GET', `/v1/shifts?from=${MON}&to=${addDays(MON, 6)}`)).json().data[0].id;
    expect((await other.api('PATCH', `/v1/shifts/${ours}`, { start: '08:00' })).statusCode).toBe(404);
  });
});
