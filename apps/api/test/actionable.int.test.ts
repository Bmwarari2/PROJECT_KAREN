import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { widgets, type Widgets } from './reports-fixtures';
import { createTask, notify } from '../src/lib/notify';

/**
 * Everything that names a thing takes you to it (ADR-0160, ADR-0161): notifications carry a target
 * and the page it opens, tasks open what they are about, approval requests and leave requests have
 * their own read endpoints for their people, a person's compliance is one call for their profile, and
 * the web app can ask in one batch which profiles a viewer may open. Fictional Widgets: Mona manages
 * Ada, Ben and Cleo; Dan and Eve report to no one.
 */
let ctx: TestContext;
let w: Widgets;
let mona: { cookie: string; userId: string };
let ada: { cookie: string; userId: string };
let dan: { cookie: string; userId: string };
let leaveId: string;
let approvalId: string;

const UUID = /^[0-9a-f-]{36}$/;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  w = await widgets(ctx);
  mona = await w.login(w.people.mona, 'manager', { type: 'own_team' });
  ada = await w.login(w.people.ada, 'employee', { type: 'self' });
  dan = await w.login(w.people.dan, 'employee', { type: 'self' });
  // Ada asks for a day off; her manager Mona decides (the policy is created on first use)
  const types = (await w.api('GET', '/v1/leave/types', undefined, ada.cookie)).json() as Array<{
    id: string;
    key: string;
  }>;
  const day = addDays(today('Europe/London'), 40);
  const r = await w.api(
    'POST',
    '/v1/leave/requests',
    { leaveTypeId: types.find((t) => t.key === 'annual')!.id, startDate: day, endDate: day },
    ada.cookie,
  );
  expect(r.statusCode, r.body).toBe(201);
  leaveId = r.json().id;
  const mine = (await w.api('GET', '/v1/approvals?view=mine', undefined, mona.cookie)).json();
  approvalId = mine.find(
    (a: { payload: { leaveRequestId: string } }) => a.payload.leaveRequestId === leaveId,
  ).id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('which profiles a viewer may open', () => {
  const ask = (cookie: string, ids: string[]) =>
    w.api('POST', '/v1/people/visibility', { ids }, cookie).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { all: boolean; visible: string[] };
    });

  it('answers everyone for the owner, the team and themselves for a manager, only themselves for an employee', async () => {
    const all = Object.values(w.people);
    expect(await ask(w.owner.cookie, [w.people.ada, w.people.dan])).toEqual({
      all: true,
      visible: [w.people.ada, w.people.dan],
    });
    const team = await ask(mona.cookie, all);
    expect(team.all).toBe(false);
    // Ben has left (his reporting line ended with his employment), so he is no longer on Mona's team
    expect(team.visible.sort()).toEqual([w.people.ada, w.people.cleo, w.people.mona].sort());
    expect(await ask(ada.cookie, all)).toEqual({ all: false, visible: [w.people.ada] });
  });

  it('matches what the profile endpoint answers', async () => {
    const ids = [w.people.ada, w.people.ben, w.people.dan, w.people.mona];
    const team = await ask(mona.cookie, ids);
    for (const id of ids) {
      const status = (await w.api('GET', `/v1/employees/${id}`, undefined, mona.cookie)).statusCode;
      expect(status).toBe(team.visible.includes(id) ? 200 : 403);
    }
  });

  it('refuses an empty or oversized batch', async () => {
    expect((await w.api('POST', '/v1/people/visibility', { ids: [] }, ada.cookie)).statusCode).toBe(400);
    const many = Array.from({ length: 201 }, () => w.people.ada);
    expect((await w.api('POST', '/v1/people/visibility', { ids: many }, ada.cookie)).statusCode).toBe(400);
  });
});

