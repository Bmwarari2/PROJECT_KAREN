import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { withTenant, type JobRow } from '@thapsus/db';
import { closeDb, cookieFrom, enrolTotp, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers, eventSubscribers } from '../src/worker';
import type { MemoryObjectStore } from '../src/lib/object-store';
import { pdfPageTexts, pdfText } from './pdf-text';

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let entity: string;
const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) => ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);

/** Runs every queued job (and outbox subscribers) for the tenant, like the worker would. */
async function drain() {
  for (let round = 0; round < 10; round++) {
    const events = await tx((t) => t.query<{ id: string; topic: string; aggregate_type: string | null; aggregate_id: string | null; payload: Record<string, unknown>; created_at: string }>(`UPDATE app.outbox SET published_at = now() WHERE published_at IS NULL RETURNING id, topic, aggregate_type, aggregate_id, payload, created_at`));
    for (const ev of events) {
      for (const [pattern, subs] of Object.entries(eventSubscribers)) {
        if (pattern === ev.topic || (pattern.endsWith('.*') && ev.topic.startsWith(pattern.slice(0, -1)))) {
          for (const s of subs) await tx((t) => s(t, { tenantId: owner.tenantId, id: ev.id, topic: ev.topic, aggregateType: ev.aggregate_type, aggregateId: ev.aggregate_id, payload: ev.payload, createdAt: ev.created_at }));
        }
      }
    }
    const jobs = await tx((t) => t.query<JobRow>(`UPDATE app.jobs SET status = 'running', attempts = attempts + 1 WHERE status = 'queued' RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`));
    if (!events.length && !jobs.length) return;
    for (const job of jobs) {
      const result = await jobHandlers[job.kind]!({ tenantId: owner.tenantId, job, deps: ctx.deps, tx: (fn) => tx(fn), progress: (d, total) => tx((t) => t.exec('UPDATE app.jobs SET progress_done = $2, progress_total = coalesce($3, progress_total) WHERE id = $1', [job.id, d, total ?? null])).then(() => undefined) });
      await tx((t) => t.exec(`UPDATE app.jobs SET status = 'succeeded', result = $2 WHERE id = $1`, [job.id, JSON.stringify(result ?? {})]));
    }
  }
}

