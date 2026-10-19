import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import { featureEnabled, processMoveRequests, withTenant } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { closeDb, cookieFrom, ownerSession, PASSWORD, randomIp, startTestApp, totpCode, type TestContext } from './helpers';
import { createStaff, STAFF_COOKIE } from '../src/modules/backoffice/auth';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * Phase 9.5 — per-tenant feature flags (settings and back office, exposed to the app shell), custom
 * branding (accent within WCAG 2.2 AA limits in both modes, logo in the home-region object store) and
 * the dedicated-database option driven from the back office with status tracking.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const api = (method: string, url: string, payload?: unknown, headers: Record<string, string> = { cookie: owner.cookie }) =>
  ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers, remoteAddress: randomIp() });

async function staff(role: 'super_admin' | 'support') {
  const email = `${role}.${Math.random().toString(36).slice(2, 6)}@thapsus.example.test`;
  const s = await createStaff(ctx.app, email, 'Fictional Staff', role);
  const login = await ctx.app.inject({ method: 'POST', url: '/v1/backoffice/auth/login', payload: { email, password: s.password }, remoteAddress: randomIp() });
  const cookie = `${STAFF_COOKIE}=${String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]}`;
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(s.totpSecret), digits: 6, period: 30 }).generate({ timestamp: ctx.clock.now.getTime() });
  expect((await ctx.app.inject({ method: 'POST', url: '/v1/backoffice/auth/totp', headers: { cookie }, payload: { code } })).statusCode).toBe(204);
  return { cookie, id: s.id };
}

