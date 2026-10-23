import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMinutes } from '@thapsus/core/time';
import { closeDb, randomIp, startTestApp, type TestContext } from './helpers';
import { NOW, timeCompany, type TimeCompany } from './time-fixtures';

/**
 * Clock in/out (PROGRESS 4.2): idempotent offline batch sync, geofence off by default and per country
 * with notice text, manager corrections, and the shared kiosk with hashed, rate-limited, locking PINs.
 */
let ctx: TestContext;
let c: TimeCompany;
const at = (minutesFromNow: number) => addMinutes(NOW.toISOString(), minutesFromNow);
let seq = 0;
const eid = () => `evt-${Date.now().toString(36)}-${++seq}`;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  ctx.clock.now = new Date(NOW);
  c = await timeCompany(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('time settings', () => {
  it('defaults: warn, Monday workweek, geofence off; readable by every signed-in user', async () => {
    const me = await c.login(await c.hire(c.leeds));
    const s = (await c.api('GET', '/v1/settings/time', undefined, me)).json();
    expect(s).toMatchObject({
      enforcement: 'warn',
      workweekStartsOn: 1,
      geofence: { countries: [] },
      kiosk: { maxFailedAttempts: 5 },
    });
  });
  it('enabling geofencing for a country requires the notice workers will see; changes are audited', async () => {
    expect(
      (await c.api('PUT', '/v1/settings/time', { geofence: { countries: ['GB'], notice: {} } })).statusCode,
    ).toBe(422);
    const ok = await c.api('PUT', '/v1/settings/time', {
      geofence: {
        countries: ['GB'],
        notice: {
          GB: {
            'en-GB': 'Fictional notice: we check you are on site when you clock in.',
            'en-US': 'Fictional US-English notice.',
          },
        },
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const audit = await c.tx((t) =>
      t.query(`SELECT 1 FROM audit.events WHERE action = 'settings.time_updated'`),
    );
    expect(audit.length).toBeGreaterThan(0);
    await c.api('PUT', '/v1/settings/time', { geofence: { countries: [], notice: {} } });
  });
});

describe('offline queue sync', () => {
  it('the same batch twice creates each event once and reports duplicates', async () => {
    const emp = await c.hire(c.leeds);
    const me = await c.login(emp);
    const batch = {
      events: [
        { clientEventId: eid(), kind: 'in', occurredAt: at(-240) },
        { clientEventId: eid(), kind: 'break_start', occurredAt: at(-120) },
        { clientEventId: eid(), kind: 'break_end', occurredAt: at(-90) },
        { clientEventId: eid(), kind: 'out', occurredAt: at(-10) },
      ],
    };
    const first = await c.api('POST', '/v1/clock/events', batch, me);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().results.map((r: { status: string }) => r.status)).toEqual([
      'created',
      'created',
      'created',
      'created',
    ]);
    expect(first.json().state.state).toBe('out');
    const second = await c.api('POST', '/v1/clock/events', batch, me);
    expect(second.json().results.map((r: { status: string }) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    const rows = await c.tx((t) => t.query(`SELECT 1 FROM app.clock_events WHERE employee_id = $1`, [emp]));
    expect(rows).toHaveLength(4);
    expect(
      (
        await c.tx((t) =>
          t.query<{ diff: { created: number; duplicate: number } }>(
            `SELECT diff FROM audit.events WHERE action = 'clock.synced' AND target_id = $1 ORDER BY id`,
            [emp],
          ),
        )
      ).map((a) => a.diff),
    ).toEqual([
      expect.objectContaining({ created: 4, duplicate: 0 }),
      expect.objectContaining({ created: 0, duplicate: 4 }),
    ]);
  });

  it('rejects events from the future or older than the offline window', async () => {
    const me = await c.login(await c.hire(c.leeds));
    const r = await c.api(
      'POST',
      '/v1/clock/events',
      {
        events: [
          { clientEventId: eid(), kind: 'in', occurredAt: at(60) },
          { clientEventId: eid(), kind: 'in', occurredAt: at(-73 * 60) },
        ],
      },
      me,
    );
    expect(r.json().results.map((x: { reason: string }) => x.reason)).toEqual(['inFuture', 'tooOld']);
  });

  it('status shows the current state; people without an employee record cannot clock', async () => {
    const emp = await c.hire(c.leeds);
    const me = await c.login(emp);
    await c.api(
      'POST',
      '/v1/clock/events',
      { events: [{ clientEventId: eid(), kind: 'in', occurredAt: at(-30) }] },
      me,
    );
    const s = (await c.api('GET', '/v1/clock/status', undefined, me)).json();
    expect(s).toMatchObject({
      employeeId: emp,
      state: { state: 'in' },
      zone: 'Europe/London',
      geofence: { enabled: false, notice: null },
    });
    expect(s.today).toHaveLength(1);
    expect(
      (
        await c.api('POST', '/v1/clock/events', {
          events: [{ clientEventId: eid(), kind: 'in', occurredAt: at(-1) }],
        })
      ).statusCode,
    ).toBe(403); // owner has no employee record
  });
});

describe('geofence (off by default, per country, with notice)', () => {
  const where = { lat: 51.50012, lng: -0.12034 };
  it('off by default: coordinates sent by the device are discarded, never stored', async () => {
    const emp = await c.hire(c.london);
    const me = await c.login(emp);
    const r = await c.api(
      'POST',
      '/v1/clock/events',
      { events: [{ clientEventId: eid(), kind: 'in', occurredAt: at(-5), location: where }] },
      me,
    );
    expect(r.json().geofence).toEqual({ enabled: false, notice: null });
    const row = await c.tx((t) =>
      t.one<{ lat: string | null; lng: string | null; within_geofence: boolean | null }>(
        `SELECT lat, lng, within_geofence FROM app.clock_events WHERE employee_id = $1`,
        [emp],
      ),
    );
    expect(row).toEqual({ lat: null, lng: null, within_geofence: null });
  });

  it('enabled for GB at a fenced location: coarse coordinates and within/outside are stored, notice shown in the user locale; other countries unaffected', async () => {
    await c.api('PUT', '/v1/settings/time', {
      geofence: {
        countries: ['GB'],
        notice: { GB: { 'en-GB': 'Fictional notice: location is checked at clock-in.' } },
      },
    });
    try {
      const emp = await c.hire(c.london);
      const me = await c.login(emp);
      const status = (await c.api('GET', '/v1/clock/status', undefined, me)).json();
      expect(status.geofence).toEqual({
        enabled: true,
        notice: 'Fictional notice: location is checked at clock-in.',
      });
      const r = await c.api(
        'POST',
        '/v1/clock/events',
        {
          events: [
            { clientEventId: eid(), kind: 'in', occurredAt: at(-50), location: where },
            { clientEventId: eid(), kind: 'out', occurredAt: at(-5), location: { lat: 51.51, lng: -0.12 } },
          ],
        },
        me,
      );
      expect(r.json().results.map((x: { withinGeofence: boolean }) => x.withinGeofence)).toEqual([
        true,
        false,
      ]);
      const rows = await c.tx((t) =>
        t.query<{ lat: string; within_geofence: boolean }>(
          `SELECT lat, within_geofence FROM app.clock_events WHERE employee_id = $1 ORDER BY occurred_at`,
          [emp],
        ),
      );
      expect(rows.map((x) => x.lat)).toEqual(['51.5001', '51.5100']);
      // the events API never exposes coordinates
      const listed = (
        await c.api('GET', `/v1/clock/events?from=2026-06-01&to=2026-06-30`, undefined, me)
      ).json();
      expect(Object.keys(listed[0])).not.toContain('lat');
      // a German site with a fence is NOT tracked: Germany is not enabled
      const de = await c.hire(c.berlin);
      const deMe = await c.login(de);
      const deRes = await c.api(
        'POST',
        '/v1/clock/events',
        {
          events: [
            { clientEventId: eid(), kind: 'in', occurredAt: at(-5), location: { lat: 52.52, lng: 13.405 } },
          ],
        },
        deMe,
      );
      expect(deRes.json().geofence.enabled).toBe(false);
      expect(
        (
          await c.tx((t) =>
            t.one<{ lat: string | null }>(`SELECT lat FROM app.clock_events WHERE employee_id = $1`, [de]),
          )
        ).lat,
      ).toBeNull();
    } finally {
      await c.api('PUT', '/v1/settings/time', { geofence: { countries: [], notice: {} } });
    }
  });
});

describe('manager corrections', () => {
  it('a correction is a new audited event (source manager, reason) that supersedes the original', async () => {
    const mgrEmp = await c.hire(c.leeds);
    const emp = await c.hire(c.leeds, { managerId: mgrEmp });
    const mgr = await c.login(mgrEmp, 'manager');
    const me = await c.login(emp);
    const sync = (
      await c.api(
        'POST',
        '/v1/clock/events',
        { events: [{ clientEventId: eid(), kind: 'in', occurredAt: at(-300) }] },
        me,
      )
    ).json();
    const original = sync.results[0].id;
    expect(
      (
        await c.api(
          'POST',
          '/v1/clock/corrections',
          { employeeId: emp, kind: 'in', occurredAt: at(-290), reason: 'x' },
          mgr,
        )
      ).statusCode,
    ).toBe(400);
    const fix = await c.api(
      'POST',
      '/v1/clock/corrections',
      {
        employeeId: emp,
        kind: 'in',
        occurredAt: at(-280),
        reason: 'Forgot to clock in on arrival',
        replacesEventId: original,
      },
      mgr,
    );
    expect(fix.statusCode, fix.body).toBe(201);
    expect(
      (
        await c.api(
          'POST',
          '/v1/clock/corrections',
          { employeeId: emp, kind: 'in', occurredAt: at(-270), reason: 'Again', replacesEventId: original },
          mgr,
        )
      ).statusCode,
    ).toBe(409);
    const events = (
      await c.api('GET', `/v1/clock/events?employeeId=${emp}&from=2026-06-01&to=2026-06-30`, undefined, mgr)
    ).json();
    expect(events.find((e: { id: string }) => e.id === original).superseded).toBe(true);
    expect(events.find((e: { id: string }) => e.id === fix.json().id)).toMatchObject({
      source: 'manager',
      reason: 'Forgot to clock in on arrival',
      replacesEventId: original,
    });
    const audit = await c.tx((t) =>
      t.one<{ diff: { reason: string } }>(
        `SELECT diff FROM audit.events WHERE action = 'clock.corrected' AND target_id = $1`,
        [emp],
      ),
    );
    expect(audit.diff.reason).toBe('Forgot to clock in on arrival');
    // an employee cannot correct, and a manager cannot correct outside their team
    expect(
      (
        await c.api(
          'POST',
          '/v1/clock/corrections',
          { employeeId: emp, kind: 'out', occurredAt: at(-1), reason: 'Self fix' },
          me,
        )
      ).statusCode,
    ).toBe(403);
    const stranger = await c.hire(c.leeds);
    expect(
      (
        await c.api(
          'POST',
          '/v1/clock/corrections',
          { employeeId: stranger, kind: 'out', occurredAt: at(-1), reason: 'Not my team' },
          mgr,
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('shared kiosk with PIN', () => {
  async function kioskSetup(name = 'Fictional front desk') {
    const k = await c.api('POST', '/v1/kiosks', { name, locationId: c.leeds });
    expect(k.statusCode, k.body).toBe(201);
    return k.json() as { id: string; token: string };
  }
  const kioskCall = (token: string, body: Record<string, unknown>, ip = '10.200.0.1') =>
    ctx.app.inject({
      method: 'POST',
      url: '/v1/kiosk/clock',
      headers: { authorization: `Kiosk ${token}` },
      payload: body,
      remoteAddress: ip,
    });
  const numberOf = async (id: string) =>
    (
      await c.tx((t) =>
        t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [id]),
      )
    ).employee_number;

  it('the token is shown once and only its hash is stored; revoked kiosks stop working', async () => {
    const k = await kioskSetup();
    const row = await c.tx((t) =>
      t.one<{ token_hash: string }>('SELECT token_hash FROM app.kiosks WHERE id = $1', [k.id]),
    );
    expect(k.token).toMatch(/^kio_/);
    expect(row.token_hash).not.toContain(k.token.split('.')[1]);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/kiosk/session',
          headers: { authorization: `Kiosk ${k.token}` },
        })
      ).json(),
    ).toEqual({ name: 'Fictional front desk' });
    await c.api('POST', `/v1/kiosks/${k.id}/revoke`);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/kiosk/session',
          headers: { authorization: `Kiosk ${k.token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await kioskCall(k.token, { employeeNumber: 'E000001', pin: '4826', kind: 'in', clientEventId: eid() }))
        .statusCode,
    ).toBe(401);
  });

  it('employee sets a PIN (Argon2id hash, weak PINs refused) and clocks in at the kiosk; repeat taps are idempotent', async () => {
    const k = await kioskSetup();
    const emp = await c.hire(c.leeds, { legalFirstName: 'Kiosko' });
    const me = await c.login(emp);
    expect((await c.api('PUT', `/v1/kiosk-pins/${emp}`, { pin: '1234' }, me)).statusCode).toBe(422);
    expect((await c.api('PUT', `/v1/kiosk-pins/${emp}`, { pin: '4826' }, me)).statusCode).toBe(204);
    const stored = await c.tx((t) =>
      t.one<{ pin_hash: string }>('SELECT pin_hash FROM app.kiosk_pins WHERE employee_id = $1', [emp]),
    );
    expect(stored.pin_hash).toMatch(/^\$argon2id\$/);
    const tap = { employeeNumber: await numberOf(emp), pin: '4826', kind: 'in', clientEventId: eid() };
    const r = await kioskCall(k.token, tap);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'created', name: 'Kiosko', state: { state: 'in' } });
    expect((await kioskCall(k.token, tap)).json().status).toBe('duplicate');
    const ev = await c.tx((t) =>
      t.one<{ source: string; kiosk_id: string; lat: string | null }>(
        'SELECT source, kiosk_id, lat FROM app.clock_events WHERE employee_id = $1',
        [emp],
      ),
    );
    expect(ev).toEqual({ source: 'kiosk', kiosk_id: k.id, lat: null });
    expect(
      await c.tx((t) =>
        t.query(`SELECT 1 FROM audit.events WHERE action = 'clock.recorded' AND target_id = $1`, [emp]),
      ),
    ).toHaveLength(2);
    // another employee's PIN cannot be set by a colleague
    const other = await c.hire(c.leeds);
    expect((await c.api('PUT', `/v1/kiosk-pins/${other}`, { pin: '4826' }, me)).statusCode).toBe(403);
  });

  it('locks after repeated wrong PINs; unknown numbers get the same answers (no enumeration)', async () => {
    const k = await kioskSetup();
    const emp = await c.hire(c.leeds);
    await c.api('PUT', `/v1/kiosk-pins/${emp}`, { pin: '5937' });
    const number = await numberOf(emp);
    const wrong = () =>
      kioskCall(k.token, { employeeNumber: number, pin: '1111', kind: 'in', clientEventId: eid() });
    const unknown = () =>
      kioskCall(k.token, { employeeNumber: 'NOPE-404', pin: '1111', kind: 'in', clientEventId: eid() });
    const codes: number[] = [];
    const unknownCodes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await wrong()).statusCode);
      unknownCodes.push((await unknown()).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 423]);
    expect(unknownCodes).toEqual(codes);
    const a = (await wrong()).json();
    const b = (await unknown()).json();
    expect({ ...a, requestId: undefined }).toEqual({ ...b, requestId: undefined });
    // even the right PIN is refused while locked
    expect(
      (await kioskCall(k.token, { employeeNumber: number, pin: '5937', kind: 'in', clientEventId: eid() }))
        .statusCode,
    ).toBe(423);
    const pin = await c.tx((t) =>
      t.one<{ locked_until: string | null }>(
        'SELECT locked_until FROM app.kiosk_pins WHERE employee_id = $1',
        [emp],
      ),
    );
    expect(pin.locked_until).not.toBeNull();
    expect(
      (
        await c.tx((t) =>
          t.query(`SELECT 1 FROM audit.events WHERE action = 'kiosk.pin_failed' AND target_id = $1`, [emp]),
        )
      ).length,
    ).toBe(5);
    // after the lockout period it works again
    ctx.clock.advanceMinutes(16);
    try {
      expect(
        (await kioskCall(k.token, { employeeNumber: number, pin: '5937', kind: 'in', clientEventId: eid() }))
          .statusCode,
      ).toBe(200);
    } finally {
      ctx.clock.now = new Date(NOW);
    }
  });

  it('is rate-limited per kiosk', async () => {
    await c.api('PUT', '/v1/settings/time', { kiosk: { attemptsPerMinute: 5 } });
    try {
      const k = await kioskSetup();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++)
        codes.push(
          (
            await kioskCall(
              k.token,
              { employeeNumber: `RATE-${i}`, pin: '2468', kind: 'in', clientEventId: eid() },
              randomIp(),
            )
          ).statusCode,
        );
      expect(codes.slice(0, 5).every((x) => x === 401)).toBe(true);
      expect(codes.slice(5)).toEqual([429, 429]);
    } finally {
      await c.api('PUT', '/v1/settings/time', { kiosk: { attemptsPerMinute: 30 } });
    }
  });

  it('a kiosk only reaches its own tenant (same employee number elsewhere is unknown)', async () => {
    const k = await kioskSetup();
    const other = await timeCompany(ctx);
    const theirs = await other.hire(other.leeds);
    await other.api('PUT', `/v1/kiosk-pins/${theirs}`, { pin: '7351' });
    const theirNumber = (
      await other.tx((t) =>
        t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [
          theirs,
        ]),
      )
    ).employee_number;
    const ourSame = await c.tx((t) =>
      t.maybe<{ id: string }>('SELECT id FROM app.employees WHERE employee_number = $1', [theirNumber]),
    );
    expect(ourSame).toBeDefined(); // numbering collides across tenants
    expect(
      (
        await kioskCall(k.token, {
          employeeNumber: theirNumber,
          pin: '7351',
          kind: 'in',
          clientEventId: eid(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await other.tx((t) => t.query('SELECT 1 FROM app.clock_events WHERE employee_id = $1', [theirs])),
    ).toHaveLength(0);
  });

  it('only time managers create kiosks or set other people’s PINs', async () => {
    const me = await c.login(await c.hire(c.leeds));
    expect((await c.api('POST', '/v1/kiosks', { name: 'Nope' }, me)).statusCode).toBe(403);
    expect((await c.api('GET', '/v1/kiosks', undefined, me)).statusCode).toBe(403);
  });
});
