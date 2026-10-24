import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import { createTask } from '../src/lib/notify';
import { requestApproval } from '../src/modules/approvals/service';
import { runComplianceDaily } from '../src/modules/compliance/jobs';

/**
 * Phase 16 part B (ADR-0191 to ADR-0193): tasks that lead to the work.
 *  - 16.5 every task explains itself, in the reader's language;
 *  - 16.6 a main button that opens the work with the person chosen, a live status, and Mark as done as an
 *    audited fallback with a note;
 *  - 16.7 tasks close themselves when their record completes, for every kind wired today;
 *  - 16.8 "Comes from" and "Asked by" tell the truth, and due dates follow the person's dates and the packs.
 * A fictional UK company (with a US entity for Form I-9). Every person is invented.
 */
let ctx: TestContext;
let c: Phase6Company;
let mgr: string;
let emp: string;
let mgrCookie: string;
let empCookie: string;
let hrCookie: string;
let us: { entity: string; location: string };

const userOf = (employeeId: string) =>
  c.tx((t) => t.one<{ id: string }>('SELECT id FROM app.users WHERE employee_id = $1', [employeeId]));
const task = (id: string, cookie?: string, locale = 'en-GB') =>
  c.api('GET', `/v1/tasks/${id}?locale=${locale}`, undefined, cookie).then((r) => {
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  });
const taskRow = (where: string, params: unknown[]) =>
  c.tx((t) =>
    t.one<{ id: string; status: string; completed_via: string | null }>(
      `SELECT * FROM app.tasks WHERE ${where}`,
      params,
    ),
  );
const auditOf = (taskId: string) =>
  c.tx((t) =>
    t.query<{ action: string; diff: Record<string, unknown> | null; actor_type: string }>(
      `SELECT action, diff, actor_type FROM audit.events WHERE target_type = 'task' AND target_id = $1 ORDER BY at`,
      [taskId],
    ),
  );
