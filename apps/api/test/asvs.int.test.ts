import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, enrolTotp, ownerSession, PASSWORD, signup, startTestApp, totpCode, type TestContext } from './helpers';
import { hashPassword } from '../src/modules/auth/tokens';
import { assignRole } from '../src/modules/authz/principal';

/**
 * OWASP ASVS 5.0 level 2 controls added in the Phase 12 review (docs/ASVS.md). Fictional data only.
 */
let ctx: TestContext;
let https: TestContext;
beforeAll(async () => {
  ctx = await startTestApp({
    extend: (app) => {
      app.get('/v1/test-only/html', { config: { auth: 'public' }, schema: { hide: true } }, async (_req, reply) => reply.type('text/html').send('<p>fictional</p>'));
    },
  });
  // The same API as deployed behind TLS (cookie names and attributes depend on the public URL).
  https = await startTestApp({ listen: false, overrides: { config: { ...ctx.deps.config, apiBaseUrl: 'https://api.uk.thapsus-hr.test', appBaseUrl: 'https://app.uk.thapsus-hr.test' } } });
});
afterAll(async () => {
  await ctx.close();
  await https.close();
  await closeDb();
});

const inject = (c: TestContext, opts: InjectOptions) => c.app.inject(opts);
const ip = () => `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

/** A signed-in person with one built-in role and a password (fictional). */
async function person(c: TestContext, owner: { tenantId: string; slug: string }, role = 'employee') {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  const userId = await withTenant(c.deps.router, owner.tenantId, async (t) => {
    const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, 'Fictional Person') RETURNING id`, [email]);
    await t.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
    await assignRole(t, u.id, role, { type: role === 'employee' ? 'self' : 'all' });
    return u.id;
  });
  const login = () => inject(c, { method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: ip() });
  const res = await login();
  expect(res.statusCode, res.body).toBe(200);
  return { userId, email, cookie: cookieFrom(res), login };
}

const auditRows = (c: TestContext, tenantId: string, action: string, targetId?: string) =>
  withTenant(c.deps.router, tenantId, (t) => t.query<{ actor_id: string; diff: Record<string, unknown> }>('SELECT actor_id, diff FROM audit.events WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY id', [action, targetId ?? null]));

describe('V3.3 session cookie', () => {
  it('over HTTPS the session cookie is __Host-thr_sid: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain', async () => {
    const s = await signup(https);
    expect(s.cookie.startsWith('__Host-thr_sid=')).toBe(true);
    const res = await inject(https, { method: 'POST', url: '/v1/auth/login', payload: { tenant: s.slug, email: s.email, password: PASSWORD }, remoteAddress: ip() });
    const set = ([] as string[]).concat(res.headers['set-cookie'] as string[]).find((c) => c.startsWith('__Host-thr_sid='))!;
    expect(set).toMatch(/; HttpOnly/i);
    expect(set).toMatch(/; Secure/i);
    expect(set).toMatch(/; SameSite=Lax/i);
    expect(set).toMatch(/; Path=\//i);
    expect(set).not.toMatch(/Domain=/i);
    // the session works under its prefixed name only
    expect((await inject(https, { method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } })).statusCode).toBe(200);
    const plain = s.cookie.replace('__Host-thr_sid=', 'thr_sid=');
    expect((await inject(https, { method: 'GET', url: '/v1/auth/session', headers: { cookie: plain } })).statusCode).toBe(401);
  });

  it('plain-HTTP development keeps the unprefixed name (a __Host- cookie needs Secure)', async () => {
    const s = await signup(ctx);
    expect(s.cookie.startsWith('thr_sid=')).toBe(true);
  });

  it('logout clears the cookie with the same attributes and sends Clear-Site-Data', async () => {
    const s = await signup(https);
    const res = await inject(https, { method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['clear-site-data']).toBe('"cache"');
    const cleared = ([] as string[]).concat(res.headers['set-cookie'] as string[]).find((c) => c.startsWith('__Host-thr_sid='))!;
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/; Secure/i);
    expect(cleared).toMatch(/; Path=\//i);
    expect((await inject(https, { method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } })).statusCode).toBe(401);
  });

  it('the back-office staff cookie is __Host-thr_staff over HTTPS', async () => {
    const res = await inject(https, { method: 'POST', url: '/v1/backoffice/auth/login', payload: { email: 'nobody@thapsus.example.test', password: 'not-a-real-password' }, remoteAddress: ip() });
    expect(res.statusCode).toBe(401);
    const { staffCookie } = await import('../src/http/security');
    expect(staffCookie(https.deps.config)).toEqual({ name: '__Host-thr_staff', secure: true, path: '/' });
    expect(staffCookie(ctx.deps.config)).toEqual({ name: 'thr_staff', secure: false, path: '/v1/backoffice' });
  });
});

