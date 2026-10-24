import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { billingConfig, ensureBillingDefaults } from '../src/modules/billing/service';
import { purgeOldMetrics, sampleQueues } from '../src/modules/backoffice/performance';
import { enqueueJob, getPool } from '@thapsus/db';
import { closeDb, signup, startTestApp, type TestContext } from './helpers';
import { injector, staffSession } from './phase10-helpers';

/**
 * Founder's console, business overview (ADR-0175): the cell's figures come from the registry and the usage
 * snapshot, the cross-region figures from the global directory only, and neither carries personal data.
 * The shared test database holds other suites' tenants too, so figures are checked as differences.
 */
let ctx: TestContext;
let api: ReturnType<typeof injector>;
let support: Awaited<ReturnType<typeof staffSession>>;
let billing: Awaited<ReturnType<typeof staffSession>>;
let rules: Awaited<ReturnType<typeof staffSession>>;

type Metrics = {
  companies: {
    total: number;
    new7d: number;
    new30d: number;
    byPlan: Array<{ key: string | null; count: number }>;
    byBillingStatus: Array<{ key: string | null; count: number }>;
  };
  signups: Array<{ weekStart: string; count: number }>;
  trials: { active: number; endingSoon: number; ended: number; converted: number };
  churn: { cancelled: number; cancelled30d: number };
  usage: { activeUsers7d: number; activeUsers30d: number; employees: number; users: number };
  revenue: Array<{ currency: string; mrrMinor: number; arrMinor: number }>;
  snapshot: { missing: number };
};
const metrics = async (cookie = support.cookie) => {
  const r = await api('GET', '/v1/backoffice/metrics', undefined, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Metrics;
};
const count = (list: Array<{ key: string | null; count: number }>, key: string | null) =>
  list.find((x) => x.key === key)?.count ?? 0;
const gbp = (m: Metrics) => m.revenue.find((r) => r.currency === 'GBP') ?? { mrrMinor: 0, arrMinor: 0 };

/** Puts the default account's subscription into a state, as the billing module would after the provider's events. */
async function setSubscription(
  tenantId: string,
  s: {
    status: string;
    term?: 'monthly' | 'annual';
    amountMinor?: number;
    trialEndsAt?: string;
    planId?: string;
  },
) {
  await withTenant(ctx.deps.router, tenantId, async (tx) => {
    await ensureBillingDefaults(tx, billingConfig(), ctx.deps.now());
    await tx.exec(
      `UPDATE app.billing_subscriptions SET status = $1, term = coalesce($2, term), interval_amount_minor = coalesce($3, interval_amount_minor),
         trial_ends_at = coalesce($4::timestamptz, trial_ends_at), plan_id = coalesce($5, plan_id), canceled_at = CASE WHEN $1 = 'canceled' THEN now() END`,
      [s.status, s.term ?? null, s.amountMinor ?? null, s.trialEndsAt ?? null, s.planId ?? null],
    );
  });
  const r = await api('POST', `/v1/backoffice/tenants/${tenantId}/usage/refresh`, undefined, support.cookie);
  expect(r.statusCode, r.body).toBe(200);
}

beforeAll(async () => {
  ctx = await startTestApp({
    listen: false,
    // a route that fails, so the performance figures have a server error to count
    extend: (app) =>
      app.get(
        '/v1/fictional-failure/boom',
        { config: { auth: 'public' }, schema: { hide: true } },
        async () => {
          throw new Error('fictional failure');
        },
      ),
  });
  api = injector(ctx);
  support = await staffSession(ctx, 'support');
  billing = await staffSession(ctx, 'billing');
  rules = await staffSession(ctx, 'rules_editor');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('business overview for this cell', () => {
  it('counts sign-ups, trials, conversions, churn, usage and MRR/ARR per currency from the snapshot', async () => {
    const before = await metrics();
    const day = 86_400_000;
    const soon = new Date(ctx.clock.now.getTime() + 5 * day).toISOString();
    const later = new Date(ctx.clock.now.getTime() + 25 * day).toISOString();
    const trialSoon = await signup(ctx);
    const trialLater = await signup(ctx);
    const paidMonthly = await signup(ctx);
    const paidAnnual = await signup(ctx);
    const expired = await signup(ctx);
    const cancelled = await signup(ctx);
    await setSubscription(trialSoon.tenantId, { status: 'trialing', trialEndsAt: soon });
    await setSubscription(trialLater.tenantId, { status: 'trialing', trialEndsAt: later });
    await setSubscription(paidMonthly.tenantId, {
      status: 'active',
      term: 'monthly',
      amountMinor: 4500,
      planId: 'core',
    });
    await setSubscription(paidAnnual.tenantId, {
      status: 'past_due',
      term: 'annual',
      amountMinor: 120_000,
      planId: 'core',
    });
    await setSubscription(expired.tenantId, { status: 'trial_expired' });
    await setSubscription(cancelled.tenantId, { status: 'canceled' });

    const after = await metrics();
    expect(after.companies.total - before.companies.total).toBe(6);
    expect(after.companies.new7d - before.companies.new7d).toBe(6);
    expect(after.companies.new30d - before.companies.new30d).toBe(6);
    expect(after.signups).toHaveLength(12);
    expect(after.signups.at(-1)!.count - before.signups.at(-1)!.count).toBe(6);
    expect(after.trials.active - before.trials.active).toBe(2);
    expect(after.trials.endingSoon - before.trials.endingSoon).toBe(1);
    // ended trials: two paid, one expired, one cancelled; two of them converted
    expect(after.trials.ended - before.trials.ended).toBe(4);
    expect(after.trials.converted - before.trials.converted).toBe(2);
    expect(after.churn.cancelled - before.churn.cancelled).toBe(1);
    expect(after.churn.cancelled30d - before.churn.cancelled30d).toBe(1);
    expect(count(after.companies.byPlan, 'core') - count(before.companies.byPlan, 'core')).toBe(2);
    expect(
      count(after.companies.byBillingStatus, 'canceled') -
        count(before.companies.byBillingStatus, 'canceled'),
    ).toBe(1);
    // MRR: 4500 monthly + 120000 a year (10000 a month); ARR: 54000 + 120000
    expect(gbp(after).arrMinor - gbp(before).arrMinor).toBe(174_000);
    expect(gbp(after).mrrMinor - gbp(before).mrrMinor).toBe(14_500);
    // every owner signed up and has a session: active in the last 7 and 30 days
    expect(after.usage.activeUsers7d - before.usage.activeUsers7d).toBe(6);
    expect(after.usage.activeUsers30d - before.usage.activeUsers30d).toBe(6);
    expect(after.usage.users - before.usage.users).toBe(6);
  });

  it('holds counts only: no names, emails, slugs or tenant ids', async () => {
    const t = await signup(ctx);
    const r = await api('GET', '/v1/backoffice/metrics', undefined, billing.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(t.slug);
    expect(r.body).not.toContain(t.tenantId);
    expect(r.body).not.toMatch(/@|Olive|Owner/);
  });

  it('is for support, billing and super admins only', async () => {
    expect((await api('GET', '/v1/backoffice/metrics', undefined, rules.cookie)).statusCode).toBe(403);
    expect((await api('GET', '/v1/backoffice/metrics/global', undefined, rules.cookie)).statusCode).toBe(403);
    const owner = await signup(ctx);
    expect((await api('GET', '/v1/backoffice/metrics', undefined, owner.cookie)).statusCode).toBe(401);
  });
});

describe('companies in every region from the global directory only', () => {
  it('counts sign-ups per region and week, by plan and status, without personal data', async () => {
    type Global = {
      thisCell: string;
      regions: Array<{
        region: string;
        total: number;
        new7d: number;
        signups: Array<{ weekStart: string; count: number }>;
        byPlan: Array<{ key: string | null; count: number }>;
        appUrl: string;
      }>;
    };
    const get = async () =>
      (await api('GET', '/v1/backoffice/metrics/global', undefined, support.cookie)).json() as Global;
    const before = await get();
    // a workspace homed in the EU appears in the directory (its data stays in the EU cell)
    await ctx.directory.register({
      tenantId: crypto.randomUUID(),
      slug: `eu-fictional-${Math.random().toString(36).slice(2, 7)}`,
      homeRegion: 'eu',
      status: 'active',
      planRef: 'trial',
      verifiedDomains: [],
    });
    await signup(ctx);
    const after = await get();
    expect(after.thisCell).toBe('uk');
    expect(after.regions.map((r) => r.region)).toEqual(['uk', 'eu', 'us']);
    const delta = (region: string, k: 'total' | 'new7d') =>
      after.regions.find((r) => r.region === region)![k] -
      before.regions.find((r) => r.region === region)![k];
    expect(delta('eu', 'total')).toBe(1);
    expect(delta('eu', 'new7d')).toBe(1);
    expect(delta('uk', 'total')).toBe(1);
    expect(delta('us', 'total')).toBe(0);
    const eu = after.regions.find((r) => r.region === 'eu')!;
    expect(eu.signups).toHaveLength(12);
    expect(eu.appUrl).toBe('https://app.eu.thapsus-hr.test');
    expect(count(eu.byPlan, 'trial')).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(after)).not.toMatch(/eu-fictional|@/);
  });
});

describe('companies list: search, filters and a health signal', () => {
  type Row = {
    tenantId: string;
    slug: string;
    planId: string | null;
    createdAt: string;
    lastActivityAt: string | null;
    activeUsers7d: number | null;
    usage: { headcount: number; activeUsers: number } | null;
    health: { level: string; reasons: string[] };
  };
  const list = async (query: string) => {
    const r = await api('GET', `/v1/backoffice/tenants?${query}`, undefined, support.cookie);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Row[];
  };
  const ids = (rows: Row[]) => rows.map((r) => r.tenantId);

  it('filters this cell by plan, status, trial and health, sorts, and shows activity per row', async () => {
    const day = 86_400_000;
    const tag = `fc${Math.random().toString(36).slice(2, 6)}`;
    const ending = await signup(ctx, `${tag}-ending`);
    const paying = await signup(ctx, `${tag}-paying`);
    const overdue = await signup(ctx, `${tag}-overdue`);
    const gone = await signup(ctx, `${tag}-gone`);
    await setSubscription(ending.tenantId, {
      status: 'trialing',
      trialEndsAt: new Date(ctx.clock.now.getTime() + 3 * day).toISOString(),
    });
    await setSubscription(paying.tenantId, { status: 'active', amountMinor: 4500, planId: 'core' });
    await setSubscription(overdue.tenantId, { status: 'past_due', amountMinor: 4500, planId: 'core' });
    await setSubscription(gone.tenantId, { status: 'canceled' });

    const mine = await list(`q=${tag}`);
    expect(mine.map((r) => r.slug).sort()).toEqual(
      [`${tag}-ending`, `${tag}-gone`, `${tag}-overdue`, `${tag}-paying`].sort(),
    );
    const row = mine.find((r) => r.tenantId === paying.tenantId)!;
    expect(row).toMatchObject({ planId: 'core', activeUsers7d: 1, usage: { headcount: 0, activeUsers: 1 } });
    expect(row.lastActivityAt).toBeTruthy();
    expect(row.health).toEqual({ level: 'good', reasons: [] });
    expect(mine.find((r) => r.tenantId === ending.tenantId)!.health).toEqual({
      level: 'watch',
      reasons: ['trialEndingSoon'],
    });

    expect(ids(await list(`q=${tag}&trial=ending`))).toEqual([ending.tenantId]);
    expect(ids(await list(`q=${tag}&status=cancelled`))).toEqual([gone.tenantId]);
    expect(ids(await list(`q=${tag}&plan=core`)).sort()).toEqual([overdue.tenantId, paying.tenantId].sort());
    expect(ids(await list(`q=${tag}&health=risk`)).sort()).toEqual([gone.tenantId, overdue.tenantId].sort());
    // risk first, then watch, then good
    expect((await list(`q=${tag}&sort=health`)).map((r) => r.health.level)).toEqual([
      'risk',
      'risk',
      'watch',
      'good',
    ]);
    const byCreated = await list(`q=${tag}&sort=created`);
    expect(byCreated[0]!.tenantId).toBe(gone.tenantId); // newest first
    expect(
      (await api('GET', '/v1/backoffice/tenants?status=bogus', undefined, support.cookie)).statusCode,
    ).toBe(400);
  });

  it('filters every region by region and plan; rows in other regions link to their own back office', async () => {
    const tenantId = crypto.randomUUID();
    const slug = `us-fictional-${Math.random().toString(36).slice(2, 7)}`;
    await ctx.directory.register({
      tenantId,
      slug,
      homeRegion: 'us',
      status: 'active',
      planRef: 'plus',
      verifiedDomains: [],
    });
    const r = await api(
      'GET',
      `/v1/backoffice/tenants/all-regions?region=us&q=${slug}`,
      undefined,
      support.cookie,
    );
    expect(r.json()).toEqual([
      {
        tenantId,
        slug,
        region: 'us',
        status: 'active',
        planRef: 'plus',
        createdAt: expect.any(String),
        detailUrl: `https://app.us.thapsus-hr.test/backoffice/tenants/${tenantId}`,
      },
    ]);
    const none = await api(
      'GET',
      `/v1/backoffice/tenants/all-regions?region=eu&q=${slug}`,
      undefined,
      support.cookie,
    );
    expect(none.json()).toEqual([]);
    const plan = await api(
      'GET',
      `/v1/backoffice/tenants/all-regions?plan=core&q=${slug}`,
      undefined,
      support.cookie,
    );
    expect(plan.json()).toEqual([]);
  });
});

describe('platform performance (counts by route group, queues and database size)', () => {
  type Perf = {
    window: string;
    totals: { requests: number; errors5xx: number; p95Ms: number | null };
    series: Array<{ start: string; requests: number; errors5xx: number; p95Ms: number | null }>;
    routes: Array<{ group: string; requests: number; errors5xx: number; p50Ms: number | null }>;
    queues: Array<{ dbKey: string; jobsQueued: number; jobsDue: number; databaseBytes: number }>;
    worker: { beatAt: string | null };
  };
  const perf = async (window = '24h') => {
    const r = await api('GET', `/v1/backoffice/performance?window=${window}`, undefined, support.cookie);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Perf;
  };

  it('aggregates requests, server errors and latency per route group without any ids or paths', async () => {
    const before = await perf();
    const t = await signup(ctx);
    for (let i = 0; i < 3; i++) await api('GET', '/v1/me/summary', undefined, t.cookie);
    for (let i = 0; i < 2; i++)
      expect((await api('GET', '/v1/fictional-failure/boom', undefined, '')).statusCode).toBe(500);
    await api('GET', `/v1/employees/${crypto.randomUUID()}`, undefined, t.cookie);
    const after = await perf();
    expect(after.series).toHaveLength(24);
    expect(after.totals.requests - before.totals.requests).toBeGreaterThanOrEqual(7);
    expect(after.totals.errors5xx - before.totals.errors5xx).toBe(2);
    const group = (p: Perf, g: string) => p.routes.find((r) => r.group === g);
    expect(
      group(after, 'fictional-failure')!.errors5xx - (group(before, 'fictional-failure')?.errors5xx ?? 0),
    ).toBe(2);
    expect((group(after, 'me')?.requests ?? 0) - (group(before, 'me')?.requests ?? 0)).toBe(3);
    expect(group(after, 'me')!.p50Ms).not.toBeNull();
    expect(after.totals.p95Ms).not.toBeNull();
    expect(after.series.at(-1)!.requests).toBeGreaterThan(0);
    // no tenant ids, slugs, emails or concrete paths are stored or returned
    const body = JSON.stringify(after);
    expect(body).not.toContain(t.tenantId);
    expect(body).not.toContain(t.slug);
    expect(body).not.toMatch(/@|\/v1\//);
    const stored = await getPool(ctx.deps.backofficeDbUrl!).query<{ route_group: string }>(
      'SELECT DISTINCT route_group FROM platform.request_metrics',
    );
    for (const r of stored.rows) expect(r.route_group).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    const cols = await getPool(ctx.deps.backofficeDbUrl!).query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' ORDER BY 1`,
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain('tenant_id');
    expect((await perf('7d')).series).toHaveLength(7);
  });

  it('samples queue depth, oldest job age, failures and database size for every database of the cell', async () => {
    const t = await signup(ctx);
    await withTenant(ctx.deps.router, t.tenantId, (tx) =>
      enqueueJob(tx, 'fictional.perf_probe', `probe-${t.tenantId}`, {}),
    );
    // the job's run_after is the database's clock, so sample a moment later than that
    await sampleQueues(ctx.deps, new Date(Date.now() + 1000));
    const p = await perf();
    const shared = p.queues.find((q) => q.dbKey === 'shared')!;
    expect(shared.jobsQueued).toBeGreaterThanOrEqual(1);
    expect(shared.jobsDue).toBeGreaterThanOrEqual(1);
    expect(shared.databaseBytes).toBeGreaterThan(1_000_000);
    expect(p.queues.map((q) => q.dbKey).sort()).toEqual(['dedicated', 'shared']);
    expect(JSON.stringify(p.queues)).not.toContain(t.tenantId);
    // the snapshot function is for the application role only, and returns counts only
    const bo = getPool(ctx.deps.backofficeDbUrl!);
    await expect(bo.query('SELECT * FROM platform.queue_snapshot(now())')).rejects.toThrow(
      /permission denied/,
    );
    await purgeOldMetrics(ctx.deps, new Date(ctx.clock.now.getTime() + 40 * 86_400_000));
    expect((await perf()).queues).toEqual([]);
  });

  it('is for staff only', async () => {
    const owner = await signup(ctx);
    expect((await api('GET', '/v1/backoffice/performance', undefined, owner.cookie)).statusCode).toBe(401);
    expect((await api('GET', '/v1/backoffice/performance', undefined, rules.cookie)).statusCode).toBe(403);
  });
});
