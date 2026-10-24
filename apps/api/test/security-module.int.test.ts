import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withTenant, writeAudit } from '@thapsus/db';
import { runDetectionPipeline } from '../src/modules/security/pipeline';
import { insertSignals } from '../src/modules/security/signals';
import { pseudonym } from '../src/modules/security/pseudonym';
import { closeDb, ownerSession, signup, startTestApp, type TestContext } from './helpers';
import { injector, staffSession, userSession } from './phase10-helpers';

/**
 * Security monitoring end to end (ADR-0177 to ADR-0179): signals from requests and the audit trails,
 * detections and incidents, containment (blocks, sessions, API keys, staff freezes with two people), the
 * back-office Security module, honeytokens, and the customer's Security centre.
 */
export const DECOY_KEY =
  'thr_sk_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e.decoyKeyDoNotUseXq7Lm2Np9Rs4Tv6Wy8Za0Bc3Df5Gh';

let ctx: TestContext;
// documentation addresses (RFC 5737), one per call: internal addresses are never blocked
let nextIp = 10;
const randomIp = () => `203.0.113.${nextIp++}`;
let api: ReturnType<typeof injector>;
let analyst: Awaited<ReturnType<typeof staffSession>>;
let analyst2: Awaited<ReturnType<typeof staffSession>>;
let support: Awaited<ReturnType<typeof staffSession>>;
const registry = () => ctx.deps.router.registryPool();
const later = () => new Date(ctx.clock.now.getTime() + 15_000);
async function detect() {
  await ctx.app.securitySignals!.flush();
  return runDetectionPipeline(ctx.deps, later());
}
const from = (
  ip: string,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  payload?: object,
) => ctx.app.inject({ method: method as 'GET', url, headers, payload, remoteAddress: ip });

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  api = injector(ctx);
  analyst = await staffSession(ctx, 'security_analyst');
  analyst2 = await staffSession(ctx, 'security_analyst');
  support = await staffSession(ctx, 'support');
  await detect(); // everything before this suite has been seen
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('signals', () => {
  it('records refused, rejected and not-found requests by route pattern and keyed address, never the raw address or URL', async () => {
    const ip = randomIp();
    const owner = await ownerSession(ctx);
    const id = crypto.randomUUID();
    await from(ip, 'GET', `/v1/employees/${id}`, { cookie: owner.cookie });
    await from(ip, 'GET', '/v1/backoffice/tenants', { cookie: owner.cookie });
    await from(ip, 'GET', '/v1/no-such-thing');
    await ctx.app.securitySignals!.flush();
    const key = pseudonym(ctx.deps, 'ip', ip);
    const { rows } = await registry().query(
      `SELECT type, route, subject_tenant_id::text AS tenant, ip_net::text AS net FROM security.events WHERE ip_key = $1 ORDER BY id`,
      [key],
    );
    // the back-office 401 is not a sign-in route, so it is not a signal
    expect(rows).toEqual([
      {
        type: 'http.not_found',
        route: '/v1/employees/:id',
        tenant: owner.tenantId,
        net: expect.stringMatching(/\/24$/),
      },
      { type: 'route.not_found', route: null, tenant: null, net: expect.stringMatching(/\/24$/) },
    ]);
    const raw = await registry().query(
      `SELECT count(*)::int AS n FROM security.events WHERE detail::text LIKE $1 OR route LIKE $2`,
      [`%${ip}%`, `%${id}%`],
    );
    expect(raw.rows[0].n).toBe(0);
  });

  it('copies watched audit actions with codes only (admin role granted), and staff views of workspaces', async () => {
    const owner = await signup(ctx);
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      writeAudit(tx, {
        actorType: 'user',
        actorId: owner.userId,
        action: 'role.assigned',
        targetType: 'user',
        targetId: owner.userId,
        diff: {
          role: { from: null, to: 'hr_admin' },
          isAdmin: { from: null, to: true },
          note: 'Olive Owner',
        },
        ip: '203.0.113.9',
      }),
    );
    const ev = await registry().query(
      `SELECT type, actor_id::text AS actor, ip_net::text AS net, detail FROM security.events WHERE subject_tenant_id = $1 AND type = 'audit.role.assigned'`,
      [owner.tenantId],
    );
    expect(ev.rows).toEqual([
      {
        type: 'audit.role.assigned',
        actor: owner.userId,
        net: '203.0.113.0/24',
        detail: { role: 'hr_admin', isAdmin: true, actorType: 'user' },
      },
    ]);
    expect(
      (await api('GET', `/v1/backoffice/tenants/${owner.tenantId}`, undefined, support.cookie)).statusCode,
    ).toBe(200);
    const staff = await registry().query(
      `SELECT type FROM security.events WHERE staff_id = $1 AND subject_tenant_id = $2`,
      [support.staffId, owner.tenantId],
    );
    expect(staff.rows).toEqual([{ type: 'staffaudit.tenant.viewed' }]);
    // a privilege change the customer sees in its Security centre
    await detect();
    const alerts = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ rule_id: string }>('SELECT rule_id FROM app.security_alerts'),
    );
    expect(alerts.map((a) => a.rule_id)).toContain('THR-PRIV-001');
  });
});

