import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, ownerSession, signup, startTestApp, type TestContext } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';
import { Vault } from '../src/modules/vault/service';
import { loadPrincipal, assignRole } from '../src/modules/authz/principal';
import { withSupportAccess } from '../src/modules/support/access';
import { InMemoryDirectory } from '../src/lib/directory';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('passkeys', () => {
  it('registers a passkey and signs in with it (counts as MFA)', async () => {
    const s = await signup(ctx);
    const auth = new SoftAuthenticator('localhost', 'http://localhost:3000');
    const opts = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/register/options',
      headers: { cookie: s.cookie },
    });
    expect(opts.statusCode).toBe(200);
    const { challengeId, options } = opts.json();
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/register/verify',
      headers: { cookie: s.cookie },
      payload: { challengeId, response: auth.register(options) },
    });
    expect(reg.statusCode).toBe(204);
    // registering a passkey also satisfies the admin MFA gate for this session
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(200);

    const lo = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/login/options',
      payload: { tenant: s.slug },
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/login/verify',
      payload: { challengeId: lo.json().challengeId, response: auth.assert(lo.json().options) },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(me.json()).toMatchObject({ method: 'passkey', mfaVerified: true });
  });

  it('rejects assertions without user verification and replayed challenges', async () => {
    const s = await signup(ctx);
    const auth = new SoftAuthenticator('localhost', 'http://localhost:3000');
    const opts = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: { cookie: s.cookie },
      })
    ).json();
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/register/verify',
      headers: { cookie: s.cookie },
      payload: { challengeId: opts.challengeId, response: auth.register(opts.options) },
    });
    const lo = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/login/options',
        payload: { tenant: s.slug },
      })
    ).json();
    const noUv = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/login/verify',
      payload: { challengeId: lo.challengeId, response: auth.assert(lo.options, { userVerified: false }) },
    });
    expect(noUv.statusCode).toBe(401);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/login/verify',
      payload: { challengeId: lo.challengeId, response: auth.assert(lo.options) },
    });
    expect(again.statusCode).toBe(401);
  });
});

describe('region-aware sign-in routing', () => {
  it('resolves slug and verified domain to the home region', async () => {
    const dir = ctx.directory;
    await dir.register({
      tenantId: crypto.randomUUID(),
      slug: 'fictional-eu-co',
      homeRegion: 'eu',
      status: 'active',
      planRef: null,
      verifiedDomains: ['eu-co.example.test'],
    });
    const bySlug = await ctx.app.inject({ method: 'GET', url: '/global/v1/resolve?slug=fictional-eu-co' });
    expect(bySlug.json()).toMatchObject({ region: 'eu', appUrl: 'https://app.eu.thapsus-hr.test' });
    const byEmail = await ctx.app.inject({
      method: 'GET',
      url: '/global/v1/resolve?email=someone@eu-co.example.test',
    });
    expect(byEmail.json().region).toBe('eu');
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/global/v1/resolve?slug=nope-nope' })).statusCode,
    ).toBe(404);
  });

  it('a request for a tenant homed elsewhere is refused at this cell without touching tenant data', async () => {
    await ctx.directory.register({
      tenantId: crypto.randomUUID(),
      slug: 'fictional-us-co',
      homeRegion: 'us',
      status: 'active',
      planRef: null,
      verifiedDomains: [],
    });
    const spy = vi.spyOn(ctx.deps.router, 'poolFor');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: 'fictional-us-co', email: 'a@b.example.test', password: 'whatever-password' },
      remoteAddress: '10.77.0.1',
    });
    expect(res.statusCode).toBe(421);
    expect(res.json()).toMatchObject({ region: 'us', appUrl: 'https://app.us.thapsus-hr.test' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('"find my workspace" fans out to every region, which emails the user; the global layer stores nothing', async () => {
    const s = await signup(ctx);
    const calls: Array<{ url: string; body: string }> = [];
    const globalDir = new InMemoryDirectory();
    const fetchSpy = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      const r = await ctx.app.inject({
        method: 'POST',
        url: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        payload: String(init.body),
      });
      return new Response(null, { status: r.statusCode });
    }) as typeof fetch;
    const g = await startTestApp({
      listen: false,
      directory: globalDir,
      overrides: {
        serviceRole: 'global',
        fetch: fetchSpy,
        regionalApiUrls: { uk: 'http://uk.cell', eu: 'http://eu.cell', us: 'http://us.cell' },
      },
    });
    try {
      const before = JSON.stringify([...globalDir.entries.values()]);
      const res = await g.app.inject({
        method: 'POST',
        url: '/global/v1/find-workspace',
        payload: { email: s.email },
      });
      expect(res.statusCode).toBe(202);
      expect(calls.map((c) => new URL(c.url).host).sort()).toEqual(['eu.cell', 'uk.cell', 'us.cell']);
      expect(ctx.mailer.sent.findLast((m) => m.to === s.email)?.text).toContain(`workspace=${s.slug}`);
      expect(ctx.mailer.region).toBe('uk');
      expect(JSON.stringify([...globalDir.entries.values()])).toBe(before);
      expect(g.mailer.sent).toHaveLength(0);
      // the global service exposes no tenant APIs
      expect((await g.app.inject({ method: 'POST', url: '/v1/auth/login', payload: {} })).statusCode).toBe(
        404,
      );
    } finally {
      await g.close();
    }
  });
});