describe('V3.5 browser request forgery', () => {
  it('refuses state-changing requests from another origin, with or without the session cookie', async () => {
    const s = await ownerSession(ctx);
    const cross = await inject(ctx, { method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie, origin: 'https://attacker.example.test' } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toMatchObject({ code: 'forbidden', detail: 'untrustedOrigin' });
    const noOrigin = await inject(ctx, { method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie, 'sec-fetch-site': 'cross-site' } });
    expect(noOrigin.json()).toMatchObject({ code: 'forbidden', detail: 'crossSite' });
    const login = await inject(ctx, { method: 'POST', url: '/v1/auth/login', headers: { origin: 'null' }, payload: { tenant: s.slug, email: s.email, password: PASSWORD } });
    expect(login.statusCode).toBe(403);
    // the session is still alive: none of the forged requests reached a handler
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } })).statusCode).toBe(200);
  });

  it('accepts the app’s own origin, same-origin fetches and non-browser clients', async () => {
    const s = await ownerSession(ctx);
    const own = await inject(ctx, { method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie, origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' } });
    expect(own.statusCode).toBe(204);
    const t = await ownerSession(ctx);
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/logout', headers: { cookie: t.cookie } })).statusCode).toBe(204);
    // GET is never refused (the origin check covers unsafe methods only)
    expect((await inject(ctx, { method: 'GET', url: '/v1/status', headers: { origin: 'https://attacker.example.test' } })).statusCode).toBe(200);
  });

  it('only JSON (or multipart on upload routes) is parsed: CORS-safelisted text and form bodies are refused', async () => {
    const s = await signup(ctx);
    const form = await inject(ctx, { method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `tenant=${s.slug}&email=${encodeURIComponent(s.email)}&password=${PASSWORD}` });
    expect(form.statusCode).toBe(400);
    const text = await inject(ctx, { method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify({ tenant: s.slug, email: s.email, password: PASSWORD }) });
    expect(text.statusCode).toBe(400);
    expect(form.headers['set-cookie']).toBeUndefined();
    expect(text.headers['set-cookie']).toBeUndefined();
  });

  it('the SAML ACS is the one route that accepts a cross-site form post (by design; the assertion protects it)', async () => {
    const s = await signup(ctx);
    const res = await inject(ctx, {
      method: 'POST',
      url: '/v1/auth/sso/saml/acs',
      headers: { origin: 'https://idp.example.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      payload: `SAMLResponse=bm90LWEtc2FtbC1yZXNwb25zZQ&RelayState=${s.tenantId}.00000000-0000-4000-8000-000000000000`,
    });
    // past the origin check, refused by the one-time RelayState
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalidCredentials');
  });
});

describe('V4.1 and V13.4 HTTP responses', () => {
  it('text and XML responses declare a charset; JSON keeps application/json', async () => {
    const html = await inject(ctx, { method: 'GET', url: '/v1/test-only/html' });
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    const json = await inject(ctx, { method: 'GET', url: '/v1/status' });
    expect(json.headers['content-type']).toMatch(/^application\/json/);
  });

  it('TRACE (and other unrouted methods) are not supported', async () => {
    for (const method of ['TRACE', 'CONNECT'] as const) {
      const res = await inject(ctx, { method: method as 'GET', url: '/v1/status', headers: { 'x-fictional-probe': 'echo-me' } });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('echo-me');
    }
  });
});

describe('V6.2 passwords', () => {
  it('allows long passphrases of any characters and refuses common and context-specific passwords at sign-up', async () => {
    const body = (slug: string, password: string) => ({ companyName: 'Fictional Marigold Ltd', slug, region: 'uk', ownerName: 'Olive Owner', ownerEmail: `olive@${slug}.example.test`, password, acceptDpa: true });
    const slug = () => `pw-${Math.random().toString(36).slice(2, 8)}`;
    const long = 'é'.repeat(20) + ' correct horse battery staple '.repeat(3);
    expect(long.length).toBeGreaterThan(64);
    expect((await inject(ctx, { method: 'POST', url: '/v1/signup', payload: body(slug(), long), remoteAddress: ip() })).statusCode).toBe(201);
    const common = await inject(ctx, { method: 'POST', url: '/v1/signup', payload: body(slug(), '1qaz2wsx3edc'), remoteAddress: ip() });
    expect(common.statusCode).toBe(400);
    expect(common.json().errors).toEqual([{ path: '/password', message: 'tooCommon' }]);
    const context = await inject(ctx, { method: 'POST', url: '/v1/signup', payload: body(slug(), 'Marigold-Payroll-2026'), remoteAddress: ip() });
    expect(context.json().errors).toEqual([{ path: '/password', message: 'contextSpecific' }]);
  });

  it('password change needs the current password, applies the policy, keeps this session and ends the others', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    const other = cookieFrom(await p.login());
    const change = (payload: object) => inject(ctx, { method: 'POST', url: '/v1/auth/password', headers: { cookie: p.cookie }, payload });
    expect((await change({ currentPassword: 'wrong-but-fictional', newPassword: 'Sunlit-meadow-passphrase-7' })).statusCode).toBe(401);
    expect((await change({ newPassword: 'Sunlit-meadow-passphrase-7' })).statusCode).toBe(401);
    expect((await change({ currentPassword: PASSWORD, newPassword: 'qwertyuiopasdfgh' })).json().errors[0].message).toBe('tooCommon');
    expect((await change({ currentPassword: PASSWORD, newPassword: 'Sunlit-meadow-passphrase-7' })).statusCode).toBe(204);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: p.cookie } })).statusCode).toBe(200);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: other } })).statusCode).toBe(401);
    const [audit] = await auditRows(ctx, owner.tenantId, 'auth.password_changed', p.userId);
    expect(audit!.diff).toMatchObject({ otherSessionsEnded: 1 });
  });
});

