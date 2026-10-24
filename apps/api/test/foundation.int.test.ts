import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@thapsus/db';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { closeDb, ownerSession, randomIp, startTestApp, type TestContext } from './helpers';
import { loadPrincipal } from '../src/modules/authz/principal';

const pushes = vi.hoisted(() => ({
  calls: [] as Array<{ endpoint: string; payload: string; vapid: unknown }>,
}));
vi.mock('web-push', () => ({
  default: {
    sendNotification: async (sub: { endpoint: string }, payload: string, opts: { vapidDetails: unknown }) => {
      pushes.calls.push({ endpoint: sub.endpoint, payload, vapid: opts.vapidDetails });
      return { statusCode: 201 };
    },
  },
}));

/** Foundation behaviours not covered by the feature suites: roles, delegation expiry, audit context, push, schema rules. */
const VAPID = {
  publicKey: 'BFictionalPublicKeyForTestsOnly',
  privateKey: 'fictional-private-key',
  subject: 'mailto:dev@thapsus-hr.test',
};
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);

beforeAll(async () => {
  ctx = await startTestApp({
    listen: false,
    overrides: { webPush: VAPID },
    // A mutating route that does not audit itself: the safety-net hook must record it.
    extend: (app) => app.post('/v1/__test/unaudited', async () => ({ ok: true })),
  });
  owner = await ownerSession(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('built-in roles', () => {
  it('every new tenant gets exactly the built-in roles from the brief', async () => {
    const roles = await tx((t) =>
      t.query<{ key: string; built_in: boolean; is_admin: boolean }>(
        'SELECT key, built_in, is_admin FROM app.roles ORDER BY key',
      ),
    );
    expect(roles.map((r) => r.key).sort()).toEqual([
      'employee',
      'entity_hr_admin',
      'hr_admin',
      'it_admin',
      'manager',
      'owner',
      'payroll_admin',
    ]);
    expect(roles.every((r) => r.built_in)).toBe(true);
    for (const r of roles) expect(r.is_admin).toBe(BUILT_IN_ROLES.find((b) => b.key === r.key)!.isAdmin);
    // the Thapsus super-admin is a back-office role, never a tenant role
    expect(roles.some((r) => /super/.test(r.key))).toBe(false);
  });
});

describe('delegation', () => {
  it('only active delegations extend authority; expired and future ones do not', async () => {
    const ids = await tx(async (t) => {
      const mk = async (email: string) => {
        const e = await t.one<{ id: string }>(
          `INSERT INTO app.employees (tenant_id, employee_number, start_date, display_name) VALUES (app.current_tenant(), $1, '2024-01-01', 'Fictional') RETURNING id`,
          [email],
        );
        const u = await t.one<{ id: string }>(
          `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional', $2) RETURNING id`,
          [email, e.id],
        );
        return { employee: e.id, user: u.id };
      };
      return {
        a: await mk('mgr-a@example.test'),
        b: await mk('mgr-b@example.test'),
        c: await mk('mgr-c@example.test'),
        d: await mk('delegate@example.test'),
      };
    });
    await tx(async (t) => {
      const ins = (from: string, starts: string, ends: string) =>
        t.exec(
          `INSERT INTO app.delegations (tenant_id, from_user_id, to_user_id, starts_at, ends_at) VALUES (app.current_tenant(), $1, $2, now() + $3::interval, now() + $4::interval)`,
          [from, ids.d.user, starts, ends],
        );
      await ins(ids.a.user, '-1 day', '1 day'); // active
      await ins(ids.b.user, '-10 days', '-1 day'); // expired
      await ins(ids.c.user, '1 day', '10 days'); // not started
    });
    const p = await tx((t) => loadPrincipal(t, ids.d.user));
    expect(p.delegatedFromEmployeeIds).toEqual([ids.a.employee]);
  });
});

describe('audit context', () => {
  it('records actor, IP, user agent and request id on audited mutations', async () => {
    const ip = randomIp();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/me/preferences',
      payload: { locale: 'en-US' },
      headers: { cookie: owner.cookie, 'user-agent': 'FictionalBrowser/1.0' },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(204);
    const row = await tx((t) =>
      t.one<{ actor_type: string; actor_id: string; ip: string; user_agent: string; request_id: string }>(
        `SELECT actor_type, actor_id, host(ip) AS ip, user_agent, request_id FROM audit.events WHERE action = 'user.preferences_updated' ORDER BY id DESC LIMIT 1`,
      ),
    );
    expect(row).toMatchObject({
      actor_type: 'user',
      actor_id: owner.userId,
      ip,
      user_agent: 'FictionalBrowser/1.0',
    });
    expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a client cannot choose its own IP: only the hop added by the trusted proxy counts', async () => {
    // The ALB appends the real client address; anything to its left was supplied by the client.
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/me/preferences',
      payload: { locale: 'en-GB' },
      headers: { cookie: owner.cookie, 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      remoteAddress: '10.0.12.34',
    });
    expect(res.statusCode).toBe(204);
    const row = await tx((t) =>
      t.one<{ ip: string }>(
        `SELECT host(ip) AS ip FROM audit.events WHERE action = 'user.preferences_updated' ORDER BY id DESC LIMIT 1`,
      ),
    );
    expect(row.ip).toBe('203.0.113.9');
  });

  it('the safety-net hook audits a mutating call whose route forgot to', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/__test/unaudited',
      headers: { cookie: owner.cookie, 'user-agent': 'FictionalBrowser/2.0' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await tx((t) =>
      t.query<{ action: string; actor_id: string; user_agent: string }>(
        `SELECT action, actor_id, user_agent FROM audit.events WHERE action = 'http.post /v1/__test/unaudited'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: owner.userId, user_agent: 'FictionalBrowser/2.0' });
  });
});

describe('web push', () => {
  it('stores a subscription and sends a localised test notification signed with the VAPID keys', async () => {
    const endpoint = 'https://push.example.test/fictional-subscription';
    const sub = await ctx.app.inject({
      method: 'POST',
      url: '/v1/me/push-subscriptions',
      headers: { cookie: owner.cookie },
      payload: { endpoint, keys: { p256dh: 'BFictionalP256dhKey', auth: 'fictional-auth' } },
    });
    expect(sub.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' })).json()).toEqual({
      publicKey: VAPID.publicKey,
    });
    const sent = await ctx.app.inject({
      method: 'POST',
      url: '/v1/me/push-test',
      headers: { cookie: owner.cookie },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ sent: 1 });
    const call = pushes.calls.find((c) => c.endpoint === endpoint)!;
    expect(JSON.parse(call.payload)).toMatchObject({ title: 'Thapsus-HR' });
    expect(call.vapid).toEqual(VAPID);
    const audited = await tx((t) =>
      t.query(`SELECT 1 FROM audit.events WHERE action IN ('push.subscribed', 'push.test_sent')`),
    );
    expect(audited).toHaveLength(2);
  });
});

describe('schema rules', () => {
  it('instants are timestamptz everywhere (no timestamp without time zone)', async () => {
    const cols = await tx((t) =>
      t.query<{ table_schema: string; table_name: string; column_name: string }>(
        `SELECT table_schema, table_name, column_name FROM information_schema.columns
          WHERE data_type = 'timestamp without time zone' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      ),
    );
    expect(cols).toEqual([]);
  });
});

describe('global ↔ cell internal calls', () => {
  it('find-workspace refuses a missing or wrong internal token and accepts the configured one', async () => {
    const call = (token?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/internal/find-workspace',
        headers: token ? { 'x-internal-token': token } : {},
        payload: { email: 'nobody@fictional.example.test' },
      });
    expect((await call()).statusCode).toBe(403);
    expect((await call(`${ctx.deps.config.internalToken}x`)).statusCode).toBe(403);
    expect((await call('x'.repeat(ctx.deps.config.internalToken.length))).statusCode).toBe(403);
    expect((await call(ctx.deps.config.internalToken)).statusCode).toBe(202);
  });
});