const daily = (date: string) => c.tx((t) => runComplianceDaily(ctx.deps, t, date));

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  mgr = await c.hire({ legalFirstName: 'Mira', legalLastName: 'Manager' });
  emp = await c.hire({ legalFirstName: 'Eli', legalLastName: 'Example', managerId: mgr });
  mgrCookie = await c.login(mgr, 'manager');
  empCookie = await c.login(emp);
  hrCookie = await c.login(await c.hire({ legalFirstName: 'Harper', legalLastName: 'People' }), 'hr_admin');
  us = {
    entity: await c.post('/v1/org/legal-entities', {
      name: 'Fictional Payroll Inc',
      country: 'US',
      regionCode: 'US-NY',
      currency: 'USD',
      timeZone: 'America/New_York',
    }),
    location: '',
  };
  us.location = await c.post('/v1/org/locations', {
    name: 'Fictional Office New York',
    country: 'US',
    regionCode: 'US-NY',
    timeZone: 'America/New_York',
    entityId: us.entity,
  });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('16.5 every task explains itself, in the reader’s language', () => {
  it('renders a system task’s title and description from the catalogue in the reader’s locale', async () => {
    const id = (await c.tx((t) =>
      createTask(t, {
        source: 'compliance',
        titleKey: 'compliance.task.i9Reverify',
        descriptionKey: 'taskActions.text.compliance.i9Reverify',
        textParams: { name: 'Eli Example' },
        subjectEmployeeId: emp,
        assigneeRole: 'hr_admin',
        action: { kind: 'open_person', params: { tab: 'compliance' } },
        dedupeKey: 'fictional-i18n-task',
      }),
    ))!;
    const gb = await task(id, hrCookie, 'en-GB');
    const usa = await task(id, hrCookie, 'en-US');
    expect(gb.title).toBe('Form I-9 reverification: Eli Example');
    expect(gb.description).toContain('employment authorisation');
    expect(usa.description).toContain('employment authorization');
    // the workspace-locale rendering is stored too, for exports and e-mails
    const stored = await c.tx((t) =>
      t.one<{ title: string; description: string }>(
        'SELECT title, description FROM app.tasks WHERE id = $1',
        [id],
      ),
    );
    expect(stored.title).toBe('Form I-9 reverification: Eli Example');
    expect(stored.description).toContain('Supplement B');
  });

  it('a workflow template task keeps its description; the automation editor’s description reaches the task', async () => {
    const rule = await c.api('POST', '/v1/automation/rules', {
      name: 'Fictional welcome call',
      trigger: { type: 'record.created', entity: 'employee' },
      actions: [
        {
          type: 'task',
          title: 'Call the new starter',
          description: 'Ring them before day one to say hello and answer questions. Fictional.',
          assignee: { type: 'role', value: 'hr_admin' },
          dueInDays: 3,
        },
      ],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const joiner = await c.hire({ legalFirstName: 'Juno', legalLastName: 'Joiner', startDate: '2026-11-02' });
    await c.drain();
    const row = await taskRow(`source = 'automation' AND subject_employee_id = $1`, [joiner]);
    const t = await task(row.id, hrCookie);
    expect(t).toMatchObject({
      title: 'Call the new starter',
      description: 'Ring them before day one to say hello and answer questions. Fictional.',
      origin: {
        source: 'automation',
        label: 'Automation rule: Fictional welcome call',
        href: '/app/automation',
      },
      action: { kind: 'open_person', label: 'Open their profile', href: `/app/people/${joiner}` },
    });
  });
});

describe('16.6 task actions: the main button, its status and Mark as done', () => {
  let templateId: string;
  let workflowTask: string;

  it('validates actions and due rules in workflow templates', async () => {
    const base = { kind: 'custom', name: 'Fictional checks' };
    const bad = [
      { action: { kind: 'made_up' } },
      { action: { kind: 'open_link', params: { href: 'https://evil.example/app' } } },
      { action: { kind: 'form', params: { formKind: 'nope' } } },
    ];
    for (const extra of bad) {
      const r = await c.api('POST', '/v1/workflow-templates', {
        ...base,
        tasks: [
          { key: 'a', title: 'A', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: 0, ...extra },
        ],
      });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    const ok = await c.api('POST', '/v1/workflow-templates', {
      ...base,
      tasks: [
        {
          key: 'profile',
          title: 'Check their compliance record',
          description: 'Look over their compliance record before the review. Fictional.',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 5,
          action: { kind: 'open_person', params: { tab: 'compliance' } },
        },
        {
          key: 'plain',
          title: 'Book a desk',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 1,
        },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    templateId = ok.json().id;
  });

  it('opens the work for the person, from the task page and the list', async () => {
    const start = await c.api('POST', '/v1/workflows', {
      templateId,
      employeeId: emp,
      anchorDate: '2026-11-02',
    });
    expect(start.statusCode, start.body).toBe(201);
    workflowTask = (
      await taskRow(`source_id = $1 AND title = 'Check their compliance record'`, [start.json().id])
    ).id;
    const t = await task(workflowTask, hrCookie);
    expect(t).toMatchObject({
      description: 'Look over their compliance record before the review. Fictional.',
      dueOn: '2026-11-07',
      action: {
        kind: 'open_person',
        opens: 'open_person',
        label: 'Open their compliance record',
        href: `/app/people/${emp}?tab=compliance`,
        landed: true,
      },
      origin: {
        source: 'workflow',
        label: 'Workflow: Fictional checks',
        href: `/app/settings/workflows#tpl-${templateId}`,
      },
      canComplete: true,
      closesItself: false,
    });
    const list = (await c.api('GET', '/v1/tasks', undefined, hrCookie)).json();
    expect(list.find((x: { id: string }) => x.id === workflowTask)).toMatchObject({
      href: `/app/tasks/${workflowTask}`,
      action: { label: 'Open their compliance record', href: `/app/people/${emp}?tab=compliance` },
    });
  });

  it('Mark as done takes a short note, keeps it and audits it; a task without a note still closes', async () => {
    const long = await c.api(
      'POST',
      `/v1/tasks/${workflowTask}/complete`,
      { note: 'x'.repeat(501) },
      hrCookie,
    );
    expect(long.statusCode).toBe(400);
    const r = await c.api(
      'POST',
      `/v1/tasks/${workflowTask}/complete`,
      { note: 'Checked on paper with the new starter. Fictional.' },
      hrCookie,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(await task(workflowTask, hrCookie)).toMatchObject({
      status: 'done',
      completedVia: 'manual',
      completionNote: 'Checked on paper with the new starter. Fictional.',
      action: null,
    });
    expect(await auditOf(workflowTask)).toEqual([
      expect.objectContaining({
        action: 'task.completed',
        actor_type: 'user',
        diff: { via: 'manual', note: 'Checked on paper with the new starter. Fictional.' },
      }),
    ]);
    // the joiner's checklist marks its steps done without a note, as before
    const plain = await taskRow(`title = 'Book a desk' AND subject_employee_id = $1`, [emp]);
    const noNote = await c.api('POST', `/v1/tasks/${plain.id}/complete`, undefined, hrCookie);
    expect(noNote.statusCode, noNote.body).toBe(200);
  });

  it('edits a template; workflows started earlier keep their tasks', async () => {
    const r = await c.api('PUT', `/v1/workflow-templates/${templateId}`, {
      name: 'Fictional checks (edited)',
      tasks: [
        {
          key: 'profile',
          title: 'Check their documents',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 5,
          action: { kind: 'send_document', params: {} },
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    const tpl = (await c.api('GET', '/v1/workflow-templates'))
      .json()
      .find((x: { id: string }) => x.id === templateId);
    expect(tpl).toMatchObject({
      name: 'Fictional checks (edited)',
      tasks: [{ key: 'profile', action: { kind: 'send_document', params: {} } }],
    });
    expect((await task(workflowTask, hrCookie)).title).toBe('Check their compliance record');
    expect(
      (await c.api('PUT', `/v1/workflow-templates/${templateId}`, { name: 'x', tasks: [] })).statusCode,
    ).toBe(400);
  });

  it('a placeholder kind opens its fallback page, labelled for that page, until its part lands', async () => {
    const id = (await c.tx((t) =>
      createTask(t, {
        source: 'workflow',
        title: 'Send the statement of main terms',
        subjectEmployeeId: emp,
        assigneeRole: 'hr_admin',
        action: { kind: 'send_document', params: { templateId: '0b7a1d4e-9c2f-4e8a-9b1d-3c5e7f9a1b2c' } },
        dedupeKey: 'fictional-placeholder',
      }),
    ))!;
    expect((await task(id, hrCookie)).action).toEqual({
      kind: 'send_document',
      opens: 'open_person',
      label: 'Open their documents',
      href: `/app/people/${emp}?tab=documents`,
      landed: false,
    });
  });
});

describe('16.7 tasks close themselves when their record completes', () => {
  it('asset acknowledgement: from the asset register, closed when the holder confirms', async () => {
    const asset = await c.post('/v1/assets', {
      assetTag: 'FICT-TA-1',
      type: 'laptop',
      name: 'Fictional Book 14',
    });
    const a = await c.api('POST', `/v1/assets/${asset}/assign`, {
      employeeId: emp,
      assignedOn: '2026-10-01',
    });
    expect(a.statusCode, a.body).toBe(201);
    const assignment = a.json().id;
    const row = await taskRow(`record_type = 'asset_acknowledgement' AND record_id = $1`, [assignment]);
    const before = await task(row.id, empCookie);
    expect(before).toMatchObject({
      source: 'asset',
      title: 'Confirm you received Fictional Book 14',
      action: {
        kind: 'open_record',
        label: 'Confirm you received it',
        href: `/app/assets?ack=${assignment}`,
      },
      recordStatus: { text: 'Not confirmed yet', tone: 'warning' },
      origin: { label: 'Asset register', href: '/app/assets' },
      closesItself: true,
    });
    expect(before.description).toContain('Fictional Book 14');
    const ack = await c.api(
      'POST',
      `/v1/asset-assignments/${assignment}/acknowledge`,
      { confirm: true },
      empCookie,
    );
    expect(ack.statusCode, ack.body).toBe(200);
    expect(await task(row.id, empCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
    expect(await auditOf(row.id)).toEqual([
      expect.objectContaining({
        action: 'task.completed',
        diff: expect.objectContaining({
          via: 'record',
          recordType: 'asset_acknowledgement',
          reason: 'asset.acknowledged',
        }),
      }),
    ]);
  });

  it('asset return: the offboarding return task closes when the return is recorded', async () => {
    const leaver = await c.hire({ legalFirstName: 'Lee', legalLastName: 'Leaver' });
    const tpl = await c.post('/v1/workflow-templates', {
      kind: 'offboarding',
      name: 'Fictional leaver checklist',
      autoStart: false,
      tasks: [
        { key: 'exit', title: 'Exit chat', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: 0 },
      ],
    });
    const phone = await c.post('/v1/assets', {
      assetTag: 'FICT-TA-2',
      type: 'laptop',
      name: 'Fictional Phone 9',
    });
    const assignment = (
      await c.api('POST', `/v1/assets/${phone}/assign`, { employeeId: leaver, assignedOn: '2026-09-01' })
    ).json().id;
    const end = addDays(today('Europe/London'), 20);
    expect(
      (await c.api('POST', '/v1/workflows', { templateId: tpl, employeeId: leaver, anchorDate: end }))
        .statusCode,
    ).toBe(201);
    const row = await taskRow(`record_type = 'asset_return' AND record_id = $1`, [assignment]);
    expect(await task(row.id, hrCookie)).toMatchObject({
      source: 'workflow',
      title: 'Return Fictional Phone 9 (FICT-TA-2)',
      action: { label: 'Record the return', href: `/app/assets?return=${assignment}` },
      recordStatus: { text: 'Still issued', tone: 'warning' },
      origin: { label: 'Offboarding workflow: Fictional leaver checklist' },
      closesItself: true,
    });
    const ok = await c.api(
      'POST',
      `/v1/asset-assignments/${assignment}/return`,
      {
        returnedOn: '2026-09-20',
        checklist: [
          { key: 'device', done: true },
          { key: 'charger', done: true },
          { key: 'dataWiped', done: true },
        ],
      },
      hrCookie,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await task(row.id, hrCookie);
    expect(after).toMatchObject({ status: 'done', completedVia: 'record' });
    // the acknowledgement nobody gave is no longer needed
    const ack = await taskRow(`record_type = 'asset_acknowledgement' AND record_id = $1`, [assignment]).catch(
      () => null,
    );
    if (ack) expect(ack.status).toBe('cancelled');
  });

  it('right to work: the missing-check task and an onboarding check step close when a check is recorded; a newer check closes the follow-up', async () => {
    const starter = await c.hire({ legalFirstName: 'Rae', legalLastName: 'Right', startDate: '2026-11-16' });
    const onboarding = await c.post('/v1/workflow-templates', {
      kind: 'custom',
      name: 'Fictional pre-start',
      tasks: [
        {
          key: 'rtw',
          title: 'Check right to work before day one',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: -3,
          action: { kind: 'rtw_check' },
        },
      ],
    });
    await c.api('POST', '/v1/workflows', {
      templateId: onboarding,
      employeeId: starter,
      anchorDate: '2026-11-16',
    });
    await daily('2026-10-24');
    const missing = await taskRow(`dedupe_key = $1`, [`rtw-missing:${starter}`]);
    const step = await taskRow(`action_kind = 'rtw_check' AND subject_employee_id = $1`, [starter]);
    expect(await task(missing.id, hrCookie)).toMatchObject({
      title: 'Right-to-work check before the first day: Rae Right',
      origin: { label: 'Compliance', href: '/app/compliance/right-to-work' },
      action: { label: 'Open their compliance record', href: `/app/people/${starter}?tab=compliance` },
      recordStatus: { text: 'No check recorded yet' },
      closesItself: true,
    });
    // the placeholder rtw_check kind opens the compliance tab until part E's dialog lands
    expect((await task(step.id, hrCookie)).action).toMatchObject({
      kind: 'rtw_check',
      landed: false,
      opens: 'open_person',
    });
    const first = await c.api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: starter,
      checkMethod: 'manual_document_check',
      listType: 'list_b_group_1',
      checkedOn: '2026-10-20',
      permissionExpiresOn: '2026-12-31',
    });
    expect(first.statusCode, first.body).toBe(201);
    expect((await task(missing.id, hrCookie)).status).toBe('done');
    expect((await task(step.id, hrCookie)).status).toBe('done');
    // the time-limited permission raises a follow-up task (its record is the check)
    await daily('2026-10-25');
    const followUp = await taskRow(`dedupe_key = $1`, [`rtwcheck:${first.json().id}:task`]);
    expect(await task(followUp.id, hrCookie)).toMatchObject({
      action: { label: 'Open the check', href: `/app/compliance/right-to-work/${first.json().id}` },
      recordStatus: { tone: 'warning' },
    });
    const second = await c.api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: starter,
      checkMethod: 'manual_document_check',
      listType: 'list_a',
      checkedOn: '2026-10-26',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(await task(followUp.id, hrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
  });

  it('compliance matrix: a missing requirement closes when the record is added', async () => {
    const req = await c.post('/v1/compliance/requirements', {
      kind: 'licence',
      name: 'Fictional forklift licence',
      appliesTo: { jobTitles: ['Forklift Operator'] },
      validityMonths: 12,
    });
    const driver = await c.hire({
      legalFirstName: 'Fin',
      legalLastName: 'Forklift',
      jobTitle: 'Forklift Operator',
    });
    await daily('2026-10-24');
    const row = await taskRow(`dedupe_key = $1`, [`matrix-missing:${req}:${driver}`]);
    expect(await task(row.id, hrCookie)).toMatchObject({
      title: 'Record Fictional forklift licence: Fin Forklift',
      recordStatus: { text: 'Not recorded yet' },
      origin: { href: '/app/compliance/matrix' },
    });
    const rec = await c.api('POST', '/v1/compliance/records', {
      requirementId: req,
      employeeId: driver,
      issuedOn: '2026-10-20',
    });
    expect(rec.statusCode, rec.body).toBe(201);
    expect(await task(row.id, hrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
  });

  it('Form I-9: Section 1 and Section 2 tasks close when the record says so; Section 2 is due on the US pack’s deadline', async () => {
    // Thursday 22 October 2026: three business days later is Tuesday 27 October (a calendar count says Sunday)
    const hire = await c.hire({
      legalFirstName: 'Ivy',
      legalLastName: 'Example',
      startDate: '2026-10-22',
      entityId: us.entity,
      locationId: us.location,
      payCurrency: 'USD',
    });
    const tpl = await c.post('/v1/workflow-templates', {
      kind: 'custom',
      name: 'Fictional US first week',
      tasks: [
        {
          key: 's1',
          title: 'Complete Form I-9 Section 1',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 0,
          action: { kind: 'i9_section1' },
        },
        {
          key: 's2',
          title: 'Complete Form I-9 Section 2',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 0,
          due: { anchor: 'start', offsetDays: 0, packDeadline: 'i9_section2' },
          action: { kind: 'i9_section2' },
        },
      ],
    });
    await c.api('POST', '/v1/workflows', { templateId: tpl, employeeId: hire, anchorDate: '2026-10-22' });
    const s1 = await taskRow(`action_kind = 'i9_section1' AND subject_employee_id = $1`, [hire]);
    const s2 = await taskRow(`action_kind = 'i9_section2' AND subject_employee_id = $1`, [hire]);
    expect(await task(s2.id, hrCookie)).toMatchObject({
      dueOn: '2026-10-27',
      recordStatus: { text: 'No Form I-9 recorded yet' },
      action: { kind: 'i9_section2', landed: false, href: `/app/people/${hire}?tab=compliance` },
    });
    const rec = await c.api('POST', '/v1/compliance/i9', {
      employeeId: hire,
      section1CompletedOn: '2026-10-22',
    });
    expect(rec.statusCode, rec.body).toBe(200);
    // the record's own deadline is the same date as the task's
    expect(rec.json().section2DueOn).toBe('2026-10-27');
    expect((await task(s1.id, hrCookie)).status).toBe('done');
    expect(await task(s2.id, hrCookie)).toMatchObject({
      status: 'open',
      recordStatus: { text: expect.stringContaining('Section 2 due by') },
    });
    expect(
      (await c.api('PATCH', `/v1/compliance/i9/${rec.json().id}`, { section2CompletedOn: '2026-10-26' }))
        .statusCode,
    ).toBe(200);
    expect(await task(s2.id, hrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
  });

  it('document signature: the signing task opens the viewer and closes on signing', async () => {
    const tpl = await c.post('/v1/document-templates', {
      name: 'Fictional handbook',
      body: 'Hello {{employee.firstName}}.',
    });
    const gen = await c.api('POST', `/v1/document-templates/${tpl}/generate`, {
      employeeId: emp,
      requireSignature: true,
    });
    expect(gen.statusCode, gen.body).toBe(201);
    const sr = (await c.api('GET', '/v1/signature-requests', undefined, empCookie)).json()[0];
    const row = await taskRow(`record_type = 'signature_request' AND record_id = $1`, [sr.id]);
    const list = (await c.api('GET', '/v1/tasks', undefined, empCookie)).json();
    const t = list.find((x: { id: string }) => x.id === row.id);
    expect(t.title).toBe('Sign Fictional handbook');
    expect(t.action).toMatchObject({
      label: 'Review and sign',
      href: expect.stringMatching(new RegExp(`\\?sign=${sr.id}$`)),
    });
    expect(await task(row.id, empCookie)).toMatchObject({
      origin: { label: 'Documents' },
      recordStatus: { text: 'Waiting to be signed' },
    });
    const sign = await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/sign`,
      { consent: true, typedName: 'Eli Example' },
      empCookie,
    );
    expect(sign.statusCode, sign.body).toBe(200);
    expect(await task(row.id, empCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
  });

  it('approvals: the approver’s task closes with the decision, audited', async () => {
    const types = (await c.api('GET', '/v1/leave/types', undefined, empCookie)).json() as Array<{
      id: string;
      key: string;
    }>;
    let day = addDays(today('Europe/London'), 40);
    while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = addDays(day, 1);
    const leave = await c.api(
      'POST',
      '/v1/leave/requests',
      { leaveTypeId: types.find((x) => x.key === 'annual')!.id, startDate: day, endDate: day },
      empCookie,
    );
    expect(leave.statusCode, leave.body).toBe(201);
    const row = await taskRow(`source = 'approval' AND subject_employee_id = $1 AND status = 'open'`, [emp]);
    const t = await task(row.id, mgrCookie);
    expect(t).toMatchObject({
      description: expect.stringContaining('Eli Example asked for time off'),
      action: { kind: 'open_record', label: 'Review the request' },
      recordStatus: { text: 'Waiting for a decision' },
      origin: { source: 'approval' },
    });
    const approval = t.action.href.split('/').pop();
    // "Asked by" names the person who asked
    expect((await c.api('GET', `/v1/approvals/${approval}`, undefined, mgrCookie)).json().askedBy).toEqual({
      kind: 'person',
      name: 'Eli Example',
      employeeId: emp,
    });
    expect(
      (await c.api('POST', `/v1/approvals/${approval}/decide`, { decision: 'approve' }, mgrCookie))
        .statusCode,
    ).toBe(200);
    expect(await task(row.id, mgrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
    expect((await auditOf(row.id)).map((a) => a.action)).toEqual(['task.completed']);
  });

  it('return to work: the manager’s task comes from Absence and closes when the conversation is recorded', async () => {
    const s = await c.api('POST', '/v1/sickness', {
      employeeId: emp,
      startDate: '2026-10-12',
      endDate: '2026-10-14',
    });
    expect(s.statusCode, s.body).toBe(201);
    const row = await taskRow(`record_type = 'return_to_work' AND record_id = $1`, [s.json().id]);
    expect(await task(row.id, mgrCookie)).toMatchObject({
      source: 'absence',
      title: 'Return-to-work conversation: Eli Example',
      description: expect.stringContaining('fit to return'),
      dueOn: '2026-10-16',
      // past its due date in the viewer's zone (the page needs no time library for it)
      overdue: true,
      origin: { label: 'Absence', href: `/app/people/${emp}?tab=time-off` },
      action: { kind: 'form', opens: 'open_person', label: 'Open their time off', landed: false },
      recordStatus: { text: 'Conversation not recorded yet' },
      closesItself: true,
    });
    const rtw = await c.api(
      'POST',
      `/v1/sickness/${s.json().id}/return-to-work`,
      { answers: { feeling: 'Fictional' }, fitForWork: true },
      mgrCookie,
    );
    expect(rtw.statusCode, rtw.body).toBe(200);
    expect(await task(row.id, mgrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
  });

  it('a request to HR closes when HR resolves it, and the person sees the reply', async () => {
    const sent = await c.api(
      'POST',
      '/v1/hr-requests',
      { subject: 'Fictional parking question', message: 'Fictional details.' },
      empCookie,
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().id;
    expect(await task(id, hrCookie)).toMatchObject({ origin: { label: 'Request to HR' }, canComplete: true });
    const done = await c.api(
      'POST',
      `/v1/tasks/${id}/complete`,
      { note: 'Use the visitor bays on Fridays. Fictional.' },
      hrCookie,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(await task(id, hrCookie)).toMatchObject({ status: 'done', completedVia: 'record' });
    expect((await c.api('GET', `/v1/hr-requests/${id}`, undefined, empCookie)).json()).toMatchObject({
      status: 'done',
      reply: 'Use the visitor bays on Fridays. Fictional.',
    });
    expect((await auditOf(id)).map((a) => a.action)).toContain('task.completed');
  });
});

describe('16.8 truthful labels and due dates', () => {
  it('due dates follow the probation end date and count business days without the pack’s bank holidays', async () => {
    const person = await c.hire({
      legalFirstName: 'Pia',
      legalLastName: 'Probation',
      startDate: '2026-12-21',
      probationEndDate: '2027-06-21',
    });
    const tpl = await c.post('/v1/workflow-templates', {
      kind: 'custom',
      name: 'Fictional dates',
      tasks: [
        {
          key: 'review',
          title: 'Probation review',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 180,
          due: { anchor: 'probation_end', offsetDays: -7 },
        },
        {
          key: 'kit',
          title: 'Hand over the kit',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 4,
          due: { anchor: 'anchor', offsetDays: 4, businessDays: true },
        },
      ],
    });
    await c.api('POST', '/v1/workflows', { templateId: tpl, employeeId: person, anchorDate: '2026-12-21' });
    const review = await taskRow(`title = 'Probation review' AND subject_employee_id = $1`, [person]);
    const kit = await taskRow(`title = 'Hand over the kit' AND subject_employee_id = $1`, [person]);
    expect((await task(review.id, hrCookie)).dueOn).toBe('2027-06-14');
    // Monday 21 December + 4 business days: Christmas Day and the Boxing Day substitute (28th) are closed
    expect((await task(kit.id, hrCookie)).dueOn).toBe('2026-12-29');
    // probation shortened: the review follows the new date
    const change = await c.api('POST', `/v1/employees/${person}/changes`, {
      effectiveDate: '2026-12-21',
      probationEndDate: '2027-03-21',
    });
    expect(change.statusCode, change.body).toBe(200);
    await c.drain();
    expect((await task(review.id, hrCookie)).dueOn).toBe('2027-03-14');
    expect((await task(kit.id, hrCookie)).dueOn).toBe('2026-12-29');
  });

  it('"Asked by" names the person, even without a sign-in; "The system" only for automations', async () => {
    await c.post('/v1/approval-policies', {
      subject: 'employee.change',
      name: 'Fictional change approval',
      condition: { field: 'jobTitle', op: 'present' },
      steps: [{ approver: { type: 'role', value: 'hr_admin' } }],
    });
    const ask = (asker: Parameters<typeof requestApproval>[5], requestedBy: string | null = null) =>
      c.tx((t) =>
        requestApproval(
          t,
          'employee.change',
          emp,
          requestedBy,
          { jobTitle: 'Fictional lead', effectiveDate: '2026-12-01' },
          asker,
        ),
      );
    const askedBy = async (id: string | undefined) =>
      (await c.api('GET', `/v1/approvals/${id}`)).json().askedBy;
    expect(await askedBy(await ask({ employeeId: mgr }))).toEqual({
      kind: 'person',
      name: 'Mira Manager',
      employeeId: mgr,
    });
    const hrUser = (await userOf(mgr)).id;
    expect(await askedBy(await ask({}, hrUser))).toEqual({
      kind: 'person',
      name: 'Mira Manager',
      employeeId: mgr,
    });
    expect(await askedBy(await ask({ via: 'automation' }))).toEqual({
      kind: 'automation',
      name: null,
      employeeId: null,
    });
    expect(await askedBy(await ask({}))).toEqual({ kind: 'unrecorded', name: null, employeeId: null });
  });
});
