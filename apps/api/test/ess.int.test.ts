import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { widgets, type Widgets } from './reports-fixtures';
import { createTask, notify } from '../src/lib/notify';
import type { MemoryMailer } from '../src/lib/mailer';

/**
 * PROGRESS 7.4 employee self-service API: the "Me" hub summary, own details with change requests through
 * the approval flow, in-app notifications and email / web push preferences honoured at delivery.
 */
let ctx: TestContext;
let w: Widgets;
let ada: { cookie: string; userId: string };

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  w = await widgets(ctx);
  ada = await w.login(w.people.ada, 'employee', { type: 'self' });
  // leave defaults (types and the annual policy from the packs) are created on first use
  expect((await w.api('POST', '/v1/sickness', { employeeId: w.people.mona, startDate: '2026-05-05', endDate: '2026-05-05' })).statusCode).toBe(201);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('7.4 the Me hub', () => {
  it('summarises my leave, next shift, clock, documents to sign, tasks, notifications and payslips', async () => {
    const day = addDays(today('Europe/London'), 7);
    const shift = await w.api('POST', '/v1/shifts', { employeeId: w.people.ada, date: day, start: '09:00', end: '17:00', breakMinutes: 30 });
    expect(shift.statusCode, shift.body).toBe(201);
    expect((await w.api('POST', '/v1/rota/publish', { from: day, to: day })).statusCode).toBe(200);
    await w.tx(async (t) => {
      await createTask(t, { source: 'manual', title: 'Fictional checklist item', assigneeUserId: ada.userId, dueOn: '2026-01-05', dedupeKey: `ess-task-${ada.userId}` });
      await notify(t, { userIds: [ada.userId], kind: 'task.assigned', titleKey: 'notify.reportReady', link: '/app/tasks', email: false });
    });
    const s = await w.api('GET', '/v1/me/summary', undefined, ada.cookie);
    expect(s.statusCode, s.body).toBe(200);
    const body = s.json();
    expect(body.employee).toMatchObject({ id: w.people.ada, displayName: 'Ada Fictional' });
    expect(body.leave).toMatchObject({ unit: 'days', pending: 0 });
    expect(body.leave.available).toMatch(/^\d+(\.\d)?$/);
    expect(body.rota.nextShift).toMatchObject({ date: day, start: `${day}T09:00`, end: `${day}T17:00` });
    expect(body.clock).toEqual({ clockedIn: false, since: null });
    expect(body.tasks).toEqual({ open: 1, overdue: 1 });
    expect(body.notifications.unread).toBe(2); // the published rota and the task
    expect(body.payslips).toEqual({ total: 0, unviewed: 0, latest: null }); // wired to the phase 6 payslips
    expect(body.documents).toEqual({ toSign: 0 });
  });

  it('lists my notifications in my language and marks them read', async () => {
    const list = (await w.api('GET', '/v1/me/notifications', undefined, ada.cookie)).json();
    expect(list.unread).toBe(2);
    expect(list.data.map((n: { kind: string }) => n.kind).sort()).toEqual(['rota.published', 'task.assigned']);
    expect(list.data.find((n: { kind: string }) => n.kind === 'task.assigned')).toMatchObject({ category: 'task', title: 'A scheduled report is ready. Sign in to download it.', link: '/app/tasks', read: false });
    const one = list.data[0].id;
    expect((await w.api('POST', '/v1/me/notifications/read', { ids: [one] }, ada.cookie)).json()).toEqual({ updated: 1 });
    expect((await w.api('POST', '/v1/me/notifications/read', { all: true }, ada.cookie)).json()).toEqual({ updated: 1 });
    expect((await w.api('GET', '/v1/me/notifications?unread=true', undefined, ada.cookie)).json().data).toEqual([]);
  });
});

