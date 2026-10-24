import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBillingConfig, slaDeadlines } from '@thapsus/core/billing';
import { getPool, withTenant } from '@thapsus/db';
import { MemoryObjectStore } from '../src/lib/object-store';
import { periodic } from '../src/worker';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import {
  injector,
  runJob,
  runQueued,
  staffSession,
  supportContactRole,
  userSession,
} from './phase10-helpers';

/**
 * Help centre and support tickets (PROGRESS 10.1): tickets in the home region (forced RLS),
 * admins see all and employees their own, attachments in the home-region object store, SLA timers
 * from the plan configuration, idempotent escalation, configurable contact channels, and staff
 * working the queue with every view and reply audited.
 */
const cfg = loadBillingConfig('builtin:billing-config-v1');
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let employee: Awaited<ReturnType<typeof userSession>>;
let colleague: Awaited<ReturnType<typeof userSession>>;
let api: ReturnType<typeof injector>;
const objects = () => ctx.deps.objects as MemoryObjectStore;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  // built-in employees ask their own HR team; a custom role granted support.ticket contacts support (ADR-0163)
  const contact = await supportContactRole(ctx, owner);
  employee = await userSession(ctx, owner, contact, 'Fictional Requester');
  colleague = await userSession(ctx, owner, contact, 'Fictional Colleague');
  api = injector(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const newTicket = (cookie: string, over: Record<string, unknown> = {}) =>
  api(
    'POST',
    '/v1/support/tickets',
    {
      subject: 'Payslip export shows the wrong month',
      body: 'Steps: open Payroll → Export. Fictional details only.',
      category: 'problem',
      priority: 'high',
      contextPath: '/app/timesheets',
      ...over,
    },
    cookie,
  );

describe('help centre', () => {
  it('searches localised articles and returns contextual articles for an app page', async () => {
    const s = await api('GET', '/v1/help/articles?q=cancel%20plan', undefined, owner.cookie);
    expect(s.statusCode).toBe(200);
    expect(s.json()[0].slug).toBe('plans-and-billing');
    const us = await ctx.app.inject({
      method: 'GET',
      url: '/v1/help/articles/plans-and-billing',
      headers: { cookie: owner.cookie, 'accept-language': 'en-US' },
    });
    expect(us.json().title).toMatch(/canceling/);
    const c = await api('GET', '/v1/help/articles?context=/app/notifications', undefined, employee.cookie);
    expect(c.json().map((a: { slug: string }) => a.slug)).toContain('notifications');
    expect((await api('GET', '/v1/help/articles/nope', undefined, employee.cookie)).statusCode).toBe(404);
  });

  it('shows each reader only the articles about what they may do (ADR-0162)', async () => {
    const plain = await userSession(ctx, owner, 'employee', 'Fictional Reader');
    const slugs = async (url: string, cookie: string) =>
      ((await api('GET', url, undefined, cookie)).json() as Array<{ slug: string }>).map((a) => a.slug);
    const all = await slugs('/v1/help/articles', plain.cookie);
    expect(all).toEqual(
      expect.arrayContaining(['signing-in', 'resetting-sign-in', 'notifications', 'contacting-hr']),
    );
    // setting up the workspace is for admins (ADR-0190); booking time off needs an employee record
    for (const admin of [
      'getting-started',
      'plans-and-billing',
      'adding-people',
      'support-access',
      'security-and-sign-in',
      'requesting-time-off',
    ])
      expect(all).not.toContain(admin);
    expect(all).not.toContain('contacting-support');
    // searching and opening behave the same: an article that is not for the reader is not found
    expect(await slugs('/v1/help/articles?q=cancel%20plan', plain.cookie)).toEqual([]);
    expect(
      (await api('GET', '/v1/help/articles/plans-and-billing', undefined, plain.cookie)).statusCode,
    ).toBe(404);
    // the contextual link on a page they cannot use falls back to an article for them
    expect(await slugs('/v1/help/articles?context=/app/billing', plain.cookie)).toEqual(['signing-in']);
    expect(await slugs('/v1/help/articles', owner.cookie)).toEqual(
      expect.arrayContaining(['plans-and-billing']),
    );
  });

  it('shows an article only where its feature is on for the workspace and its country applies (ADR-0190)', async () => {
    const slugs = async (url = '/v1/help/articles') =>
      ((await api('GET', url, undefined, owner.cookie)).json() as Array<{ slug: string }>).map((a) => a.slug);
    // no legal entity yet: neither country's article
    let all = await slugs();
    expect(all).not.toContain('form-i9');
    expect(all).not.toContain('right-to-work-checks');
    const entity = (country: string, currency: string, timeZone: string) =>
      api(
        'POST',
        '/v1/org/legal-entities',
        { name: `Fictional ${country} Ltd`, country, currency, timeZone },
        owner.cookie,
      );
    expect((await entity('US', 'USD', 'America/New_York')).statusCode).toBe(201);
    all = await slugs();
    expect(all).toContain('form-i9');
    expect(all).not.toContain('right-to-work-checks');
    expect(
      (await api('GET', '/v1/help/articles/right-to-work-checks', undefined, owner.cookie)).statusCode,
    ).toBe(404);
    expect((await entity('GB', 'GBP', 'Europe/London')).statusCode).toBe(201);
    expect(await slugs()).toEqual(expect.arrayContaining(['form-i9', 'right-to-work-checks']));
    // a feature the workspace turns off hides its article, in search and on its page too
    expect(await slugs()).toContain('custom-branding');
    const off = await api('PUT', '/v1/settings/features/customBranding', { enabled: false }, owner.cookie);
    expect(off.statusCode, off.body).toBe(200);
    expect(await slugs()).not.toContain('custom-branding');
    expect(await slugs('/v1/help/articles?q=accent%20colour')).not.toContain('custom-branding');
    expect(await slugs('/v1/help/articles?context=/app/settings/branding')).not.toContain('custom-branding');
    await api('PUT', '/v1/settings/features/customBranding', { enabled: null }, owner.cookie);
    // Ask HR: the staff-managed entitlement and the customer's opt-in
    expect(await slugs()).not.toContain('ask-hr');
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.exec(
        `UPDATE app.tenants SET features = jsonb_set(jsonb_set(features, '{flags}', coalesce(features->'flags', '{}'::jsonb) || '{"aiAssistant": true}'::jsonb), '{ai}', '{"enabled": true}'::jsonb)`,
      ),
    );
    expect(await slugs()).toContain('ask-hr');
  });

  it('shows the contact channels and SLA targets for the plan and region', async () => {
    const r = await api('GET', '/v1/support/contact', undefined, employee.cookie);
    expect(r.json()).toMatchObject({ planId: cfg.trial.planId, region: 'uk', coverage: 'business_hours' });
    expect(r.json().channels.map((c: { kind: string }) => c.kind)).toEqual(
      cfg.support.contactChannels[cfg.trial.planId]!.map((c) => c.kind),
    );
    expect(r.json().sla).toEqual(cfg.plans.find((p) => p.id === cfg.trial.planId)!.support.sla);
  });
});