async function hire(values: Record<string, unknown> = {}) {
  const res = await api('POST', '/v1/employees', { startDate: '2026-03-02', legalFirstName: 'Fictional', legalLastName: 'Person', jobTitle: 'Analyst', entityId: entity, payAmountMinor: 3_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent', ...values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function login(employeeId: string, role: string, scope: { type: 'all' | 'self' | 'own_team' } = { type: 'self' }) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  const userId = await tx(async (t) => {
    const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`, [email, employeeId]);
    await t.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
    await assignRole(t, u.id, role, scope);
    if (role !== 'employee') await assignRole(t, u.id, 'employee', { type: 'self' });
    return u.id;
  });
  const cookie = cookieFrom(await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: `10.70.${Math.floor(Math.random() * 250)}.2` }));
  return { cookie, userId };
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  entity = (await api('POST', '/v1/org/legal-entities', { name: 'Fictional Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' })).json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('documents', () => {
  it('validates uploads by type, size and content', async () => {
    const emp = await hire();
    expect((await api('POST', '/v1/documents', { title: 'Exe', fileName: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 10, employeeId: emp })).statusCode).toBe(400);
    expect((await api('POST', '/v1/documents', { title: 'Big', fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 100 * 1024 * 1024, employeeId: emp })).statusCode).toBe(400);
    const ok = await api('POST', '/v1/documents', { title: 'Passport scan', fileName: 'p.pdf', contentType: 'application/pdf', sizeBytes: 9, employeeId: emp, expiresOn: '2027-01-01' });
    expect(ok.statusCode).toBe(201);
    const store = ctx.deps.objects as MemoryObjectStore;
    const key = decodeURIComponent(ok.json().uploadUrl.replace('memory://put/', ''));
    expect(key.startsWith(`${owner.tenantId}/`)).toBe(true);
    await store.put(key, Buffer.from('not a pdf'), 'application/pdf');
    expect((await api('POST', `/v1/documents/${ok.json().id}/complete`)).statusCode).toBe(422);
    const good = await api('POST', '/v1/documents', { title: 'Contract', fileName: 'c.pdf', contentType: 'application/pdf', sizeBytes: 12, employeeId: emp });
    await store.put(decodeURIComponent(good.json().uploadUrl.replace('memory://put/', '')), Buffer.from('%PDF-1.7 ok'), 'application/pdf');
    const done = await api('POST', `/v1/documents/${good.json().id}/complete`);
    expect(done.json()).toMatchObject({ status: 'ready' });
    expect(done.json().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders templates with merge fields, collects a click-to-sign signature with a verifiable audit trail', async () => {
    const emp = await hire({ legalFirstName: 'Signe', legalLastName: 'Example' });
    const signer = await login(emp, 'employee');
    const bad = await api('POST', '/v1/document-templates', { name: 'Bad', body: 'Hello {{employee.nope}}' });
    const badGen = await api('POST', `/v1/document-templates/${bad.json().id}/generate`, { employeeId: emp });
    expect(badGen.statusCode).toBe(400);
    const tpl = await api('POST', '/v1/document-templates', { name: 'Offer letter', body: 'Dear {{employee.firstName}},\nYour title is {{employee.jobTitle}} at {{company.name}} on {{employee.salary}}.' });
    expect(tpl.json().mergeFields).toEqual(['employee.firstName', 'employee.jobTitle', 'company.name', 'employee.salary']);
    const gen = await api('POST', `/v1/document-templates/${tpl.json().id}/generate`, { employeeId: emp, requireSignature: true });
    expect(gen.statusCode).toBe(201);
    // the merged values are really in the rendered PDF (not just the template)
    const store = ctx.deps.objects as MemoryObjectStore;
    const generated = await tx((t) => t.one<{ file_key: string; sha256: string }>('SELECT file_key, sha256 FROM app.documents WHERE id = $1', [gen.json().documentId]));
    const generatedText = await pdfText(store.objects.get(generated.file_key)!.body);
    expect(generatedText).toContain('Offer letter');
    expect(generatedText).toContain('Dear Signe,');
    expect(generatedText).toContain(`Your title is Analyst at Fictional ${owner.slug} Ltd on £30,000.00.`);
    expect(generatedText).not.toContain('{{');
    const pending = (await api('GET', '/v1/signature-requests', undefined, signer.cookie)).json();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'pending', signedAt: null });
    const expectedSignedAt = ctx.deps.now().toISOString();
    const sign = await ctx.app.inject({ method: 'POST', url: `/v1/signature-requests/${pending[0].id}/sign`, payload: { consent: true, typedName: 'Signe Example' }, headers: { cookie: signer.cookie, 'user-agent': 'FictionalBrowser/1.0' }, remoteAddress: '10.77.1.23' });
    expect(sign.statusCode, sign.body).toBe(200);
    const { documentSha256, signedSha256, signedDocumentId } = sign.json();
    // the hash is of the exact document that was generated and shown to the signer
    expect(documentSha256).toBe(generated.sha256);
    // signed PDF = original + certificate page
    const signedRow = await tx((t) => t.one<{ file_key: string }>('SELECT file_key FROM app.documents WHERE id = $1', [signedDocumentId]));
    const signedPdf = await PDFDocument.load(store.objects.get(signedRow.file_key)!.body);
    expect(signedPdf.getPageCount()).toBe(2);
    const [page1, certificate] = (await pdfPageTexts(store.objects.get(signedRow.file_key)!.body)).map((p) => p.replace(/\s+/g, ' '));
    expect(page1).toContain('Dear Signe,');
    for (const evidence of ['Signe Example', expectedSignedAt, '10.77.1.23', 'FictionalBrowser/1.0', documentSha256, pending[0].id]) expect(certificate, evidence).toContain(evidence);
    const verify = (await api('GET', `/v1/signature-requests/${pending[0].id}/verify`)).json();
    expect(verify).toMatchObject({ valid: true, signerName: 'Signe Example', documentSha256, signedSha256 });
    expect(new Date(verify.signedAt).toISOString()).toBe(expectedSignedAt);
    const sr = await tx((t) => t.one<{ signer_ip: string; signed_at: string; signer_user_id: string; signer_user_agent: string; status: string }>('SELECT host(signer_ip) AS signer_ip, signed_at, signer_user_id, signer_user_agent, status FROM app.signature_requests WHERE id = $1', [pending[0].id]));
    expect(sr).toMatchObject({ signer_ip: '10.77.1.23', signer_user_id: signer.userId, signer_user_agent: 'FictionalBrowser/1.0', status: 'signed' });
    expect(new Date(sr.signed_at).toISOString()).toBe(expectedSignedAt);
    const signedList = (await api('GET', '/v1/signature-requests', undefined, signer.cookie)).json();
    expect(new Date(signedList[0].signedAt).toISOString()).toBe(expectedSignedAt);
    const audit = await tx((t) => t.one<{ actor_id: string; diff: { documentSha256: string } }>(`SELECT actor_id, diff FROM audit.events WHERE action = 'document.signed' AND target_id = $1`, [pending[0].id]));
    expect(audit).toMatchObject({ actor_id: signer.userId, diff: { documentSha256 } });
    expect((await api('POST', `/v1/signature-requests/${pending[0].id}/sign`, { consent: true, typedName: 'Again' }, signer.cookie)).statusCode).toBe(409);
    // tampering with the stored signed file breaks verification
    store.objects.get(signedRow.file_key)!.body = Buffer.concat([store.objects.get(signedRow.file_key)!.body, Buffer.from('x')]);
    expect((await api('GET', `/v1/signature-requests/${pending[0].id}/verify`)).json().valid).toBe(false);
  });

  it('folder permissions decide who sees and downloads each document', async () => {
    const folder = async (visibility: string) => (await api('POST', '/v1/document-folders', { name: `Folder ${visibility}`, visibility })).json().id as string;
    const folders = { hr: await folder('hr'), managers: await folder('managers'), employee: await folder('employee'), everyone: await folder('everyone') };
    const mgrEmp = await hire({ legalFirstName: 'Folder', legalLastName: 'Manager' });
    const emp = await hire({ legalFirstName: 'Folder', legalLastName: 'Owner', managerId: mgrEmp });
    const colleague = await hire({ legalFirstName: 'Folder', legalLastName: 'Colleague' });
    const insert = (title: string, folderId: string | null, employeeId: string | null) =>
      tx((t) => t.one<{ id: string }>(`INSERT INTO app.documents (tenant_id, folder_id, employee_id, title, file_key, file_name, content_type, status) VALUES (app.current_tenant(), $1, $2, $3, $4, 'f.pdf', 'application/pdf', 'ready') RETURNING id`, [folderId, employeeId, title, `${owner.tenantId}/test/${title}`])).then((r) => r.id);
    const docs: Record<string, string> = {};
    for (const [vis, id] of Object.entries(folders)) {
      docs[`person-${vis}`] = await insert(`person-${vis}`, id, emp);
      docs[`company-${vis}`] = await insert(`company-${vis}`, id, null);
    }
    docs['person-none'] = await insert('person-none', null, emp);
    docs['company-none'] = await insert('company-none', null, null);

    const self = await login(emp, 'employee');
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const other = await login(colleague, 'employee');
    const titles = async (cookie: string, query = '') => ((await api('GET', `/v1/documents${query}`, undefined, cookie)).json() as Array<{ title: string }>).map((d) => d.title).filter((t) => t.startsWith('person-') || t.startsWith('company-')).sort();
    const expectSeen = {
      owner: ['company-employee', 'company-everyone', 'company-hr', 'company-managers', 'company-none', 'person-employee', 'person-everyone', 'person-hr', 'person-managers', 'person-none'],
      self: ['company-employee', 'company-everyone', 'person-employee', 'person-everyone', 'person-none'],
      manager: ['company-employee', 'company-everyone', 'company-managers', 'person-employee', 'person-everyone', 'person-managers', 'person-none'],
      colleague: ['company-employee', 'company-everyone', 'person-everyone'],
    };
    expect(await titles(owner.cookie)).toEqual(expectSeen.owner);
    expect(await titles(self.cookie)).toEqual(expectSeen.self);
    expect(await titles(mgr.cookie)).toEqual(expectSeen.manager);
    expect(await titles(other.cookie)).toEqual(expectSeen.colleague);
    // the per-person view applies the same folder rules
    expect(await titles(self.cookie, `?employeeId=${emp}`)).toEqual(['person-employee', 'person-everyone', 'person-none']);
    expect(await titles(mgr.cookie, `?employeeId=${emp}`)).toEqual(['person-employee', 'person-everyone', 'person-managers', 'person-none']);
    expect((await api('GET', `/v1/documents?employeeId=${emp}`, undefined, other.cookie)).statusCode).toBe(403);
    expect(await titles(owner.cookie, `?folderId=${folders.hr}`)).toEqual(['company-hr', 'person-hr']);
    // downloads follow exactly the same rules as the lists
    const all = Object.keys(docs);
    for (const [who, cookie] of [['owner', owner.cookie], ['self', self.cookie], ['manager', mgr.cookie], ['colleague', other.cookie]] as const) {
      for (const title of all) {
        const res = await api('GET', `/v1/documents/${docs[title]}/download`, undefined, cookie);
        expect(res.statusCode, `${who} downloads ${title}`).toBe(expectSeen[who].includes(title) ? 200 : 403);
      }
    }
    // only HR can create folders; a person may not file their own document where they could not see it
    expect((await api('POST', '/v1/document-folders', { name: 'Mine', visibility: 'everyone' }, mgr.cookie)).statusCode).toBe(403);
    expect((await api('POST', '/v1/documents', { title: 'Own note', fileName: 'n.pdf', contentType: 'application/pdf', sizeBytes: 10, employeeId: emp, folderId: folders.hr }, self.cookie)).statusCode).toBe(403);
    expect((await api('POST', '/v1/documents', { title: 'Own note', fileName: 'n.pdf', contentType: 'application/pdf', sizeBytes: 10, employeeId: emp, folderId: folders.employee }, self.cookie)).statusCode).toBe(201);
  });

  it('bulk-sends to a filtered set as a background job with progress', async () => {
    const dept = (await api('POST', '/v1/org/departments', { name: 'Bulk dept' })).json().id;
    const ids = [await hire({ departmentId: dept }), await hire({ departmentId: dept }), await hire({ departmentId: dept })];
    const tpl = await api('POST', '/v1/document-templates', { name: 'Policy update', body: 'Hi {{employee.displayName}}' });
    const res = await api('POST', '/v1/documents/bulk-send', { templateId: tpl.json().id, filter: { departmentId: dept }, requireSignature: true });
    expect(res.statusCode).toBe(202);
    expect(res.json().recipients).toBe(3);
    await drain();
    const job = (await api('GET', `/v1/jobs/${res.json().jobId}`)).json();
    expect(job).toMatchObject({ status: 'succeeded', progressDone: '3', progressTotal: '3' });
    for (const id of ids) expect((await api('GET', `/v1/documents?employeeId=${id}`)).json().some((d: { title: string }) => d.title === 'Policy update')).toBe(true);
  });

  it('sends expiry reminders once per threshold', async () => {
    const emp = await hire();
    await tx((t) => t.exec(`INSERT INTO app.documents (tenant_id, employee_id, title, file_key, file_name, content_type, status, expires_on) VALUES (app.current_tenant(), $1, 'Visa', 'k', 'v.pdf', 'application/pdf', 'ready', '2026-11-17')`, [emp]));
    const run = () => jobHandlers['documents.expiry_reminders']!({ tenantId: owner.tenantId, job: { id: 'j', tenant_id: owner.tenantId, kind: 'documents.expiry_reminders', idempotency_key: 'x', input: { date: '2026-10-18' }, attempts: 1, created_by: null }, deps: ctx.deps, tx: (fn) => tx(fn), progress: async () => undefined });
    expect((await run())!.sent).toBeGreaterThan(0);
    expect((await run())!.sent).toBe(0);
  });
});

describe('workflows', () => {
  it('auto-starts onboarding with relative due dates and role/manager assignees, and completes', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Manny' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    await api('POST', '/v1/workflow-templates', {
      kind: 'onboarding',
      name: 'Standard onboarding',
      tasks: [
        { key: 'laptop', title: 'Order laptop', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: -5 },
        { key: 'buddy', title: 'Assign a buddy', assignee: { type: 'manager' }, dueOffsetDays: 0 },
      ],
    });
    const emp = await hire({ startDate: '2026-12-01', managerId: mgrEmp });
    await drain();
    const wf = (await api('GET', `/v1/workflows?employeeId=${emp}`)).json();
    expect(wf).toHaveLength(1);
    expect(wf[0]).toMatchObject({ kind: 'onboarding', taskCount: 2, doneCount: 0 });
    const mgrTasks = (await api('GET', '/v1/tasks', undefined, mgr.cookie)).json();
    const buddy = mgrTasks.find((t: { title: string }) => t.title === 'Assign a buddy');
    expect(buddy.dueOn).toBe('2026-12-01');
    const hrTasks = (await api('GET', '/v1/tasks')).json();
    const laptop = hrTasks.find((t: { title: string; subjectEmployeeId: string }) => t.title === 'Order laptop' && t.subjectEmployeeId === emp);
    expect(laptop.dueOn).toBe('2026-11-26');
    await api('POST', `/v1/tasks/${buddy.id}/complete`, undefined, mgr.cookie);
    await api('POST', `/v1/tasks/${laptop.id}/complete`);
    expect((await api('GET', `/v1/workflows?employeeId=${emp}`)).json()[0].status).toBe('completed');
    // the same event delivered twice does not start a second workflow
    await tx((t) => t.exec(`UPDATE app.outbox SET published_at = NULL WHERE aggregate_id = $1`, [emp]));
    await drain();
    expect((await api('GET', `/v1/workflows?employeeId=${emp}`)).json()).toHaveLength(1);
  });

  it('transfers an employee with effective dating and starts transfer workflows', async () => {
    const other = (await api('POST', '/v1/org/legal-entities', { name: 'Fictional Second Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' })).json().id;
    await api('POST', '/v1/workflow-templates', { kind: 'transfer', name: 'Transfer checklist', tasks: [{ key: 'contract', title: 'Issue new contract', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: 0 }] });
    const emp = await hire();
    expect((await api('POST', `/v1/employees/${emp}/transfer`, { effectiveDate: '2027-01-01', entityId: other, jobTitle: 'Senior analyst' })).statusCode).toBe(200);
    await drain();
    expect((await api('GET', `/v1/employees/${emp}?asOf=2026-12-31`)).json().employee.entityId).toBe(entity);
    expect((await api('GET', `/v1/employees/${emp}?asOf=2027-01-01`)).json().employee.entityId).toBe(other);
    expect((await api('GET', `/v1/workflows?employeeId=${emp}`)).json().map((w: { kind: string }) => w.kind)).toContain('transfer');
  });
});

describe('workflow due dates, assignees and reminders', () => {
  const runReminders = (date: string) =>
    jobHandlers['tasks.reminders']!({ tenantId: owner.tenantId, job: { id: 'r', tenant_id: owner.tenantId, kind: 'tasks.reminders', idempotency_key: date, input: { date }, attempts: 1, created_by: null }, deps: ctx.deps, tx: (fn) => tx(fn), progress: async () => undefined });

  it('assigns tasks to a named person and reminds them at the lead time set on each task, then once when overdue', async () => {
    const assigneeEmp = await hire({ legalFirstName: 'Remy', legalLastName: 'Assignee' });
    const assignee = await login(assigneeEmp, 'employee');
    const tpl = (await api('POST', '/v1/workflow-templates', {
      kind: 'custom',
      name: 'Reminder lead times',
      autoStart: false,
      tasks: [
        { key: 'early', title: 'Early reminder task', assignee: { type: 'user', value: assignee.userId }, dueOffsetDays: 10, reminderDaysBefore: 5 },
        { key: 'late', title: 'Late reminder task', assignee: { type: 'user', value: assignee.userId }, dueOffsetDays: 10, reminderDaysBefore: 1 },
        { key: 'default', title: 'Default reminder task', assignee: { type: 'user', value: assignee.userId }, dueOffsetDays: 10 },
      ],
    })).json().id;
    const subject = await hire({ legalFirstName: 'Reminded' });
    expect((await api('POST', '/v1/workflows', { templateId: tpl, employeeId: subject, anchorDate: '2027-03-01' })).statusCode).toBe(201);
    const mine = ((await api('GET', '/v1/tasks', undefined, assignee.cookie)).json() as Array<{ title: string; dueOn: string; subjectEmployeeId: string }>).filter((t) => t.subjectEmployeeId === subject);
    expect(mine.map((t) => [t.title, t.dueOn]).sort()).toEqual([['Default reminder task', '2027-03-11'], ['Early reminder task', '2027-03-11'], ['Late reminder task', '2027-03-11']]);
    // nobody else gets a person-assigned task
    expect(((await api('GET', '/v1/tasks')).json() as Array<{ subjectEmployeeId: string; title: string }>).filter((t) => t.subjectEmployeeId === subject && t.title.endsWith('reminder task'))).toEqual([]);
    const stored = await tx((t) => t.query<{ title: string; reminder_days_before: number | null }>(`SELECT title, reminder_days_before FROM app.tasks WHERE subject_employee_id = $1 AND source = 'workflow' ORDER BY title`, [subject]));
    expect(stored.map((r) => [r.title, r.reminder_days_before])).toEqual([['Default reminder task', null], ['Early reminder task', 5], ['Late reminder task', 1]]);

    const reminded = async () =>
      (await tx((t) => t.query<{ title_key: string; title: string }>(`SELECT title_key, params->>'title' AS title FROM app.notifications WHERE user_id = $1 AND kind IN ('task.due', 'task.overdue') AND params->>'title' LIKE '%reminder task' ORDER BY created_at, title`, [assignee.userId]))).map((n) => `${n.title_key}:${n.title}`);
    await runReminders('2027-03-05');
    expect(await reminded()).toEqual([]);
    await runReminders('2027-03-06'); // 5 days before
    expect(await reminded()).toEqual(['notify.taskDueSoon:Early reminder task']);
    await runReminders('2027-03-09'); // the default lead time (2 days)
    expect(await reminded()).toEqual(['notify.taskDueSoon:Early reminder task', 'notify.taskDueSoon:Default reminder task']);
    await runReminders('2027-03-10');
    await runReminders('2027-03-10'); // idempotent
    expect(await reminded()).toHaveLength(3);
    expect((await reminded()).at(-1)).toBe('notify.taskDueSoon:Late reminder task');
    // completed tasks are not chased
    const early = mine.find((t) => t.title === 'Early reminder task') as unknown as { id: string };
    await api('POST', `/v1/tasks/${early.id}/complete`, undefined, assignee.cookie);
    await runReminders('2027-03-12');
    await runReminders('2027-03-13');
    expect((await reminded()).filter((r) => r.startsWith('notify.taskOverdue')).sort()).toEqual(['notify.taskOverdue:Default reminder task', 'notify.taskOverdue:Late reminder task']);
    // reminders are emailed through the delivery job
    const delivery = await tx((t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs j JOIN app.notifications n ON n.id::text = j.idempotency_key WHERE j.kind = 'notifications.deliver' AND n.user_id = $1 AND n.kind = 'task.overdue'`, [assignee.userId]));
    expect(delivery.n).toBe(2);
  });

  it('starts offboarding automatically on termination with due dates relative to the leave date', async () => {
    await api('POST', '/v1/workflow-templates', {
      kind: 'offboarding',
      name: 'Leaver checklist',
      tasks: [
        { key: 'equipment', title: 'Collect equipment', assignee: { type: 'manager' }, dueOffsetDays: -3, reminderDaysBefore: 7 },
        { key: 'exit', title: 'Exit interview', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: -1 },
        { key: 'access', title: 'Remove access', assignee: { type: 'role', value: 'hr_admin' }, dueOffsetDays: 1 },
      ],
    });
    const mgrEmp = await hire({ legalFirstName: 'Leaving', legalLastName: 'Manager' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const emp = await hire({ legalFirstName: 'Leaving', managerId: mgrEmp });
    await drain();
    expect((await api('GET', `/v1/workflows?employeeId=${emp}`)).json().map((w: { kind: string }) => w.kind)).not.toContain('offboarding');
    expect((await api('POST', `/v1/employees/${emp}/terminate`, { endDate: '2027-02-26', reason: 'Resignation' })).statusCode).toBe(200);
    await drain();
    const wf = ((await api('GET', `/v1/workflows?employeeId=${emp}`)).json() as Array<{ id: string; kind: string; anchorDate: string; taskCount: number; templateName: string }>).find((w) => w.kind === 'offboarding');
    expect(wf).toMatchObject({ anchorDate: '2027-02-26', taskCount: 3, templateName: 'Leaver checklist' });
    const tasks = await tx((t) => t.query<{ title: string; due_on: string; assignee_user_id: string | null; assignee_role: string | null; reminder_days_before: number | null }>(`SELECT title, due_on, assignee_user_id, assignee_role, reminder_days_before FROM app.tasks WHERE source = 'workflow' AND source_id = $1 ORDER BY due_on`, [wf!.id]));
    expect(tasks.map((r) => [r.title, r.due_on, r.assignee_user_id, r.assignee_role, r.reminder_days_before])).toEqual([
      ['Collect equipment', '2027-02-23', mgr.userId, null, 7],
      ['Exit interview', '2027-02-25', null, 'hr_admin', null],
      ['Remove access', '2027-02-27', null, 'hr_admin', null],
    ]);
    // the same termination event redelivered does not start a second offboarding
    await tx((t) => t.exec(`UPDATE app.outbox SET published_at = NULL WHERE aggregate_id = $1 AND topic = 'employee.terminated'`, [emp]));
    await drain();
    expect(((await api('GET', `/v1/workflows?employeeId=${emp}`)).json() as Array<{ kind: string }>).filter((w) => w.kind === 'offboarding')).toHaveLength(1);
  });

  it('a transfer changes location and job with effective dating and dates its tasks from the transfer date', async () => {
    const leeds = (await api('POST', '/v1/org/locations', { name: 'Fictional Leeds office', entityId: entity, country: 'GB', regionCode: 'GB-ENG', timeZone: 'Europe/London' })).json().id;
    const glasgow = (await api('POST', '/v1/org/locations', { name: 'Fictional Glasgow office', entityId: entity, country: 'GB', regionCode: 'GB-SCT', timeZone: 'Europe/London' })).json().id;
    await api('POST', '/v1/workflow-templates', {
      kind: 'transfer',
      name: 'Relocation checklist',
      tasks: [
        { key: 'desk', title: 'Book a desk at the new site', assignee: { type: 'employee' }, dueOffsetDays: -7 },
        { key: 'induction', title: 'Run the site induction', assignee: { type: 'manager' }, dueOffsetDays: 2 },
      ],
    });
    const mgrEmp = await hire({ legalFirstName: 'Site', legalLastName: 'Manager' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const emp = await hire({ legalFirstName: 'Mover', locationId: leeds, managerId: mgrEmp });
    const self = await login(emp, 'employee');
    expect((await api('POST', `/v1/employees/${emp}/transfer`, { effectiveDate: '2027-04-05', locationId: glasgow, jobTitle: 'Site lead', reason: 'Relocation' })).statusCode).toBe(200);
    await drain();
    expect((await api('GET', `/v1/employees/${emp}?asOf=2027-04-04`)).json().employee).toMatchObject({ locationId: leeds, location: 'Fictional Leeds office', jobTitle: 'Analyst' });
    expect((await api('GET', `/v1/employees/${emp}?asOf=2027-04-05`)).json().employee).toMatchObject({ locationId: glasgow, location: 'Fictional Glasgow office', jobTitle: 'Site lead', entityId: entity });
    const jobs = (await api('GET', `/v1/employees/${emp}/history`)).json().job as Array<{ location_id: string; valid_from: string; valid_to: string | null }>;
    expect(jobs.map((j) => [j.location_id, j.valid_from, j.valid_to])).toEqual([[leeds, '2026-03-02', '2027-04-05'], [glasgow, '2027-04-05', null]]);
    const wf = ((await api('GET', `/v1/workflows?employeeId=${emp}`)).json() as Array<{ kind: string; anchorDate: string; templateName: string }>).find((w) => w.templateName === 'Relocation checklist');
    expect(wf).toMatchObject({ kind: 'transfer', anchorDate: '2027-04-05' });
    expect(((await api('GET', '/v1/tasks', undefined, self.cookie)).json() as Array<{ title: string; dueOn: string }>).find((t) => t.title === 'Book a desk at the new site')?.dueOn).toBe('2027-03-29');
    expect(((await api('GET', '/v1/tasks', undefined, mgr.cookie)).json() as Array<{ title: string; dueOn: string; subjectEmployeeId: string }>).find((t) => t.title === 'Run the site induction' && t.subjectEmployeeId === emp)?.dueOn).toBe('2027-04-07');
    const audit = await tx((t) => t.one<{ diff: { changes: Record<string, { from: unknown; to: unknown }> } }>(`SELECT diff FROM audit.events WHERE action = 'employee.transferred' AND target_id = $1`, [emp]));
    expect(audit.diff.changes).toMatchObject({ locationId: { from: leeds, to: glasgow }, jobTitle: { from: 'Analyst', to: 'Site lead' } });
  });
});

describe('approvals', () => {
  it('multi-step conditional approval with delegation, then applies the change', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Approver' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    const deputyEmp = await hire({ legalFirstName: 'Deputy' });
    const deputy = await login(deputyEmp, 'employee');
    await api('POST', '/v1/approval-policies', {
      subject: 'employee.change',
      name: 'Pay change approval',
      condition: { field: 'payAmountMinor', op: 'present' },
      steps: [{ approver: { type: 'manager' } }, { approver: { type: 'role', value: 'owner' }, condition: { field: 'payAmountMinor', op: 'gt', value: 5_000_000 } }],
    });
    const emp = await hire({ managerId: mgrEmp });
    // manager delegates to a deputy while away
    await api('POST', '/v1/delegations', { toUserId: deputy.userId, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() }, mgr.cookie);
    // small raise: one step
    const small = await api('POST', `/v1/employees/${emp}/changes`, { effectiveDate: '2026-06-01', payAmountMinor: 3_200_000 });
    expect(small.statusCode).toBe(202);
    const deputyInbox = (await api('GET', '/v1/approvals', undefined, deputy.cookie)).json();
    expect(deputyInbox.map((r: { id: string }) => r.id)).toContain(small.json().approvalRequestId);
    expect((await api('POST', `/v1/approvals/${small.json().approvalRequestId}/decide`, { decision: 'approve' }, deputy.cookie)).json().status).toBe('approved');
    expect((await api('GET', `/v1/employees/${emp}?asOf=2026-06-01`)).json().employee.payAmountMinor).toBe('3200000');
    // big raise: manager then owner (conditional second step)
    const big = await api('POST', `/v1/employees/${emp}/changes`, { effectiveDate: '2026-07-01', payAmountMinor: 6_000_000 });
    const rid = big.json().approvalRequestId;
    expect((await api('POST', `/v1/approvals/${rid}/decide`, { decision: 'approve' }, mgr.cookie)).json().status).toBe('pending');
    expect((await api('GET', `/v1/employees/${emp}?asOf=2026-07-01`)).json().employee.payAmountMinor).toBe('3200000');
    expect((await api('POST', `/v1/approvals/${rid}/decide`, { decision: 'approve' }, deputy.cookie)).statusCode).toBe(403);
    // owner requested it, so the owner cannot approve their own request
    expect((await api('POST', `/v1/approvals/${rid}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    // non-pay changes need no approval
    expect((await api('POST', `/v1/employees/${emp}/changes`, { effectiveDate: '2026-07-01', jobTitle: 'Analyst II' })).statusCode).toBe(200);
    const history = await tx((t) => t.query<{ action: string }>(`SELECT action FROM audit.events WHERE target_id = $1 AND action LIKE 'approval.%' ORDER BY id`, [rid]));
    expect(history.map((h) => h.action)).toEqual(['approval.approved']);
  });

  it('escalates on timeout and supports bulk decisions with a result summary', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Slow' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    await api('POST', '/v1/approval-policies', { subject: 'employee.change', name: 'Contract change approval', priority: 1, condition: { field: 'contractType', op: 'present' }, steps: [{ approver: { type: 'manager' }, timeoutHours: 1, escalateTo: { type: 'role', value: 'owner' } }] });
    const a = await hire({ managerId: mgrEmp });
    const b = await hire({ managerId: mgrEmp });
    const r1 = (await api('POST', `/v1/employees/${a}/changes`, { effectiveDate: '2026-08-01', contractType: 'fixed_term' })).json().approvalRequestId;
    const r2 = (await api('POST', `/v1/employees/${b}/changes`, { effectiveDate: '2026-08-01', contractType: 'fixed_term' })).json().approvalRequestId;
    await tx((t) => t.exec(`UPDATE app.approval_steps SET due_at = now() - interval '1 minute' WHERE request_id = $1`, [r1]));
    await jobHandlers['approvals.escalate']!({ tenantId: owner.tenantId, job: { id: 'e', tenant_id: owner.tenantId, kind: 'approvals.escalate', idempotency_key: 'e', input: {}, attempts: 1, created_by: null }, deps: ctx.deps, tx: (fn) => tx(fn), progress: async () => undefined });
    const step = await tx((t) => t.one<{ approver_user_ids: string[] }>('SELECT approver_user_ids FROM app.approval_steps WHERE request_id = $1', [r1]));
    expect(step.approver_user_ids).toContain(owner.userId);
    const bulk = (await api('POST', '/v1/approvals/bulk', { ids: [r1, r2, '00000000-0000-4000-8000-000000000000'], decision: 'reject', comment: 'Not this quarter' }, mgr.cookie)).json();
    expect(bulk.succeeded.sort()).toEqual([r1, r2].sort());
    expect(bulk.failed).toEqual([{ id: '00000000-0000-4000-8000-000000000000', code: 'notFound' }]);
  });

  it('bulk edit checks permissions per employee and summarises results', async () => {
    const ids = [await hire(), await hire()];
    const res = (await api('POST', '/v1/employees/bulk-change', { employeeIds: [...ids, '00000000-0000-4000-8000-000000000001'], effectiveDate: '2026-09-01', values: { weeklyHours: 35 } })).json();
    expect(res.updated).toBe(2);
    expect(res.failed).toHaveLength(1);
  });
});

describe('automation rules', () => {
  it('runs on record events idempotently, with dry-run and an execution log', async () => {
    const hooks: string[] = [];
    ctx.deps.fetch = (async (url: string) => {
      hooks.push(url);
      return new Response('ok');
    }) as typeof fetch;
    const rule = (await api('POST', '/v1/automation/rules', {
      name: 'Part-time joiners need a hours review',
      trigger: { type: 'record.created', entity: 'employee' },
      conditions: [{ field: 'employmentType', op: 'eq', value: 'part_time' }],
      actions: [{ type: 'task', title: 'Review working hours', assignee: { type: 'role', value: 'hr_admin' }, dueInDays: 7 }, { type: 'webhook', url: 'https://hooks.example.test/hr' }],
    })).json().id;
    const pt = await hire({ employmentType: 'part_time', fte: 0.5 });
    const ft = await hire({ employmentType: 'full_time' });
    const dry = (await api('POST', `/v1/automation/rules/${rule}/dry-run`, { employeeId: pt })).json();
    expect(dry).toMatchObject({ matched: true, candidates: 1 });
    expect(dry.actions.map((a: { type: string }) => a.type)).toEqual(['task', 'webhook']);
    expect(hooks).toHaveLength(0); // dry run never executes
    await drain();
    const tasks = (await api('GET', '/v1/tasks')).json().filter((t: { title: string }) => t.title === 'Review working hours');
    expect(tasks.map((t: { subjectEmployeeId: string }) => t.subjectEmployeeId)).toEqual([pt]);
    expect(hooks).toEqual(['https://hooks.example.test/hr']);
    // redelivery is a no-op
    await tx((t) => t.exec(`UPDATE app.outbox SET published_at = NULL WHERE aggregate_id = $1`, [pt]));
    await tx((t) => t.exec(`DELETE FROM app.jobs WHERE kind = 'automation.evaluate'`));
    await drain();
    expect(hooks).toHaveLength(1);
    const runs = (await api('GET', `/v1/automation/rules/${rule}/runs`)).json();
    expect(runs.some((r: { dryRun: boolean; status: string }) => !r.dryRun && r.status === 'succeeded')).toBe(true);
    expect(runs.some((r: { dryRun: boolean }) => r.dryRun)).toBe(true);
    void ft;
  });

  it('date-reached rules fire on the day (work anniversary)', async () => {
    const rule = (await api('POST', '/v1/automation/rules', { name: 'Anniversary', trigger: { type: 'date.reached', dateField: 'workAnniversary', offsetDays: 0 }, actions: [{ type: 'notification', to: { type: 'employee' }, message: 'Happy work anniversary' }] })).json().id;
    const emp = await hire({ startDate: '2024-10-18' });
    await login(emp, 'employee');
    const res = await jobHandlers['automation.daily']!({ tenantId: owner.tenantId, job: { id: 'd', tenant_id: owner.tenantId, kind: 'automation.daily', idempotency_key: 'd', input: { date: '2026-10-18' }, attempts: 1, created_by: null }, deps: ctx.deps, tx: (fn) => tx(fn), progress: async () => undefined });
    expect(res!.ran).toBeGreaterThanOrEqual(1);
    const runs = (await api('GET', `/v1/automation/rules/${rule}/runs`)).json();
    expect(runs[0].eventKey).toBe(`date:${emp}:2026-10-18`);
  });
});

describe('bulk import and export', () => {
  const upload = (name: string, body: string | Buffer) => {
    const boundary = '----thapsus' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(body), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return ctx.app.inject({ method: 'POST', url: '/v1/imports', payload, headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };

  it('previews with row-level errors, runs as a job with an error report, and re-running is idempotent', async () => {
    const csv = ['Employee ID,First name,Last name,Start date,Job title,Entity,Salary,Currency,Pay frequency,Contract type,Manager', 'IMP001,Ada,Fictional,2026-01-05,Engineer,Fictional Ltd,50000,GBP,annual,permanent,', 'IMP002,Bo,Fictional,2026-02-01,Engineer,Fictional Ltd,48000.50,GBP,annual,permanent,IMP001', 'IMP003,Cy,Fictional,not-a-date,Engineer,Nowhere Ltd,abc,GBP,annual,permanent,'].join('\n');
    const up = await upload('people.csv', csv);
    expect(up.statusCode, up.body).toBe(201);
    const { id, suggestedMapping } = up.json();
    expect(suggestedMapping).toMatchObject({ 'Employee ID': 'employeeNumber', 'First name': 'legalFirstName', Salary: 'payAmountMinor', Entity: 'entityName', Manager: 'managerEmployeeNumber' });
    const mapping = { ...suggestedMapping, 'Start date': 'startDate', 'Job title': 'jobTitle', 'Pay frequency': 'payFrequency', 'Contract type': 'contractType' };
    const preview = (await api('POST', `/v1/imports/${id}/preview`, { mapping })).json();
    expect(preview).toMatchObject({ rows: 3, valid: 2, creates: 2 });
    expect(preview.errors.map((e: { row: number; column: string }) => `${e.row}:${e.column}`).sort()).toEqual(['4:entityName', '4:payAmountMinor', '4:startDate']);
    const run = (await api('POST', `/v1/imports/${id}/run`, {})).json();
    await drain();
    const status = (await api('GET', `/v1/imports/${id}`)).json();
    expect(status.stats).toMatchObject({ created: 2, failed: 1, errors: 3 });
    expect(status.errorReportUrl).toBeTruthy();
    const bo = await tx((t) => t.one<{ manager_id: string; id: string }>(`SELECT id, manager_id FROM app.employees WHERE employee_number = 'IMP002'`));
    const ada = await tx((t) => t.one<{ id: string }>(`SELECT id FROM app.employees WHERE employee_number = 'IMP001'`));
    expect(bo.manager_id).toBe(ada.id);
    expect((await api('GET', `/v1/employees/${bo.id}`)).json().employee.payAmountMinor).toBe('4800050');
    // running the same file again reuses the same job (idempotent) …
    expect((await api('POST', `/v1/imports/${id}/run`, {})).json()).toEqual({ jobId: run.jobId, created: false });
    // … and uploading it again changes nothing
    const again = await upload('people.csv', csv);
    await api('POST', `/v1/imports/${again.json().id}/preview`, { mapping });
    await api('POST', `/v1/imports/${again.json().id}/run`, {});
    await drain();
    expect((await api('GET', `/v1/imports/${again.json().id}`)).json().stats).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const hist = (await api('GET', `/v1/employees/${bo.id}/history`)).json();
    expect(hist.job).toHaveLength(1);
  });

  it('exports CSV and Excel respecting field-level permissions', async () => {
    const csv = await api('GET', '/v1/exports/employees?format=csv&fields=employeeNumber,displayName,payAmountMinor');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('employeeNumber,displayName,payAmountMinor');
    const xlsx = await api('GET', '/v1/exports/employees?format=xlsx');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const mgrEmp = await hire({ legalFirstName: 'Exporter' });
    await hire({ managerId: mgrEmp, legalFirstName: 'Reportee' });
    const mgr = await login(mgrEmp, 'manager', { type: 'own_team' });
    expect((await api('GET', '/v1/exports/employees?format=csv', undefined, mgr.cookie)).statusCode).toBe(403);
    // grant export to managers via a custom role to prove pay is blanked per row
    await tx(async (t) => {
      await t.exec(`INSERT INTO app.roles (tenant_id, key, name, permissions, field_access) VALUES (app.current_tenant(), 'team_exporter', 'Team exporter', '{exports.run,employees.read}', '{"employee.*":"read","employee.pay.*":"none"}')`);
      await assignRole(t, mgr.userId, 'team_exporter', { type: 'own_team' });
    });
    const out = (await api('GET', '/v1/exports/employees?format=csv&fields=displayName,payAmountMinor', undefined, mgr.cookie)).body.split('\r\n');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^"Reportee Person",""$/);
    void enrolTotp;
  });
});
