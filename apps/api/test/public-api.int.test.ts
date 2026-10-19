import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, ownerSession, PASSWORD, randomIp, startTestApp, totpCode, type TestContext } from './helpers';
import { deprecationHeaders, platformHttpPlugin } from '../src/modules/platform/http';
import { jobHandlers } from '../src/worker';

/**
 * Phase 9.1 — public REST API: scoped API keys, OAuth 2.0 client credentials, the api_client principal
 * (role ∩ scopes), per-tenant rate limits, idempotency keys, cursor pagination and deprecation headers.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const as = (cookie: string) => ({ cookie });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const inject = (o: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => ctx.app.inject({ ...o, method: o.method as 'GET', payload: o.payload as object, remoteAddress: randomIp() });
const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, tenantId, fn);

/** Signs the owner in again (the test clock moves past session lifetimes). */
async function relogin() {
  const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email: owner.email, password: PASSWORD }, remoteAddress: randomIp() });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = cookieFrom(login);
  const mfa = await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: totpCode(owner.totpSecret, ctx.clock.now) } });
  expect(mfa.statusCode, mfa.body).toBe(204);
  owner.cookie = cookie;
}

async function createKey(body: Record<string, unknown>, cookie = owner.cookie) {
  const res = await inject({ method: 'POST', url: '/v1/settings/api-keys', headers: as(cookie), payload: body });
  return res;
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  const entity = await inject({ method: 'POST', url: '/v1/org/legal-entities', headers: as(owner.cookie), payload: { name: 'Fictional Widgets Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' } });
  expect(entity.statusCode, entity.body).toBe(201);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('scoped API keys', () => {
  it('are shown once, prefix-identifiable, hashed at rest and resolve to an api_client principal', async () => {
    const res = await createKey({ name: 'Payroll sync', scopes: ['employees:read'], roleKey: 'hr_admin' });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created.key).toMatch(new RegExp(`^thr_sk_${owner.tenantId}\\.[A-Za-z0-9_-]{43}$`));
    expect(created.key.split('.')[1].slice(0, 8)).toBe(created.prefix);
    // never shown again, never stored in plaintext
    const list = (await inject({ method: 'GET', url: '/v1/settings/api-keys', headers: as(owner.cookie) })).json();
    expect(JSON.stringify(list)).not.toContain(created.key.split('.')[1]);
    const stored = await tx(owner.tenantId, (t) => t.one<{ key_hash: Buffer }>('SELECT key_hash FROM app.api_keys WHERE id = $1', [created.id]));
    expect(stored.key_hash.length).toBe(32);
    expect(stored.key_hash.toString('latin1')).not.toContain(created.key.split('.')[1]);

    const people = await inject({ method: 'GET', url: '/v1/employees', headers: bearer(created.key) });
    expect(people.statusCode, people.body).toBe(200);
    expect(people.headers['cache-control']).toBe('private, no-store');
    expect(people.headers['ratelimit-limit']).toBeDefined();
    // read scope: writes are refused even though the role could write
    const hire = await inject({ method: 'POST', url: '/v1/employees', headers: bearer(created.key), payload: { startDate: '2026-01-05', legalFirstName: 'Fictional', legalLastName: 'Hire' } });
    expect(hire.statusCode).toBe(403);
    // identity, settings and the caller's own profile are for people only
    for (const url of ['/v1/auth/session', '/v1/settings/domains', '/v1/settings/api-keys', '/v1/tenant/experience']) {
      const r = await inject({ method: 'GET', url, headers: bearer(created.key) });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().detail).toBe('apiClientNotAllowed');
    }
    const lastUsed = await tx(owner.tenantId, (t) => t.one<{ last_used_at: string | null }>('SELECT last_used_at FROM app.api_keys WHERE id = $1', [created.id]));
    expect(lastUsed.last_used_at).not.toBeNull();

    const revoked = await inject({ method: 'POST', url: `/v1/settings/api-keys/${created.id}/revoke`, headers: as(owner.cookie) });
    expect(revoked.json().revokedAt).not.toBeNull();
    expect((await inject({ method: 'GET', url: '/v1/employees', headers: bearer(created.key) })).statusCode).toBe(401);
  });

  it('get the intersection of the role and the scopes', async () => {
    const managerKey = (await createKey({ name: 'Team tool', scopes: ['employees:write'], roleKey: 'manager' })).json();
    expect(managerKey.key).toBeDefined();
    // employees:write would allow employees.create, but the manager role does not
    const hire = await inject({ method: 'POST', url: '/v1/employees', headers: bearer(managerKey.key), payload: { startDate: '2026-01-05', legalFirstName: 'Fictional', legalLastName: 'Hire' } });
    expect(hire.statusCode).toBe(403);
    const writer = (await createKey({ name: 'HRIS sync', scopes: ['employees:write', 'org:read'], roleKey: 'hr_admin' })).json();
    const entities = (await inject({ method: 'GET', url: '/v1/org/legal-entities', headers: bearer(writer.key) })).json();
    const ok = await inject({ method: 'POST', url: '/v1/employees', headers: bearer(writer.key), payload: { startDate: '2026-01-05', legalFirstName: 'Fictional', legalLastName: 'Synced', entityId: entities[0].id, jobTitle: 'Analyst', payAmountMinor: 3_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent' } });
    expect(ok.statusCode, ok.body).toBe(201);
    // the change is audited with the API client as the actor
    const audit = await tx(owner.tenantId, (t) => t.maybe<{ actor_type: string; actor_id: string }>(`SELECT actor_type, actor_id FROM audit.events WHERE action = 'employee.created' AND target_id = $1`, [ok.json().id]));
    expect(audit).toEqual({ actor_type: 'api_client', actor_id: writer.id });
    const none = await createKey({ name: 'Nothing', scopes: ['webhooks:manage'], roleKey: 'employee' });
    expect(none.statusCode).toBe(422);
    expect(none.json().detail).toBe('noEffectivePermissions');
  });

  it('can never carry permissions the creator does not hold', async () => {
    // a non-admin custom role that may manage settings but not hire
    const userId = await tx(owner.tenantId, async (t) => {
      const role = await t.one<{ id: string }>(`INSERT INTO app.roles (tenant_id, key, name, is_admin, permissions, field_access) VALUES (app.current_tenant(), 'integrations', 'Integrations', false, '{settings.manage,employees.read}', '{}') RETURNING id`);
      const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, 'Fictional Integrator') RETURNING id`, [`integrator@${owner.slug}.example.test`]);
      await t.exec(`INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type) VALUES (app.current_tenant(), $1, $2, 'all')`, [u.id, role.id]);
      return u.id;
    });
    const { createSession } = await import('../src/modules/auth/sessions');
    const token = await tx(owner.tenantId, (t) => createSession(t, { userId, tenantId: owner.tenantId, method: 'password', mfaVerified: false, now: ctx.clock.now }));
    const res = await createKey({ name: 'Escalation', scopes: ['employees:write'], roleKey: 'owner' }, `thr_sid=${token}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe('exceedsYourPermissions');
    expect(res.json().permissions).toEqual(expect.arrayContaining(['employees.create']));
    expect((await createKey({ name: 'Fine', scopes: ['employees:read'], roleKey: 'hr_admin' }, `thr_sid=${token}`)).statusCode).toBe(403); // employees.history
    expect((await createKey({ name: 'Fine', scopes: ['org:read'], roleKey: 'integrations' }, `thr_sid=${token}`)).statusCode).toBe(201);
  });

  it('list endpoints use cursor pagination (?cursor&limit → nextCursor)', async () => {
    for (let i = 0; i < 3; i++) await createKey({ name: `Paged ${i}`, scopes: ['org:read'], roleKey: 'hr_admin' });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { data: Array<{ id: string }>; nextCursor: string | null } = (await inject({ method: 'GET', url: `/v1/settings/api-keys?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers: as(owner.cookie) })).json();
      expect(page.data.length).toBeLessThanOrEqual(2);
      for (const k of page.data) {
        expect(seen.has(k.id)).toBe(false);
        seen.add(k.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const total = await tx(owner.tenantId, (t) => t.one<{ n: number }>('SELECT count(*)::int AS n FROM app.api_keys'));
    expect(seen.size).toBe(total.n);
    expect(pages).toBeGreaterThan(1);
  });
});

describe('OAuth 2.0 client credentials (RFC 6749 §4.4)', () => {
  const token = (headers: Record<string, string>, payload: string) => inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload });
  const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });

  it('issues short-lived bearer tokens limited to the requested scopes; rotation keeps the old secret for the grace period', async () => {
    const c = (await inject({ method: 'POST', url: '/v1/settings/oauth-clients', headers: as(owner.cookie), payload: { name: 'Data warehouse', scopes: ['employees:read', 'org:read'], roleKey: 'hr_admin' } })).json();
    expect(c.clientId).toMatch(/^thr_ci_/);
    expect(c.clientSecret).toMatch(/^thr_cs_/);

    const ok = await token(basic(c.clientId, c.clientSecret), 'grant_type=client_credentials&scope=org%3Aread');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
    const t = ok.json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'org:read' });
    expect(t.access_token).toMatch(/^thr_at_/);
    // only the requested scope: org:read lets it read reference data, not people
    expect((await inject({ method: 'GET', url: '/v1/org/departments', headers: bearer(t.access_token) })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/v1/employees', headers: bearer(t.access_token) })).statusCode).toBe(200); // org:read includes employees.read
    const audit = await tx(owner.tenantId, (x) => x.maybe(`SELECT 1 FROM audit.events WHERE action = 'oauth.token_issued' AND actor_id = $1`, [c.id]));
    expect(audit).toBeDefined();

    // client_secret_post works too
    const post = await token({}, `grant_type=client_credentials&client_id=${encodeURIComponent(c.clientId)}&client_secret=${encodeURIComponent(c.clientSecret)}`);
    expect(post.statusCode).toBe(200);
    expect(post.json().scope).toBe('employees:read org:read');

    // RFC 6749 §5.2 errors
    const bad = await token(basic(c.clientId, 'thr_cs_wrong'), 'grant_type=client_credentials');
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'invalid_client' });
    expect(bad.headers['www-authenticate']).toContain('Basic');
    expect((await token(basic(c.clientId, c.clientSecret), 'grant_type=password')).json()).toEqual({ error: 'unsupported_grant_type' });
    expect((await token(basic(c.clientId, c.clientSecret), 'grant_type=client_credentials&scope=audit%3Aread')).json()).toEqual({ error: 'invalid_scope' });
    expect((await token(basic(`thr_ci_${crypto.randomUUID()}.AAAAAAAAAAAAAAAAAAAAAA`, 'x'), 'grant_type=client_credentials')).statusCode).toBe(401);

    // tokens are short-lived
    ctx.clock.advanceMinutes(61);
    expect((await inject({ method: 'GET', url: '/v1/employees', headers: bearer(t.access_token) })).statusCode).toBe(401);
    await relogin();

    // rotation: both secrets work during the grace period, only the new one after it
    const rotated = (await inject({ method: 'POST', url: `/v1/settings/oauth-clients/${c.id}/rotate-secret`, headers: as(owner.cookie), payload: { graceHours: 24 } })).json();
    expect(rotated.clientSecret).not.toBe(c.clientSecret);
    expect((await token(basic(c.clientId, c.clientSecret), 'grant_type=client_credentials')).statusCode).toBe(200);
    expect((await token(basic(c.clientId, rotated.clientSecret), 'grant_type=client_credentials')).statusCode).toBe(200);
    ctx.clock.advanceMinutes(25 * 60);
    await relogin();
    expect((await token(basic(c.clientId, c.clientSecret), 'grant_type=client_credentials')).statusCode).toBe(401);
    const fresh = (await token(basic(c.clientId, rotated.clientSecret), 'grant_type=client_credentials')).json();

    // revoking the client revokes its tokens
    await inject({ method: 'POST', url: `/v1/settings/oauth-clients/${c.id}/revoke`, headers: as(owner.cookie) });
    expect((await inject({ method: 'GET', url: '/v1/employees', headers: bearer(fresh.access_token) })).statusCode).toBe(401);
    expect((await token(basic(c.clientId, rotated.clientSecret), 'grant_type=client_credentials')).statusCode).toBe(401);
  });
});

describe('per-tenant rate limits', () => {
  it('returns 429 with Retry-After and RateLimit headers once the tenant limit is used up; other tenants are unaffected', async () => {
    const other = await ownerSession(ctx);
    const mine = (await createKey({ name: 'Limited', scopes: ['org:read'], roleKey: 'hr_admin' })).json();
    const theirs = (await inject({ method: 'POST', url: '/v1/settings/api-keys', headers: as(other.cookie), payload: { name: 'Neighbour', scopes: ['org:read'], roleKey: 'hr_admin' } })).json();
    await tx(owner.tenantId, (t) => t.exec(`UPDATE app.tenants SET features = jsonb_set(features, '{api}', '{"rateLimitPerMinute": 3}')`));
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await inject({ method: 'GET', url: '/v1/org/departments', headers: bearer(mine.key) });
      statuses.push(last.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect(last!.headers['ratelimit-limit']).toBe('3');
    expect(last!.headers['ratelimit-remaining']).toBe('0');
    expect(last!.headers['ratelimit-policy']).toBe('3;w=60');
    expect(last!.json().code).toBe('rateLimited');
    const neighbour = await inject({ method: 'GET', url: '/v1/org/departments', headers: bearer(theirs.key) });
    expect(neighbour.statusCode).toBe(200);
    expect(neighbour.headers['ratelimit-limit']).toBe('600'); // plan default
    // browser sessions are not counted against the API budget
    expect((await inject({ method: 'GET', url: '/v1/org/departments', headers: as(owner.cookie) })).statusCode).toBe(200);
    await ctx.deps.limiter.reset(`api:tenant:${owner.tenantId}`);
    await tx(owner.tenantId, (t) => t.exec(`UPDATE app.tenants SET features = features - 'api'`));
  });
});

describe('idempotency keys', () => {
  it('replay the stored response for the same key and body, refuse a different body, and are scoped per caller', async () => {
    const k = (await createKey({ name: 'Idempotent', scopes: ['org:write'], roleKey: 'hr_admin' })).json();
    const headers = { ...bearer(k.key), 'idempotency-key': 'dept-create-0001' };
    const first = await inject({ method: 'POST', url: '/v1/org/departments', headers, payload: { name: 'Fictional Research' } });
    expect(first.statusCode, first.body).toBe(201);
    const again = await inject({ method: 'POST', url: '/v1/org/departments', headers, payload: { name: 'Fictional Research' } });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const count = await tx(owner.tenantId, (t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.departments WHERE name = 'Fictional Research'`));
    expect(count.n).toBe(1);
    // same key, different request → 422
    const reused = await inject({ method: 'POST', url: '/v1/org/departments', headers, payload: { name: 'Fictional Something Else' } });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().detail).toBe('idempotencyKeyReused');
    // the same key from another caller (a person) is independent
    const person = await inject({ method: 'POST', url: '/v1/org/departments', headers: { ...as(owner.cookie), 'idempotency-key': 'dept-create-0001' }, payload: { name: 'Fictional Person Dept' } });
    expect(person.statusCode).toBe(201);
    expect(person.headers['idempotent-replayed']).toBeUndefined();
    // invalid keys are rejected
    expect((await inject({ method: 'POST', url: '/v1/org/departments', headers: { ...bearer(k.key), 'idempotency-key': 'x'.repeat(300) }, payload: { name: 'Too long' } })).statusCode).toBe(400);

    // the expiry job purges keys past their 24-hour window, after which the key can be used again
    ctx.clock.advanceMinutes(25 * 60);
    await relogin();
    const purge = await jobHandlers['platform.purge_expired']!({ tenantId: owner.tenantId, job: { id: 'p', tenant_id: owner.tenantId, kind: 'platform.purge_expired', idempotency_key: 'p', input: {}, attempts: 1, created_by: null }, deps: ctx.deps, tx: (fn) => tx(owner.tenantId, fn), progress: async () => undefined });
    expect((purge as { idempotencyKeys: number }).idempotencyKeys).toBeGreaterThanOrEqual(2);
    const reuse = await inject({ method: 'POST', url: '/v1/org/departments', headers, payload: { name: 'Fictional Research Two' } });
    expect(reuse.statusCode).toBe(201);
    expect(reuse.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('feature flag gate', () => {
  it('turning the public API off refuses keys and token requests', async () => {
    const k = (await createKey({ name: 'Gated', scopes: ['org:read'], roleKey: 'hr_admin' })).json();
    const off = await inject({ method: 'PUT', url: '/v1/settings/features/publicApi', headers: as(owner.cookie), payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    const r = await inject({ method: 'GET', url: '/v1/org/departments', headers: bearer(k.key) });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ detail: 'featureDisabled', feature: 'publicApi' });
    expect((await createKey({ name: 'Blocked', scopes: ['org:read'], roleKey: 'hr_admin' })).statusCode).toBe(403);
    await inject({ method: 'PUT', url: '/v1/settings/features/publicApi', headers: as(owner.cookie), payload: { enabled: null } });
    expect((await inject({ method: 'GET', url: '/v1/org/departments', headers: bearer(k.key) })).statusCode).toBe(200);
  });
});

describe('versioning: deprecation headers', () => {
  it('formats RFC 9745 Deprecation, RFC 8594 Sunset and a deprecation Link', () => {
    expect(deprecationHeaders({ since: '2027-01-01', sunset: '2027-07-01', link: 'https://example.test/migrate' })).toEqual({
      Deprecation: '@1798761600',
      Sunset: 'Thu, 01 Jul 2027 00:00:00 GMT',
      Link: '<https://example.test/migrate>; rel="deprecation"; type="text/html"',
    });
    expect(() => deprecationHeaders({ since: 'soon' })).toThrow();
  });

  it('are sent on operations whose route config declares a deprecation', async () => {
    const app = Fastify();
    await app.register(platformHttpPlugin, { deps: ctx.deps });
    app.get('/v1/legacy', { config: { deprecation: { since: '2027-01-01', sunset: '2027-07-01' } } }, async () => ({ ok: true }));
    app.get('/v1/current', async () => ({ ok: true }));
    const legacy = await app.inject({ method: 'GET', url: '/v1/legacy' });
    expect(legacy.headers.deprecation).toBe('@1798761600');
    expect(legacy.headers.sunset).toBe('Thu, 01 Jul 2027 00:00:00 GMT');
    expect((await app.inject({ method: 'GET', url: '/v1/current' })).headers.deprecation).toBeUndefined();
    await app.close();
  });
});