describe('tickets in the home region', () => {
  let ticketId: string;

  it('an employee raises a ticket; SLA deadlines come from the plan, priority and region support hours', async () => {
    const r = await newTicket(employee.cookie);
    expect(r.statusCode, r.body).toBe(201);
    const t = r.json();
    ticketId = t.id;
    expect(t.reference).toMatch(/^T-[0-9A-F]{8}$/);
    const d = slaDeadlines(cfg, cfg.trial.planId, 'high', 'uk', t.createdAt);
    expect(new Date(t.sla.firstResponse.dueAt).toISOString()).toBe(
      new Date(d.firstResponseDueAt).toISOString(),
    );
    expect(new Date(t.sla.resolution.dueAt).toISOString()).toBe(new Date(d.resolutionDueAt).toISOString());
    expect(t.sla.flag).toBe('on_track');
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.one<{ diff: Record<string, unknown> }>(
        `SELECT diff FROM audit.events WHERE action = 'support_ticket.created' AND target_id = $1`,
        [ticketId],
      ),
    );
    expect(JSON.stringify(audit.diff)).not.toMatch(/Payslip|Steps/); // the audit records the change, not the text
  });

  it('only admins may raise urgent tickets', async () => {
    expect((await newTicket(employee.cookie, { priority: 'urgent' })).statusCode).toBe(403);
    expect((await newTicket(owner.cookie, { priority: 'urgent' })).statusCode).toBe(201);
  });

  it('employees see their own tickets; admins see every ticket in the company', async () => {
    const mine = (await api('GET', '/v1/support/tickets', undefined, employee.cookie)).json();
    expect(mine.map((t: { id: string }) => t.id)).toContain(ticketId);
    expect((await api('GET', '/v1/support/tickets?scope=all', undefined, employee.cookie)).statusCode).toBe(
      403,
    );
    expect(
      (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, colleague.cookie)).statusCode,
    ).toBe(404);
    expect((await api('GET', '/v1/support/tickets', undefined, colleague.cookie)).json()).toEqual([]);
    const all = (await api('GET', '/v1/support/tickets?scope=all', undefined, owner.cookie)).json();
    expect(all.length).toBe(2);
    expect((await api('GET', `/v1/support/tickets/${ticketId}`, undefined, owner.cookie)).statusCode).toBe(
      200,
    );
  });

  it('stores attachments in the home-region object store under the tenant prefix, with type and size limits', async () => {
    const boundary = 'fictionalboundary';
    const body = (name: string, type: string, content: string | Buffer) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fictional-png-bytes'),
    ]);
    // the bytes must match the declared type (ASVS V5.2.2)
    const fake = await ctx.app.inject({
      method: 'POST',
      url: `/v1/support/tickets/${ticketId}/attachments`,
      headers: { cookie: employee.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body('screen.png', 'image/png', 'not-really-a-png'),
    });
    expect(fake.statusCode).toBe(400);
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/v1/support/tickets/${ticketId}/attachments`,
      headers: { cookie: employee.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body('screen.png', 'image/png', png),
    });
    expect(up.statusCode, up.body).toBe(201);
    const keys = [...objects().objects.keys()].filter((k) => k.includes('/support/'));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith(`${owner.tenantId}/support/${ticketId}/`)).toBe(true);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/v1/support/tickets/${ticketId}/attachments`,
      headers: { cookie: employee.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body('x.exe', 'application/x-msdownload', 'nope'),
    });
    expect(bad.statusCode).toBe(400);
    const thread = (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, employee.cookie)).json();
    expect(thread.attachments).toHaveLength(1);
    const dl = await api(
      'GET',
      `/v1/support/tickets/${ticketId}/attachments/${thread.attachments[0].id}`,
      undefined,
      employee.cookie,
    );
    expect(dl.json().url).toMatch(/^memory:\/\/get\//);
    expect(
      (
        await api(
          'GET',
          `/v1/support/tickets/${ticketId}/attachments/${thread.attachments[0].id}`,
          undefined,
          colleague.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('the back-office queue index holds routing metadata only (no subject, message or file)', async () => {
    const { rows } = await ctx.deps.router
      .registryPool()
      .query('SELECT * FROM backoffice.support_queue WHERE ticket_id = $1', [ticketId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toMatch(/Payslip|Steps|screen\.png|Fictional Requester/);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'category',
      'created_at',
      'first_responded_at',
      'first_response_at_risk_at',
      'first_response_due_at',
      'last_activity_at',
      'last_author',
      'plan_id',
      'priority',
      'reference',
      'resolution_at_risk_at',
      'resolution_due_at',
      'resolved_at',
      'status',
      'subject_tenant_id',
      'synced_at',
      'ticket_id',
    ]);
  });

  it('staff work the queue: every view and reply is audited in the customer log and the staff trail', async () => {
    const support = await staffSession(ctx, 'support');
    const queue = (await api('GET', '/v1/backoffice/support/queue', undefined, support.cookie)).json();
    const item = queue.find((q: { ticketId: string }) => q.ticketId === ticketId);
    expect(item).toMatchObject({
      tenantId: owner.tenantId,
      slug: owner.slug,
      priority: 'high',
      status: 'open',
      lastAuthor: 'user',
    });
    expect(item).not.toHaveProperty('subject');
    // tenants cannot reach the queue
    expect((await api('GET', '/v1/backoffice/support/queue', undefined, owner.cookie)).statusCode).toBe(401);
    const view = await api(
      'GET',
      `/v1/backoffice/support/tickets/${owner.tenantId}/${ticketId}`,
      undefined,
      support.cookie,
    );
    expect(view.statusCode).toBe(200);
    expect(view.json().ticket.subject).toBe('Payslip export shows the wrong month');
    ctx.clock.advanceMinutes(5); // the test clock is frozen: without this the reply shares the first message's timestamp and the thread order is arbitrary
    const reply = await api(
      'POST',
      `/v1/backoffice/support/tickets/${owner.tenantId}/${ticketId}/messages`,
      { body: 'Thanks — we are looking into the export month.', status: 'awaiting_customer' },
      support.cookie,
    );
    expect(reply.statusCode, reply.body).toBe(201);
    const thread = (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, employee.cookie)).json();
    expect(thread.ticket.status).toBe('awaiting_customer');
    expect(thread.ticket.sla.firstResponse.state).toMatch(/^met/);
    expect(thread.messages.at(-1)).toMatchObject({ authorType: 'staff', authorName: null });
    const tenantAudit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string; actor_type: string; actor_id: string }>(
        `SELECT action, actor_type, actor_id FROM audit.events WHERE target_id = $1 AND actor_type = 'support' ORDER BY id`,
        [ticketId],
      ),
    );
    expect(tenantAudit.map((a) => a.action)).toEqual([
      'support_ticket.viewed_by_staff',
      'support_ticket.staff_replied',
    ]);
    expect(tenantAudit.every((a) => a.actor_id === support.staffId)).toBe(true);
    const { rows: trail } = await getPool(ctx.deps.backofficeDbUrl!).query(
      `SELECT action FROM backoffice.staff_audit WHERE staff_id = $1 AND subject_tenant_id = $2 ORDER BY id`,
      [support.staffId, owner.tenantId],
    );
    expect(trail.map((r: { action: string }) => r.action)).toEqual([
      'support.ticket_viewed',
      'support.ticket_replied',
    ]);
    // the requester is notified in-app (email follows from the home region)
    const n = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query(`SELECT kind FROM app.notifications WHERE user_id = $1 AND kind = 'support.reply'`, [
        employee.userId,
      ]),
    );
    expect(n).toHaveLength(1);
    // a customer reply re-opens it
    expect(
      (
        await api(
          'POST',
          `/v1/support/tickets/${ticketId}/messages`,
          { body: 'It happened again today.' },
          employee.cookie,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, employee.cookie)).json().ticket.status,
    ).toBe('open');
  });

  it('staff priority changes recalculate SLA deadlines from the opening time', async () => {
    const support = await staffSession(ctx, 'support');
    const before = (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, employee.cookie)).json()
      .ticket;
    expect(
      (
        await api(
          'PATCH',
          `/v1/backoffice/support/tickets/${owner.tenantId}/${ticketId}`,
          { priority: 'low' },
          support.cookie,
        )
      ).statusCode,
    ).toBe(204);
    const after = (await api('GET', `/v1/support/tickets/${ticketId}`, undefined, employee.cookie)).json()
      .ticket;
    expect(new Date(after.sla.resolution.dueAt).toISOString()).toBe(
      new Date(slaDeadlines(cfg, before.planId, 'low', 'uk', before.createdAt).resolutionDueAt).toISOString(),
    );
  });

  it('a closed ticket takes no more replies', async () => {
    expect(
      (await api('POST', `/v1/support/tickets/${ticketId}/close`, undefined, employee.cookie)).statusCode,
    ).toBe(204);
    expect(
      (await api('POST', `/v1/support/tickets/${ticketId}/messages`, { body: 'x' }, employee.cookie))
        .statusCode,
    ).toBe(409);
  });
});

