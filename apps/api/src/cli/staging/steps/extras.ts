import { createHash } from 'node:crypto';
import { addDays, addMonths, compareDates } from '@thapsus/core/time';
import { breachDeadlines } from '@thapsus/rules';
import { writeAudit } from '@thapsus/db';
import { requestApproval } from '../../../modules/approvals/service';
import { deadlineColumns, resolveSubject } from '../../../modules/privacy/dsr';
import { insertRows, seedUuid, type SeedCtx } from '../context';
import { currentPay } from '../plan';
import { backdateApproval } from './leave';
import { raiseHrRequest } from '../../../modules/workflows/hr-requests';

/**
 * Approvals that need a decision from the admin logins, saved and scheduled reports, and privacy operations
 * (data subject requests with deadlines from the packs, a legal hold, a closed breach with its deadlines).
 */
export async function seedApprovalsReportsPrivacy(ctx: SeedCtx) {
  const { tx, plan, ids, anchor, book } = ctx;
  // ---- approvals: pay changes need the payroll admin; personal-detail changes need HR ----------------------
  await insertRows(
    tx,
    'app.approval_policies',
    [
      {
        subject: 'employee.change',
        name: 'Pay change approval',
        condition: { field: 'payAmountMinor', op: 'present' },
        steps: [{ approver: { type: 'role', value: 'payroll_admin' } }],
        priority: 10,
      },
      {
        subject: 'employee.self_change',
        name: 'Personal details change',
        condition: null,
        steps: [{ approver: { type: 'role', value: 'hr_admin' } }],
        priority: 100,
      },
    ],
    { json: ['steps', 'condition'] },
  );
  const raise = plan.people.find(
    (p) =>
      p.team === 'data' &&
      p.level === 'member' &&
      p.kind === 'roster' &&
      !plan.futureChanges.some((c) => c.personIdx === p.idx),
  );
  if (raise) {
    const pay = currentPay(raise, anchor);
    const payload = {
      effectiveDate: plan.nextMonth,
      payAmountMinor: Math.round((pay.amountMinor * 1.06) / 10000) * 10000,
      payCurrency: raise.currency,
      payFrequency: pay.frequency,
      reason: 'Market adjustment',
    };
    const id = await requestApproval(
      tx,
      'employee.change',
      ids.employee[raise.idx]!,
      ids.user.hr_admin,
      payload,
    );
    if (id) {
      await backdateApproval(ctx, id, `${addDays(anchor, -2)}T14:20:00Z`, null);
      await writeAudit(tx, {
        actorType: 'system',
        action: 'employee.change_requested',
        targetType: 'employee',
        targetId: ids.employee[raise.idx],
        diff: {
          approvalRequestId: id,
          effectiveDate: payload.effectiveDate,
          fields: ['payAmountMinor', 'payCurrency', 'payFrequency'],
        },
      });
    }
  }
  const emp = plan.people[plan.logins.employee]!;
  const selfChange = await requestApproval(
    tx,
    'employee.self_change',
    ids.employee[emp.idx]!,
    ids.user.employee,
    {
      effectiveDate: anchor,
      legalLastName: `${emp.last}-Specimen`,
      reason: 'Name change after marriage',
    },
  );
  if (selfChange) await backdateApproval(ctx, selfChange, `${addDays(anchor, -1)}T20:05:00Z`, null);

  // ---- Contact HR (ADR-0163): the employee login asked HR two things; one is answered, one is waiting ----
  const empId = ids.employee[emp.idx]!;
  const answered = await raiseHrRequest(
    tx,
    empId,
    'Can I carry over holiday into next year?',
    'I have three days left and a family trip planned for January. Fictional request for the staging workspace.',
    ids.user.employee,
  );
  await tx.exec(
    `UPDATE app.tasks SET created_at = $2, status = 'done', completed_at = $3, completed_by = $4 WHERE id = $1`,
    [answered, `${addDays(anchor, -12)}T10:15:00Z`, `${addDays(anchor, -11)}T09:30:00Z`, ids.user.hr_admin],
  );
  await tx.exec(`UPDATE app.notifications SET created_at = $2, read_at = $3 WHERE dedupe_key = $1`, [
    `hr-request:${answered}`,
    `${addDays(anchor, -12)}T10:15:00Z`,
    `${addDays(anchor, -11)}T09:25:00Z`,
  ]);
  const waiting = await raiseHrRequest(
    tx,
    empId,
    'Update to my bank details',
    'I have moved bank and need to give payroll my new account. Who should I send it to? Fictional request.',
    ids.user.employee,
  );
  await tx.exec('UPDATE app.tasks SET created_at = $2 WHERE id = $1', [
    waiting,
    `${addDays(anchor, -1)}T16:40:00Z`,
  ]);
  await tx.exec('UPDATE app.notifications SET created_at = $2 WHERE dedupe_key = $1', [
    `hr-request:${waiting}`,
    `${addDays(anchor, -1)}T16:40:00Z`,
  ]);
  ctx.counts.hrRequests = 2;

  // ---- reports ------------------------------------------------------------------------------------------
  const saved = [
    {
      name: 'Headcount by legal entity',
      report: 'headcount',
      params: { groupBy: 'entity' },
      relative: 'today',
      owner: ids.user.hr_admin,
      shared: true,
    },
    {
      name: 'Turnover this year by department',
      report: 'turnover',
      params: { groupBy: 'department' },
      relative: 'yearToDate',
      owner: ids.user.hr_admin,
      shared: true,
    },
    {
      name: 'Absence last month',
      report: 'absence',
      params: { groupBy: 'type' },
      relative: 'previousMonth',
      owner: ids.user.hr_admin,
      shared: false,
    },
    {
      name: 'Holiday liability',
      report: 'holiday-liability',
      params: { groupBy: 'entity', leaveType: 'annual' },
      relative: 'today',
      owner: ids.user.payroll_admin,
      shared: false,
    },
    {
      name: 'Overtime last month',
      report: 'overtime',
      params: {},
      relative: 'previousMonth',
      owner: ids.user.payroll_admin,
      shared: false,
    },
    {
      name: 'Headcount history',
      report: 'headcount-history',
      params: { groupBy: 'none' },
      relative: 'yearToDate',
      owner: ids.user.owner,
      shared: false,
    },
    {
      name: "My team's absence",
      report: 'absence',
      params: { groupBy: 'employee' },
      relative: 'yearToDate',
      owner: ids.user.manager,
      shared: false,
    },
  ];
  const savedIds = saved.map((s) => seedUuid('saved-report', s.name));
  await insertRows(
    tx,
    'app.saved_reports',
    saved.map((s, i) => ({
      id: savedIds[i],
      name: s.name,
      kind: 'ready',
      report_key: s.report,
      spec: { params: s.params, relative: s.relative },
      owner_user_id: s.owner,
      shared: s.shared,
    })),
  );
  await insertRows(tx, 'app.saved_reports', [
    {
      id: seedUuid('saved-report', 'starters'),
      name: 'People who joined this year',
      kind: 'builder',
      report_key: null,
      spec: {
        dataset: 'employees',
        columns: ['displayName', 'jobTitle', 'department', 'startDate'],
        sort: { key: 'startDate', dir: 'desc' },
        relative: 'yearToDate',
      },
      owner_user_id: ids.user.hr_admin,
      shared: true,
    },
  ]);
  await insertRows(tx, 'app.report_schedules', [
    {
      saved_report_id: savedIds[0],
      frequency: 'weekly',
      time_of_day: '07:45',
      weekday: 1,
      day_of_month: null,
      time_zone: 'Europe/London',
      format: 'pdf',
      recipient_user_ids: [ids.user.hr_admin, ids.user.owner],
      enabled: true,
      created_by: ids.user.hr_admin,
    },
    {
      saved_report_id: savedIds[3],
      frequency: 'monthly',
      time_of_day: '08:10',
      weekday: null,
      day_of_month: 1,
      time_zone: 'Europe/London',
      format: 'xlsx',
      recipient_user_ids: [ids.user.payroll_admin],
      enabled: true,
      created_by: ids.user.payroll_admin,
    },
  ]);
  ctx.counts.savedReports = saved.length + 1;
  ctx.counts.reportSchedules = 2;

  // ---- privacy operations ----------------------------------------------------------------------------------
  const leaver = plan.people.find(
    (p) =>
      p.kind === 'past_leaver' && p.entity === 'uk' && compareDates(p.endDate!, addDays(anchor, -60)) < 0,
  );
  const active = plan.people.find(
    (p) => p.kind === 'roster' && p.team === 'sales_acc' && p.level === 'member',
  );
  const dsr = async (
    kind: 'access' | 'correction',
    employeeId: string,
    receivedOn: string,
    status: string,
    details: string,
    completedOn?: string,
  ) => {
    const s = await resolveSubject(tx, { employeeId });
    const d = deadlineColumns(book, {
      jurisdiction: s.jurisdiction,
      kind,
      received_on: receivedOn,
      information_received_on: null,
      paused_days: 0,
      extended: false,
    });
    await tx.exec(
      `INSERT INTO app.dsr_requests (tenant_id, kind, status, subject_employee_id, subject_user_id, requester_relationship, channel, jurisdiction, received_on, due_on, extended_due_on, rule, identity_verified_at, identity_method, identity_note, details, created_by, created_at, completed_at)
       VALUES (app.current_tenant(), $1, $2, $3, $4, 'self', 'email', $5, $6, $7, $8, $9, $10, 'known_contact_details', 'Replied from the personal email address on file', $11, $12, $13, $14)`,
      [
        kind,
        status,
        s.employeeId,
        s.userId,
        s.jurisdiction,
        receivedOn,
        d.due_on,
        d.extended_due_on,
        d.rule ? JSON.stringify(d.rule) : null,
        `${addDays(receivedOn, 1)}T10:00:00Z`,
        details,
        ids.user.hr_admin,
        `${receivedOn}T09:30:00Z`,
        completedOn ? `${completedOn}T16:00:00Z` : null,
      ],
    );
  };
  if (leaver)
    await dsr(
      'access',
      ids.employee[leaver.idx]!,
      addDays(anchor, -12),
      'in_progress',
      'Former employee asks for a copy of their personnel file.',
    );
  if (active)
    await dsr(
      'correction',
      ids.employee[active.idx]!,
      addDays(anchor, -60),
      'completed',
      'Asked to correct the spelling of their home address.',
      addDays(anchor, -50),
    );
  const tribunal = plan.people.find((p) => p.kind === 'past_leaver' && p.leaverType === 'involuntary');
  if (tribunal)
    await insertRows(tx, 'app.legal_holds', [
      {
        employee_id: ids.employee[tribunal.idx],
        category: null,
        reason: 'Employment tribunal claim (fictional case)',
        reference: 'ET-FICTIONAL-0001',
        created_by: ids.user.hr_admin,
      },
    ]);
  const awareAt = `${addDays(anchor, -48)}T11:00:00Z`;
  const affected = { GB: 1 };
  const deadlines = breachDeadlines(book, awareAt, affected).filter(
    (d) => d.audience !== 'processorToController',
  );
  await insertRows(
    tx,
    'app.incidents',
    [
      {
        source: 'customer',
        title: 'Payslip emailed to the wrong internal recipient',
        description:
          'A payslip was attached to an email to the wrong colleague, who deleted it on request. Fictional sample incident.',
        severity: 'low',
        status: 'closed',
        personal_data_breach: true,
        risk_level: 'unlikely',
        occurred_at: `${addDays(anchor, -48)}T09:40:00Z`,
        aware_at: awareAt,
        contained_at: `${addDays(anchor, -48)}T12:30:00Z`,
        closed_at: `${addDays(anchor, -41)}T15:00:00Z`,
        affected,
        data_categories: ['pay'],
        deadlines,
        notifications: {
          regulator: { decision: 'not_required', reason: 'Unlikely to result in a risk to the individual' },
        },
        created_by: ids.user.hr_admin,
      },
    ],
    { json: ['deadlines', 'affected', 'notifications'] },
  );
  await insertRows(tx, 'app.subprocessor_subscriptions', [{ user_id: ids.user.owner }]);
  ctx.counts.dataSubjectRequests = (leaver ? 1 : 0) + (active ? 1 : 0);
}

