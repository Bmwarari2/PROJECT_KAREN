import { createHash } from 'node:crypto';
import {
  addDays,
  addMinutes,
  compareDates,
  dayOfWeek,
  daysBetween,
  eachDay,
  startOfIsoWeek,
} from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import { requestApproval } from '../../../modules/approvals/service';
import { shiftTimes, timesheetCsv } from '../../../modules/time/engine';
import { buildTimesheet, timeSettings } from '../../../modules/time/service';
import { prng } from '../../fixtures';
import { insertRows, type SeedCtx } from '../context';
import { currentJob, employedOn, locationOf, type PlanPerson, type ShiftKind } from '../plan';
import { backdateApproval } from './leave';

/** Shift times per rota (local wall-clock; 30-minute unpaid break). Company rota design, not law. */
const TIMES: Record<ShiftKind, Array<[start: string, end: string]>> = {
  rotating: [
    ['06:00', '14:00'],
    ['14:00', '22:00'],
  ],
  nights: [['22:00', '06:00']],
  transport: [['07:00', '15:00']],
  goods_in: [['05:00', '13:00']],
  inventory: [['08:00', '16:00']],
  us_support: [['09:00', '17:30']],
  us_office: [['09:00', '17:00']],
};
const ROLE: Partial<Record<string, string>> = {
  'Warehouse operative': 'Picker',
  'Forklift driver': 'Forklift',
  'Delivery driver': 'Driver',
  'Goods-in operative': 'Goods-in',
  'Inventory controller': 'Stock control',
  'Customer support specialist': 'Support desk',
  'Office administrator': 'Front desk',
};

/**
 * Rotas, clocking and timesheets for the hourly workforce (Manchester warehouse and transport, the New York
 * support desk): rota templates, four past weeks, this week and two weeks ahead of shifts, open shifts, a
 * pending claim and swap, clock events for every worked shift, weekly timesheets built by the timesheet
 * engine (so overtime and working-time findings come from the packs), 48-hour opt-outs and availability.
 */
