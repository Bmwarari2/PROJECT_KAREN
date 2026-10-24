import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  PASSWORD,
  randomIp,
  signup,
  startTestApp,
  totpCode,
  type TestContext,
} from './helpers';
import { hashPassword } from '../src/modules/auth/tokens';
import { assignRole } from '../src/modules/authz/principal';
import { clientNetworkFromEnv } from '../src/deps';
import { ACCOUNT_LIMITS } from '../src/modules/auth/throttles';
import { ADMIN_ABSOLUTE_HOURS, ADMIN_IDLE_MINUTES, securityFrom } from '../src/modules/auth/sessions';
import { onSecurityEvent, type SecurityEvent } from '../src/lib/security-events';

/**
 * Customer identity hardening (PROGRESS 15.3, 15.5, 15.8; plan 2.1.2, 2.1.5, 2.1.6; ADR-0170, ADR-0172,
 * ADR-0173): two-step verification for everyone in new workspaces, per-account and per-workspace
 * throttles next to the per-IP ones, auth.* security events, and shorter admin sessions.
 */
let ctx: TestContext;
const events: SecurityEvent[] = [];
let stop: () => void;
beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  stop = onSecurityEvent((e) => void events.push(e));
});
afterAll(async () => {
  stop();
  await ctx.close();
  await closeDb();
});

type Owner = { tenantId: string; slug: string; cookie: string; userId: string };

