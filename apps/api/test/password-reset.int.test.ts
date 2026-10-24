import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { withTenant } from '@thapsus/db';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  PASSWORD,
  randomIp,
  startTestApp,
  totpCode,
  type TestContext,
} from './helpers';
import { hashPassword } from '../src/modules/auth/tokens';
import { assignRole } from '../src/modules/authz/principal';
import { UNIFORM_RESPONSE_MS } from '../src/modules/auth/common';
import { ADMIN_RESET_LINK_HOURS, RESET_LINK_MINUTES } from '../src/modules/auth/password-reset';
import { onSecurityEvent, type SecurityEvent } from '../src/lib/security-events';

/**
 * Forgotten passwords and admin-sent reset links (PROGRESS 15.1, 15.2; ADR-0171). Fictional people only.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const events: SecurityEvent[] = [];
let stop: () => void;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx, undefined, { mfaForEveryone: false });
  stop = onSecurityEvent((e) => void events.push(e));
});
afterAll(async () => {
  stop();
  await ctx.close();
  await closeDb();
});

const NEW_PASSWORD = 'Lantern-meadow-quietly-77';

async function person(role = 'employee', name = 'Fictional Person') {
  const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
  const userId = await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
      [email, name],
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

const login = (email: string, password = PASSWORD) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: owner.slug, email, password },
    remoteAddress: randomIp(),
  });
const askReset = (email: string, ip = randomIp(), tenant = owner.slug) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/password-reset',
    payload: { tenant, email },
    remoteAddress: ip,
  });
const complete = (token: string, newPassword = NEW_PASSWORD) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/password-reset/complete',
    payload: { token, newPassword },
    remoteAddress: randomIp(),
  });
const mailsTo = (to: string) => ctx.mailer.sent.filter((m) => m.to === to);
const resetToken = (text: string) => decodeURIComponent(/\/auth\/reset\?token=(\S+)/.exec(text)![1]!);
const audit = (action: string) =>
  withTenant(ctx.deps.router, owner.tenantId, (tx) =>
    tx.query<{ actor_id: string | null; target_id: string; diff: Record<string, unknown> }>(
      'SELECT actor_id, target_id, diff FROM audit.events WHERE action = $1 ORDER BY id',
      [action],
    ),
  );
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('forgotten password: asking for a link', () => {
  it('answers the same, after the same time, whether or not the account exists', async () => {
    const known = await person();
    const unknown = `nobody.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
    const timed = async (email: string) => {
      const t0 = performance.now();
      const res = await askReset(email);
      return { res, ms: performance.now() - t0 };
    };
    const a: number[] = [];
    const b: number[] = [];
    let first: Awaited<ReturnType<typeof timed>> | undefined;
    let other: Awaited<ReturnType<typeof timed>> | undefined;
    for (let i = 0; i < 3; i++) {
      const x = await timed(known.email);
      const y = await timed(unknown);
      a.push(x.ms);
      b.push(y.ms);
      first ??= x;
      other ??= y;
    }
    expect(first!.res.statusCode).toBe(202);
    expect(other!.res.statusCode).toBe(202);
    expect(first!.res.body).toBe(other!.res.body);
    const names = (h: Record<string, unknown>) =>
      Object.keys(h)
        .filter((k) => !['date', 'x-request-id', 'request-id'].includes(k))
        .sort();
    expect(names(first!.res.headers)).toEqual(names(other!.res.headers));
    for (const ms of [...a, ...b]) expect(ms).toBeGreaterThanOrEqual(UNIFORM_RESPONSE_MS - 5);
    expect(Math.abs(median(a) - median(b))).toBeLessThan(60);
    // only the real account gets an email (the newest link is the one that works)
    expect(mailsTo(known.email)).toHaveLength(3);
    expect(mailsTo(unknown)).toHaveLength(0);
    expect(mailsTo(known.email)[0]!.text).toContain(`${RESET_LINK_MINUTES} minutes`);
  });

  it('throttles requests per account, per workspace and per IP, and emits auth.throttled', async () => {
    const p = await person();
    for (let i = 0; i < 3; i++) expect((await askReset(p.email)).statusCode).toBe(202);
    const perAccount = await askReset(p.email);
    expect(perAccount.statusCode).toBe(429);
    expect(Number(perAccount.headers['retry-after'])).toBeGreaterThan(0);
    // per IP: 20 requests in 15 minutes, whatever the address asked for
    const ip = randomIp();
    for (let i = 0; i < 20; i++)
      expect(
        (await askReset(`ip.${i}.${Math.random().toString(36).slice(2, 6)}@example.test`, ip)).statusCode,
      ).toBe(202);
    expect((await askReset('one.more@example.test', ip)).statusCode).toBe(429);
    // per workspace: a budget shared by sign-in links and reset links (lowered here; production in throttles.ts)
    const small = await ownerSession(ctx, undefined, { mfaForEveryone: false });
    const fresh = await ownerSession(ctx, undefined, { mfaForEveryone: false });
    ctx.deps.authBudgets = { emailLinks: { floor: 4, perUser: 0 } };
    try {
      for (let i = 0; i < 4; i++)
        expect((await askReset(`spread.${i}@example.test`, randomIp(), small.slug)).statusCode).toBe(202);
      expect((await askReset('spread.5@example.test', randomIp(), small.slug)).statusCode).toBe(429);
      // another workspace is not affected
      expect((await askReset('someone@example.test', randomIp(), fresh.slug)).statusCode).toBe(202);
    } finally {
      ctx.deps.authBudgets = undefined;
    }
    const throttled = events.filter((e) => e.type === 'auth.throttled').map((e) => e.detail?.scope);
    expect(throttled).toEqual(expect.arrayContaining(['account', 'ip', 'tenant']));
  });
});

describe('forgotten password: using the link', () => {
  it('a single-use, 30-minute, hashed token that only resets: it never signs in, and a sign-in link never resets', async () => {
    const p = await person();
    await askReset(p.email);
    const token = resetToken(mailsTo(p.email).at(-1)!.text);
    expect(token).toMatch(/^r_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
    const secret = token.split('.')[1]!;
    // stored only as its SHA-256 hash, scoped to resets
    const rows = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ token_hash: Buffer; purpose: string; expires_at: string }>(
        `SELECT token_hash, purpose, expires_at FROM app.magic_links WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
        [p.userId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.equals(createHash('sha256').update(secret).digest())).toBe(true);
    expect(new Date(rows[0]!.expires_at).getTime() - ctx.clock.now.getTime()).toBe(
      RESET_LINK_MINUTES * 60_000,
    );
    // the same secret presented as a sign-in link does not sign anyone in
    const asSignIn = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token: `m_${owner.tenantId}.${secret}` },
    });
    expect(asSignIn.statusCode).toBe(401);
    // a sign-in link cannot reset a password
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { tenant: owner.slug, email: p.email },
      remoteAddress: randomIp(),
    });
    const magic = /token=([^\s]+)/.exec(mailsTo(p.email).at(-1)!.text)![1]!;
    const magicSecret = decodeURIComponent(magic).split('.')[1]!;
    expect((await complete(`r_${owner.tenantId}.${magicSecret}`)).statusCode).toBe(401);
    // expired after 30 minutes
    ctx.clock.advanceMinutes(RESET_LINK_MINUTES + 1);
    try {
      expect((await complete(token)).statusCode).toBe(401);
    } finally {
      ctx.clock.advanceMinutes(-(RESET_LINK_MINUTES + 1));
    }
  });

  it('applies the password policy, ends every session, clears a lockout, is audited and told by email; the second factor stays', async () => {
    const p = await person('employee', 'Robin Fictional');
    const signedIn = await login(p.email);
    const cookie = cookieFrom(signedIn);
    const secret = await enrolTotp(ctx, cookie);
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.exec(
        `UPDATE app.users SET failed_attempts = 5, locked_until = now() + interval '1 hour' WHERE id = $1`,
        [p.userId],
      ),
    );
    await askReset(p.email);
    const token = resetToken(mailsTo(p.email).at(-1)!.text);
    // a refused password keeps the link usable
    const weak = await complete(token, 'robin-fictional-2026');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().errors[0].path).toBe('/newPassword');
    const ok = await complete(token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ workspace: owner.slug });
    expect((await complete(token)).statusCode).toBe(401); // single use
    // every session ended, including the one that was signed in
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode,
    ).toBe(401);
    // the old password no longer works; the new one does, and the authenticator is still required
    expect((await login(p.email)).statusCode).toBe(401);
    const fresh = await login(p.email, NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: false });
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { cookie: cookieFrom(fresh) },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfaRequired');
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/mfa/totp/verify',
          headers: { cookie: cookieFrom(fresh) },
          payload: { code: totpCode(secret, ctx.clock.now, 1) },
        })
      ).statusCode,
    ).toBe(204);
    // audited, and the person is told (no password or token in either)
    const done = (await audit('auth.password_reset_completed')).filter((r) => r.target_id === p.userId);
    expect(done).toEqual([
      expect.objectContaining({ actor_id: p.userId, diff: { endedSessions: 1, initiatedBy: 'self' } }),
    ]);
    const notice = mailsTo(p.email).at(-1)!;
    expect(notice.subject).toMatch(/password/i);
    expect(notice.text).not.toContain(NEW_PASSWORD);
    expect(notice.text).toContain(`/signin?workspace=${owner.slug}`);
    const mine = events.filter((e) => e.userId === p.userId).map((e) => e.type);
    expect(mine).toEqual(
      expect.arrayContaining(['auth.password_reset_requested', 'auth.password_reset_completed']),
    );
    expect(JSON.stringify(events)).not.toContain(p.email);
  });

  it('someone signed in with an emailed link sets a new password without the current one, within the re-authentication window', async () => {
    const p = await person();
    const linkIn = async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link',
        payload: { tenant: owner.slug, email: p.email },
        remoteAddress: randomIp(),
      });
      const t = decodeURIComponent(/token=([^\s]+)/.exec(mailsTo(p.email).at(-1)!.text)![1]!);
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link/consume',
        payload: { token: t },
      });
      expect(r.statusCode).toBe(200);
      return cookieFrom(r);
    };
    const cookie = await linkIn();
    const session = (
      await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })
    ).json();
    expect(session).toMatchObject({ method: 'magic_link', hasPassword: true, passwordWithoutCurrent: true });
    const set = (c: string, body: Record<string, string>) =>
      ctx.app.inject({ method: 'POST', url: '/v1/auth/password', headers: { cookie: c }, payload: body });
    expect((await set(cookie, { newPassword: 'qwertyuiopasdfgh' })).statusCode).toBe(400); // policy still applies
    expect((await set(cookie, { newPassword: NEW_PASSWORD })).statusCode).toBe(204);
    const changed = (await audit('auth.password_changed')).filter((r) => r.target_id === p.userId);
    expect(changed.at(-1)!.diff).toMatchObject({ via: 'email_link' });
    expect(mailsTo(p.email).at(-1)!.subject).toMatch(/password/i);
    expect(events.some((e) => e.type === 'auth.password_set_after_email_link' && e.userId === p.userId)).toBe(
      true,
    );
    // outside the window: re-authenticate first
    const later = await linkIn();
    ctx.clock.advanceMinutes(11);
    try {
      const old = await set(later, { newPassword: 'Another-lantern-meadow-88' });
      expect(old.statusCode).toBe(403);
      expect(old.json().code).toBe('reauthenticationRequired');
    } finally {
      ctx.clock.advanceMinutes(-11);
    }
    // a password sign-in still needs the current password
    const pw = cookieFrom(await login(p.email, NEW_PASSWORD));
    expect((await set(pw, { newPassword: 'Another-lantern-meadow-88' })).statusCode).toBe(401);
  });
});

describe('admin-sent reset links', () => {
  it('only company-wide settings managers who cover the person may send one, never for themselves, after re-authenticating', async () => {
    const employee = await person();
    const hr = await person('hr_admin', 'Harper Fictional');
    const hrCookie = cookieFrom(await login(hr.email));
    await enrolTotp(ctx, hrCookie);
    const send = (userId: string, cookie: string) =>
      ctx.app.inject({ method: 'POST', url: `/v1/users/${userId}/password-reset`, headers: { cookie } });
    // HR admins hold settings.read only
    expect((await send(employee.userId, hrCookie)).statusCode).toBe(403);
    // a settings manager who does not hold everything the person holds is refused
    const settings = await person('employee', 'Sasha Fictional');
    await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
      await tx.exec(
        `INSERT INTO app.roles (tenant_id, key, name, permissions, is_admin) VALUES (app.current_tenant(), 'fictional_settings', 'Fictional settings manager', ARRAY['settings.manage', 'settings.read'], true)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
      );
      await assignRole(tx, settings.userId, 'fictional_settings', { type: 'all' });
    });
    const sCookie = cookieFrom(await login(settings.email));
    await enrolTotp(ctx, sCookie);
    const exceeds = await send(hr.userId, sCookie);
    expect(exceeds.statusCode).toBe(403);
    expect(exceeds.json().reason).toBe('exceedsYourAccess');
    // never for yourself
    expect((await send(owner.userId, owner.cookie)).json().reason).toBe('ownAccount');
    // the owner's sign-in is older than the re-authentication window
    ctx.clock.advanceMinutes(11);
    try {
      expect((await send(employee.userId, owner.cookie)).json().code).toBe('reauthenticationRequired');
      const reauth = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/reauth',
        headers: { cookie: owner.cookie },
        payload: { password: PASSWORD },
      });
      expect(reauth.statusCode).toBe(204);
      owner.cookie = cookieFrom(reauth);
      const sent = await send(employee.userId, owner.cookie);
      expect(sent.statusCode, sent.body).toBe(202);
      // the admin never sees the password or the link
      expect(Object.keys(sent.json())).toEqual(['expiresAt']);
      expect(new Date(sent.json().expiresAt).getTime() - ctx.clock.now.getTime()).toBe(
        ADMIN_RESET_LINK_HOURS * 3_600_000,
      );
      const mail = mailsTo(employee.email).at(-1)!;
      expect(mail.text).toContain(`${ADMIN_RESET_LINK_HOURS} hours`);
      expect((await audit('auth.password_reset_sent')).at(-1)).toMatchObject({
        actor_id: owner.userId,
        target_id: employee.userId,
      });
      const done = await complete(resetToken(mail.text));
      expect(done.statusCode).toBe(200);
      expect((await audit('auth.password_reset_completed')).at(-1)!.diff).toMatchObject({
        initiatedBy: 'admin',
      });
      expect(
        events.some((e) => e.type === 'auth.password_reset_requested' && e.detail?.initiatedBy === 'admin'),
      ).toBe(true);
    } finally {
      ctx.clock.advanceMinutes(-11);
    }
  });

  it('the two-step verification reset follows the same rule', async () => {
    const hr = await person('hr_admin', 'Hollis Fictional');
    const hrCookie = cookieFrom(await login(hr.email));
    await enrolTotp(ctx, hrCookie);
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/v1/users/${owner.userId}/mfa/reset`,
      headers: { cookie: hrCookie },
      payload: { identityConfirmed: true },
    });
    expect(reset.statusCode).toBe(403);
    const own = await ctx.app.inject({
      method: 'POST',
      url: `/v1/users/${owner.userId}/mfa/reset`,
      headers: { cookie: owner.cookie },
      payload: { identityConfirmed: true },
    });
    expect(own.json().reason).toBe('ownAccount');
  });
});