function multipart(field: string, filename: string, contentType: string, data: Buffer) {
  const boundary = `----fictional${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fictional-png-body')]);

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('feature flags', () => {
  it('resolve defaults, are toggled by company admins (tenant-managed only) and reach the app shell', async () => {
    const list = (await api('GET', '/v1/settings/features')).json();
    expect(list.find((f: { key: string }) => f.key === 'webhooks')).toMatchObject({ enabled: true, default: true, overridden: false, managedBy: 'tenant' });
    expect(list.find((f: { key: string }) => f.key === 'aiAssistant')).toMatchObject({ enabled: false, managedBy: 'staff' });
    expect((await api('GET', '/v1/tenant/experience')).json().features).toMatchObject({ webhooks: true, aiAssistant: false });

    const off = await api('PUT', '/v1/settings/features/webhooks', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().find((f: { key: string }) => f.key === 'webhooks')).toMatchObject({ enabled: false, overridden: true });
    expect((await api('GET', '/v1/tenant/experience')).json().features.webhooks).toBe(false);
    expect(await withTenant(ctx.deps.router, owner.tenantId, (tx) => featureEnabled(tx, 'webhooks'))).toBe(false);
    expect((await api('GET', '/v1/webhooks')).statusCode).toBe(403);
    // staff-managed flags cannot be changed by the customer
    const ai = await api('PUT', '/v1/settings/features/aiAssistant', { enabled: true });
    expect(ai.statusCode).toBe(403);
    expect(ai.json().detail).toBe('staffManagedFeature');
    expect((await api('PUT', '/v1/settings/features/notAFlag', { enabled: true })).statusCode).toBe(404);
    // null restores the default; every change is audited
    await api('PUT', '/v1/settings/features/webhooks', { enabled: null });
    expect((await api('GET', '/v1/tenant/experience')).json().features.webhooks).toBe(true);
    const audits = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.query<{ diff: unknown }>(`SELECT diff FROM audit.events WHERE action = 'feature.flag_changed' ORDER BY id`));
    expect(audits.map((a) => a.diff)).toEqual([{ from: true, to: false }, { from: false, to: null }]);
  });

  it('are toggled by Thapsus staff in the back office (super admins only), audited in both trails', async () => {
    const support = await staff('support');
    expect((await api('PUT', `/v1/backoffice/tenants/${owner.tenantId}/features/aiAssistant`, { enabled: true }, { cookie: support.cookie })).statusCode).toBe(403);
    const admin = await staff('super_admin');
    const res = await api('PUT', `/v1/backoffice/tenants/${owner.tenantId}/features/aiAssistant`, { enabled: true }, { cookie: admin.cookie });
    expect(res.statusCode, res.body).toBe(200);
    expect((await api('GET', '/v1/tenant/experience')).json().features.aiAssistant).toBe(true);
    const tenantAudit = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.maybe<{ actor_type: string; actor_id: string }>(`SELECT actor_type, actor_id FROM audit.events WHERE action = 'feature.flag_changed' AND target_id = 'aiAssistant'`));
    expect(tenantAudit).toEqual({ actor_type: 'support', actor_id: admin.id });
    const db = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await db.connect();
    const trail = await db.query(`SELECT action FROM backoffice.staff_audit WHERE staff_id = $1 AND subject_tenant_id = $2`, [admin.id, owner.tenantId]);
    await db.end();
    expect(trail.rows.map((r) => r.action)).toContain('tenant.feature_flag_changed');
    // per-tenant API rate limit override
    const rl = await api('PUT', `/v1/backoffice/tenants/${owner.tenantId}/api-settings`, { rateLimitPerMinute: 1200 }, { cookie: admin.cookie });
    expect(rl.json()).toEqual({ rateLimitPerMinute: 1200 });
    const stored = await withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.one<{ api: unknown }>(`SELECT features->'api' AS api FROM app.tenants`));
    expect(stored.api).toEqual({ rateLimitPerMinute: 1200 });
  });
});

describe('custom branding', () => {
  it('accepts an accent only when WCAG 2.2 AA contrast holds in light and dark mode', async () => {
    const bad = await api('PUT', '/v1/settings/branding', { accentLight: '#ffff00' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toBe('insufficientContrast');
    expect(bad.json().failures).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'light', pair: 'accent/bg', required: 4.5 })]));
    const badDark = await api('PUT', '/v1/settings/branding', { accentLight: '#1f3a8a', accentDark: '#1f3a8a' });
    expect(badDark.statusCode).toBe(422);
    expect(badDark.json().failures.every((f: { mode: string }) => f.mode === 'dark')).toBe(true);
    expect((await api('PUT', '/v1/settings/branding', { accentLight: 'red' })).statusCode).toBe(400);

    const ok = await api('PUT', '/v1/settings/branding', { accentLight: '#1F3A8A' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().accentLight).toBe('#1f3a8a');
    expect(ok.json().checks.every((c: { pass: boolean }) => c.pass)).toBe(true);
    const exp = (await api('GET', '/v1/tenant/experience')).json();
    expect(exp.branding.palette.light.accent).toBe('#1f3a8a');
    expect(exp.branding.palette.dark.accent).not.toBe('#1f3a8a'); // a lighter accent for dark mode was derived

    // turning custom branding off falls back to the design-token accent everywhere
    await api('PUT', '/v1/settings/features/customBranding', { enabled: false });
    expect((await api('GET', '/v1/tenant/experience')).json().branding).toEqual({ palette: null, logoUrl: null });
    expect((await api('PUT', '/v1/settings/branding', { accentLight: '#1f3a8a' })).statusCode).toBe(403);
    await api('PUT', '/v1/settings/features/customBranding', { enabled: null });
  });

  it('stores the logo in the home-region object store under the tenant prefix and serves it to signed-in users only', async () => {
    const up = multipart('file', 'logo.png', 'image/png', PNG);
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/settings/branding/logo', headers: { cookie: owner.cookie, 'content-type': up.contentType }, payload: up.body });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().logo).toMatchObject({ contentType: 'image/png', bytes: PNG.length });
    const objects = ctx.deps.objects as MemoryObjectStore;
    const keys = [...objects.objects.keys()].filter((k) => k.includes('/branding/'));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith(`${owner.tenantId}/branding/`)).toBe(true);
    const img = await api('GET', res.json().logo.url);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('private, no-store');
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: res.json().logo.url })).statusCode).toBe(401);
    expect((await api('GET', '/v1/tenant/experience')).json().branding.logoUrl).toBe(res.json().logo.url);

    // SVG (scriptable) and files whose content does not match the declared type are refused
    const svg = multipart('file', 'logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/settings/branding/logo', headers: { cookie: owner.cookie, 'content-type': svg.contentType }, payload: svg.body })).statusCode).toBe(400);
    const fake = multipart('file', 'logo.png', 'image/png', Buffer.from('GIF89a not a png'));
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/settings/branding/logo', headers: { cookie: owner.cookie, 'content-type': fake.contentType }, payload: fake.body })).statusCode).toBe(400);
    // replacing deletes the previous object; removing clears it
    const again = multipart('file', 'logo2.png', 'image/png', Buffer.concat([PNG, Buffer.from('v2')]));
    await ctx.app.inject({ method: 'POST', url: '/v1/settings/branding/logo', headers: { cookie: owner.cookie, 'content-type': again.contentType }, payload: again.body });
    expect([...objects.objects.keys()].filter((k) => k.startsWith(`${owner.tenantId}/branding/`))).toHaveLength(1);
    expect((await api('DELETE', '/v1/settings/branding/logo')).json().logo).toBeNull();
    expect([...objects.objects.keys()].filter((k) => k.startsWith(`${owner.tenantId}/branding/`))).toHaveLength(0);
  });
});

describe('dedicated database option (back office → move runner → tenant keeps working)', () => {
  it('moves a tenant through a tracked back-office request and the tenant passes the same checks afterwards', async () => {
    const o = await ownerSession(ctx);
    const admin = await staff('super_admin');
    const dept = await api('POST', '/v1/org/departments', { name: 'Fictional Before Move' }, { cookie: o.cookie });
    expect(dept.statusCode).toBe(201);

    expect((await api('POST', `/v1/backoffice/tenants/${o.tenantId}/database-moves`, { targetKey: 'nowhere', reason: 'Contracted isolation' }, { cookie: admin.cookie })).json().detail).toBe('targetNotConfigured');
    expect((await api('POST', `/v1/backoffice/tenants/${o.tenantId}/database-moves`, { targetKey: 'shared', reason: 'Contracted isolation' }, { cookie: admin.cookie })).json().detail).toBe('alreadyOnTarget');
    const req = await api('POST', `/v1/backoffice/tenants/${o.tenantId}/database-moves`, { targetKey: 'dedicated', purgeSource: true, reason: 'Contracted dedicated database (fictional)' }, { cookie: admin.cookie });
    expect(req.statusCode, req.body).toBe(202);
    expect(req.json()).toMatchObject({ status: 'requested', targetKey: 'dedicated', tenantId: o.tenantId });
    expect((await api('POST', `/v1/backoffice/tenants/${o.tenantId}/database-moves`, { targetKey: 'dedicated', reason: 'Duplicate' }, { cookie: admin.cookie })).statusCode).toBe(409);

    // the runner (a one-off task with owner credentials: `move-tenant --process-requests`)
    const outcomes = await processMoveRequests({ ownerUrls: { shared: ownerUrl(TEST_DBS.shared), dedicated: ownerUrl(TEST_DBS.dedicated) } });
    expect(outcomes.find((x) => x.id === req.json().id)).toMatchObject({ status: 'succeeded' });
    const status = (await api('GET', `/v1/backoffice/database-moves/${req.json().id}`, undefined, { cookie: admin.cookie })).json();
    expect(status).toMatchObject({ status: 'succeeded', targetKey: 'dedicated' });
    expect(status.progress).toEqual(expect.arrayContaining(['routing switched to dedicated', 'source purged']));
    expect(status.report.tables.find((t: { table: string }) => t.table === 'app.departments').rows).toBeGreaterThanOrEqual(1);
    expect((await ctx.deps.router.lookup(o.tenantId)).db_key).toBe('dedicated');

    // the tenant keeps working: sign in, MFA, reads, writes and an intact audit chain
    ctx.clock.advanceMinutes(1);
    const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: o.slug, email: o.email, password: PASSWORD }, remoteAddress: randomIp() });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: totpCode(o.totpSecret, ctx.clock.now) } })).statusCode).toBe(204);
    const depts = (await api('GET', '/v1/org/departments', undefined, { cookie })).json();
    expect(depts.map((d: { name: string }) => d.name)).toContain('Fictional Before Move');
    expect((await api('POST', '/v1/org/departments', { name: 'Fictional After Move' }, { cookie })).statusCode).toBe(201);
    expect((await api('POST', '/v1/audit/verify', undefined, { cookie })).json().intact).toBe(true);
    const shared = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await shared.connect();
    try {
      expect((await shared.query('SELECT count(*)::int AS n FROM app.departments WHERE tenant_id = $1', [o.tenantId])).rows[0].n).toBe(0);
    } finally {
      await shared.end();
    }

    // a request that has not started can be cancelled
    const o2 = await ownerSession(ctx);
    const pending = (await api('POST', `/v1/backoffice/tenants/${o2.tenantId}/database-moves`, { targetKey: 'dedicated', reason: 'Changed my mind' }, { cookie: admin.cookie })).json();
    expect((await api('POST', `/v1/backoffice/database-moves/${pending.id}/cancel`, undefined, { cookie: admin.cookie })).json().status).toBe('cancelled');
    expect(await processMoveRequests({ ownerUrls: { shared: ownerUrl(TEST_DBS.shared), dedicated: ownerUrl(TEST_DBS.dedicated) } })).toEqual([]);
  });
});