async function person(owner: Owner, role = 'employee') {
  const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
  const userId = await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, 'Fictional Person') RETURNING id`,
      [email],
    );
    await tx.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(tx, u.id, 'employee', { type: 'self' });
    if (role !== 'employee') await assignRole(tx, u.id, role, { type: 'all' });
    return u.id;
  });
  return { userId, email };
}
const login = (slug: string, email: string, password = PASSWORD, ip = randomIp()) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: slug, email, password },
    remoteAddress: ip,
  });
const get = (url: string, cookie: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie, ...headers } });

describe('two-step verification for everyone (plan 2.1.2)', () => {
  it('is on in new workspaces: an employee with only a password must set up an authenticator before anything else', async () => {
    const owner = await ownerSession(ctx, undefined, { mfaForEveryone: true });
    expect((await get('/v1/settings/security', owner.cookie)).json()).toMatchObject({
      requireMfaForEveryone: true,
      trustIdpMfa: false,
    });
    const p = await person(owner);
    const res = await login(owner.slug, p.email);
    expect(res.json()).toMatchObject({ mfaRequired: false, mfaEnrollmentRequired: true });
    const cookie = cookieFrom(res);
    const blocked = await get('/v1/auth/sessions', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfaEnrollmentRequired');
    expect((await get('/v1/auth/session', cookie)).json()).toMatchObject({
      isAdmin: false,
      mustUseMfa: true,
    });
    await enrolTotp(ctx, cookie);
    expect((await get('/v1/auth/sessions', cookie)).statusCode).toBe(200);
  });

  it('admins can turn it off after re-authenticating; employees then sign in with a password only', async () => {
    const owner = await ownerSession(ctx, undefined, { mfaForEveryone: true });
    ctx.clock.advanceMinutes(11);
    try {
      const patch = () =>
        ctx.app.inject({
          method: 'PATCH',
          url: '/v1/settings/security',
          headers: { cookie: owner.cookie },
          payload: { requireMfaForEveryone: false },
        });
      expect((await patch()).json().code).toBe('reauthenticationRequired');
      const reauth = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/reauth',
        headers: { cookie: owner.cookie },
        payload: { code: totpCode(owner.totpSecret, ctx.clock.now) },
      });
      expect(reauth.statusCode).toBe(204);
      owner.cookie = cookieFrom(reauth);
      expect((await patch()).statusCode).toBe(200);
      const p = await person(owner);
      expect((await login(owner.slug, p.email)).json()).toMatchObject({ mfaEnrollmentRequired: false });
      // turning it back on needs no re-authentication (it makes sign-in stronger)
      const on = await ctx.app.inject({
        method: 'PATCH',
        url: '/v1/settings/security',
        headers: { cookie: owner.cookie },
        payload: { requireMfaForEveryone: true },
      });
      expect(on.statusCode).toBe(200);
    } finally {
      ctx.clock.advanceMinutes(-11);
    }
  });

  it('workspaces created before the change keep their behaviour (defaults version 1); new ones get version 2', async () => {
    const legacy = await signup(ctx, undefined, ctx.deps.config.cell, { mfaForEveryone: true });
    const row = await withTenant(ctx.deps.router, legacy.tenantId, (tx) =>
      tx.one<{ security: Record<string, unknown>; security_defaults_version: number }>(
        'SELECT security, security_defaults_version FROM app.tenants',
      ),
    );
    expect(row.security_defaults_version).toBe(2);
    expect(row.security).toMatchObject({ requireMfaForEveryone: true, trustIdpMfa: false });
    // a workspace as migration 0024 leaves an existing one: no explicit choice, version 1
    await withTenant(ctx.deps.router, legacy.tenantId, (tx) =>
      tx.exec(`UPDATE app.tenants SET security = '{}'::jsonb, security_defaults_version = 1`),
    );
    expect(securityFrom({}, 1)).toMatchObject({ requireMfaForEveryone: false, trustIdpMfa: true });
    const owner = { ...legacy } as Owner;
    const p = await person(owner);
    expect((await login(legacy.slug, p.email)).json()).toMatchObject({ mfaEnrollmentRequired: false });
    // admins still must use a second factor there
    expect((await login(legacy.slug, legacy.email)).json()).toMatchObject({ mfaEnrollmentRequired: true });
  });
});

describe('throttles per account, per workspace and per IP (plan 2.1.6)', () => {
  it('sign-in: a workspace-wide failure budget stops stuffing spread over many addresses and accounts', async () => {
    const owner = await ownerSession(ctx);
    const other = await ownerSession(ctx);
    const p = await person(owner);
    ctx.deps.authBudgets = { loginFailures: { floor: 5, perUser: 0 } };
    try {
      for (let i = 0; i < 5; i++)
        expect((await login(owner.slug, `stuffed.${i}@example.test`, 'Wrong-password-123')).statusCode).toBe(
          401,
        );
      // the budget is spent: even the right password waits for the window, from any address
      const refused = await login(owner.slug, p.email);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // another workspace signs in normally
      expect((await login(other.slug, other.email)).statusCode).toBe(200);
      // successful sign-ins do not use the budget
      const busy = await ownerSession(ctx);
      for (let i = 0; i < 6; i++) expect((await login(busy.slug, busy.email)).statusCode).toBe(200);
    } finally {
      ctx.deps.authBudgets = undefined;
    }
    const scopes = events.filter((e) => e.type === 'auth.throttled' && e.tenantId === owner.tenantId);
    expect(scopes.map((e) => e.detail?.scope)).toContain('tenant');
  });

  it('sign-in: per account (10) and per IP (50) in 15 minutes; failures and lockouts are auth.* events', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(owner);
    for (let i = 0; i < 5; i++) await login(owner.slug, p.email, 'Wrong-password-123');
    const locked = await login(owner.slug, p.email);
    expect(locked.statusCode).toBe(423);
    for (let i = 0; i < ACCOUNT_LIMITS.loginAttempts - 6; i++) await login(owner.slug, p.email);
    expect((await login(owner.slug, p.email)).statusCode).toBe(429);
    const ip = randomIp();
    for (let i = 0; i < ACCOUNT_LIMITS.loginAttemptsPerIp; i++)
      await login(owner.slug, `ip.${i}@example.test`, 'Wrong-password-123', ip);
    expect((await login(owner.slug, owner.email, PASSWORD, ip)).statusCode).toBe(429);
    const mine = events.filter((e) => e.tenantId === owner.tenantId);
    expect(mine.map((e) => e.type)).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.lockout']));
    // per-account and per-IP refusals come before the workspace is looked up: keyed, without a tenant
    expect(
      events.filter((e) => e.type === 'auth.throttled' && !e.tenantId).map((e) => e.detail?.scope),
    ).toEqual(expect.arrayContaining(['account', 'ip']));
    const unknown = mine.find((e) => e.type === 'auth.login_failed' && !e.userId)!;
    expect(unknown.accountKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(unknown.ipKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const text = JSON.stringify(mine);
    expect(text).not.toContain(p.email);
    expect(text).not.toContain(ip);
  });

  it('authenticator codes: limited per account, per IP and per workspace', async () => {
    const owner = await ownerSession(ctx);
    const verify = (cookie: string, ip = randomIp()) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp/verify',
        headers: { cookie },
        payload: { code: '000000' },
        remoteAddress: ip,
      });
    const users = [];
    for (let i = 0; i < 3; i++) {
      const p = await person(owner);
      const c = cookieFrom(await login(owner.slug, p.email));
      await enrolTotp(ctx, c);
      users.push(cookieFrom(await login(owner.slug, p.email)));
    }
    // per account: 5 codes in 5 minutes (the enrolment code was the first)
    for (let i = 0; i < ACCOUNT_LIMITS.mfaAttempts - 1; i++)
      expect((await verify(users[0]!)).statusCode).toBe(401);
    expect((await verify(users[0]!)).statusCode).toBe(429);
    // per workspace: a failure budget across people (lowered here)
    ctx.deps.authBudgets = { mfaFailures: { floor: ACCOUNT_LIMITS.mfaAttempts + 1, perUser: 0 } };
    try {
      expect((await verify(users[1]!)).statusCode).toBe(401);
      expect((await verify(users[1]!)).statusCode).toBe(401);
      expect((await verify(users[2]!)).statusCode).toBe(429);
    } finally {
      ctx.deps.authBudgets = undefined;
    }
    expect(events.filter((e) => e.type === 'auth.mfa_failed' && e.tenantId === owner.tenantId).length).toBe(
      ACCOUNT_LIMITS.mfaAttempts + 1,
    );
  });

  it('emailed sign-in links: per account, per workspace and per IP, with the same answer for unknown accounts', async () => {
    const owner = await ownerSession(ctx);
    const ask = (email: string, ip = randomIp()) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link',
        payload: { tenant: owner.slug, email },
        remoteAddress: ip,
      });
    const known = await ask(owner.email);
    expect(known.statusCode).toBe(202);
    for (let i = 1; i < ACCOUNT_LIMITS.magicLinkRequests; i++)
      expect((await ask(owner.email)).statusCode).toBe(202);
    expect((await ask(owner.email)).statusCode).toBe(429);
    const unknown = await ask('nobody@example.test');
    expect(unknown.statusCode).toBe(202);
    expect(unknown.body).toBe(known.body);
    ctx.deps.authBudgets = { emailLinks: { floor: ACCOUNT_LIMITS.magicLinkRequests + 1, perUser: 0 } };
    try {
      expect((await ask('another@example.test')).statusCode).toBe(429);
    } finally {
      ctx.deps.authBudgets = undefined;
    }
  });
});

describe('admin sessions (plan 2.1.5)', () => {
  it('end after 15 idle minutes and 8 hours whatever the workspace allows; employees keep the workspace limits', async () => {
    const owner = await ownerSession(ctx);
    await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: owner.cookie },
      payload: { sessionIdleMinutes: 120, sessionAbsoluteHours: 24 },
    });
    const p = await person(owner);
    const employee = cookieFrom(await login(owner.slug, p.email));
    const admin = cookieFrom(await login(owner.slug, owner.email));
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/verify',
      headers: { cookie: admin },
      payload: { code: totpCode(owner.totpSecret, ctx.clock.now, 1) },
    });
    const moved: number[] = [];
    const advance = (n: number) => {
      ctx.clock.advanceMinutes(n);
      moved.push(n);
    };
    try {
      advance(ADMIN_IDLE_MINUTES - 1);
      expect((await get('/v1/auth/session', admin)).statusCode).toBe(200);
      advance(ADMIN_IDLE_MINUTES + 1);
      expect((await get('/v1/auth/session', admin)).statusCode).toBe(401);
      expect((await get('/v1/auth/session', employee)).statusCode).toBe(200); // 120 idle minutes
      // absolute: an active admin session still ends at 8 hours
      const again = cookieFrom(await login(owner.slug, owner.email));
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp/verify',
        headers: { cookie: again },
        payload: { code: totpCode(owner.totpSecret, ctx.clock.now, 2) },
      });
      for (let m = 0; m < ADMIN_ABSOLUTE_HOURS * 60 - 14; m += 14) {
        advance(14);
        expect((await get('/v1/auth/session', again)).statusCode).toBe(200);
      }
      advance(15);
      expect((await get('/v1/auth/session', again)).statusCode).toBe(401);
    } finally {
      ctx.clock.advanceMinutes(-moved.reduce((a, b) => a + b, 0));
    }
  });

  it('re-authenticate when the network (autonomous system) changes, when the cell has that signal', async () => {
    expect(clientNetworkFromEnv({})).toBeUndefined();
    const fromHeader = clientNetworkFromEnv({ CLIENT_ASN_HEADER: 'CloudFront-Viewer-ASN' })!;
    expect(fromHeader({ 'cloudfront-viewer-asn': '64496' })).toBe('AS64496');
    expect(fromHeader({ 'cloudfront-viewer-asn': 'AS64496; drop table' })).toBeUndefined();
    ctx.deps.clientNetwork = fromHeader;
    try {
      const owner = await ownerSession(ctx);
      const p = await person(owner);
      const employee = cookieFrom(await login(owner.slug, p.email));
      const asn = (n: string) => ({ 'cloudfront-viewer-asn': n });
      expect((await get('/v1/settings/security', owner.cookie, asn('64496'))).statusCode).toBe(200);
      expect((await get('/v1/settings/security', owner.cookie, asn('64496'))).statusCode).toBe(200);
      const moved = await get('/v1/settings/security', owner.cookie, asn('64511'));
      expect(moved.statusCode).toBe(403);
      expect(moved.json()).toMatchObject({ code: 'reauthenticationRequired', reason: 'networkChanged' });
      expect((await get('/v1/auth/session', owner.cookie, asn('64511'))).statusCode).toBe(200);
      const reauth = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/reauth',
        headers: { cookie: owner.cookie, ...asn('64511') },
        payload: { password: PASSWORD },
      });
      expect(reauth.statusCode).toBe(204);
      const fresh = cookieFrom(reauth);
      expect((await get('/v1/settings/security', fresh, asn('64511'))).statusCode).toBe(200);
      // employees are not asked (their access is limited to their own records)
      expect((await get('/v1/auth/sessions', employee, asn('64496'))).statusCode).toBe(200);
      expect((await get('/v1/auth/sessions', employee, asn('64511'))).statusCode).toBe(200);
      expect(
        events.some((e) => e.type === 'auth.session_network_changed' && e.tenantId === owner.tenantId),
      ).toBe(true);
    } finally {
      ctx.deps.clientNetwork = undefined;
    }
  });
});
