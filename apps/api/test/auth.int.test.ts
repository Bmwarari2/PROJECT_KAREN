import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  PASSWORD,
  signup,
  startTestApp,
  totpCode,
  uniq,
  type TestContext,
} from './helpers';
import { DIRECTORY_FIELDS } from '../src/lib/directory';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const login = (tenant: string, email: string, password = PASSWORD, ip = '10.0.0.1') =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant, email, password },
    remoteAddress: ip,
  });

describe('sign-up and home region', () => {
  it('creates the tenant in this cell and registers only routing data globally', async () => {
    const s = await signup(ctx);
    const entry = await ctx.directory.byId(s.tenantId);
    expect(entry).toMatchObject({ slug: s.slug, homeRegion: 'uk', status: 'active' });
    expect(Object.keys(entry!).sort()).toEqual(
      DIRECTORY_FIELDS.filter((f) => !['createdAt', 'updatedAt'].includes(f)).sort(),
    );
    expect(JSON.stringify(entry)).not.toContain(s.email);
  });

  it('refuses to create a tenant for another region in this cell and points to the right one', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {
        companyName: 'Fictional EU GmbH',
        slug: uniq('eu'),
        region: 'eu',
        ownerName: 'E',
        ownerEmail: 'e@eu.example.test',
        password: PASSWORD,
        acceptDpa: true,
      },
    });
    expect(res.statusCode).toBe(421);
    expect(res.json()).toMatchObject({
      code: 'wrongRegion',
      region: 'eu',
      appUrl: 'https://app.eu.thapsus-hr.test',
    });
  });

  it('rejects duplicate slugs and weak passwords', async () => {
    const s = await signup(ctx);
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {
        companyName: 'Dup',
        slug: s.slug,
        region: 'uk',
        ownerName: 'D',
        ownerEmail: 'd@d.example.test',
        password: PASSWORD,
        acceptDpa: true,
      },
    });
    expect(dup.statusCode).toBe(409);
    const weak = await ctx.app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {
        companyName: 'Weak',
        slug: uniq('weak'),
        region: 'uk',
        ownerName: 'W',
        ownerEmail: 'w@w.example.test',
        password: 'short',
        acceptDpa: true,
      },
    });
    expect(weak.statusCode).toBe(400);
  });
});

describe('MFA is mandatory for admins', () => {
  it('admin routes are refused until a second factor is enrolled and verified', async () => {
    const s = await signup(ctx);
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/v1/settings/domains',
      headers: { cookie: s.cookie },
    });
    expect(before.statusCode).toBe(403);
    expect(before.json().code).toBe('mfaEnrollmentRequired');
    const secret = await enrolTotp(ctx, s.cookie);
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/settings/domains',
      headers: { cookie: s.cookie },
    });
    expect(after.statusCode).toBe(200);

    // A new password session is gated until the TOTP is verified.
    const res = await login(s.slug, s.email);
    expect(res.json()).toMatchObject({ mfaRequired: true });
    const cookie = cookieFrom(res);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains', headers: { cookie } })).json().code,
    ).toBe('mfaRequired');
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/verify',
      headers: { cookie },
      payload: { code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    ctx.clock.advanceMinutes(1); // a new time step (codes cannot be replayed)
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/verify',
      headers: { cookie },
      payload: { code: totpCode(secret, ctx.clock.now) },
    });
    expect(ok.statusCode).toBe(204);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains', headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('a TOTP code cannot be replayed', async () => {
    const s = await ownerSession(ctx);
    ctx.clock.advanceMinutes(1);
    const code = totpCode(s.totpSecret, ctx.clock.now);
    const a = cookieFrom(await login(s.slug, s.email));
    const b = cookieFrom(await login(s.slug, s.email, PASSWORD, '10.0.0.2'));
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/mfa/totp/verify',
          headers: { cookie: a },
          payload: { code },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/mfa/totp/verify',
          headers: { cookie: b },
          payload: { code },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('sign-in protection', () => {
  it('locks the account after repeated failures', async () => {
    const s = await signup(ctx);
    for (let i = 0; i < 5; i++)
      expect((await login(s.slug, s.email, 'Wrong-password-123', `10.1.0.${i}`)).statusCode).toBe(401);
    const locked = await login(s.slug, s.email, PASSWORD, '10.1.0.9');
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('lockedOut');
    ctx.clock.advanceMinutes(16);
    expect((await login(s.slug, s.email, PASSWORD, '10.1.0.10')).statusCode).toBe(200);
  });

  it('rate-limits sign-in attempts per account and per IP', async () => {
    const s = await signup(ctx);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await login(s.slug, `nobody${i % 1}@x.example.test`, 'x', '10.2.0.1')).statusCode);
    expect(statuses.slice(0, 10).every((c) => c === 401)).toBe(true);
    const limited = await login(s.slug, 'nobody0@x.example.test', 'x', '10.2.0.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('does not reveal whether an account exists', async () => {
    const s = await signup(ctx);
    const a = await login(s.slug, 'ghost@x.example.test', 'Wrong-password-123', '10.3.0.1');
    const b = await login(s.slug, s.email, 'Wrong-password-123', '10.3.0.2');
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json().code).toBe(b.json().code);
  });
});

describe('session lifetime', () => {
  it('expires after the idle timeout', async () => {
    const s = await ownerSession(ctx);
    ctx.clock.advanceMinutes(29);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(200);
    ctx.clock.advanceMinutes(31);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('expires at the absolute timeout even when active, and both are configurable per tenant', async () => {
    const s = await ownerSession(ctx);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: s.cookie },
      payload: { sessionIdleMinutes: 60, sessionAbsoluteHours: 2 },
    });
    expect(patch.statusCode).toBe(200);
    ctx.clock.advanceMinutes(1);
    const res = await login(s.slug, s.email, PASSWORD, '10.4.0.1');
    const cookie = cookieFrom(res);
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/totp/verify',
      headers: { cookie },
      payload: { code: totpCode(s.totpSecret, ctx.clock.now) },
    });
    for (let i = 0; i < 2; i++) {
      ctx.clock.advanceMinutes(50);
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode,
      ).toBe(200);
    }
    ctx.clock.advanceMinutes(25);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('logout revokes the session', async () => {
    const s = await ownerSession(ctx);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(204);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('magic links', () => {
  it('emails a single-use link that signs the user in', async () => {
    const s = await signup(ctx);
    const req = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { tenant: s.slug, email: s.email },
    });
    expect(req.statusCode).toBe(202);
    const mail = ctx.mailer.sent.findLast((m) => m.to === s.email)!;
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ tenantId: s.tenantId, mfaEnrollmentRequired: true });
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/auth/magic-link/consume', payload: { token } }))
        .statusCode,
    ).toBe(401);
  });

  it('expires after 10 minutes (ASVS V6.5.5)', async () => {
    const s = await signup(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { tenant: s.slug, email: s.email },
    });
    const token = decodeURIComponent(
      /token=([^\s]+)/.exec(ctx.mailer.sent.findLast((m) => m.to === s.email)!.text)![1]!,
    );
    ctx.clock.advanceMinutes(11);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/auth/magic-link/consume', payload: { token } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('responses are never cacheable', () => {
  it('sets Cache-Control: private, no-store on public and authenticated responses', async () => {
    const s = await ownerSession(ctx);
    const authed = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie: s.cookie },
    });
    const pub = await ctx.app.inject({ method: 'GET', url: '/health' });
    const err = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session' });
    for (const r of [authed, pub, err]) expect(r.headers['cache-control']).toBe('private, no-store');
  });
});