/**
 * Settings a company builds up over time: automation rules (run by the worker from now on), a custom object
 * type with records, and the record of the people import that created the workforce (its file in the
 * object store, as the import keeps it).
 */
export async function seedSettings(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  await insertRows(
    tx,
    'app.automation_rules',
    [
      {
        name: 'Probation review reminder',
        enabled: true,
        trigger: { type: 'date.reached', dateField: 'probationEndDate', offsetDays: -14 },
        conditions: [],
        actions: [
          {
            type: 'task',
            title: 'Prepare the probation review',
            assignee: { type: 'manager' },
            dueInDays: 10,
          },
        ],
        created_by: ids.user.hr_admin,
      },
      {
        name: 'Work anniversary',
        enabled: true,
        trigger: { type: 'date.reached', dateField: 'workAnniversary', offsetDays: 0 },
        conditions: [],
        actions: [
          {
            type: 'notification',
            to: { type: 'manager' },
            message: 'A member of your team has a work anniversary today.',
          },
        ],
        created_by: ids.user.hr_admin,
      },
      {
        name: 'Welcome pack for new joiners',
        enabled: true,
        trigger: { type: 'record.created', entity: 'employee' },
        conditions: [],
        actions: [
          {
            type: 'notification',
            to: { type: 'role', value: 'hr_admin' },
            message: 'Order a welcome pack for the new joiner.',
          },
        ],
        created_by: ids.user.hr_admin,
      },
    ],
    { json: ['trigger', 'conditions', 'actions'] },
  );
  const typeId = seedUuid('custom-object-type', 'memberships');
  await insertRows(
    tx,
    'app.custom_object_types',
    [
      {
        id: typeId,
        key: 'professionalMemberships',
        label: { 'en-GB': 'Professional memberships', 'en-US': 'Professional memberships' },
        fields: [
          {
            key: 'body',
            label: { 'en-GB': 'Professional body', 'en-US': 'Professional body' },
            fieldType: 'text',
            required: true,
          },
          {
            key: 'membershipNumber',
            label: { 'en-GB': 'Membership number', 'en-US': 'Membership number' },
            fieldType: 'text',
          },
          { key: 'renewsOn', label: { 'en-GB': 'Renews on', 'en-US': 'Renews on' }, fieldType: 'date' },
        ],
      },
    ],
    { json: ['fields'] },
  );
  const BODIES: Record<string, string> = {
    finance: 'Fictional Institute of Accountants',
    payroll: 'Fictional Payroll Association',
    hr: 'Fictional Institute of People Professionals',
    legal: 'Fictional Law Society',
  };
  const members = plan.people.filter((p) => p.kind === 'roster' && BODIES[p.team]);
  await insertRows(
    tx,
    'app.custom_object_records',
    members.map((p, i) => ({
      type_id: typeId,
      employee_id: ids.employee[p.idx],
      data: {
        body: BODIES[p.team],
        membershipNumber: `FICT-${String(1000 + i)}`,
        renewsOn: addMonths(anchor, 1 + (i % 11)),
      },
      valid_from: p.startDate,
    })),
  );
  // the people import that loaded the workforce (a CSV of employee numbers and names, kept like an upload)
  const rows = [
    'employeeNumber,legalFirstName,legalLastName,startDate',
    ...plan.people.map((p) => `${p.number},${p.first},${p.last},${p.startDate}`),
  ];
  const csv = Buffer.from(rows.join('\r\n'));
  const key = `${ctx.tenantId}/imports/${seedUuid('import', 'people')}.csv`;
  await ctx.objects.put(key, csv, 'text/csv');
  await insertRows(
    tx,
    'app.import_batches',
    [
      {
        kind: 'employees',
        file_key: key,
        file_name: 'kestrel-people.csv',
        file_sha256: createHash('sha256').update(csv).digest('hex'),
        mapping: {},
        status: 'completed',
        row_count: plan.people.length,
        stats: { created: plan.people.length, updated: 0, unchanged: 0, failed: 0, dryRun: false, errors: 0 },
        created_by: ids.user.hr_admin,
      },
    ],
    { json: ['mapping', 'stats'] },
  );
  ctx.counts.automationRules = 3;
  ctx.counts.customObjectRecords = members.length;
}

/**
 * The seeded history raised in-app notifications through the normal paths; their email and push deliveries
 * are cancelled so loading the workspace does not send a burst of messages about events that never happened
 * live. Notifications stay in the app; anything that happens after seeding is delivered as usual.
 */
export async function suppressSeededDeliveries(ctx: SeedCtx) {
  const n = await ctx.tx.exec(
    `UPDATE app.jobs SET status = 'cancelled', error = 'seeded history: not delivered', finished_at = now() WHERE kind = 'notifications.deliver' AND status = 'queued'`,
  );
  // older notifications have been read
  await ctx.tx.exec(
    `UPDATE app.notifications SET read_at = created_at + interval '2 hours' WHERE read_at IS NULL AND created_at < $1::date - 7`,
    [ctx.anchor],
  );
  ctx.counts.notifications = (
    await ctx.tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.notifications')
  ).n;
  ctx.counts.deliveriesSuppressed = n;
}