describe('honeytokens and blocks', () => {
  it('the decoy API key raises a critical incident and blocks the address; lifting the block lets it back in', async () => {
    const ip = randomIp();
    const r = await from(ip, 'GET', '/v1/employees', { authorization: `Bearer ${DECOY_KEY}` });
    expect(r.statusCode).toBe(401);
    const run = await detect();
    const o = run.outcomes.find(
      (x) => x.hit.rule.id === 'THR-DECEPT-001' && x.hit.ipKey === pseudonym(ctx.deps, 'ip', ip),
    )!;
    expect(o).toMatchObject({ severity: 'critical', newIncident: true });
    await ctx.app.securityCaches!.refreshBlocks();
    const blocked = await from(ip, 'GET', '/v1/status');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toBe('blocked');
    expect((await from(randomIp(), 'GET', '/v1/status')).statusCode).not.toBe(403);

    const detail = (
      await api('GET', `/v1/backoffice/security/incidents/${o.incidentId}`, undefined, analyst.cookie)
    ).json();
    expect(detail.incident).toMatchObject({
      severity: 'critical',
      status: 'contained',
      reference: o.incidentReference,
    });
    const block = detail.containment.find((c: { kind: string }) => c.kind === 'block_ip');
    expect(block).toMatchObject({ automated: true, active: true });
    const rev = await api(
      'POST',
      `/v1/backoffice/security/containment/${block.id}/reverse`,
      undefined,
      analyst.cookie,
    );
    expect(rev.json()).toEqual({ state: 'reversed' });
    expect((await from(ip, 'GET', '/v1/status')).statusCode).not.toBe(403);
  });

  it('honey endpoints answer 404 slowly, raise a detection and show on the registry', async () => {
    const ip = randomIp();
    expect((await from(ip, 'GET', '/.env')).statusCode).toBe(404);
    expect((await from(ip, 'POST', '/wp-login.php')).statusCode).toBe(404);
    expect((await from(ip, 'GET', '/v1/honey/git-config')).statusCode).toBe(404);
    const run = await detect();
    expect(
      run.outcomes.filter((x) => x.hit.ipKey === pseudonym(ctx.deps, 'ip', ip)).map((x) => x.hit.rule.id),
    ).toEqual(['THR-DECEPT-002']);
    const reg = (await api('GET', '/v1/backoffice/security/honeytokens', undefined, analyst.cookie)).json();
    const env = reg.find((h: { label: string }) => /environment file/.test(h.label));
    expect(env.touches30d).toBeGreaterThanOrEqual(1);
    expect(reg.find((h: { kind: string }) => h.kind === 'api_key').plantedIn).toBe('docs/api.md');
    expect(JSON.stringify(reg)).not.toContain('decoyKey');
    // the honey routes are not in the published API description
    const spec = (await ctx.app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(
      Object.keys(spec.paths).filter((p) => /\/v1\/honey|\.env|wp-login|export-all|\.git/.test(p)),
    ).toEqual([]);
  });

  it('a decoy object key raises a detection before anything is served', async () => {
    await ctx.app.securityCaches!.refreshHoneytokens();
    await ctx.deps.objects.presignGet('exports/backup/all-employees-full.csv').catch(() => undefined);
    const run = await detect();
    expect(run.outcomes.some((x) => x.hit.rule.id === 'THR-DECEPT-001' && !x.hit.ipKey)).toBe(true);
  });
});

describe('containment from the incident view', () => {
  it("ends a person's sessions after a sign-in that followed many failures", async () => {
    const owner = await ownerSession(ctx);
    const emp = await userSession(ctx, owner, 'employee');
    await insertSignals(
      registry(),
      Array.from({ length: 5 }, (_, i) => ({
        at: new Date(ctx.clock.now.getTime() - 10 * 60_000 + i * 1000).toISOString(),
        type: 'audit.auth.login_failed',
        source: 'audit' as const,
        tenantId: owner.tenantId,
        actorId: emp.userId,
      })),
    );
    await insertSignals(registry(), [
      {
        at: ctx.clock.now.toISOString(),
        type: 'audit.auth.login',
        source: 'audit',
        tenantId: owner.tenantId,
        actorId: emp.userId,
      },
    ]);
    const run = await detect();
    const o = run.outcomes.find((x) => x.hit.rule.id === 'THR-CRED-004' && x.hit.actorId === emp.userId)!;
    expect(o).toBeTruthy();
    const detail = (
      await api('GET', `/v1/backoffice/security/incidents/${o.incidentId}`, undefined, analyst.cookie)
    ).json();
    expect(detail.actions).toContain('end_sessions');
    expect(detail.tenants).toEqual([{ tenantId: owner.tenantId, slug: owner.slug }]);
    expect((await api('GET', '/v1/me/summary', undefined, emp.cookie)).statusCode).toBe(200);
    const c = await api(
      'POST',
      `/v1/backoffice/security/incidents/${o.incidentId}/containment`,
      { kind: 'end_sessions' },
      analyst.cookie,
    );
    expect(c.statusCode, c.body).toBe(201);
    expect((await api('GET', '/v1/me/summary', undefined, emp.cookie)).statusCode).toBe(401);
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM audit.events WHERE action = 'security.sessions_ended' AND target_id = $1`,
        [emp.userId],
      ),
    );
    expect(audit).toEqual([{ action: 'security.sessions_ended', actor_type: 'support' }]);
    // the customer's admins see it in their Security centre
    const centre = (await api('GET', '/v1/settings/security-centre', undefined, owner.cookie)).json();
    expect(centre.alerts.find((a: { ruleId: string }) => a.ruleId === 'THR-CRED-004')).toMatchObject({
      subject: { userId: emp.userId },
    });
  });

  it('suspends an API key and restores it', async () => {
    const owner = await ownerSession(ctx);
    await api('PUT', '/v1/settings/features/publicApi', { enabled: true }, owner.cookie);
    const created = await api(
      'POST',
      '/v1/settings/api-keys',
      { name: 'Fictional sync', scopes: ['employees:read'], roleKey: 'hr_admin' },
      owner.cookie,
    );
    expect(created.statusCode, created.body).toBe(201);
    const { id, key } = created.json() as { id: string; key: string };
    const call = () => from(randomIp(), 'GET', '/v1/employees', { authorization: `Bearer ${key}` });
    expect((await call()).statusCode).toBe(200);
    await insertSignals(
      registry(),
      Array.from({ length: 30 }, (_, i) => ({
        at: new Date(ctx.clock.now.getTime() - 20 * 60_000 + i * 1000).toISOString(),
        type: 'audit.document.downloaded',
        source: 'audit' as const,
        tenantId: owner.tenantId,
        actorId: id,
        detail: { actorType: 'api_client' },
      })),
    );
    const o = (await detect()).outcomes.find(
      (x) => x.hit.rule.id === 'THR-EXFIL-001' && x.hit.actorId === id,
    )!;
    const detail = (
      await api('GET', `/v1/backoffice/security/incidents/${o.incidentId}`, undefined, analyst.cookie)
    ).json();
    expect(detail.actions).toEqual(expect.arrayContaining(['suspend_api_key']));
    expect(detail.actions).not.toContain('end_sessions');
    const c = await api(
      'POST',
      `/v1/backoffice/security/incidents/${o.incidentId}/containment`,
      { kind: 'suspend_api_key' },
      analyst.cookie,
    );
    expect(c.statusCode, c.body).toBe(201);
    expect((await call()).statusCode).toBe(401);
    expect(
      (
        await api(
          'POST',
          `/v1/backoffice/security/containment/${c.json().id}/reverse`,
          undefined,
          analyst.cookie,
        )
      ).json(),
    ).toEqual({
      state: 'reversed',
    });
    expect((await call()).statusCode).toBe(200);
  });

  it('freezes a staff account under attack automatically; unfreezing needs a second staff member', async () => {
    const victim = await staffSession(ctx, 'support');
    // four wrong passwords (the account throttle allows five sign-ins in 15 minutes) and a wrong code
    for (let i = 0; i < 4; i++)
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/backoffice/auth/login',
        payload: { email: victim.email, password: 'Fictional-wrong-password-1' },
        remoteAddress: randomIp(),
      });
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/backoffice/auth/totp',
      headers: { cookie: victim.cookie },
      payload: { code: '000000' },
      remoteAddress: randomIp(),
    });
    const o = (await detect()).outcomes.find(
      (x) => x.hit.rule.id === 'THR-STAFF-001' && x.hit.staffId === victim.staffId,
    )!;
    expect(o).toBeTruthy();
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, victim.cookie)).statusCode).toBe(401);
    const bo = getPool(ctx.deps.backofficeDbUrl!);
    expect(
      (await bo.query('SELECT active FROM backoffice.staff_users WHERE id = $1', [victim.staffId])).rows[0]
        .active,
    ).toBe(false);
    const detail = (
      await api('GET', `/v1/backoffice/security/incidents/${o.incidentId}`, undefined, analyst.cookie)
    ).json();
    const freeze = detail.containment.find((c: { kind: string }) => c.kind === 'freeze_staff');
    expect(freeze).toMatchObject({ automated: true, active: true });
    const url = `/v1/backoffice/security/containment/${freeze.id}/reverse`;
    expect((await api('POST', url, undefined, analyst.cookie)).json()).toEqual({
      state: 'awaitingSecondApproval',
    });
    const same = await api('POST', url, undefined, analyst.cookie);
    expect(same.statusCode).toBe(403);
    expect(same.json().detail).toBe('secondPersonRequired');
    expect((await api('POST', url, undefined, analyst2.cookie)).json()).toEqual({ state: 'reversed' });
    expect(
      (await bo.query('SELECT active FROM backoffice.staff_users WHERE id = $1', [victim.staffId])).rows[0]
        .active,
    ).toBe(true);
  });
});

describe('the Security module', () => {
  it('is for security analysts and super admins only', async () => {
    expect((await api('GET', '/v1/backoffice/security/overview', undefined, support.cookie)).statusCode).toBe(
      403,
    );
    const owner = await signup(ctx);
    expect((await api('GET', '/v1/backoffice/security/overview', undefined, owner.cookie)).statusCode).toBe(
      401,
    );
    expect((await api('GET', '/v1/backoffice/security/overview', undefined, analyst.cookie)).statusCode).toBe(
      200,
    );
  });

  it('shows detections, open incidents, sign-in health, top offending addresses and the pipeline', async () => {
    const ip = randomIp();
    for (let i = 0; i < 3; i++) await from(ip, 'GET', '/v1/backoffice/tenants');
    await detect();
    const o = (await api('GET', '/v1/backoffice/security/overview', undefined, analyst.cookie)).json();
    expect(o.detections24h.map((d: { severity: string }) => d.severity)).toEqual([
      'low',
      'medium',
      'high',
      'critical',
    ]);
    expect(o.openIncidents.reduce((n: number, d: { count: number }) => n + d.count, 0)).toBeGreaterThan(0);
    expect(o.pipeline).toMatchObject({ stale: false });
    expect(o.topIps.length).toBeGreaterThan(0);
    for (const t of o.topIps) expect(t.ipNet === null || /\/(24|48)$/.test(t.ipNet)).toBe(true);
    expect(JSON.stringify(o)).not.toContain(ip);
  });

  it('works an incident: acknowledge, assign, note, resolve, all on the timeline and in the staff trail', async () => {
    const list = (await api('GET', '/v1/backoffice/security/incidents', undefined, analyst.cookie)).json();
    const inc = list.find((i: { status: string }) => i.status !== 'resolved');
    const p = await api(
      'PATCH',
      `/v1/backoffice/security/incidents/${inc.id}`,
      { status: 'acknowledged', assignedTo: analyst.staffId },
      analyst.cookie,
    );
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ status: 'acknowledged', assignedTo: { id: analyst.staffId } });
    expect(
      (
        await api(
          'PATCH',
          `/v1/backoffice/security/incidents/${inc.id}`,
          { assignedTo: support.staffId },
          analyst.cookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(
          'POST',
          `/v1/backoffice/security/incidents/${inc.id}/notes`,
          { body: 'Checked the address range; a fictional scanner.' },
          analyst.cookie,
        )
      ).statusCode,
    ).toBe(201);
    await api('PATCH', `/v1/backoffice/security/incidents/${inc.id}`, { status: 'resolved' }, analyst.cookie);
    const d = (
      await api('GET', `/v1/backoffice/security/incidents/${inc.id}`, undefined, analyst.cookie)
    ).json();
    expect(d.resolvedAt).toBeTruthy();
    expect(d.timeline.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['status', 'assignment', 'note']),
    );
    const trail = await getPool(ctx.deps.backofficeDbUrl!).query(
      `SELECT action FROM backoffice.staff_audit WHERE staff_id = $1 AND action LIKE 'security.%'`,
      [analyst.staffId],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'security.incident_updated',
        'security.incident_noted',
        'security.incident_viewed',
      ]),
    );
  });

  it('lists the rule catalogue with on/off and fixture results, and tests it against this cell', async () => {
    const tested = (
      await api('POST', '/v1/backoffice/security/rules/test', undefined, analyst.cookie)
    ).json();
    expect(tested.length).toBeGreaterThanOrEqual(20);
    expect(tested.filter((t: { passed: boolean }) => !t.passed)).toEqual([]);
    expect(
      (await api('PATCH', '/v1/backoffice/security/rules/THR-AI-001', { enabled: false }, analyst.cookie))
        .statusCode,
    ).toBe(204);
    const cat = (await api('GET', '/v1/backoffice/security/rules', undefined, analyst.cookie)).json();
    const ai = cat.rules.find((r: { id: string }) => r.id === 'THR-AI-001');
    expect(ai).toMatchObject({ enabled: false, lastTest: { passed: true }, mitre: { id: 'T1496' } });
    expect(cat.rules.find((r: { id: string }) => r.id === 'THR-CLOUD-001')).toMatchObject({
      status: 'planned',
      enabled: false,
    });
    await api('PATCH', '/v1/backoffice/security/rules/THR-AI-001', { enabled: true }, analyst.cookie);
    expect(
      (await api('PATCH', '/v1/backoffice/security/rules/THR-CLOUD-001', { enabled: true }, analyst.cookie))
        .statusCode,
    ).toBe(404);
  });
});

describe("the customer's Security centre", () => {
  it('shows failed sign-ins, admin changes, MFA adoption and recipients to admins only; recipients must be admins', async () => {
    const owner = await ownerSession(ctx);
    const emp = await userSession(ctx, owner, 'employee');
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email: owner.email, password: 'Fictional-wrong-1' },
      remoteAddress: '198.51.100.23',
    });
    const c = (await api('GET', '/v1/settings/security-centre', undefined, owner.cookie)).json();
    expect(c.signIns.failed7d).toBeGreaterThanOrEqual(1);
    expect(c.recentFailures[0]).toMatchObject({
      network: '198.51.100.0/24',
      person: { userId: owner.userId },
    });
    expect(c.mfa).toMatchObject({ users: 2, withMfa: 1, admins: 1, adminsWithoutMfa: 0 });
    expect(c.recipientsAreDefault).toBe(true);
    expect(c.recipients.map((r: { userId: string }) => r.userId)).toEqual([owner.userId]);
    expect((await api('GET', '/v1/settings/security-centre', undefined, emp.cookie)).statusCode).toBe(403);
    expect(
      (await api('PUT', '/v1/settings/security-centre/recipients', { userIds: [emp.userId] }, owner.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (await api('PUT', '/v1/settings/security-centre/recipients', { userIds: [owner.userId] }, owner.cookie))
        .statusCode,
    ).toBe(204);
    expect(
      (await api('GET', '/v1/settings/security-centre', undefined, owner.cookie)).json().recipientsAreDefault,
    ).toBe(false);
  });
});
