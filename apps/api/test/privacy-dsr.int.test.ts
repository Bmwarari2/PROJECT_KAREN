import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { closeDb, enrolTotp, startTestApp, type TestContext } from './helpers';
import { privacyCompany, type PrivacyCompany } from './privacy-fixtures';
import type { MemoryObjectStore } from '../src/lib/object-store';

let ctx: TestContext;
let c: PrivacyCompany;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await privacyCompany(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const createDsr = async (body: Record<string, unknown>) => {
  const r = await c.api('POST', '/v1/privacy/requests', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
};

describe('data subject request deadlines (from the jurisdiction packs)', () => {
  it('uses the law of the subject: UK GDPR Art. 12A, CCPA 45 days, none in Texas', async () => {
    const uk = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('london'), receivedOn: '2026-03-10' });
    expect(uk).toMatchObject({ jurisdiction: 'GB', dueOn: '2026-04-10', extendedDueOn: '2026-06-10' });
    expect(uk.rule).toMatchObject({ jurisdiction: 'GB', key: 'privacy.dsr_deadline', effectiveFrom: '2026-02-05' });
    expect(uk.rule.source.url).toMatch(/^https:\/\/www\.legislation\.gov\.uk\/eur\/2016\/679\/article\/12A/);
    const ukOld = await createDsr({ kind: 'deletion', subjectEmployeeId: await c.hire('london'), receivedOn: '2026-01-31' });
    expect(ukOld).toMatchObject({ dueOn: '2026-02-28', extendedDueOn: '2026-04-28' });
    expect(ukOld.rule.effectiveTo).toBe('2026-02-05');
    const ca = await createDsr({ kind: 'deletion', subjectEmployeeId: await c.hire('sf'), receivedOn: '2026-03-10' });
    expect(ca).toMatchObject({ jurisdiction: 'US-CA', dueOn: '2026-04-24', extendedDueOn: '2026-06-08' });
    expect(ca.rule.source.url).toMatch(/cppa\.ca\.gov/);
    const tx = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('austin'), receivedOn: '2026-03-10' });
    expect(tx).toMatchObject({ jurisdiction: 'US-TX', dueOn: null, rule: null, extensionAllowed: false });
  });

  it('restarts the UK clock when identity information arrives and stops it for access clarification', async () => {
    const r = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('london'), receivedOn: '2026-03-10' });
    const id = (await c.api('POST', `/v1/privacy/requests/${r.id}/identity`, { method: 'document_check', note: 'Checked against the HR file in person', informationReceivedOn: '2026-03-15' })).json();
    expect(id).toMatchObject({ identityMethod: 'document_check', informationReceivedOn: '2026-03-15', dueOn: '2026-04-15' });
    const cl = (await c.api('POST', `/v1/privacy/requests/${r.id}/clarification`, { requestedOn: '2026-03-20', receivedOn: '2026-03-25' })).json();
    expect(cl).toMatchObject({ pausedDays: 5, dueOn: '2026-04-20' });
    const ca = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('sf'), receivedOn: '2026-03-10' });
    expect((await c.api('POST', `/v1/privacy/requests/${ca.id}/clarification`, { requestedOn: '2026-03-12', receivedOn: '2026-03-20' })).json().dueOn).toBe('2026-04-24');
  });

  it('allows one extension, only before the initial deadline, with a reason', async () => {
    const saved = ctx.clock.now;
    try {
      const r = await createDsr({ kind: 'deletion', subjectEmployeeId: await c.hire('london'), receivedOn: '2026-03-10' });
      ctx.clock.now = new Date('2026-04-11T09:00:00Z');
      expect((await c.api('POST', `/v1/privacy/requests/${r.id}/extend`, { reason: 'Records across three systems' })).statusCode).toBe(422);
      ctx.clock.now = new Date('2026-03-30T09:00:00Z');
      const ext = await c.api('POST', `/v1/privacy/requests/${r.id}/extend`, { reason: 'Records across three systems' });
      expect(ext.json()).toMatchObject({ extended: true, effectiveDueOn: '2026-06-10', extensionReason: 'Records across three systems', daysRemaining: 72 });
      expect((await c.api('POST', `/v1/privacy/requests/${r.id}/extend`, { reason: 'again' })).statusCode).toBe(409);
      const tx = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('austin'), receivedOn: '2026-03-10' });
      expect((await c.api('POST', `/v1/privacy/requests/${tx.id}/extend`, { reason: 'no law applies' })).statusCode).toBe(422);
    } finally {
      ctx.clock.now = saved;
    }
  });

  it('sends deadline reminders once per threshold and an overdue notice (idempotent daily job)', async () => {
    const r = await createDsr({ kind: 'access', subjectEmployeeId: await c.hire('london'), receivedOn: '2026-05-04' });
    expect(r.dueOn).toBe('2026-06-04');
    const count = () => c.tx((t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.notifications WHERE dedupe_key LIKE $1`, [`dsr:${r.id}:%`]));
    await c.runJob('privacy.reminders', { date: '2026-05-20' });
    expect((await count()).n).toBe(0);
    await c.runJob('privacy.reminders', { date: '2026-05-28' });
    await c.runJob('privacy.reminders', { date: '2026-05-28' });
    expect((await count()).n).toBe(1);
    await c.runJob('privacy.reminders', { date: '2026-06-05' });
    await c.runJob('privacy.reminders', { date: '2026-06-06' });
    const keys = await c.tx((t) => t.query<{ dedupe_key: string; title_key: string }>(`SELECT dedupe_key, title_key FROM app.notifications WHERE dedupe_key LIKE $1 ORDER BY created_at`, [`dsr:${r.id}:%`]));
    expect(keys.map((k) => k.title_key)).toEqual(['notify.dsrDue', 'notify.dsrOverdue']);
  });
});

describe('per-person access export', () => {
  it('exports every table about the person as JSON plus a PDF, decrypting vault values with an audit entry each', async () => {
    const emp = await c.hire('london');
    const login = await c.loginAs(emp, 'employee');
    await c.tx((t) => t.exec(`INSERT INTO app.emergency_contacts (tenant_id, employee_id, name, relationship, phone) VALUES (app.current_tenant(), $1, 'Fictional Contact', 'sibling', '+44 7700 900123')`, [emp]));
    await c.putSensitive(emp, 'sickness', 'reason:test', 'Fictional migraine episode');
    await c.putSensitive(emp, 'diversity', 'ethnicity', 'Prefer not to say');
    const r = await createDsr({ kind: 'access', subjectEmployeeId: emp, receivedOn: '2026-03-10', identity: { method: 'signed_in_account' } });
    expect(r.subjectUserId).toBe(login.userId);
    expect((await c.api('POST', `/v1/privacy/requests/${r.id}/export`)).statusCode).toBe(202);
    const [result] = await c.runQueued('privacy.dsr_export');
    expect(result).toMatchObject({ requestId: r.id, sensitiveValues: 2 });
    const detail = (await c.api('GET', `/v1/privacy/requests/${r.id}`)).json();
    expect(detail).toMatchObject({ status: 'in_progress', exportReady: true });

    const store = ctx.deps.objects as MemoryObjectStore;
    const json = JSON.parse(store.objects.get(detail.outcome.export.json.key)!.body.toString('utf8'));
    expect(detail.outcome.export.json.key.startsWith(`${c.owner.tenantId}/privacy/dsr/${r.id}/`)).toBe(true);
    expect(json.format).toBe('thapsus-hr.subject-access-export');
    expect(json.tables['app.employees'][0].id).toBe(emp);
    expect(json.tables['app.employee_personal'][0]).toMatchObject({ legal_first_name: 'Fictional', date_of_birth: '1990-01-01' });
    expect(json.tables['app.emergency_contacts'][0]).toMatchObject({ name: 'Fictional Contact' });
    expect(json.tables['app.users'][0]).toMatchObject({ id: login.userId, email: login.email });
    expect(json.tables['app.password_credentials']).toHaveLength(1);
    expect(json.sensitive.values.map((v: { value: string }) => v.value).sort()).toEqual(['Fictional migraine episode', 'Prefer not to say']);
    const raw = JSON.stringify(json);
    for (const secret of ['password_hash', 'token_hash', 'envelope', 'secret']) expect(raw).not.toContain(`"${secret}"`);
    expect(raw).not.toContain('$argon2');

    const audits = await c.tx((t) => t.query<{ diff: { purpose?: string; requestId?: string } }>(`SELECT diff FROM audit.events WHERE action = 'vault.read' AND sensitive AND diff->>'requestId' = $1`, [r.id]));
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.diff.purpose === 'dsr_access_export')).toBe(true);

    const pdf = store.objects.get(detail.outcome.export.pdf.key)!.body;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1);

    const dl = await c.api('GET', `/v1/privacy/requests/${r.id}/download?file=json`);
    expect(dl.statusCode).toBe(200);
    expect(dl.json()).toMatchObject({ url: expect.stringMatching(/^memory:\/\/get\//), sha256: detail.outcome.export.json.sha256 });
    const logged = await c.tx((t) => t.query(`SELECT 1 FROM audit.events WHERE action = 'privacy.dsr_export_downloaded' AND target_id = $1 AND sensitive`, [r.id]));
    expect(logged).toHaveLength(1);
  });

  it('withholds vault categories the person running it cannot read, and audits the refusal', async () => {
    const emp = await c.hire('london');
    await c.putSensitive(emp, 'sickness', 'reason:x', 'Fictional flu');
    const r = await createDsr({ kind: 'access', subjectEmployeeId: emp, receivedOn: '2026-03-10' });
    // A custom privacy officer role without vault access runs the export.
    const officer = await c.loginAs(null, 'employee');
    await c.tx(async (t) => {
      const role = await t.one<{ id: string }>(`INSERT INTO app.roles (tenant_id, key, name, is_admin, permissions, field_access) VALUES (app.current_tenant(), 'privacy_officer', 'Privacy officer', false, '{privacy.*}', '{}') RETURNING id`);
      await t.exec(`INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type, scope_values) VALUES (app.current_tenant(), $1, $2, 'all', '{}')`, [officer.userId, role.id]);
    });
    expect((await c.api('POST', `/v1/privacy/requests/${r.id}/export`, undefined, officer.cookie)).statusCode).toBe(202);
    const [result] = await c.runQueued('privacy.dsr_export');
    expect(result).toMatchObject({ sensitiveValues: 0, withheldCategories: ['sickness'] });
    const denied = await c.tx((t) => t.query(`SELECT 1 FROM audit.events WHERE action = 'vault.read_denied' AND actor_id = $1`, [officer.userId]));
    expect(denied).toHaveLength(1);
  });

  it('only privacy roles can see or create requests', async () => {
    const emp = await c.hire('london');
    const staff = await c.loginAs(emp, 'employee');
    expect((await c.api('GET', '/v1/privacy/requests', undefined, staff.cookie)).statusCode).toBe(403);
    expect((await c.api('POST', '/v1/privacy/requests', { kind: 'access', subjectEmployeeId: emp }, staff.cookie)).statusCode).toBe(403);
    const hr = await c.loginAs(null, 'hr_admin');
    await enrolTotp(ctx, hr.cookie);
    expect((await c.api('GET', '/v1/privacy/requests', undefined, hr.cookie)).statusCode).toBe(200);
  });
});

describe('correction workflow', () => {
  it('applies the correction as an effective-dated change through the employees service, with audit', async () => {
    const emp = await c.hire('london', { legalLastName: 'Mispelt' });
    const r = await createDsr({ kind: 'correction', subjectEmployeeId: emp, receivedOn: '2026-03-10', details: 'Surname is spelt wrongly' });
    expect((await c.api('POST', `/v1/privacy/requests/${r.id}/correction`, { effectiveDate: '2026-05-01', changes: { notAField: 1 } })).statusCode).toBe(400);
    const res = await c.api('POST', `/v1/privacy/requests/${r.id}/correction`, { effectiveDate: '2026-05-01', changes: { legalLastName: 'Misspelt' }, note: 'Confirmed with passport check note' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome.correction).toMatchObject({ effectiveDate: '2026-05-01', fields: ['legalLastName'] });
    const rows = await c.tx((t) => t.query<{ valid_from: string; valid_to: string | null; legal_last_name: string }>(`SELECT valid_from, valid_to, legal_last_name FROM app.employee_personal WHERE employee_id = $1 ORDER BY valid_from`, [emp]));
    expect(rows.map((x) => [x.valid_from, x.valid_to, x.legal_last_name])).toEqual([
      ['2024-03-04', '2026-05-01', 'Mispelt'],
      ['2026-05-01', null, 'Misspelt'],
    ]);
    const audit = await c.tx((t) => t.one<{ diff: { changes: Record<string, { from: string; to: string }> } }>(`SELECT diff FROM audit.events WHERE action = 'privacy.dsr_correction_applied' AND target_id = $1`, [emp]));
    expect(audit.diff.changes.legalLastName).toEqual({ from: 'Mispelt', to: 'Misspelt' });
    const ev = await c.tx((t) => t.query(`SELECT 1 FROM app.outbox WHERE topic = 'employee.corrected' AND aggregate_id = $1`, [emp]));
    expect(ev).toHaveLength(1);
  });
});

describe('deletion workflow', () => {
  it('refuses while a legal hold applies, then erases what no statutory minimum keeps and logs counts only', async () => {
    const emp = await c.hire('london', { legalFirstName: 'Zebedee', legalLastName: 'Quuxworth', personalEmail: 'zebedee.quuxworth@home.example.test' });
    const login = await c.loginAs(emp, 'employee');
    await c.tx(async (t) => {
      await t.exec(`INSERT INTO app.emergency_contacts (tenant_id, employee_id, name, relationship) VALUES (app.current_tenant(), $1, 'Fictional Contact', 'parent')`, [emp]);
      await t.exec(`INSERT INTO app.clock_events (tenant_id, employee_id, kind, occurred_at, zone, source, client_event_id) VALUES (app.current_tenant(), $1, 'in', $2, 'Europe/London', 'pwa', 'evt-1')`, [emp, ctx.clock.now.toISOString()]);
    });
    await c.putSensitive(emp, 'sickness', 'reason:1', 'Fictional cold');
    const docKey = `${c.owner.tenantId}/documents/${crypto.randomUUID()}.pdf`;
    await (ctx.deps.objects as MemoryObjectStore).put(docKey, Buffer.from('%PDF-1.7 fictional'), 'application/pdf');
    await c.tx((t) => t.exec(`INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, status) VALUES (app.current_tenant(), $1, 'Fictional contract', 'contract', $2, 'c.pdf', 'application/pdf', 18, 'ready')`, [emp, docKey]));
    const r = await createDsr({ kind: 'deletion', subjectEmployeeId: emp, receivedOn: '2026-03-10' });

    const hold = (await c.api('POST', '/v1/privacy/legal-holds', { employeeId: emp, reason: 'Fictional tribunal claim' })).json();
    const held = (await c.api('GET', `/v1/privacy/requests/${r.id}/erasure-plan`)).json();
    expect(held.erase).toEqual([]);
    expect(held.retain.every((x: { reason: string }) => x.reason === 'legal_hold')).toBe(true);
    expect((await c.api('POST', `/v1/privacy/legal-holds/${hold.id}/release`)).statusCode).toBe(200);

    const plan = (await c.api('GET', `/v1/privacy/requests/${r.id}/erasure-plan`)).json();
    expect(plan.erase).toEqual(expect.arrayContaining(['personnel_records', 'contact', 'account', 'sickness_records']));
    const time = plan.retain.find((x: { category: string }) => x.category === 'time_records');
    expect(time).toMatchObject({ reason: 'statutory_retention' });
    expect(time.rules[0].source.url).toMatch(/legislation\.gov\.uk\/uksi\/1998\/1833\/regulation\/9/);

    const res = await c.api('POST', `/v1/privacy/requests/${r.id}/erase`, { confirm: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().request.status).toBe('completed');
    expect(res.json().filesDeleted).toBe(1);
    const after = await c.tx(async (t) => ({
      employee: await t.one<{ display_name: string; work_email: string | null; employee_number: string; search: string }>(`SELECT display_name, work_email, employee_number, search::text FROM app.employees WHERE id = $1`, [emp]),
      personal: await t.query<{ legal_first_name: string; personal_email: string | null; date_of_birth: string | null }>(`SELECT legal_first_name, personal_email, date_of_birth FROM app.employee_personal WHERE employee_id = $1`, [emp]),
      user: await t.one<{ email: string; status: string }>(`SELECT email, status FROM app.users WHERE id = $1`, [login.userId]),
      sessions: await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.sessions WHERE user_id = $1`, [login.userId]),
      contacts: await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.emergency_contacts WHERE employee_id = $1`, [emp]),
      vault: await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM vault.records WHERE subject_id = $1`, [emp]),
      clock: await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.clock_events WHERE employee_id = $1`, [emp]),
      log: await t.query<Record<string, unknown>>(`SELECT * FROM app.retention_runs WHERE trigger = 'dsr'`),
    }));
    expect(after.employee.display_name).toBe('Erased person');
    expect(after.employee.work_email).toBeNull();
    expect(after.employee.employee_number).toMatch(/^erased-/);
    expect(after.employee.search).not.toMatch(/zebedee|quuxworth/i);
    expect(after.personal.every((p) => p.legal_first_name === 'Erased' && p.personal_email === null && p.date_of_birth === null)).toBe(true);
    expect(after.user).toMatchObject({ status: 'deactivated', email: expect.stringMatching(/@erased\.invalid$/) });
    expect([after.sessions.n, after.contacts.n, after.vault.n]).toEqual([0, 0, 0]);
    expect(after.clock.n).toBe(1); // working-time records are kept for two years (WTR 1998 reg. 9)
    expect((ctx.deps.objects as MemoryObjectStore).objects.has(docKey)).toBe(false);
    const search = (await c.api('GET', '/v1/employees?q=Quuxworth')).json();
    expect(search.data).toHaveLength(0);
    // The deletion log holds categories and counts only.
    expect(after.log.some((l) => l.category === 'time_records' && l.action === 'retain')).toBe(true);
    const logText = JSON.stringify(after.log);
    for (const pii of ['Zebedee', 'Quuxworth', 'zebedee.quuxworth', emp, login.userId]) expect(logText).not.toContain(pii);
    expect((await c.api('POST', `/v1/privacy/requests/${r.id}/erase`, { confirm: true })).statusCode).toBe(409);
  });

  it('keeps the identity of a current California employee (29 CFR 1602.14) but erases account artefacts', async () => {
    const emp = await c.hire('sf');
    const login = await c.loginAs(emp, 'employee');
    const r = await createDsr({ kind: 'deletion', subjectEmployeeId: emp, receivedOn: '2026-03-10' });
    const plan = (await c.api('GET', `/v1/privacy/requests/${r.id}/erasure-plan`)).json();
    const personnel = plan.retain.find((x: { category: string }) => x.category === 'personnel_records');
    expect(personnel).toMatchObject({ reason: 'statutory_retention', until: null });
    expect(personnel.rules[0].source.url).toMatch(/ecfr\.gov.*1602\.14/);
    expect((await c.api('POST', `/v1/privacy/requests/${r.id}/erase`, { confirm: true })).statusCode).toBe(200);
    const still = await c.tx((t) => t.one<{ display_name: string }>(`SELECT display_name FROM app.employees WHERE id = $1`, [emp]));
    expect(still.display_name).not.toBe('Erased person');
    const sessions = await c.tx((t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.sessions WHERE user_id = $1`, [login.userId]));
    expect(sessions.n).toBe(0);
  });
});