describe('V6.3 and V6.4 no sign-in path skips an enabled second factor', () => {
  it('a non-admin with an authenticator must use it after a password sign-in', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    const secret = await enrolTotp(ctx, p.cookie);
    const res = await p.login();
    expect(res.json()).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: false });
    const cookie = cookieFrom(res);
    const blocked = await inject(ctx, { method: 'GET', url: '/v1/me/notifications', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfaRequired');
    ctx.clock.advanceMinutes(1);
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: totpCode(secret, ctx.clock.now) } })).statusCode).toBe(204);
    expect((await inject(ctx, { method: 'GET', url: '/v1/me/notifications', headers: { cookie } })).statusCode).toBe(200);
  });

  it('an emailed sign-in link (the forgotten-password route) still requires the second factor', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    await enrolTotp(ctx, p.cookie);
    await inject(ctx, { method: 'POST', url: '/v1/auth/magic-link', payload: { tenant: owner.slug, email: p.email }, remoteAddress: ip() });
    const link = ctx.mailer.sent.filter((m) => m.to === p.email).at(-1)!.text.match(/token=([^\s]+)/)![1]!;
    const res = await inject(ctx, { method: 'POST', url: '/v1/auth/magic-link/consume', payload: { token: decodeURIComponent(link) }, remoteAddress: ip() });
    expect(res.json()).toMatchObject({ mfaRequired: true });
    expect((await inject(ctx, { method: 'GET', url: '/v1/me/notifications', headers: { cookie: cookieFrom(res) } })).json().code).toBe('mfaRequired');
  });
});