describe('sensitive data vault', () => {
  it('stores ciphertext only, refuses roles without permission and audits every decrypt', async () => {
    const owner = await ownerSession(ctx);
    const vault = new Vault(ctx.deps.keys);
    const employeeId = crypto.randomUUID();
    const managerId = await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
      const m = await tx.one<{ id: string }>(
        `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), 'mgr@v.example.test', 'Mo Manager') RETURNING id`,
      );
      await assignRole(tx, m.id, 'manager');
      return m.id;
    });
    await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
      const principal = await loadPrincipal(tx, owner.userId);
      await vault.put(
        tx,
        { principal, actorType: 'user' },
        owner.tenantId,
        { employeeId },
        'health',
        'condition',
        'Fictional condition A',
      );
    });
    const raw = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ envelope: unknown }>('SELECT envelope FROM vault.records'),
    );
    expect(JSON.stringify(raw)).not.toContain('Fictional condition A');

    const read = await withTenant(ctx.deps.router, owner.tenantId, async (tx) =>
      vault.read(
        tx,
        { principal: await loadPrincipal(tx, owner.userId), actorType: 'user' },
        owner.tenantId,
        { employeeId },
        'health',
      ),
    );
    expect(read[0]!.value).toBe('Fictional condition A');

    await expect(
      withTenant(ctx.deps.router, owner.tenantId, async (tx) =>
        vault.read(
          tx,
          { principal: await loadPrincipal(tx, managerId), actorType: 'user' },
          owner.tenantId,
          { employeeId, managerChain: [] },
          'health',
        ),
      ),
    ).rejects.toThrow('forbidden');

    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string; sensitive: boolean }>(
        `SELECT action, sensitive FROM audit.events WHERE action LIKE 'vault.%' ORDER BY id`,
      ),
    );
    expect(audit.map((a) => a.action)).toEqual(['vault.write', 'vault.read']);
    expect(audit.every((a) => a.sensitive)).toBe(true);
  });

  it('ciphertext from one tenant cannot be decrypted in another tenant (AAD binding)', async () => {
    const a = await ownerSession(ctx);
    const b = await ownerSession(ctx);
    const vault = new Vault(ctx.deps.keys);
    const emp = crypto.randomUUID();
    const envelope = await withTenant(ctx.deps.router, a.tenantId, async (tx) => {
      await vault.put(
        tx,
        { principal: await loadPrincipal(tx, a.userId), actorType: 'user' },
        a.tenantId,
        { employeeId: emp },
        'immigration',
        'visa',
        'Fictional visa',
      );
      return (await tx.one<{ envelope: unknown }>('SELECT envelope FROM vault.records')).envelope;
    });
    await withTenant(ctx.deps.router, b.tenantId, (tx) =>
      tx.exec(
        `INSERT INTO vault.records (tenant_id, subject_id, category, field, envelope) VALUES (app.current_tenant(), $1, 'immigration', 'visa', $2)`,
        [emp, JSON.stringify(envelope)],
      ),
    );
    await expect(
      withTenant(ctx.deps.router, b.tenantId, async (tx) =>
        vault.read(
          tx,
          { principal: await loadPrincipal(tx, b.userId), actorType: 'user' },
          b.tenantId,
          { employeeId: emp },
          'immigration',
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('Thapsus support access', () => {
  const staffId = '5a1f0000-0000-4000-8000-000000000001';
  const run = (tenantId: string, opts: { write?: boolean } = {}) =>
    withSupportAccess(
      { router: ctx.deps.router, backofficeDbUrl: ctx.deps.backofficeDbUrl! },
      staffId,
      tenantId,
      'view_users',
      (tx) => tx.query('SELECT id FROM app.users'),
      opts,
    );

  it('has no path to tenant data without an active grant', async () => {
    const o = await ownerSession(ctx);
    await expect(run(o.tenantId)).rejects.toThrow('No active support grant');
  });

  it('works while granted, is read-only for read grants, audits, and stops on revoke', async () => {
    const o = await ownerSession(ctx);
    const g = await ctx.app.inject({
      method: 'POST',
      url: '/v1/settings/support-grants',
      headers: { cookie: o.cookie },
      payload: { staffId, accessLevel: 'read', hours: 2, reason: 'Ticket 123: payroll export question' },
    });
    expect(g.statusCode).toBe(201);
    expect((await run(o.tenantId)).length).toBeGreaterThan(0);
    await expect(run(o.tenantId, { write: true })).rejects.toThrow('read-only');
    const audit = await withTenant(ctx.deps.router, o.tenantId, (tx) =>
      tx.query<{ actor_type: string; action: string }>(
        `SELECT actor_type, action FROM audit.events WHERE actor_type = 'support'`,
      ),
    );
    expect(audit).toEqual([{ actor_type: 'support', action: 'support.view_users' }]);
    await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/settings/support-grants/${g.json().id}`,
      headers: { cookie: o.cookie },
    });
    await expect(run(o.tenantId)).rejects.toThrow('No active support grant');
  });

  it('expires on time', async () => {
    const o = await ownerSession(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/settings/support-grants',
      headers: { cookie: o.cookie },
      payload: { staffId, accessLevel: 'read', hours: 1, reason: 'Ticket 124' },
    });
    await withTenant(ctx.deps.router, o.tenantId, (tx) =>
      tx.exec(
        `UPDATE app.support_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`,
      ),
    );
    await expect(run(o.tenantId)).rejects.toThrow('No active support grant');
  });
});

describe('audit log coverage and export', () => {
  it('every successful mutating call writes an audit entry, and exports are filtered by date in CSV and JSON', async () => {
    const o = await ownerSession(ctx);
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/me/preferences',
      headers: { cookie: o.cookie },
      payload: { timeZone: 'Europe/Dublin' },
    });
    const page = await ctx.app.inject({
      method: 'GET',
      url: `/v1/audit/events?from=${from}&to=${to}`,
      headers: { cookie: o.cookie },
    });
    const actions = page.json().data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'auth.login',
        'auth.mfa.totp_enrolled',
        'user.preferences_updated',
      ]),
    );
    const entry = page.json().data.find((e: { action: string }) => e.action === 'user.preferences_updated');
    expect(entry).toMatchObject({ actorType: 'user', actorId: o.userId, targetId: o.userId });
    expect(entry.requestId).toBeTruthy();

    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/v1/audit/events?from=${from}&to=${to}&format=csv`,
      headers: { cookie: o.cookie },
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe(
      'id,seq,at,actorType,actorId,action,targetType,targetId,diff,ip,userAgent,requestId,sensitive,hash',
    );
    const json = await ctx.app.inject({
      method: 'GET',
      url: `/v1/audit/events?from=${from}&to=${to}&format=json`,
      headers: { cookie: o.cookie },
    });
    expect(Array.isArray(json.json())).toBe(true);
    const empty = await ctx.app.inject({
      method: 'GET',
      url: `/v1/audit/events?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z&format=json`,
      headers: { cookie: o.cookie },
    });
    expect(empty.json()).toEqual([]);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/v1/audit/verify',
      headers: { cookie: o.cookie },
    });
    expect(verify.json()).toMatchObject({ intact: true });
  });

  it('employees cannot export the audit log', async () => {
    const o = await ownerSession(ctx);
    const emp = await withTenant(ctx.deps.router, o.tenantId, async (tx) => {
      const u = await tx.one<{ id: string }>(
        `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), 'emp@x.example.test', 'Em Ployee') RETURNING id`,
      );
      await assignRole(tx, u.id, 'employee');
      await tx.exec(
        `INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) SELECT tenant_id, $1, password_hash FROM app.password_credentials WHERE user_id = $2`,
        [u.id, o.userId],
      );
      return u.id;
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: o.slug, email: 'emp@x.example.test', password: 'Correct-Horse-Battery-9' },
      remoteAddress: '10.88.0.1',
    });
    expect(res.json().userId).toBe(emp);
    const exp = await ctx.app.inject({
      method: 'GET',
      url: `/v1/audit/events?from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z&format=csv`,
      headers: { cookie: cookieFrom(res) },
    });
    expect(exp.statusCode).toBe(403);
  });
});
