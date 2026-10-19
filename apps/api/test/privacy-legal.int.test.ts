import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TRUST } from '@thapsus/core/trust';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { closeDb, enrolTotp, startTestApp, totpCode, type TestContext } from './helpers';
import { privacyCompany, type PrivacyCompany } from './privacy-fixtures';
import { createStaff, STAFF_COOKIE } from '../src/modules/backoffice/auth';

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

/** Notifications to the owner (other admins receive their own copies). */
const notifications = (prefix: string) => c.tx((t) => t.query<{ user_id: string; title_key: string }>(`SELECT user_id, title_key FROM app.notifications WHERE dedupe_key LIKE $1 AND user_id = $2 ORDER BY created_at`, [`${prefix}%`, c.owner.userId]));

describe('DPA acceptance', () => {
  it('records acceptance of the current version at sign-up, requires re-acceptance of a new version, owner only', async () => {
    const v = (await c.api('GET', '/v1/privacy/dpa')).json();
    expect(v).toMatchObject({ template: 'uk', currentVersion: TRUST.dpa.uk.version, reacceptanceRequired: false, legalReview: 'pending' });
    expect(v.acceptances[0]).toMatchObject({ version: TRUST.dpa.uk.version, acceptedBy: c.owner.userId, acceptedByName: 'Olive Owner' });
    // A new DPA version is published: the stored acceptance is now for an older version.
    await c.tx((t) => t.exec(`UPDATE app.dpa_acceptances SET dpa_version = '2025-01-01'`));
    expect((await c.api('GET', '/v1/privacy/dpa')).json().reacceptanceRequired).toBe(true);
    await c.runJob('privacy.reminders', { date: '2026-10-19' });
    await c.runJob('privacy.reminders', { date: '2026-10-20' });
    expect((await notifications('dpa:')).map((n) => n.title_key)).toEqual(['notify.dpaReaccept']);
    const hr = await c.loginAs(null, 'hr_admin');
    await enrolTotp(ctx, hr.cookie);
    expect((await c.api('POST', '/v1/privacy/dpa/accept', { version: TRUST.dpa.uk.version }, hr.cookie)).statusCode).toBe(403);
    expect((await c.api('POST', '/v1/privacy/dpa/accept', { version: '2024-01-01' })).statusCode).toBe(422);
    const ok = await c.api('POST', '/v1/privacy/dpa/accept', { version: TRUST.dpa.uk.version });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ reacceptanceRequired: false });
    expect((await c.api('POST', '/v1/privacy/dpa/accept', { version: TRUST.dpa.uk.version })).statusCode).toBe(409);
    const audit = await c.tx((t) => t.query(`SELECT 1 FROM audit.events WHERE action = 'privacy.dpa_accepted'`));
    expect(audit).toHaveLength(1);
  });
});

describe('sub-processors', () => {
  it('serves the per-region list and notifies subscribed admins of changes once, for their region only', async () => {
    const sub = await c.api('PUT', '/v1/privacy/subprocessors/subscription', { subscribed: true });
    expect(sub.json()).toMatchObject({ region: 'uk', subscribed: true, noticeDays: 30 });
    expect(sub.json().sections[0].columns).toContain('UK tenants');
    const changes = TRUST.subprocessors.changes;
    changes.push(
      { id: 'test-uk-addition', type: 'addition', announced: '2026-11-01', effectiveFrom: '2026-12-01', regions: ['uk', 'eu'], change: 'Fictional Mail Relay Ltd for transactional email' },
      { id: 'test-us-only', type: 'addition', announced: '2026-11-01', effectiveFrom: '2026-12-01', regions: ['us'], change: 'Fictional US-only vendor' },
    );
    try {
      await c.runJob('privacy.subprocessor_notices', { date: '2026-10-31' });
      expect(await notifications('subprocessor:')).toEqual([]);
      await c.runJob('privacy.subprocessor_notices', { date: '2026-11-01' });
      await c.runJob('privacy.subprocessor_notices', { date: '2026-11-02' });
      const sent = await notifications('subprocessor:');
      expect(sent).toEqual([{ user_id: c.owner.userId, title_key: 'notify.subprocessorChange' }]);
    } finally {
      changes.splice(changes.length - 2, 2);
    }
  });

  it('the worker schedule queues one notice run per UTC date, which notifies subscribers of a change once', async () => {
    await c.api('PUT', '/v1/privacy/subprocessors/subscription', { subscribed: true });
    const changes = TRUST.subprocessors.changes;
    changes.push({ id: 'test-uk-scheduled', type: 'addition', announced: '2026-11-03', effectiveFrom: '2026-12-03', regions: ['uk'], change: 'Fictional Rota Reminders Ltd for shift reminders' });
    try {
      await c.runPeriodic('2026-11-03T00:10:00Z');
      await c.runPeriodic('2026-11-03T13:00:00Z');
      expect((await c.jobsOf('privacy.subprocessor_notices', '2026-11-03')).map((j) => [j.idempotency_key, j.input])).toEqual([['2026-11-03', { date: '2026-11-03' }]]);
      await c.runQueued('privacy.subprocessor_notices', '2026-11-03');
      expect(await notifications('subprocessor:test-uk-scheduled')).toEqual([{ user_id: c.owner.userId, title_key: 'notify.subprocessorChange' }]);
    } finally {
      changes.pop();
    }
  });
});

