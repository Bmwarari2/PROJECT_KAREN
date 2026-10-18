import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@thapsus/db';
import { MemoryMailer, type Mail } from '../src/lib/mailer';
import { recordHeartbeat, withDeliveryHealth } from '../src/modules/status/service';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { injector, staffSession } from './phase10-helpers';

/**
 * Public status endpoint per cell (PROGRESS 10.3): unauthenticated, no personal data, edge-cacheable
 * (ADR-0105); staff post incidents and maintenance for this region, every post audited.
 */
let ctx: TestContext;
let api: ReturnType<typeof injector>;
const status = () => ctx.app.inject({ method: 'GET', url: '/v1/status' });

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  api = injector(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('GET /v1/status', () => {
  it('is public, describes only this region, carries no personal data and may be cached at the edge', async () => {
    await recordHeartbeat(ctx.deps.router, 'worker', ctx.clock.now);
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=30, s-maxage=30, stale-while-revalidate=60');
    expect(r.json()).toMatchObject({ region: 'uk', components: [{ id: 'api', state: 'operational' }, { id: 'database', state: 'operational' }, { id: 'worker', state: 'operational' }, { id: 'email' }] });
    expect(Object.keys(r.json()).sort()).toEqual(['active', 'components', 'generatedAt', 'history', 'overall', 'region', 'upcoming']);
    // every other API response stays private, no-store
    const other = await ctx.app.inject({ method: 'GET', url: '/v1/billing/plans' });
    expect(other.headers['cache-control']).toBe('private, no-store');
  });

  it('reports email delivery problems from the recorded outcomes (timestamps and counts only)', async () => {
    const failing = { region: 'uk' as const, send: async (m: Mail) => { void m; throw new Error('SES throttled'); } };
    const mailer = withDeliveryHealth(failing, () => ctx.deps.router.registryPool());
    await expect(mailer.send({ to: 'someone@fictional.example.test', subject: 's', text: 't' })).rejects.toThrow();
    expect((await status()).json().components.find((c: { id: string }) => c.id === 'email').state).toBe('degraded');
    const ok = withDeliveryHealth(new MemoryMailer('uk'), () => ctx.deps.router.registryPool());
    await ok.send({ to: 'someone@fictional.example.test', subject: 's', text: 't' });
    expect((await status()).json().components.find((c: { id: string }) => c.id === 'email').state).toBe('operational');
    const { rows } = await ctx.deps.router.registryPool().query(`SELECT * FROM backoffice.service_heartbeats WHERE service = 'email'`);
    expect(JSON.stringify(rows)).not.toMatch(/someone@|fictional\.example/);
  });
});

describe('staff incidents and maintenance', () => {
  it('support staff post an incident with updates; the page shows it for this region; every post is audited', async () => {
    const support = await staffSession(ctx, 'support');
    const owner = await ownerSession(ctx);
    expect((await api('POST', '/v1/backoffice/status/incidents', { kind: 'incident', impact: 'major', title: 'Slow sign-in', components: ['api'], body: 'Investigating' }, owner.cookie)).statusCode).toBe(401);
    expect((await api('POST', '/v1/backoffice/status/incidents', { kind: 'incident', impact: 'maintenance', title: 'Bad', components: ['api'], body: 'x' }, support.cookie)).statusCode).toBe(400);
    const r = await api('POST', '/v1/backoffice/status/incidents', { kind: 'incident', impact: 'major', title: 'Slow sign-in in the UK region', components: ['api'], body: 'We are investigating slow sign-in.' }, support.cookie);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    let s = (await status()).json();
    expect(s.overall).toBe('outage');
    expect(s.active[0]).toMatchObject({ id, title: 'Slow sign-in in the UK region', status: 'investigating', updates: [{ status: 'investigating', body: 'We are investigating slow sign-in.' }] });
    expect(JSON.stringify(s)).not.toContain(support.staffId);
    expect(JSON.stringify(s)).not.toContain(support.email);
    expect((await api('POST', `/v1/backoffice/status/incidents/${id}/updates`, { status: 'completed', body: 'x' }, support.cookie)).statusCode).toBe(400);
    expect((await api('POST', `/v1/backoffice/status/incidents/${id}/updates`, { status: 'resolved', body: 'Fixed: a configuration change was rolled back.' }, support.cookie)).statusCode).toBe(201);
    s = (await status()).json();
    expect(s.active).toEqual([]);
    expect(s.history[0]).toMatchObject({ id, status: 'resolved', resolvedAt: expect.any(String) });
    expect(s.history[0].updates).toHaveLength(2);
    const window = { scheduledStart: new Date(ctx.clock.now.getTime() + 86_400_000).toISOString(), scheduledEnd: new Date(ctx.clock.now.getTime() + 90_000_000).toISOString() };
    expect((await api('POST', '/v1/backoffice/status/incidents', { kind: 'maintenance', impact: 'maintenance', title: 'Database upgrade', components: ['database'], body: 'Planned maintenance.', ...window }, support.cookie)).statusCode).toBe(201);
    expect((await status()).json().upcoming[0]).toMatchObject({ title: 'Database upgrade', status: 'scheduled' });
    const trail = (await getPool(ctx.deps.backofficeDbUrl!).query<{ action: string }>(`SELECT action FROM backoffice.staff_audit WHERE staff_id = $1 AND action LIKE 'status.%' ORDER BY id`, [support.staffId])).rows.map((x) => x.action);
    expect(trail).toEqual(['status.incident_posted', 'status.incident_updated', 'status.incident_posted']);
    await expect(getPool(ctx.deps.backofficeDbUrl!).query(`DELETE FROM backoffice.status_updates`)).rejects.toThrow();
  });
});
