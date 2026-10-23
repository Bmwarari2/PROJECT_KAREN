import {
  addDays,
  compareDates,
  dateParts,
  dayOfWeek,
  daysBetween,
  makeDate,
  maxDate,
  minDate,
} from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import { createTask } from '../../../lib/notify';
import { decide, requestApproval } from '../../../modules/approvals/service';
import { computeBalance, dailyHours, requestAmount, type LeavePolicy } from '../../../modules/leave/engine';
import { ensureLeaveDefaults } from '../../../modules/leave/service';
import { prng } from '../../fixtures';
import { bump, insertRows, type SeedCtx } from '../context';
import { currentJob, employedOn, locationOf, type PlanPerson } from '../plan';

/** Company leave and absence settings, and a year and a half of leave and sickness history. */

const at = (date: string, hhmm = '09:30') => `${date}T${hhmm}:00Z`;

export interface LeavePolicyRow {
  id: string;
  config: LeavePolicy;
  entity_id: string | null;
  country: string | null;
}

/** Policy each person's annual leave comes from (assignments first, as policyFor resolves them). */
export function annualPolicyKey(p: PlanPerson): 'senior' | 'uk' | 'ie' | 'us' | 'irregular' {
  if (p.casual) return 'irregular';
  if (p.entity === 'ie') return 'ie';
  if (p.entity === 'us') return 'us';
  return p.level === 'exec' || /^Head of|General counsel/.test(p.jobs.at(-1)!.title) ? 'senior' : 'uk';
}

