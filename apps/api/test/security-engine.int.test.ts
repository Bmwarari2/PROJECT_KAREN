import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@thapsus/db';
import { DETECTION_RULES } from '@thapsus/core/security';
import { testRules } from '../src/modules/security/fixtures';
import { insertSignals, type Signal } from '../src/modules/security/signals';
import { runDetectionPipeline } from '../src/modules/security/pipeline';
import { closeDb, startTestApp, type TestContext } from './helpers';

/**
 * The detection engine against the real database (ADR-0177): every active rule's fixture fires exactly once
 * and its near miss never; detections roll up into incidents with dedupe windows; automated blocks apply.
 */
let ctx: TestContext;
const registry = () => ctx.deps.router.registryPool();
const ipKey = (name: string) => `engine-${Math.random().toString(36).slice(2, 8)}-${name}`;
const at = (minutesAgo: number, i = 0) =>
  new Date(ctx.clock.now.getTime() - minutesAgo * 60_000 + i * 1000).toISOString();

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('rule fixtures', () => {
  it('every active rule fires once on its fixture and never on its near miss', async () => {
    const results = await testRules(() => registry().connect(), DETECTION_RULES, ctx.clock.now);
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });
});

describe('the detection run', () => {
  it('records a detection and incident once, blocks the address, and extends rather than repeats within the dedupe window', async () => {
    // let earlier events pass the cursor lag first
    await runDetectionPipeline(ctx.deps, new Date(ctx.clock.now.getTime() + 60_000));
    const ip = ipKey('spray');
    const spray: Signal[] = Array.from({ length: 20 }, (_, i) => ({
      at: at(3, i),
      type: 'authn.failed',
      source: 'request',
      ipKey: ip,
      ipNet: '198.51.100.0/24',
      route: '/v1/auth/login',
    }));
    await insertSignals(registry(), spray);
    const first = await runDetectionPipeline(ctx.deps, ctx.clock.now);
    const mine = first.outcomes.filter((o) => o.hit.ipKey === ip);
    expect(mine.map((o) => o.hit.rule.id)).toEqual(['THR-CRED-001']);
    expect(mine[0]).toMatchObject({ isNew: true, newIncident: true, severity: 'high' });
    const block = await registry().query(
      `SELECT kind, automated, ip_net::text FROM security.containment_actions WHERE ip_key = $1`,
      [ip],
    );
    expect(block.rows).toEqual([{ kind: 'block_ip', automated: true, ip_net: '198.51.100.0/24' }]);
    const incident = await registry().query<{ status: string; reference: string }>(
      'SELECT status, reference FROM security.incidents WHERE id = $1',
      [mine[0]!.incidentId],
    );
    expect(incident.rows[0]!.status).toBe('contained');
    expect(incident.rows[0]!.reference).toMatch(/^SEC-\d{5}$/);

    // more failures from the same address: the same detection grows, no new incident
    await insertSignals(
      registry(),
      spray.map((s) => ({ ...s, at: at(1) })),
    );
    const second = await runDetectionPipeline(ctx.deps, new Date(ctx.clock.now.getTime() + 15_000));
    const again = second.outcomes.filter((o) => o.hit.ipKey === ip);
    expect(again.map((o) => [o.isNew, o.detectionId])).toEqual([[false, mine[0]!.detectionId]]);

    // a probing burst from the same address joins the same incident (one incident per address)
    await insertSignals(
      registry(),
      Array.from({ length: 30 }, (_, i) => ({
        at: at(1, i),
        type: 'authz.denied',
        source: 'request' as const,
        ipKey: ip,
        route: '/v1/employees/:id',
      })),
    );
    const third = await runDetectionPipeline(ctx.deps, new Date(ctx.clock.now.getTime() + 30_000));
    const probe = third.outcomes.find((o) => o.hit.ipKey === ip && o.hit.rule.id === 'THR-PROBE-001')!;
    expect(probe).toMatchObject({ isNew: true, newIncident: false, incidentId: mine[0]!.incidentId });
    const timeline = await registry().query<{ kind: string }>(
      'SELECT kind FROM security.incident_events WHERE incident_id = $1 ORDER BY id',
      [mine[0]!.incidentId],
    );
    // the high detection also raised an immediate alert (recorded even with no recipients configured)
    expect(timeline.rows.map((r) => r.kind)).toEqual([
      'opened',
      'detection',
      'containment',
      'alert',
      'detection',
    ]);
  });

  it('runs in one worker at a time', async () => {
    const holder = await registry().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM security.pipeline_state WHERE name = 'detections' FOR UPDATE`);
      expect((await runDetectionPipeline(ctx.deps, ctx.clock.now)).skipped).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('stores pseudonymous values only: no raw addresses, emails or ids in routes', async () => {
    const cols = await getPool(ctx.deps.backofficeDbUrl!).query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'security' AND table_name = 'events' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id',
      'at',
      'type',
      'source',
      'subject_tenant_id',
      'actor_id',
      'staff_id',
      'ip_key',
      'ip_net',
      'account_key',
      'route',
      'detail',
    ]);
    // a route with an id in it, a raw address as a key and a free-text detail never reach the table
    const n = await insertSignals(registry(), [
      {
        at: at(0),
        type: 'authz.denied',
        source: 'request',
        ipKey: '203.0.113.7',
        route: `/v1/employees/${crypto.randomUUID()}`,
        detail: { note: 'Ada Fictional <ada@example.test>', code: 'denied' },
      },
    ]);
    expect(n).toBe(1);
    const row = (
      await registry().query('SELECT ip_key, route, detail FROM security.events ORDER BY id DESC LIMIT 1')
    ).rows[0];
    expect(row).toEqual({ ip_key: null, route: null, detail: { code: 'denied' } });
  });
});