export async function seedTime(ctx: SeedCtx) {
  const { tx, plan, ids, anchor, book } = ctx;
  const thisWeek = startOfIsoWeek(anchor);
  const firstWeek = addDays(thisWeek, -28);
  const lastWeek = addDays(thisWeek, 14);
  const workers = plan.people.filter((p) => p.shift && p.kind !== 'upcoming_starter');
  const loc = (p: PlanPerson) => locationOf(currentJob(p, anchor).location);

  // ---- templates -------------------------------------------------------------------------------------------
  const slots = (start: string, end: string, role: string, headcount: number, days = [1, 2, 3, 4, 5]) =>
    days.map((weekday) => ({ weekday, start, end, breakMinutes: 30, role, headcount }));
  await insertRows(
    tx,
    'app.rota_templates',
    [
      {
        name: 'Warehouse earlies',
        location_id: ids.location.MAN,
        department_id: ids.dept.logistics,
        slots: slots('06:00', '14:00', 'Picker', 10),
      },
      {
        name: 'Warehouse lates',
        location_id: ids.location.MAN,
        department_id: ids.dept.logistics,
        slots: slots('14:00', '22:00', 'Picker', 10),
      },
      {
        name: 'Warehouse nights',
        location_id: ids.location.MAN,
        department_id: ids.dept.logistics,
        slots: slots('22:00', '06:00', 'Picker', 10),
      },
      {
        name: 'Transport day',
        location_id: ids.location.MAN,
        department_id: ids.dept.logistics,
        slots: slots('07:00', '15:00', 'Driver', 9),
      },
      {
        name: 'New York support desk',
        location_id: ids.location.NYC,
        department_id: ids.dept.support,
        slots: slots('09:00', '17:30', 'Support desk', 4),
      },
    ],
    { json: ['slots'] },
  );

  // ---- days off: public holidays, company closures, leave and sickness ------------------------------------
  const holidays = new Map<string, Set<string>>();
  const holidaySet = (p: PlanPerson) => {
    const l = loc(p);
    if (!holidays.has(l.key)) {
      const out = new Set<string>();
      for (const y of new Set([firstWeek, lastWeek].map((d) => Number(d.slice(0, 4)))))
        for (const d of book.daysOff(l.country, y, l.regionCode)) out.add(d);
      if (l.entity === 'uk') for (const c of closureDays) out.add(c);
      holidays.set(l.key, out);
    }
    return holidays.get(l.key)!;
  };
  const closureDays = (
    await tx.query<{ d: string }>(
      `SELECT x->>'date' AS d FROM app.company_calendars c, jsonb_array_elements(c.days) x WHERE c.entity_id = $1`,
      [ids.entity.uk],
    )
  ).map((x) => x.d);
  const away = new Map<string, Set<string>>();
  for (const l of await tx.query<{ employee_id: string; start_date: string; end_date: string }>(
    `SELECT employee_id, start_date::text, end_date::text FROM app.leave_requests
      WHERE status IN ('approved', 'pending') AND end_date >= $1 AND start_date <= $2 AND employee_id = ANY($3::uuid[])`,
    [firstWeek, lastWeek, workers.map((p) => ids.employee[p.idx])],
  )) {
    const set = away.get(l.employee_id) ?? new Set<string>();
    for (const d of eachDay(
      l.start_date < firstWeek ? firstWeek : l.start_date,
      l.end_date > addDays(lastWeek, 7) ? addDays(lastWeek, 7) : l.end_date,
    ))
      set.add(d);
    away.set(l.employee_id, set);
  }

  // ---- shifts -----------------------------------------------------------------------------------------------
  type ShiftRow = Record<string, unknown> & {
    id: string;
    employee_id: string | null;
    shift_date: string;
    starts_at: string;
    ends_at: string;
    status: string;
  };
  const shifts: ShiftRow[] = [];
  const shiftKey = new Map<string, ShiftRow>();
  const addShift = (
    p: PlanPerson | null,
    date: string,
    start: string,
    end: string,
    kindLoc: ReturnType<typeof loc>,
    role: string | null,
    notes?: string,
  ) => {
    const tm = shiftTimes(date, start, end, kindLoc.timeZone);
    const weekStart = startOfIsoWeek(date);
    const status = compareDates(weekStart, addDays(thisWeek, 7)) <= 0 ? 'published' : 'draft';
    const row: ShiftRow = {
      id: crypto.randomUUID(),
      employee_id: p ? ids.employee[p.idx]! : null,
      location_id: ids.location[kindLoc.key],
      department_id: p ? ids.dept[p.dept] : ids.dept.logistics,
      role,
      shift_date: date,
      start_local: tm.startLocal,
      end_local: tm.endLocal,
      zone: kindLoc.timeZone,
      starts_at: tm.startsAt,
      ends_at: tm.endsAt,
      break_minutes: 30,
      status,
      published_at: status === 'published' ? `${addDays(weekStart, -10)}T15:00:00Z` : null,
      notes: notes ?? null,
    };
    shifts.push(row);
    if (p) shiftKey.set(`${p.idx}:${date}`, row);
    return row;
  };
  for (const p of workers) {
    const l = loc(p);
    const off = away.get(ids.employee[p.idx]!) ?? new Set<string>();
    const hol = holidaySet(p);
    const casualDays = [2, 4, 6, 3].slice(0, 2 + (p.idx % 2));
    for (const day of eachDay(firstWeek, addDays(lastWeek, 6))) {
      const dow = dayOfWeek(day);
      if (!employedOn(p, day) || off.has(day) || hol.has(day)) continue;
      if (p.casual ? !casualDays.includes(dow) : dow > 5) continue;
      const weekIndex = Math.floor(daysBetween(firstWeek, day) / 7);
      const options = TIMES[p.shift!];
      const [start, end] = p.casual ? options[0]! : options[(weekIndex + p.idx) % options.length]!;
      addShift(p, day, start, end, l, ROLE[currentJob(p, day).title] ?? null);
    }
  }
  // US overtime week: one support specialist covered an extra Saturday two weeks ago
  const usOvertime = workers.find((p) => p.shift === 'us_support');
  if (usOvertime)
    addShift(
      usOvertime,
      addDays(thisWeek, -9),
      '10:00',
      '14:30',
      loc(usOvertime),
      'Support desk',
      'Weekend cover',
    );
  // open shifts next week (Manchester warehouse), one claimed by a team member
  const man = locationOf('MAN');
  const open = [2, 3, 4, 6].map((d) =>
    addShift(
      null,
      addDays(thisWeek, 7 + d - 1),
      '06:00',
      '14:00',
      man,
      'Picker',
      'Extra cover for the seasonal peak',
    ),
  );
  await insertRows(
    tx,
    'app.shifts',
    shifts.map(({ ...s }) => s),
  );
  ctx.counts.shifts = shifts.length;

  // ---- claims and swaps awaiting the manager ---------------------------------------------------------------
  const team = plan.people.filter(
    (p) => p.managerIdx === plan.logins.manager && p.kind === 'roster' && p.login === null && !p.endDate,
  );
  await tx.exec(
    `INSERT INTO app.approval_policies (tenant_id, subject, name, steps)
     SELECT app.current_tenant(), s, n, '[{"approver":{"type":"manager"}}]' FROM (VALUES ('shift.claim', 'Open shift claim'), ('shift.swap', 'Shift swap'), ('timesheet', 'Timesheet approval')) v(s, n)
      WHERE NOT EXISTS (SELECT 1 FROM app.approval_policies p WHERE p.subject = v.s)`,
  );
  // the Saturday open shift: nobody on the weekday rota has a shift that day
  const claimed = open[3]!;
  const claimer = team.find((p) => !shiftKey.has(`${p.idx}:${claimed.shift_date}`));
  if (claimer) {
    const sw = await tx.one<{ id: string }>(
      `INSERT INTO app.shift_swaps (tenant_id, shift_id, from_employee_id, kind, note, created_at) VALUES (app.current_tenant(), $1, $2, 'claim_open', $3, $4) RETURNING id`,
      [claimed.id, ids.employee[claimer.idx], 'Happy to pick this up', `${addDays(anchor, -1)}T12:10:00Z`],
    );
    const approvalId = await requestApproval(tx, 'shift.claim', ids.employee[claimer.idx]!, null, {
      swapId: sw.id,
      shiftId: claimed.id,
      date: claimed.shift_date,
      start: String(claimed.start_local).slice(11),
      end: String(claimed.end_local).slice(11),
    });
    await tx.exec('UPDATE app.shift_swaps SET approval_request_id = $2 WHERE id = $1', [sw.id, approvalId]);
    if (approvalId) await backdateApproval(ctx, approvalId, `${addDays(anchor, -1)}T12:10:00Z`, null);
  }
  const swapDay = addDays(thisWeek, 9);
  const a = team.find((p) => p !== claimer && shiftKey.has(`${p.idx}:${swapDay}`));
  const b =
    team.find((p) => p !== claimer && p !== a && !shiftKey.has(`${p.idx}:${swapDay}`)) ??
    team.find((p) => p !== claimer && p !== a);
  const from = a && shiftKey.get(`${a.idx}:${swapDay}`);
  if (a && b && from && compareDates(from.shift_date, anchor) > 0) {
    const sw = await tx.one<{ id: string }>(
      `INSERT INTO app.shift_swaps (tenant_id, shift_id, from_employee_id, to_employee_id, kind, note, accepted_at, created_at) VALUES (app.current_tenant(), $1, $2, $3, 'swap', $4, $5, $6) RETURNING id`,
      [
        from.id,
        ids.employee[a.idx],
        ids.employee[b.idx],
        'Family commitment that afternoon',
        `${addDays(anchor, -1)}T18:00:00Z`,
        `${addDays(anchor, -2)}T09:00:00Z`,
      ],
    );
    const approvalId = await requestApproval(tx, 'shift.swap', ids.employee[a.idx]!, null, {
      swapId: sw.id,
      shiftId: from.id,
      toShiftId: null,
      toEmployeeId: ids.employee[b.idx],
      date: from.shift_date,
    });
    await tx.exec('UPDATE app.shift_swaps SET approval_request_id = $2 WHERE id = $1', [sw.id, approvalId]);
    if (approvalId) await backdateApproval(ctx, approvalId, `${addDays(anchor, -1)}T18:00:00Z`, null);
  }

  // ---- clock events for every worked shift up to yesterday ----------------------------------------------
  const events: Array<Record<string, unknown>> = [];
  const forgot = workers.find((p) => p.team === 'wh_b' && !p.casual);
  for (const s of shifts) {
    if (!s.employee_id || s.status !== 'published' || compareDates(s.shift_date, anchor) >= 0) continue;
    const p = plan.people[ids.employee.indexOf(s.employee_id)]!;
    const pr = prng(99_000 + p.idx * 400 + daysBetween(firstWeek, s.shift_date));
    const late = pr() < 0.04 ? 17 : 0;
    const stay = pr() < 0.08 ? 45 : Math.floor(pr() * 9);
    const inAt = addMinutes(s.starts_at, -Math.floor(pr() * 7) + late);
    const breakAt = addMinutes(s.starts_at, 240 + Math.floor(pr() * 20) - 10);
    const outAt = addMinutes(s.ends_at, stay);
    const source = p.casual || pr() < 0.2 ? 'pwa' : 'kiosk';
    const zone = String(s.zone);
    const ev = (kind: string, occurred: string) => ({
      employee_id: s.employee_id,
      kind,
      occurred_at: occurred,
      zone,
      source,
      client_event_id: `seed:${p.number}:${s.shift_date}:${kind}`,
      created_at: occurred,
    });
    events.push(
      ev('in', inAt),
      ev('break_start', breakAt),
      ev('break_end', addMinutes(breakAt, 30 + Math.floor(pr() * 3))),
    );
    // someone forgot to clock out yesterday-ish (this week's timesheet shows the open interval)
    if (
      p === forgot &&
      compareDates(s.shift_date, thisWeek) >= 0 &&
      compareDates(s.shift_date, addDays(anchor, -1)) === 0
    )
      continue;
    events.push(ev('out', outAt));
  }
  await insertRows(tx, 'app.clock_events', events);
  ctx.counts.clockEvents = events.length;
  // a manager correction: a clock-out recorded an hour late is replaced (the original stays, superseded)
  const corrected = team[0]
    ? shifts.find(
        (s) =>
          s.employee_id === ids.employee[team[0]!.idx] &&
          compareDates(s.shift_date, addDays(thisWeek, -14)) >= 0 &&
          compareDates(s.shift_date, addDays(thisWeek, -8)) <= 0,
      )
    : undefined;
  if (corrected) {
    const orig = await tx.maybe<{ id: string; occurred_at: string }>(
      `SELECT id, occurred_at FROM app.clock_events WHERE employee_id = $1 AND kind = 'out' AND client_event_id = $2`,
      [corrected.employee_id, `seed:${team[0]!.number}:${corrected.shift_date}:out`],
    );
    if (orig) {
      await tx.exec(`UPDATE app.clock_events SET occurred_at = $2 WHERE id = $1`, [
        orig.id,
        addMinutes(corrected.ends_at, 62),
      ]);
      await insertRows(tx, 'app.clock_events', [
        {
          employee_id: corrected.employee_id,
          kind: 'out',
          occurred_at: addMinutes(corrected.ends_at, 2),
          zone: corrected.zone,
          source: 'manager',
          client_event_id: `seed:${team[0]!.number}:${corrected.shift_date}:out:correction`,
          recorded_by: ids.user.manager,
          reason: 'Clocked out late at the kiosk; left at the end of the shift',
          replaces_event_id: orig.id,
        },
      ]);
    }
  }

  // ---- weekly timesheets (built by the timesheet engine from the clock events and the rota) -------------
  const settings = await timeSettings(tx);
  const submitted: Array<{
    p: PlanPerson;
    id: string;
    week: string;
    worked: number;
    overtime: number;
    violations: number;
  }> = [];
  let timesheets = 0;
  for (const p of workers) {
    const teamOfManager = p.managerIdx === plan.logins.manager;
    for (let w = 4; w >= 1; w--) {
      const week = addDays(thisWeek, -7 * w);
      if (!employedOn(p, addDays(week, 6)) && !employedOn(p, week)) continue;
      const ts = await buildTimesheet(tx, book, ids.employee[p.idx]!, week, settings);
      if (ts.workedMinutes === 0 || ts.openClock) continue;
      const pendingWeek = teamOfManager && w === 1;
      if (pendingWeek && submitted.length >= 5) continue; // the rest of the team has not submitted yet
      const decided = pendingWeek ? null : `${addDays(week, 8 + (p.idx % 2))}T10:00:00Z`;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO app.timesheets (tenant_id, employee_id, week_start, status, regular_minutes, overtime_minutes, double_minutes, scheduled_minutes, worked_minutes, violations, days, sources, time_recording_required, submitted_at, submitted_by, decided_at)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [
          ids.employee[p.idx],
          week,
          pendingWeek ? 'submitted' : 'approved',
          ts.regularMinutes,
          ts.overtimeMinutes,
          ts.doubleMinutes,
          ts.scheduledMinutes,
          ts.workedMinutes,
          JSON.stringify(ts.violations),
          JSON.stringify(ts.days),
          JSON.stringify(ts.sources),
          ts.timeRecordingRequired,
          `${addDays(week, 7)}T08:30:00Z`,
          p.login ? ids.user[p.login] : null,
          decided,
        ],
      );
      timesheets++;
      if (pendingWeek)
        submitted.push({
          p,
          id: row.id,
          week,
          worked: ts.workedMinutes,
          overtime: ts.overtimeMinutes + ts.doubleMinutes,
          violations: ts.violations.length,
        });
    }
  }
  for (const s of submitted) {
    const approvalId = await requestApproval(
      tx,
      'timesheet',
      ids.employee[s.p.idx]!,
      s.p.login ? ids.user[s.p.login] : null,
      {
        timesheetId: s.id,
        weekStart: s.week,
        workedMinutes: s.worked,
        overtimeMinutes: s.overtime,
        violations: s.violations,
      },
    );
    await tx.exec('UPDATE app.timesheets SET approval_request_id = $2 WHERE id = $1', [s.id, approvalId]);
    if (approvalId) await backdateApproval(ctx, approvalId, `${addDays(s.week, 7)}T08:30:00Z`, null);
  }
  ctx.counts.timesheets = timesheets;
  ctx.counts.timesheetsAwaitingManager = submitted.length;
  // payroll exported the oldest approved week (the export record and checksum the export route writes)
  const exportWeek = addDays(thisWeek, -28);
  const rows = await tx.query<{
    id: string;
    employee_number: string;
    display_name: string;
    week_start: string;
    worked_minutes: number;
    scheduled_minutes: number;
    regular_minutes: number;
    overtime_minutes: number;
    double_minutes: number;
    violations: unknown[];
    decided_at: string;
  }>(
    `SELECT t.*, e.employee_number, e.display_name FROM app.timesheets t JOIN app.employees e ON e.tenant_id = t.tenant_id AND e.id = t.employee_id
      WHERE t.week_start = $1 AND t.status = 'approved' ORDER BY e.employee_number`,
    [exportWeek],
  );
  if (rows.length) {
    const csv = timesheetCsv(
      rows.map((x) => ({
        employeeNumber: x.employee_number,
        name: x.display_name,
        weekStart: x.week_start,
        worked: x.worked_minutes,
        scheduled: x.scheduled_minutes,
        regular: x.regular_minutes,
        overtime: x.overtime_minutes,
        double: x.double_minutes,
        violations: x.violations.length,
        approvedAt: x.decided_at,
      })),
    );
    const checksum = createHash('sha256').update(csv).digest('hex');
    const exportedAt = `${addDays(exportWeek, 10)}T14:00:00Z`;
    const exp = await tx.one<{ id: string }>(
      `INSERT INTO app.timesheet_exports (tenant_id, week_start, row_count, checksum, created_by, created_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
      [exportWeek, rows.length, checksum, ids.user.payroll_admin, exportedAt],
    );
    await tx.exec(`UPDATE app.timesheets SET exported_at = $2 WHERE id = ANY($1::uuid[])`, [
      rows.map((x) => x.id),
      exportedAt,
    ]);
    await writeAudit(tx, {
      actorType: 'system',
      action: 'timesheets.exported',
      targetType: 'timesheet_export',
      targetId: exp.id,
      diff: { weekStart: exportWeek, rows: rows.length, checksum },
    });
  }

  // ---- working-time opt-outs and availability ------------------------------------------------------------
  const optRule = book.resolve<{ defaultTerminationNoticeDays: number }>(
    'GB',
    'working_time.opt_out',
    anchor,
  ).value;
  const optOuts = plan.people.filter((p) => p.optOut && p.kind === 'roster');
  await insertRows(
    tx,
    'app.working_time_opt_outs',
    optOuts.map((p, i) => ({
      employee_id: ids.employee[p.idx],
      valid_from: addDays(p.startDate, 7),
      // one worker has given notice to end the opt-out (the notice period from the GB pack)
      valid_to: i === 0 ? addDays(anchor, -3 + optRule.defaultTerminationNoticeDays) : null,
      notice_days: optRule.defaultTerminationNoticeDays,
      notice_given_on: i === 0 ? addDays(anchor, -3) : null,
    })),
  );
  const casuals = plan.people.filter((p) => p.casual);
  await insertRows(tx, 'app.availability', [
    ...casuals.slice(0, 2).map((p) => ({
      employee_id: ids.employee[p.idx],
      weekday: 1,
      on_date: null,
      available: false,
      from_time: null,
      to_time: null,
      note: 'College on Mondays',
    })),
    ...casuals.map((p) => ({
      employee_id: ids.employee[p.idx],
      weekday: 6,
      on_date: null,
      available: true,
      from_time: '06:00',
      to_time: '14:00',
      note: 'Prefers Saturday earlies',
    })),
    ...casuals.slice(0, 1).map((p) => ({
      employee_id: ids.employee[p.idx],
      weekday: null,
      on_date: addDays(thisWeek, 11),
      available: false,
      from_time: null,
      to_time: null,
      note: 'Appointment',
    })),
  ]);
  ctx.counts.optOuts = optOuts.length;
}