describe('7.4 own details', () => {
  it('shows my record with field access; contact details change directly, legal details go to HR for approval', async () => {
    const p = (await w.api('GET', '/v1/me/profile', undefined, ada.cookie)).json();
    expect(p.employee).toMatchObject({ id: w.people.ada, legalFirstName: 'Ada', legalLastName: 'Fictional', jobTitle: 'Analyst', payAmountMinor: '3640000' });
    expect(p.access).toMatchObject({ personalPhone: 'write', legalLastName: 'read', emergencyContacts: 'write' });
    expect(p.requestable).toEqual(['legalFirstName', 'legalLastName', 'dateOfBirth', 'nationality']);
    // a contact detail: the existing effective-dated change endpoint, applied straight away
    const direct = await w.api('POST', `/v1/employees/${w.people.ada}/changes`, { effectiveDate: today('Europe/London'), personalPhone: '+44 7700 900123' }, ada.cookie);
    expect(direct.statusCode, direct.body).toBe(200);
    // a legal name: a change request decided by HR (here the owner: the company has no HR admin)
    const req = await w.api('POST', '/v1/me/change-requests', { legalLastName: 'Fictional-Smith', reason: 'Fictional marriage' }, ada.cookie);
    expect(req.statusCode, req.body).toBe(202);
    expect(req.json().fields).toEqual(['legalLastName']);
    expect((await w.api('GET', '/v1/me/summary', undefined, ada.cookie)).json().changeRequests).toEqual({ pending: 1 });
    expect((await w.api('POST', `/v1/approvals/${req.json().approvalRequestId}/decide`, { decision: 'approve' }, ada.cookie)).statusCode).toBe(403); // never your own request
    const decided = await w.api('POST', `/v1/approvals/${req.json().approvalRequestId}/decide`, { decision: 'approve' });
    expect(decided.json()).toMatchObject({ status: 'approved' });
    expect((await w.api('GET', '/v1/me/profile', undefined, ada.cookie)).json().employee.legalLastName).toBe('Fictional-Smith');
    expect((await w.api('GET', '/v1/me/change-requests', undefined, ada.cookie)).json()[0]).toMatchObject({ status: 'approved', fields: ['legalLastName'] });
    const audit = await w.tx((t) => t.one<{ diff: Record<string, unknown> }>(`SELECT diff FROM audit.events WHERE action = 'employee.self_change_requested' ORDER BY id DESC LIMIT 1`));
    expect(JSON.stringify(audit.diff)).not.toContain('Fictional-Smith'); // field names, never values
    expect((await w.api('POST', '/v1/me/change-requests', {}, ada.cookie)).statusCode).toBe(400);
  });
});

describe('7.4 notification preferences', () => {
  it('turning off email for a category stops those emails; other categories still send; in-app is always kept', async () => {
    const prefs = await w.api('PUT', '/v1/me/notification-preferences', { categories: { leave: { email: false } } }, ada.cookie);
    expect(prefs.statusCode, prefs.body).toBe(200);
    expect(prefs.json().categories.leave).toEqual({ email: false, push: true });
    expect((await w.api('GET', '/v1/me/notification-preferences', undefined, ada.cookie)).json()).toMatchObject({ email: true, categories: { leave: { email: false }, task: { email: true } } });
    expect((await w.api('PUT', '/v1/me/notification-preferences', { categories: { nope: { email: false } } }, ada.cookie)).statusCode).toBe(400);
    const mailer = ctx.deps.mailer as MemoryMailer;
    const before = mailer.sent.length;
    await w.tx(async (t) => {
      await notify(t, { userIds: [ada.userId], kind: 'leave.approved', titleKey: 'notify.leaveApproved', link: '/app/time-off', dedupeKey: 'ess-pref-leave' });
      await notify(t, { userIds: [ada.userId], kind: 'task.assigned', titleKey: 'notify.reportReady', link: '/app/tasks', dedupeKey: 'ess-pref-task' });
    });
    await w.drain();
    const mine = mailer.sent.slice(before).filter((m) => m.to.startsWith('employee.'));
    expect(mine.filter((m) => m.text.includes('/app/time-off'))).toHaveLength(0); // leave emails are off
    expect(mine.filter((m) => m.text.includes('/app/tasks'))).toHaveLength(1);
    const inApp = (await w.api('GET', '/v1/me/notifications', undefined, ada.cookie)).json().data.map((n: { kind: string }) => n.kind);
    expect(inApp).toEqual(expect.arrayContaining(['leave.approved', 'task.assigned']));
    const off = await w.api('PUT', '/v1/me/notification-preferences', { email: false }, ada.cookie);
    expect(off.json().email).toBe(false);
  });
});