export async function seedLeave(ctx: SeedCtx) {
  const { tx, book, plan, ids, anchor } = ctx;
  // ---- types and policies -----------------------------------------------------------------------------
  await ensureLeaveDefaults(tx, book); // leave types + the UK statutory-minimum policy from the GB pack
  await insertRows(tx, 'app.leave_types', [
    {
      key: 'compassionate',
      name: { 'en-GB': 'Compassionate leave', 'en-US': 'Bereavement leave' },
      category: 'other',
      paid: true,
      requires_approval: true,
      deducts_balance: false,
    },
  ]);
  for (const t of await tx.query<{ id: string; key: string }>('SELECT id, key FROM app.leave_types'))
    ids.leaveType[t.key] = t.id;
  const uk = await tx.one<LeavePolicyRow>(
    `SELECT id, config, entity_id, country FROM app.leave_policies WHERE leave_type_id = $1 ORDER BY created_at LIMIT 1`,
    [ids.leaveType.annual],
  );
  const ieMin = book.resolve<{ maxWorkingWeeks: number }>(
    'IE',
    'leave.statutory_annual_minimum',
    anchor,
  ).value;
  const irregular = book.resolve<{ accrualPercentOfHoursWorked: number; capDays: number }>(
    'GB',
    'leave.irregular_hours_accrual',
    anchor,
  ).value;
  const base = { ...uk.config, carryOver: { maxDays: 5, expiresAfterMonths: 3 } };
  // Policies only reached through an assignment have no entity or country, so the default for an
  // employee (policyFor: entity, then country, then the oldest) stays the statutory one; created_at
  // records when the company introduced each policy, which keeps that order deterministic.
  const policies: Record<
    string,
    { name: string; config: LeavePolicy; entity: string | null; country: string | null; since: string }
  > = {
    // Ireland: the statutory minimum from the IE pack plus three company days; public holidays are on top
    ie: {
      name: `Ireland annual leave (${ieMin.maxWorkingWeeks * 5 + 3} days)`,
      config: {
        ...base,
        accrual: { method: 'annual_upfront', days: ieMin.maxWorkingWeeks * 5 + 3 },
        includesPublicHolidays: false,
      },
      entity: ids.entity.ie,
      country: 'IE',
      since: '2019-01-07',
    },
    // United States: no federal minimum (US pack), so this is company policy
    us: {
      name: 'US paid time off (15 days)',
      config: { ...base, accrual: { method: 'annual_upfront', days: 15 }, includesPublicHolidays: false },
      entity: ids.entity.us,
      country: 'US',
      since: '2024-03-04',
    },
    senior: {
      name: 'Senior leadership annual leave (33 days)',
      config: { ...uk.config, accrual: { method: 'annual_upfront', days: 33 } },
      entity: null,
      country: null,
      since: '2016-01-04',
    },
    // irregular-hours and part-year workers: accrual percentage from the GB pack (in hours)
    irregular: {
      name: `Irregular hours (${irregular.accrualPercentOfHoursWorked}% of hours worked)`,
      config: {
        accrual: { method: 'per_hour_worked', percent: irregular.accrualPercentOfHoursWorked },
        unit: 'hours',
        yearStart: '01-01',
        proRata: false,
        includesPublicHolidays: false,
        waitingDays: 0,
        allowNegativeDays: 0,
        rounding: 'none',
      },
      entity: null,
      country: null,
      since: '2024-04-01',
    },
  };
  const policyId: Record<string, string> = { uk: uk.id };
  const policyConfig: Record<string, LeavePolicy> = { uk: uk.config };
  // the statutory default (and time off in lieu) have applied since the company started
  await tx.exec(`UPDATE app.leave_policies SET created_at = '2012-03-05T09:00:00Z'`);
  for (const [key, p] of Object.entries(policies)) {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, entity_id, country, config, created_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [p.name, ids.leaveType.annual, p.entity, p.country, JSON.stringify(p.config), `${p.since}T09:00:00Z`],
    );
    policyId[key] = row.id;
    policyConfig[key] = p.config;
  }
  // assignments: the senior policy for executives and heads of department, irregular hours for casual workers
  await insertRows(
    tx,
    'app.leave_policy_assignments',
    plan.people
      .filter((p) => ['senior', 'irregular'].includes(annualPolicyKey(p)))
      .map((p) => ({
        employee_id: ids.employee[p.idx],
        policy_id: policyId[annualPolicyKey(p)],
        leave_type_id: ids.leaveType.annual,
        valid_from: p.startDate,
        valid_to: p.endDate ? addDays(p.endDate, 1) : null,
      })),
  );
  // company closure days (public holidays come from the packs)
  const { year } = dateParts(anchor);
  const closures = (y: number) => [{ date: makeDate(y, 12, 24), name: 'Christmas Eve (company closure)' }];
  await insertRows(
    tx,
    'app.company_calendars',
    [
      {
        name: 'UK company closure days',
        entity_id: ids.entity.uk,
        days: [year - 1, year, year + 1].flatMap(closures),
      },
      {
        name: 'Ireland company closure days',
        entity_id: ids.entity.ie,
        days: [year - 1, year, year + 1].flatMap(closures),
      },
    ],
    { json: ['days'] },
  );
  await insertRows(tx, 'app.cover_rules', [
    {
      name: 'Manchester warehouse minimum cover',
      department_id: ids.dept.logistics,
      location_id: ids.location.MAN,
      min_present: 50,
      enforcement: 'warn',
    },
    {
      name: 'Edinburgh support desk cover',
      department_id: ids.dept.support,
      location_id: ids.location.EDI,
      min_present: 18,
      enforcement: 'warn',
    },
  ]);
  await insertRows(tx, 'app.absence_triggers', [
    {
      name: 'Bradford factor review',
      bradford_threshold: 100,
      spells_threshold: 4,
      window_days: 365,
      notify_role: 'hr_admin',
      notify_manager: true,
    },
  ]);

  // ---- helpers ---------------------------------------------------------------------------------------
  const holidayCache = new Map<string, string[]>();
  const holidaysFor = (p: PlanPerson) => {
    const loc = locationOf(currentJob(p, anchor).location);
    const key = `${loc.key}`;
    if (!holidayCache.has(key)) {
      const out = new Set<string>();
      for (let y = year - 2; y <= year + 1; y++)
        for (const d of book.daysOff(loc.country, y, loc.regionCode)) out.add(d);
      if (loc.entity !== 'us')
        for (let y = year - 1; y <= year + 1; y++) for (const c of closures(y)) out.add(c.date);
      holidayCache.set(key, [...out].sort());
    }
    return holidayCache.get(key)!;
  };
  const patternOf = (p: PlanPerson, date: string) => {
    const j = currentJob(p, date);
    return j.pattern ?? dailyHours(j.weeklyHours ?? 37.5 * j.fte, 5);
  };
  // blocked dates per person (leave, sickness and family leave never overlap)
  const busy = new Map<number, Array<[string, string]>>();
  const free = (p: PlanPerson, s: string, e: string) =>
    !(busy.get(p.idx) ?? []).some(([a, b]) => compareDates(s, b) <= 0 && compareDates(e, a) >= 0);
  const occupy = (p: PlanPerson, s: string, e: string) =>
    busy.set(p.idx, [...(busy.get(p.idx) ?? []), [s, e]]);
  /** End date after `n` of the person's working days from `start` (holidays skipped). */
  const spanEnd = (p: PlanPerson, start: string, n: number) => {
    const pat = patternOf(p, start);
    const hol = new Set(holidaysFor(p));
    let d = start;
    let k = 0;
    for (let guard = 0; guard < 60; guard++) {
      if (pat[dayOfWeek(d) as 1] > 0 && !hol.has(d)) k++;
      if (k >= n) return d;
      d = addDays(d, 1);
    }
    return d;
  };
  const amount = (
    p: PlanPerson,
    s: string,
    e: string,
    half?: { startHalf?: 'am' | 'pm'; endHalf?: 'am' | 'pm' },
  ) => requestAmount({ start: s, end: e, pattern: patternOf(p, s), holidays: holidaysFor(p), ...half });

  interface Req {
    p: PlanPerson;
    type: string;
    start: string;
    end: string;
    startHalf?: 'am' | 'pm';
    endHalf?: 'am' | 'pm';
    days: number;
    hours: number;
    status: 'approved' | 'pending' | 'rejected' | 'cancelled';
    note?: string;
    flow?: 'pending' | 'approve' | 'reject';
    decidedBy?: string;
  }
  const reqs: Req[] = [];
  const add = (q: Omit<Req, 'days' | 'hours'>) => {
    const a = amount(q.p, q.start, q.end, { startHalf: q.startHalf, endHalf: q.endHalf });
    if (a.days <= 0 || !free(q.p, q.start, q.end)) return undefined;
    const full = { ...q, days: a.days, hours: a.hours };
    reqs.push(full);
    if (q.status !== 'rejected' && q.status !== 'cancelled') occupy(q.p, q.start, q.end);
    return full;
  };

  // ---- family leave, special leave and sickness first (they shape the annual leave around them) -------
  const roster = plan.people.filter((p) => p.kind === 'roster' && !p.login);
  const maternity = roster.find((p) => p.sex === 'female' && p.team === 'design' && p.level === 'member');
  if (maternity)
    add({
      p: maternity,
      type: 'family',
      start: addDays(anchor, -75),
      end: addDays(anchor, 190),
      status: 'approved',
      note: 'Maternity leave',
    });
  const paternity = roster.find((p) => p.sex === 'male' && p.team === 'web' && p.level === 'member');
  if (paternity) {
    const s = maxDate(addDays(anchor, -140), paternity.startDate);
    add({
      p: paternity,
      type: 'family',
      start: s,
      end: spanEnd(paternity, s, 10),
      status: 'approved',
      note: 'Paternity leave',
    });
  }
  for (const [i, p] of roster
    .filter((x) => x.team === 'finance' || x.team === 'ops_lon')
    .slice(0, 2)
    .entries()) {
    const s = addDays(anchor, -200 + i * 40);
    if (dayOfWeek(s) < 6)
      add({
        p,
        type: 'unpaid',
        start: s,
        end: spanEnd(p, s, 3),
        status: 'approved',
        note: 'Unpaid leave: house move',
      });
  }
  const comp = roster.find((p) => p.team === 'sales_acc' && p.level === 'member');
  if (comp) {
    const s = addDays(anchor, -90 + ((7 - dayOfWeek(addDays(anchor, -90))) % 7) + 1);
    add({ p: comp, type: 'compassionate', start: s, end: spanEnd(comp, s, 2), status: 'approved' });
  }
  await seedSickness(ctx, { add, spanEnd, free, occupy, roster, patternOf, holidaysFor });

  // ---- annual leave: last year and this year, within each person's balance ---------------------------
  const managerTeam = plan.people.filter((p) => p.managerIdx === plan.logins.manager && p.kind === 'roster');
  let otherPending = 0;
  const windows = (y: number): Array<[from: string, to: string, min: number, max: number]> => [
    [makeDate(y, 1, 12), makeDate(y, 3, 27), 1, 3],
    [makeDate(y, 4, 13), makeDate(y, 6, 19), 3, 5],
    [makeDate(y, 7, 6), makeDate(y, 8, 28), 5, 10],
    [makeDate(y, 9, 14), makeDate(y, 11, 20), 1, 3],
    [makeDate(y, 12, 14), makeDate(y, 12, 21), 2, 3],
  ];
  for (const p of plan.people) {
    if (p.kind === 'upcoming_starter' || p.casual) continue;
    const key = annualPolicyKey(p);
    const config = policyConfig[key]!;
    const pr = prng(91_000 + p.idx);
    const inTeam = managerTeam.includes(p);
    for (const y of [year - 1, year]) {
      const ys = makeDate(y, 1, 1);
      const ye = makeDate(y, 12, 31);
      if (!employedOn(p, ye) && !(p.endDate && compareDates(p.endDate, ys) >= 0)) continue;
      if (compareDates(p.startDate, ye) > 0) continue;
      const target = y < year ? 0.85 + pr() * 0.15 : 0.8 + pr() * 0.15;
      // the year's balance before any annual leave (computed once; each booking then draws it down)
      const pot = computeBalance({
        policy: config,
        employee: { startDate: p.startDate, endDate: p.endDate, fte: currentJob(p, ye).fte },
        year: y,
        asOf: ye,
        pattern: patternOf(p, ys),
        holidays: holidaysFor(p),
        requests: [],
        adjustments: [],
        carriedIn: 0,
      }).available;
      let left = pot;
      for (const [from, to, min, max] of windows(y)) {
        const lo = maxDate(from, p.startDate);
        const hi = p.endDate ? minDate(to, addDays(p.endDate, -1)) : to;
        if (compareDates(lo, hi) >= 0) continue;
        const start = (() => {
          let d = addDays(lo, Math.floor(pr() * Math.max(1, daysBetween(lo, hi))));
          while (dayOfWeek(d) !== 1 && pr() < 0.7) d = addDays(d, 1);
          return d;
        })();
        const n = min + Math.floor(pr() * (max - min + 1));
        const halfDay = n === 1 && pr() < 0.25;
        const end = halfDay ? start : spanEnd(p, start, n);
        if ((p.endDate && compareDates(end, p.endDate) > 0) || compareDates(end, ye) > 0) continue;
        const a = amount(p, start, end, halfDay ? { startHalf: 'pm' } : undefined);
        if (a.days <= 0 || left - a.days < pot * (1 - target)) continue;
        const past = compareDates(end, anchor) < 0;
        const future = compareDates(start, anchor) > 0;
        let status: Req['status'] = 'approved';
        let flow: Req['flow'];
        if (past && pr() < 0.03) status = 'cancelled';
        if (future) {
          const pending = inTeam
            ? !reqs.some((q) => q.p === p && q.flow === 'pending')
            : otherPending < 12 && pr() < 0.12;
          if (pending) {
            status = 'pending';
            flow = 'pending';
            if (!inTeam) otherPending++;
          } else if (inTeam) flow = 'approve';
        } else if (inTeam && compareDates(start, addDays(anchor, -75)) > 0) flow = 'approve';
        const booked = add({
          p,
          type: 'annual',
          start,
          end,
          ...(halfDay ? { startHalf: 'pm' as const } : {}),
          status,
          flow,
        });
        if (booked && status !== 'cancelled') left -= booked.days;
      }
    }
  }
  // one request the manager turned down (peak season)
  const declined = managerTeam.find((p) => p.login === null);
  if (declined) {
    const s = addDays(anchor, -40 + ((8 - dayOfWeek(addDays(anchor, -40))) % 7));
    add({
      p: declined,
      type: 'annual',
      start: s,
      end: spanEnd(declined, s, 3),
      status: 'pending',
      flow: 'reject',
      note: 'Short notice: peak season',
    });
  }
  // TOIL: earned by the Manchester team leaders for weekend cover, some of it already taken
  const leads = plan.people.filter((p) => p.level === 'lead' && currentJob(p, anchor).location === 'MAN');
  const adjustments: Array<Record<string, unknown>> = [];
  for (const [i, p] of leads.entries()) {
    adjustments.push({
      employee_id: ids.employee[p.idx],
      leave_type_id: ids.leaveType.toil,
      amount: i % 2 ? 1.5 : 1,
      kind: 'toil',
      effective_date: addDays(anchor, -120 + i * 9),
      reason: 'Weekend stocktake cover',
    });
    if (i < 3) {
      const s = addDays(anchor, -60 + i * 11);
      if (dayOfWeek(s) < 6)
        add({ p, type: 'toil', start: s, end: s, status: 'approved', note: 'Time off in lieu' });
    }
  }
  // long-service award days (company policy)
  for (const p of plan.people
    .filter((x) => x.kind === 'roster' && compareDates(x.startDate, addDays(anchor, -3650)) < 0 && !x.casual)
    .slice(0, 6))
    adjustments.push({
      employee_id: ids.employee[p.idx],
      leave_type_id: ids.leaveType.annual,
      amount: 1,
      kind: 'manual',
      effective_date: makeDate(year, 1, 1),
      reason: 'Long-service award: ten years',
    });
  await insertRows(tx, 'app.leave_adjustments', adjustments);
  ctx.counts.leaveAdjustments = adjustments.length;

  // ---- write: history in bulk; the manager's team and pending requests through the approval flow -------
  const user = (p: PlanPerson) => (p.login ? ids.user[p.login] : null);
  const direct = reqs.filter((q) => !q.flow);
  await insertRows(
    tx,
    'app.leave_requests',
    direct.map((q) => ({
      employee_id: ids.employee[q.p.idx],
      leave_type_id: ids.leaveType[q.type],
      start_date: q.start,
      end_date: q.end,
      start_half: q.startHalf ?? null,
      end_half: q.endHalf ?? null,
      amount_days: q.days,
      amount_hours: q.hours,
      status: q.status,
      note: q.note ?? null,
      requested_by: user(q.p),
      decided_at:
        q.status === 'pending' ? null : at(minDate(addDays(q.start, -10), addDays(anchor, -1)), '10:15'),
      created_at: at(minDate(addDays(q.start, -12 - (q.p.idx % 20)), addDays(anchor, -1))),
    })),
  );
  await tx.exec(
    `INSERT INTO app.approval_policies (tenant_id, subject, name, steps) SELECT app.current_tenant(), 'leave.request', 'Leave approval', '[{"approver":{"type":"manager"}}]'
      WHERE NOT EXISTS (SELECT 1 FROM app.approval_policies WHERE subject = 'leave.request')`,
  );
  const managerUser = ids.user.manager;
  for (const q of reqs.filter((x) => x.flow)) {
    const lr = await tx.one<{ id: string }>(
      `INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, start_half, end_half, amount_days, amount_hours, note, requested_by, status)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') RETURNING id`,
      [
        ids.employee[q.p.idx],
        ids.leaveType[q.type],
        q.start,
        q.end,
        q.startHalf ?? null,
        q.endHalf ?? null,
        q.days,
        q.hours,
        q.note ?? null,
        user(q.p),
      ],
    );
    const approvalId = await requestApproval(tx, 'leave.request', ids.employee[q.p.idx]!, user(q.p), {
      leaveRequestId: lr.id,
      leaveType: q.type,
      startDate: q.start,
      endDate: q.end,
      amountDays: q.days,
    });
    await tx.exec('UPDATE app.leave_requests SET approval_request_id = $2 WHERE id = $1', [
      lr.id,
      approvalId,
    ]);
    const created = at(minDate(addDays(q.start, -14), addDays(anchor, -1 - (q.p.idx % 4))));
    if (q.flow !== 'pending' && approvalId) {
      const approver = q.p.managerIdx === plan.logins.manager ? managerUser : ids.user.hr_admin;
      await decide(
        tx,
        approvalId,
        approver,
        q.flow === 'approve' ? 'approve' : 'reject',
        q.flow === 'reject' ? q.note : undefined,
      );
      await backdateApproval(
        ctx,
        approvalId,
        created,
        at(minDate(addDays(q.start, -12), addDays(anchor, -1)), '11:05'),
      );
    } else if (approvalId) await backdateApproval(ctx, approvalId, created, null);
    await tx.exec('UPDATE app.leave_requests SET created_at = $2 WHERE id = $1', [lr.id, created]);
    bump(ctx, q.flow === 'pending' ? 'leavePending' : 'leaveDecidedInApp');
  }
  ctx.counts.leaveRequests = reqs.length;
}