describe('approval requests open their own page', () => {
  it('notifies the approver with the request as the target, and the task opens it too', async () => {
    const notes = (await w.api('GET', '/v1/me/notifications', undefined, mona.cookie)).json().data;
    const n = notes.find((x: { kind: string }) => x.kind === 'approval.requested');
    expect(n).toMatchObject({
      target: { type: 'approval_request', id: approvalId },
      href: `/app/approvals/${approvalId}`,
    });
    const tasks = (await w.api('GET', '/v1/tasks', undefined, mona.cookie)).json();
    expect(tasks.find((t: { source: string }) => t.source === 'approval')).toMatchObject({
      href: `/app/approvals/${approvalId}`,
    });
  });

  it('shows the request, its steps and the leave request to the approver, who may decide', async () => {
    const r = await w.api('GET', `/v1/approvals/${approvalId}`, undefined, mona.cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      id: approvalId,
      subject: 'leave.request',
      status: 'pending',
      subjectEmployeeId: w.people.ada,
      subjectName: 'Ada Fictional',
      related: { type: 'leave_request', id: leaveId, href: `/app/time-off/${leaveId}` },
      canDecide: true,
      steps: [{ index: 0, status: 'pending' }],
    });
    expect(r.json().payload.__steps).toBeUndefined();
  });

  it('shows it to whoever asked (without the decision) and to nobody else', async () => {
    const own = await w.api('GET', `/v1/approvals/${approvalId}`, undefined, ada.cookie);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().canDecide).toBe(false);
    expect((await w.api('GET', `/v1/approvals/${approvalId}`, undefined, dan.cookie)).statusCode).toBe(403);
    expect((await w.api('GET', `/v1/approvals/${approvalId}`)).statusCode).toBe(200); // the owner manages approvals
    expect(
      (await w.api('GET', '/v1/approvals/00000000-0000-4000-8000-000000000000', undefined, mona.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('lists requests with the id of the person they are about', async () => {
    const mine = (await w.api('GET', '/v1/approvals?view=mine', undefined, mona.cookie)).json();
    expect(mine.find((a: { id: string }) => a.id === approvalId)).toMatchObject({
      subjectEmployeeId: w.people.ada,
    });
  });
});

describe('leave requests open their own page', () => {
  it('shows a request to the person and their manager, with whether they may cancel it', async () => {
    const own = await w.api('GET', `/v1/leave/requests/${leaveId}`, undefined, ada.cookie);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({
      id: leaveId,
      employeeId: w.people.ada,
      leaveType: 'annual',
      status: 'pending',
      approvalRequestId: approvalId,
      canCancel: true,
    });
    const team = await w.api('GET', `/v1/leave/requests/${leaveId}`, undefined, mona.cookie);
    expect(team.statusCode, team.body).toBe(200);
    expect(team.json().canCancel).toBe(false); // a manager approves; HR records and cancels
    expect((await w.api('GET', `/v1/leave/requests/${leaveId}`, undefined, dan.cookie)).statusCode).toBe(403);
  });

  it('tells the person when it is decided, with the request as the target', async () => {
    const d = await w.api('POST', `/v1/approvals/${approvalId}/decide`, { decision: 'approve' }, mona.cookie);
    expect(d.statusCode, d.body).toBe(200);
    const notes = (await w.api('GET', '/v1/me/notifications', undefined, ada.cookie)).json().data;
    expect(notes.find((x: { kind: string }) => x.kind === 'leave.approved')).toMatchObject({
      target: { type: 'leave_request', id: leaveId },
      href: `/app/time-off/${leaveId}`,
    });
    expect(notes.find((x: { kind: string }) => x.kind === 'approval.decided')).toMatchObject({
      href: `/app/approvals/${approvalId}`,
    });
  });
});

describe('tasks open what they are about', () => {
  let taskId: string;
  beforeAll(async () => {
    taskId = (await w.tx((t) =>
      createTask(t, {
        source: 'manual',
        title: 'Fictional return-to-work conversation',
        description: 'Fictional notes for the conversation.',
        subjectEmployeeId: w.people.ada,
        assigneeUserId: mona.userId,
        dueOn: '2026-11-02',
        link: '/app/absence',
        dedupeKey: `actionable-task-${mona.userId}`,
      }),
    ))!;
  });

  it('gives a task without a screen of its own its own page', async () => {
    const tasks = (await w.api('GET', '/v1/tasks', undefined, mona.cookie)).json();
    expect(tasks.find((t: { id: string }) => t.id === taskId)).toMatchObject({
      href: `/app/tasks/${taskId}`,
    });
    const r = await w.api('GET', `/v1/tasks/${taskId}`, undefined, mona.cookie);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      title: 'Fictional return-to-work conversation',
      description: 'Fictional notes for the conversation.',
      status: 'open',
      dueOn: '2026-11-02',
      subject: { id: w.people.ada, name: 'Ada Fictional' },
      href: `/app/tasks/${taskId}`,
      canComplete: true,
    });
  });

  it('is visible to its assignee and to people who manage workflows, not to the person it is about', async () => {
    expect((await w.api('GET', `/v1/tasks/${taskId}`)).statusCode).toBe(200);
    expect((await w.api('GET', `/v1/tasks/${taskId}`, undefined, ada.cookie)).statusCode).toBe(403);
    expect((await w.api('GET', `/v1/tasks/${taskId}`, undefined, dan.cookie)).statusCode).toBe(403);
  });

  it('links an approval task to its request, and says it is closed by deciding', async () => {
    const tasks = (await w.api('GET', '/v1/tasks?status=all', undefined, mona.cookie)).json();
    const t = tasks.find((x: { source: string }) => x.source === 'approval');
    const one = (await w.api('GET', `/v1/tasks/${t.id}`, undefined, mona.cookie)).json();
    expect(one).toMatchObject({ href: `/app/approvals/${approvalId}`, canComplete: false });
  });
});

describe('notifications open their page, older ones a sensible list', () => {
  it('derives the page of older notifications from their key, link or kind', async () => {
    await w.tx(async (t) => {
      await notify(t, {
        userIds: [ada.userId],
        kind: 'compliance.rtw_missing',
        titleKey: 'notify.rtwCheckMissing',
        params: { name: 'Fictional', date: '2026-01-05' },
        email: false,
      });
      await notify(t, {
        userIds: [ada.userId],
        kind: 'report.ready',
        titleKey: 'notify.reportReady',
        link: 'https://elsewhere.example/app',
        email: false,
      });
    });
    const notes = (await w.api('GET', '/v1/me/notifications', undefined, ada.cookie)).json().data;
    expect(notes.find((x: { kind: string }) => x.kind === 'compliance.rtw_missing')).toMatchObject({
      target: null,
      href: '/app/compliance/right-to-work',
    });
    expect(notes.find((x: { kind: string }) => x.kind === 'report.ready')).toMatchObject({
      href: '/app/reports',
    });
    for (const n of notes) expect(n.href).toMatch(/^\/app(\/|\?|$)/);
  });

  it('e-mails the same page the bell opens', async () => {
    const sent = ctx.mailer.sent.length;
    await w.tx((t) =>
      notify(t, {
        userIds: [ada.userId],
        kind: 'leave.approved',
        titleKey: 'notify.leaveApproved',
        target: { type: 'leave_request', id: leaveId },
      }),
    );
    await w.drain();
    const mail = ctx.mailer.sent.slice(sent).find((m) => m.text.includes(`/app/time-off/${leaveId}`));
    expect(mail).toBeTruthy();
  });
});

describe("a person's compliance for their profile", () => {
  it('answers HR with the right-to-work checks of a UK employee, and audits the view as sensitive', async () => {
    const rec = await w.api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: w.people.ada,
      checkMethod: 'manual_document_check',
      listType: 'list_a',
      checkedOn: '2026-10-01',
    });
    expect(rec.statusCode, rec.body).toBe(201);
    const r = await w.api('GET', `/v1/compliance/people/${w.people.ada}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      employeeId: w.people.ada,
      employeeName: 'Ada Fictional',
      rightToWork: { status: 'valid', checks: [{ id: rec.json().id, current: true, listType: 'list_a' }] },
      i9: null,
    });
    const audited = await w.tx((t) =>
      t.maybe<{ sensitive: boolean }>(
        `SELECT sensitive FROM audit.events WHERE action = 'compliance.person_viewed' AND target_id = $1 ORDER BY at DESC LIMIT 1`,
        [w.people.ada],
      ),
    );
    expect(audited?.sensitive).toBe(true);
    // the check's own page: the manager sees it without the vault details
    const check = await w.api(
      'GET',
      `/v1/compliance/right-to-work/checks/${rec.json().id}`,
      undefined,
      mona.cookie,
    );
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toMatchObject({ employeeName: 'Ada Fictional', current: true, details: null });
  });

  it('refuses people outside the caller’s compliance scope', async () => {
    expect(
      (await w.api('GET', `/v1/compliance/people/${w.people.ada}`, undefined, ada.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await w.api('GET', `/v1/compliance/people/${w.people.dan}`, undefined, mona.cookie)).statusCode,
    ).toBe(403);
    expect(UUID.test(w.people.dan)).toBe(true);
  });
});

describe('Contact HR (ADR-0163)', () => {
  it('an employee asks HR; it lands as a task in the HR queue with the person linked, and they follow its status', async () => {
    const sent = await w.api(
      'POST',
      '/v1/hr-requests',
      { subject: 'Fictional question about my contract', message: 'Fictional details only.' },
      ada.cookie,
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().id as string;
    expect((await w.api('GET', '/v1/hr-requests', undefined, ada.cookie)).json()).toEqual([
      expect.objectContaining({ id, subject: 'Fictional question about my contract', status: 'open' }),
    ]);
    // the owner works the HR queue (this company has no HR admin) and is told about it
    const queue = (await w.api('GET', '/v1/tasks')).json();
    expect(queue.find((t: { id: string }) => t.id === id)).toMatchObject({
      source: 'hr_request',
      subjectEmployeeId: w.people.ada,
      href: `/app/tasks/${id}`,
    });
    const task = (await w.api('GET', `/v1/tasks/${id}`)).json();
    expect(task).toMatchObject({
      description: 'Fictional details only.',
      subject: { id: w.people.ada, name: 'Ada Fictional' },
      canComplete: true,
    });
    const ownerNotes = (await w.api('GET', '/v1/me/notifications')).json().data;
    const note = ownerNotes.find((n: { kind: string }) => n.kind === 'task.hr_request');
    expect(note).toMatchObject({ href: `/app/tasks/${id}` });
    expect(note.title).not.toContain('Fictional details only'); // the message is never in a notification
    // done: the person is told, and their list shows it
    expect((await w.api('POST', `/v1/tasks/${id}/complete`)).statusCode).toBe(200);
    const mine = (await w.api('GET', '/v1/hr-requests', undefined, ada.cookie)).json();
    expect(mine[0]).toMatchObject({ id, status: 'done' });
    const adaNotes = (await w.api('GET', '/v1/me/notifications', undefined, ada.cookie)).json().data;
    expect(adaNotes.find((n: { kind: string }) => n.kind === 'task.hr_request_done')).toMatchObject({
      href: `/app/contact-hr/${id}`,
    });
    // the request's own page: what they asked, and who closed it
    const own = await w.api('GET', `/v1/hr-requests/${id}`, undefined, ada.cookie);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({
      id,
      subject: 'Fictional question about my contract',
      message: 'Fictional details only.',
      status: 'done',
    });
    expect(own.json().completedByName).toBeTruthy();
    // someone else's request reads as missing, even to a manager
    expect((await w.api('GET', `/v1/hr-requests/${id}`, undefined, mona.cookie)).statusCode).toBe(404);
  });

  it('employees and managers contact HR, not Thapsus-HR support', async () => {
    for (const who of [ada, mona]) {
      expect((await w.api('GET', '/v1/hr-requests', undefined, who.cookie)).statusCode).toBe(200);
      const t = await w.api(
        'POST',
        '/v1/support/tickets',
        { subject: 'Fictional', body: 'Fictional', category: 'question', priority: 'low' },
        who.cookie,
      );
      expect(t.statusCode).toBe(403);
    }
    // nobody sees another person's requests
    expect((await w.api('GET', '/v1/hr-requests', undefined, dan.cookie)).json()).toEqual([]);
  });
});