describe('privacy notice templates', () => {
  it('serves UK, EU and US templates marked for legal review and saves an editable tenant copy', async () => {
    const list = (await c.api('GET', '/v1/privacy/notices')).json();
    expect(list.map((n: { template: string }) => n.template)).toEqual(['uk', 'eu', 'us']);
    for (const n of list) {
      expect(n.body).toContain('DRAFT — for legal review');
      expect(n.legalReview).toBe('pending');
    }
    const saved = await c.api('PUT', '/v1/privacy/notices/uk', { title: 'Employee privacy notice — Fictional Widgets', body: list[0].body.replace(/\{\{companyName\}\}/g, 'Fictional Widgets Ltd'), publish: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().tenantCopy).toMatchObject({ status: 'published', templateVersion: TRUST.notices.uk.version, outdated: false });
    expect(saved.json().tenantCopy.body).toContain('Fictional Widgets Ltd');
  });
});

describe('incident and breach log', () => {
  it('computes deadlines per jurisdiction from the packs, flags unmodelled ones and reminds before they pass', async () => {
    const res = await c.api('POST', '/v1/privacy/incidents', { title: 'Fictional laptop theft', personalDataBreach: true, riskLevel: 'high_risk', awareAt: '2026-10-01T09:30:00Z', affected: { GB: 40, 'US-TX': 100, 'US-WA': 600, 'US-GA': 3 }, dataCategories: ['contact', 'pay'] });
    expect(res.statusCode, res.body).toBe(201);
    const inc = res.json();
    const find = (j: string, a: string) => inc.deadlines.find((d: { jurisdiction: string; audience: string }) => d.jurisdiction === j && d.audience === a);
    expect(find('GB', 'regulator')).toMatchObject({ dueAt: '2026-10-04T09:30:00Z', body: 'Information Commission', required: true });
    expect(find('GB', 'regulator').rule.source.url).toMatch(/legislation\.gov\.uk\/eur\/2016\/679\/article\/33/);
    expect(find('US-TX', 'individuals')).toMatchObject({ dueAt: '2026-11-30T09:30:00Z' });
    expect(find('US-TX', 'regulator')).toMatchObject({ required: false, minAffected: 250 });
    expect(find('US-WA', 'regulator')).toMatchObject({ required: true, dueAt: '2026-10-31T09:30:00Z' });
    expect(inc.deadlines.some((d: { audience: string }) => d.audience === 'processorToController')).toBe(false);
    expect(inc.unmodelled).toEqual(['US-GA']);

    await c.runJob('privacy.incident_reminders', { at: '2026-10-02T09:00:00Z' });
    expect(await notifications(`incident:${inc.id}`)).toEqual([]);
    await c.runJob('privacy.incident_reminders', { at: '2026-10-03T10:00:00Z' });
    await c.runJob('privacy.incident_reminders', { at: '2026-10-03T11:00:00Z' });
    expect((await notifications(`incident:${inc.id}:GB:regulator`)).map((n) => n.title_key)).toEqual(['notify.incidentDeadline']);
    await c.runJob('privacy.incident_reminders', { at: '2026-10-04T10:00:00Z' });
    expect((await notifications(`incident:${inc.id}:GB:regulator`)).map((n) => n.title_key)).toEqual(['notify.incidentDeadline', 'notify.incidentOverdue']);

    const rec = await c.api('POST', `/v1/privacy/incidents/${inc.id}/notifications`, { jurisdiction: 'US-WA', audience: 'regulator', notifiedAt: '2026-10-05T12:00:00Z', reference: 'WA-AG-FICTIONAL-1' });
    expect(rec.json().deadlines.find((d: { jurisdiction: string; audience: string }) => d.jurisdiction === 'US-WA' && d.audience === 'regulator').notifiedAt).toBe('2026-10-05T12:00:00.000Z');
    await c.runJob('privacy.incident_reminders', { at: '2026-10-31T10:00:00Z' });
    expect(await notifications(`incident:${inc.id}:US-WA:regulator`)).toEqual([]);

    const patched = await c.api('PATCH', `/v1/privacy/incidents/${inc.id}`, { status: 'closed', affected: { GB: 40 } });
    expect(patched.json()).toMatchObject({ status: 'closed', unmodelled: [] });
    expect(patched.json().closedAt).not.toBeNull();
  });

  it('the worker schedule queues one reminder run per UTC hour, which reminds before the deadline', async () => {
    const res = await c.api('POST', '/v1/privacy/incidents', { title: 'Fictional misdirected payslip email', personalDataBreach: true, riskLevel: 'high_risk', awareAt: '2026-10-11T09:30:00Z', affected: { GB: 2 }, dataCategories: ['pay'] });
    expect(res.statusCode, res.body).toBe(201);
    const inc = res.json();
    expect(inc.deadlines.find((d: { jurisdiction: string; audience: string }) => d.jurisdiction === 'GB' && d.audience === 'regulator')).toMatchObject({ dueAt: '2026-10-14T09:30:00Z' });
    await c.runPeriodic('2026-10-13T10:05:00Z');
    await c.runPeriodic('2026-10-13T10:55:00Z');
    await c.runPeriodic('2026-10-13T11:05:00Z');
    expect((await c.jobsOf('privacy.incident_reminders', '2026-10-13')).map((j) => [j.idempotency_key, j.input])).toEqual([
      ['2026-10-13T10', { at: '2026-10-13T10:00:00Z' }],
      ['2026-10-13T11', { at: '2026-10-13T11:00:00Z' }],
    ]);
    await c.runQueued('privacy.incident_reminders', '2026-10-13');
    expect((await notifications(`incident:${inc.id}:GB:regulator`)).map((n) => n.title_key)).toEqual(['notify.incidentDeadline']); // under 24 hours left
  });

  it('records the Thapsus-side breach register (staff only) and notifies affected controllers in their own log', async () => {
    const email = `privacy.staff.${Math.random().toString(36).slice(2, 6)}@thapsus.example.test`;
    const s = await createStaff(ctx.app, email, 'Fictional Staff', 'support');
    const login = await ctx.app.inject({ method: 'POST', url: '/v1/backoffice/auth/login', payload: { email, password: s.password } });
    const cookie = `${STAFF_COOKIE}=${String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]}`;
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/backoffice/auth/totp', headers: { cookie }, payload: { code: totpCode(s.totpSecret, ctx.clock.now) } })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/backoffice/breaches' })).statusCode).toBe(401);
    expect((await c.api('GET', '/v1/backoffice/breaches')).statusCode).toBe(401); // tenant sessions never reach the back office

    const created = await ctx.app.inject({ method: 'POST', url: '/v1/backoffice/breaches', headers: { cookie }, payload: { title: 'Fictional misconfigured log bucket', summary: 'Access logs were readable for 2 hours; no tenant content in logs.', awareAt: '2026-10-10T08:00:00Z', affectedTenantIds: [c.owner.tenantId, crypto.randomUUID()], dataCategories: ['ip_address'] } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ cell: 'uk', controllersNotifyBy: '2026-10-12T08:00:00.000Z', controllersNotifiedAt: null });
    const notified = await ctx.app.inject({ method: 'POST', url: `/v1/backoffice/breaches/${created.json().id}/notify-controllers`, headers: { cookie } });
    expect(notified.json()).toMatchObject({ notified: 1, notInThisCell: 1 });
    const incidents = (await c.api('GET', '/v1/privacy/incidents')).json();
    expect(incidents.find((i: { source: string; title: string }) => i.source === 'processor' && i.title === 'Fictional misconfigured log bucket')).toBeDefined();
    expect((await notifications('processor-breach:')).map((n) => n.title_key)).toContain('notify.processorBreach');
    const ownerDb = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await ownerDb.connect();
    try {
      const trail = await ownerDb.query(`SELECT action FROM backoffice.staff_audit WHERE action LIKE 'breach.%' ORDER BY at`);
      expect(trail.rows.map((r) => r.action)).toEqual(['breach.recorded', 'breach.controllers_notified']);
      const cols = await ownerDb.query<{ c: string }>(`SELECT attname AS c FROM pg_attribute WHERE attrelid = 'backoffice.breach_register'::regclass AND attnum > 0 AND NOT attisdropped`);
      expect(cols.rows.map((r) => r.c)).not.toContain('tenant_id');
    } finally {
      await ownerDb.end();
    }
  });
});