/** Moves the timestamps of a seeded approval (and its tasks and notifications) to when it happened. */
export async function backdateApproval(
  ctx: SeedCtx,
  approvalId: string,
  createdAt: string,
  decidedAt: string | null,
) {
  const { tx } = ctx;
  await tx.exec(
    `UPDATE app.approval_requests SET created_at = $2, decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE id = $1`,
    [approvalId, createdAt, decidedAt ?? createdAt],
  );
  if (decidedAt) {
    await tx.exec(
      `UPDATE app.approval_steps SET decided_at = $2 WHERE request_id = $1 AND decided_at IS NOT NULL`,
      [approvalId, decidedAt],
    );
    await tx.exec(
      `UPDATE app.tasks SET created_at = $2, completed_at = $3 WHERE source = 'approval' AND source_id = $1`,
      [approvalId, createdAt, decidedAt],
    );
  } else
    await tx.exec(`UPDATE app.tasks SET created_at = $2 WHERE source = 'approval' AND source_id = $1`, [
      approvalId,
      createdAt,
    ]);
  await tx.exec(
    `UPDATE app.notifications SET created_at = $2, read_at = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE $3::timestamptz END
      WHERE dedupe_key = ANY($1::text[])`,
    [[`appr:${approvalId}:0`, `appr:${approvalId}:1`, `appr-done:${approvalId}`], createdAt, decidedAt],
  );
}

