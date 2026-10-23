import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { moveTenant } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import {
  closeDb,
  cookieFrom,
  ownerSession,
  PASSWORD,
  startTestApp,
  totpCode,
  type TestContext,
} from './helpers';

/**
 * Dedicated-database routing: the same API suite passes for a tenant before and after it is moved
 * from the shared database to its own database, with only registry/configuration changes.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

type Owner = Awaited<ReturnType<typeof ownerSession>>;

async function tenantSuite(o: Owner, ip: string) {
  ctx.clock.advanceMinutes(1);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: o.slug, email: o.email, password: PASSWORD },
    remoteAddress: ip,
  });
  expect(login.statusCode).toBe(200);
  const cookie = cookieFrom(login);
  expect(
    (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp/verify',
        headers: { cookie },
        payload: { code: totpCode(o.totpSecret, ctx.clock.now) },
      })
    ).statusCode,
  ).toBe(204);
  const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
  expect(me.json()).toMatchObject({ tenantId: o.tenantId, email: o.email, isAdmin: true });
  const dom = await ctx.app.inject({
    method: 'POST',
    url: '/v1/settings/domains',
    headers: { cookie },
    payload: { domain: `${Math.random().toString(36).slice(2, 8)}.${o.slug}.example.test` },
  });
  expect(dom.statusCode).toBe(201);
  const list = await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains', headers: { cookie } });
  const tok = await ctx.app.inject({
    method: 'POST',
    url: '/v1/settings/scim-tokens',
    headers: { cookie },
    payload: { name: 'IdP' },
  });
  const scim = await ctx.app.inject({
    method: 'POST',
    url: '/scim/v2/Users',
    headers: { authorization: `Bearer ${tok.json().token}`, 'content-type': 'application/scim+json' },
    payload: JSON.stringify({
      userName: `p${Math.random().toString(36).slice(2, 6)}@${o.slug}.example.test`,
      active: true,
    }),
  });
  expect(scim.statusCode).toBe(201);
  // verified domain via DNS TXT (mocked resolver)
  const d = dom.json() as { id: string; txtName: string; txtValue: string };
  ctx.dnsRecords.set(d.txtName, [[d.txtValue]]);
  expect(
    (
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/settings/domains/${d.id}/verify`,
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ verifiedAt: expect.any(String) });
  // preferences and push subscriptions
  expect(
    (
      await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/me/preferences',
        headers: { cookie },
        payload: { timeZone: 'Europe/Berlin' },
      })
    ).statusCode,
  ).toBe(204);
  const push = await ctx.app.inject({
    method: 'POST',
    url: '/v1/me/push-subscriptions',
    headers: { cookie },
    payload: {
      endpoint: `https://push.example.test/${Math.random().toString(36).slice(2)}`,
      keys: { p256dh: 'BFictional', auth: 'fictional' },
    },
  });
  expect(push.statusCode).toBe(201);
  // passwordless sign-in by magic link (email from the home region)
  expect(
    (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link',
        payload: { tenant: o.slug, email: o.email },
        remoteAddress: ip,
      })
    ).statusCode,
  ).toBe(202);
  const mail = ctx.mailer.sent.findLast((m) => m.to === o.email)!;
  const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
  expect(
    (await ctx.app.inject({ method: 'POST', url: '/v1/auth/magic-link/consume', payload: { token } })).json(),
  ).toMatchObject({ tenantId: o.tenantId });
  // audit log export and chain verification
  const range = `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`;
  const exported = await ctx.app.inject({
    method: 'GET',
    url: `/v1/audit/events?${range}&format=json`,
    headers: { cookie },
  });
  expect(exported.statusCode).toBe(200);
  expect(
    (exported.json() as Array<{ action: string }>).some((e) => e.action === 'user.preferences_updated'),
  ).toBe(true);
  const csv = await ctx.app.inject({
    method: 'GET',
    url: `/v1/audit/events?${range}&format=csv`,
    headers: { cookie },
  });
  expect(csv.headers['content-type']).toMatch(/text\/csv/);
  const verify = await ctx.app.inject({ method: 'POST', url: '/v1/audit/verify', headers: { cookie } });
  expect(verify.json().intact).toBe(true);
  return { domains: list.json().length as number };
}

describe('moving a tenant to a dedicated database', () => {
  it('passes the same API suite before and after the move with no code change', async () => {
    const o = await ownerSession(ctx);
    const neighbour = await ownerSession(ctx);
    const before = await tenantSuite(o, '10.50.0.1');
    expect(before.domains).toBe(1);

    const report = await moveTenant({
      tenantId: o.tenantId,
      targetKey: 'dedicated',
      ownerUrls: { shared: ownerUrl(TEST_DBS.shared), dedicated: ownerUrl(TEST_DBS.dedicated) },
      purgeSource: true,
    });
    expect(report.to).toBe('dedicated');
    expect(report.tables.find((t) => t.table === 'app.users')!.rows).toBeGreaterThanOrEqual(2);
    expect(report.tables.find((t) => t.table === 'audit.events')!.rows).toBeGreaterThan(5);

    const after = await tenantSuite(o, '10.50.0.2');
    expect(after.domains).toBe(2); // data written before the move is still there, new writes land on the dedicated DB

    const shared = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    const dedicated = new pg.Client({ connectionString: ownerUrl(TEST_DBS.dedicated) });
    await shared.connect();
    await dedicated.connect();
    try {
      expect(
        (await shared.query('SELECT count(*)::int AS n FROM app.users WHERE tenant_id = $1', [o.tenantId]))
          .rows[0].n,
      ).toBe(0);
      expect(
        (await shared.query('SELECT count(*)::int AS n FROM audit.events WHERE tenant_id = $1', [o.tenantId]))
          .rows[0].n,
      ).toBe(0);
      expect(
        (await dedicated.query('SELECT count(*)::int AS n FROM app.users WHERE tenant_id = $1', [o.tenantId]))
          .rows[0].n,
      ).toBeGreaterThanOrEqual(3);
      expect(
        (await shared.query('SELECT db_key FROM registry.tenants WHERE tenant_id = $1', [o.tenantId])).rows[0]
          .db_key,
      ).toBe('dedicated');
      // the neighbour on the shared database is untouched
      expect(
        (
          await shared.query('SELECT count(*)::int AS n FROM app.users WHERE tenant_id = $1', [
            neighbour.tenantId,
          ])
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await shared.end();
      await dedicated.end();
    }
    await tenantSuite(neighbour, '10.50.0.3');
  });

  it('refuses writes while a tenant is moving', async () => {
    const o = await ownerSession(ctx);
    const reg = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await reg.connect();
    await reg.query(`UPDATE registry.tenants SET status = 'moving' WHERE tenant_id = $1`, [o.tenantId]);
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/settings/domains',
        headers: { cookie: o.cookie },
        payload: { domain: `m.${o.slug}.example.test` },
      });
      expect([401, 503]).toContain(res.statusCode);
    } finally {
      await reg.query(`UPDATE registry.tenants SET status = 'active' WHERE tenant_id = $1`, [o.tenantId]);
      await reg.end();
    }
  });
});