describe('SLA escalation (idempotent periodic job)', () => {
  it('notifies the regional escalation mailbox once when at risk and once when breached, without ticket text', async () => {
    const r = await newTicket(owner.cookie, {
      priority: 'urgent',
      subject: 'Nobody can sign in',
      body: 'Fictional outage details',
    });
    const t = r.json();
    const saved = ctx.clock.now;
    const sent = () => ctx.mailer.sent.filter((m) => m.subject.includes(t.reference));
    try {
      // the periodic enqueuer is idempotent per slot
      for (let i = 0; i < 2; i++)
        await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
          for (const p of periodic) await p(tx, ctx.clock.now);
        });
      const jobs = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.query(`SELECT 1 FROM app.jobs WHERE kind = 'support.sla_sweep' AND status = 'queued'`),
      );
      expect(jobs).toHaveLength(1);
      await runQueued(ctx, owner.tenantId, 'support.sla_sweep');
      expect(sent()).toHaveLength(0); // on track
      ctx.clock.now = new Date(new Date(t.sla.firstResponse.dueAt).getTime() - 60_000); // inside the at-risk window
      await runJob(ctx, owner.tenantId, 'support.sla_sweep');
      await runJob(ctx, owner.tenantId, 'support.sla_sweep');
      expect(sent()).toHaveLength(1);
      expect(sent()[0]!.subject).toMatch(/at_risk/);
      ctx.clock.now = new Date(new Date(t.sla.firstResponse.dueAt).getTime() + 60_000);
      await runJob(ctx, owner.tenantId, 'support.sla_sweep');
      await runJob(ctx, owner.tenantId, 'support.sla_sweep');
      expect(sent()).toHaveLength(2);
      expect(sent()[1]!.subject).toMatch(/breached/);
      expect(sent()[1]!.to).toBe(`support-escalations-uk@${ctx.deps.config.domain}`);
      expect(
        sent()
          .map((m) => `${m.subject} ${m.text}`)
          .join(' '),
      ).not.toMatch(/Nobody can sign in|Fictional outage/);
      const staffView = (
        await api(
          'GET',
          '/v1/backoffice/support/queue',
          undefined,
          (await staffSession(ctx, 'support')).cookie,
        )
      )
        .json()
        .find((q: { ticketId: string }) => q.ticketId === t.id);
      expect(staffView.sla.flag).toBe('breached');
    } finally {
      ctx.clock.now = saved;
    }
  });
});

describe('contact channels are configurable per plan and region in the back office', () => {
  it('a support staff override replaces the configured channels for this region (append-only, audited)', async () => {
    const support = await staffSession(ctx, 'support');
    const put = await api(
      'PUT',
      '/v1/backoffice/settings/contact-channels',
      {
        channels: {
          [cfg.trial.planId]: [
            { kind: 'ticket', hours: 'business_hours' },
            { kind: 'phone', value: '+44 20 0000 0000', hours: 'business_hours' },
          ],
        },
      },
      support.cookie,
    );
    expect(put.statusCode, put.body).toBe(204);
    const r = (await api('GET', '/v1/support/contact', undefined, employee.cookie)).json();
    expect(r.channels).toEqual([
      { kind: 'ticket', hours: 'business_hours' },
      { kind: 'phone', value: '+44 20 0000 0000', hours: 'business_hours' },
    ]);
    expect(
      (
        await api(
          'PUT',
          '/v1/backoffice/settings/contact-channels',
          { channels: { 'no-such-plan': [] } },
          support.cookie,
        )
      ).statusCode,
    ).toBe(400);
  });
});