type Helpers = {
  add: (q: {
    p: PlanPerson;
    type: string;
    start: string;
    end: string;
    status: 'approved';
    note?: string;
  }) => { days: number; hours: number } | undefined;
  spanEnd: (p: PlanPerson, start: string, n: number) => string;
  free: (p: PlanPerson, s: string, e: string) => boolean;
  occupy: (p: PlanPerson, s: string, e: string) => void;
  roster: PlanPerson[];
  patternOf: (p: PlanPerson, date: string) => Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>;
  holidaysFor: (p: PlanPerson) => string[];
};

const REASONS = [
  'Seasonal flu',
  'Migraine',
  'Back strain',
  'Stomach bug',
  'Heavy cold',
  'Dental procedure',
  'Sprained ankle',
];

/**
 * Sickness the way `POST /v1/sickness` records it: an approved sickness leave request, the sickness record
 * (fit note required after the company's threshold; return-to-work due) and the reason sealed in the vault.
 */
async function seedSickness(ctx: SeedCtx, h: Helpers) {
  const { tx, plan, ids, anchor } = ctx;
  const r = prng(424_244);
  const fitNoteAfter = 7; // the tenant's absence setting (company policy), written at provisioning
  const spells: Array<{ p: PlanPerson; start: string; end: string | null; reason: string }> = [];
  const team = plan.people.filter(
    (p) => p.managerIdx === plan.logins.manager && p.kind === 'roster' && !p.recentStarter,
  );
  // one person in the manager's team with frequent short spells (crosses the Bradford factor trigger)
  const frequent = team.find((p) => p.login === null && !p.casual);
  if (frequent)
    for (const back of [300, 210, 130, 70, 20]) {
      const s = addDays(anchor, -back);
      if (dayOfWeek(s) < 6)
        spells.push({
          p: frequent,
          start: s,
          end: h.spanEnd(frequent, s, back === 130 ? 2 : 1),
          reason: pick(r, REASONS),
        });
    }
  const pool = h.roster.filter(
    (p) => p !== frequent && !p.casual && compareDates(p.startDate, addDays(anchor, -200)) < 0,
  );
  for (let i = 0; i < 26 && pool.length; i++) {
    const p = pool[Math.floor(r() * pool.length)]!;
    const s = addDays(anchor, -Math.floor(10 + r() * 330));
    if (dayOfWeek(s) >= 6 || compareDates(s, p.startDate) < 0) continue;
    const long = i < 2;
    spells.push({
      p,
      start: s,
      end: h.spanEnd(p, s, long ? 9 : 1 + Math.floor(r() * 3)),
      reason: long ? 'Recovering from minor surgery' : pick(r, REASONS),
    });
  }
  // the employee login was off sick recently (their manager has a return-to-work conversation to hold)
  const emp = plan.people[plan.logins.employee]!;
  const empStart = addDays(anchor, -9 + ((8 - dayOfWeek(addDays(anchor, -9))) % 7));
  spells.push({ p: emp, start: empStart, end: h.spanEnd(emp, empStart, 2), reason: 'Heavy cold' });
  // someone is off sick today with no end date yet
  const today = pool.find((p) => p.team === 'support_edi_1' && p.level === 'member');
  if (today) spells.push({ p: today, start: addDays(anchor, -2), end: null, reason: 'Back strain' });

  const managerUserOf = (p: PlanPerson) => {
    const m = p.managerIdx === null ? null : plan.people[p.managerIdx]!;
    return m?.login ? ids.user[m.login] : null;
  };
  let n = 0;
  for (const sp of spells) {
    const end = sp.end ?? sp.start;
    if (!h.free(sp.p, sp.start, end)) continue;
    const a = requestAmount({
      start: sp.start,
      end,
      pattern: h.patternOf(sp.p, sp.start),
      holidays: h.holidaysFor(sp.p),
    });
    if (a.days <= 0) continue;
    h.occupy(sp.p, sp.start, end);
    const employeeId = ids.employee[sp.p.idx]!;
    const recorded = at(sp.start, '08:40');
    const lr = await tx.one<{ id: string }>(
      `INSERT INTO app.leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, amount_days, amount_hours, status, decided_at, created_at)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 'approved', $7, $7) RETURNING id`,
      [employeeId, ids.leaveType.sickness, sp.start, end, a.days, a.hours, recorded],
    );
    const fitNoteRequired = !!sp.end && daysBetween(sp.start, sp.end) + 1 > fitNoteAfter;
    const recent = sp.end && compareDates(sp.end, addDays(anchor, -14)) > 0;
    const rtw = !sp.end ? 'not_required' : recent ? 'due' : 'completed';
    const rec = await tx.one<{ id: string }>(
      `INSERT INTO app.sickness_records (tenant_id, employee_id, start_date, end_date, leave_request_id, fit_note_required, rtw_status, created_at)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [employeeId, sp.start, sp.end, lr.id, fitNoteRequired, rtw, recorded],
    );
    const target = { employeeId, managerChain: [] as string[] };
    const vid = await ctx.vault.put(
      tx,
      ctx.system,
      ctx.tenantId,
      target,
      'sickness',
      `reason:${rec.id}`,
      sp.reason,
    );
    await tx.exec('UPDATE app.sickness_records SET reason_vault_id = $2 WHERE id = $1', [rec.id, vid]);
    const manager = managerUserOf(sp.p);
    if (manager && sp.end && rtw === 'due')
      await createTask(tx, {
        source: 'manual',
        title: 'Return-to-work conversation',
        subjectEmployeeId: employeeId,
        assigneeUserId: manager,
        dueOn: addDays(sp.end, 2),
        link: '/app/absence',
        dedupeKey: `rtw:${rec.id}`,
      });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'sickness.recorded',
      targetType: 'sickness_record',
      targetId: rec.id,
      diff: { employeeId, start: sp.start, end: sp.end, fitNoteRequired },
      sensitive: true,
    });
    n++;
  }
  ctx.counts.sicknessRecords = n;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