describe('V7.4 and V7.5 sessions', () => {
  it('people list their sessions and, after re-authenticating, end one or all of the others', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    const second = cookieFrom(await p.login());
    const third = cookieFrom(await p.login());
    const list = await inject(ctx, { method: 'GET', url: '/v1/auth/sessions', headers: { cookie: p.cookie } });
    expect(list.statusCode).toBe(200);
    const sessions = list.json().data as Array<{ id: string; current: boolean; method: string }>;
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((x) => x.current)).toHaveLength(1);
    const other = sessions.find((x) => !x.current)!;
    // the sign-in is older than the re-authentication window: ending sessions needs a fresh proof
    ctx.clock.advanceMinutes(11);
    const stale = await inject(ctx, { method: 'DELETE', url: `/v1/auth/sessions/${other.id}`, headers: { cookie: p.cookie } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('reauthenticationRequired');
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/reauth', headers: { cookie: p.cookie }, payload: { password: 'not-the-fictional-password' } })).statusCode).toBe(401);
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/reauth', headers: { cookie: p.cookie }, payload: { password: PASSWORD } })).statusCode).toBe(204);
    expect((await inject(ctx, { method: 'DELETE', url: `/v1/auth/sessions/${other.id}`, headers: { cookie: p.cookie } })).statusCode).toBe(204);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/sessions', headers: { cookie: p.cookie } })).json().data).toHaveLength(2);
    const ended = await inject(ctx, { method: 'POST', url: '/v1/auth/sessions/end-others', headers: { cookie: p.cookie } });
    expect(ended.json()).toEqual({ ended: 1 });
    for (const c of [second, third]) expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: c } })).statusCode).toBe(401);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: p.cookie } })).statusCode).toBe(200);
    expect(await auditRows(ctx, owner.tenantId, 'auth.reauth_failed', p.userId)).toHaveLength(1);
    expect(await auditRows(ctx, owner.tenantId, 'auth.other_sessions_ended', p.userId)).toHaveLength(1);
    // nobody can end someone else's session through their own list
    const owners = (await inject(ctx, { method: 'GET', url: '/v1/auth/sessions', headers: { cookie: owner.cookie } })).json().data as Array<{ id: string }>;
    expect((await inject(ctx, { method: 'DELETE', url: `/v1/auth/sessions/${owners[0]!.id}`, headers: { cookie: p.cookie } })).statusCode).toBe(404);
  });

  it('adding an authenticator ends the other sessions; changing it needs a recent re-authentication', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    const other = cookieFrom(await p.login());
    const secret = await enrolTotp(ctx, p.cookie);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: other } })).statusCode).toBe(401);
    ctx.clock.advanceMinutes(11);
    const again = await inject(ctx, { method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie: p.cookie } });
    expect(again.json().code).toBe('reauthenticationRequired');
    const passkey = await inject(ctx, { method: 'POST', url: '/v1/auth/passkeys/register/options', headers: { cookie: p.cookie } });
    expect(passkey.json().code).toBe('reauthenticationRequired');
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/reauth', headers: { cookie: p.cookie }, payload: { code: totpCode(secret, ctx.clock.now) } })).statusCode).toBe(204);
    expect((await inject(ctx, { method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie: p.cookie } })).statusCode).toBe(200);
  });

  it('company-wide admins sign one person out everywhere, or everyone', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    const q = await person(ctx, owner);
    const refused = await inject(ctx, { method: 'POST', url: `/v1/users/${q.userId}/sessions/end`, headers: { cookie: p.cookie } });
    expect(refused.statusCode).toBe(403);
    const one = await inject(ctx, { method: 'POST', url: `/v1/users/${p.userId}/sessions/end`, headers: { cookie: owner.cookie } });
    expect(one.json()).toEqual({ ended: 1 });
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: p.cookie } })).statusCode).toBe(401);
    const all = await inject(ctx, { method: 'POST', url: '/v1/settings/sessions/end-all', headers: { cookie: owner.cookie } });
    expect(all.statusCode).toBe(200);
    expect(all.json().ended).toBeGreaterThanOrEqual(1);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: q.cookie } })).statusCode).toBe(401);
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: owner.cookie } })).statusCode).toBe(200);
    expect(await auditRows(ctx, owner.tenantId, 'auth.user_sessions_ended', p.userId)).toHaveLength(1);
    expect(await auditRows(ctx, owner.tenantId, 'auth.all_sessions_ended')).toHaveLength(1);
  });
});

describe('V6.4.4 lost second factor', () => {
  it('an admin who holds everything the person holds resets their factors after confirming identity; the person is signed out and told', async () => {
    const owner = await ownerSession(ctx);
    const p = await person(ctx, owner);
    await enrolTotp(ctx, p.cookie);
    const hr = await person(ctx, owner, 'hr_admin');
    await enrolTotp(ctx, hr.cookie);
    // the HR admin role does not hold settings.manage company-wide
    expect((await inject(ctx, { method: 'POST', url: `/v1/users/${p.userId}/mfa/reset`, headers: { cookie: hr.cookie }, payload: { identityConfirmed: true } })).statusCode).toBe(403);
    // never your own factors
    expect((await inject(ctx, { method: 'POST', url: `/v1/users/${owner.userId}/mfa/reset`, headers: { cookie: owner.cookie }, payload: { identityConfirmed: true } })).statusCode).toBe(403);
    expect((await inject(ctx, { method: 'POST', url: `/v1/users/${p.userId}/mfa/reset`, headers: { cookie: owner.cookie }, payload: {} })).statusCode).toBe(400);
    const reset = await inject(ctx, { method: 'POST', url: `/v1/users/${p.userId}/mfa/reset`, headers: { cookie: owner.cookie }, payload: { identityConfirmed: true } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toEqual({ removedFactors: 1, endedSessions: 1 });
    expect((await inject(ctx, { method: 'GET', url: '/v1/auth/session', headers: { cookie: p.cookie } })).statusCode).toBe(401);
    // the next sign-in works with the password alone (a non-admin) and they can enrol again
    const fresh = await p.login();
    expect(fresh.json()).toMatchObject({ mfaRequired: false });
    expect(ctx.mailer.sent.filter((m) => m.to === p.email).at(-1)!.subject).toMatch(/two-step verification/i);
    const [audit] = await auditRows(ctx, owner.tenantId, 'auth.mfa_reset', p.userId);
    expect(audit).toMatchObject({ actor_id: owner.userId, diff: { removedFactors: 1, endedSessions: 1, identityConfirmedBy: owner.userId } });
  });
});
