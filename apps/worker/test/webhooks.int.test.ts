import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { verifyWebhookSignature } from '@thapsus/sdk';
import {
  closeDb,
  cookieFrom,
  ownerSession,
  PASSWORD,
  randomIp,
  startTestApp,
  totpCode,
  type TestContext,
} from '@thapsus/api/testing';
import { eventSubscribers, jobHandlers, periodic } from '@thapsus/api/worker';
import type { Deps } from '../../api/src/deps';
import { Engine, MemoryPublisher } from '../src/engine';

/**
 * Phase 9.2 — webhooks end to end through the real worker engine: outbox → subscriber → idempotent
 * delivery job per attempt → signed POST to a local receiver; retries with exponential backoff up to
 * the maximum; replay; secret rotation (two signatures); delivery log; SSRF refusal; feature flag.
 */
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let ctx: TestContext;
let strict: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let server: Server;
let base: string;
const received: Received[] = [];
const plan = new Map<string, number[]>(); // path → statuses to answer, in order (then 200)
let engine: Engine<Deps>;
let entityId: string;

const api = (method: string, url: string, payload?: unknown) =>
  ctx.app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    headers: { cookie: owner.cookie },
    remoteAddress: randomIp(),
  });
const tick = () => engine.processTenant(owner.tenantId);
const advance = async (seconds: number) => {
  ctx.clock.now = new Date(ctx.clock.now.getTime() + seconds * 1000);
  await tick();
};
const at = (path: string) => received.filter((r) => r.path === path);

/** Signs the owner in again after the test clock jumps past the session lifetime. */
async function relogin() {
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: owner.slug, email: owner.email, password: PASSWORD },
    remoteAddress: randomIp(),
  });
  owner.cookie = cookieFrom(login);
  const mfa = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/totp/verify',
    headers: { cookie: owner.cookie },
    payload: { code: totpCode(owner.totpSecret, ctx.clock.now) },
  });
  expect(mfa.statusCode, mfa.body).toBe(204);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      const statuses = plan.get(req.url!) ?? [];
      res.writeHead(statuses.length ? statuses.shift()! : 200, { 'content-type': 'text/plain' });
      res.end('receiver body that must never be stored');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // dev/test-only policy: a plain-http receiver on loopback (refused in production by depsFromEnv)
  ctx = await startTestApp({
    listen: false,
    overrides: { outbound: { allowHttp: true, allowPrivateNetworks: true } },
  });
  strict = await startTestApp({ listen: false });
  // The worker compares run_after with the test clock; jobs enqueued at database time must be due.
  ctx.clock.now = new Date(Date.now() + 120_000);
  owner = await ownerSession(ctx);
  engine = new Engine({
    router: ctx.deps.router,
    deps: ctx.deps,
    handlers: jobHandlers,
    subscribers: eventSubscribers,
    periodic,
    publisher: new MemoryPublisher(),
    now: () => ctx.clock.now,
  });
  const e = await api('POST', '/v1/org/legal-entities', {
    name: 'Fictional Hooks Ltd',
    country: 'GB',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  entityId = e.json().id;
});
afterAll(async () => {
  server.close();
  await ctx.close();
  await strict.close();
  await closeDb();
});

async function hire(last = 'Hookworth') {
  const res = await api('POST', '/v1/employees', {
    startDate: '2026-02-02',
    legalFirstName: 'Fictional',
    legalLastName: last,
    entityId,
    jobTitle: 'Analyst',
    payAmountMinor: 3_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

describe('webhook deliveries', () => {
  it('are signed, driven by the outbox, retried with backoff, logged and replayable', async () => {
    plan.set('/hooks/a', [500, 503]);
    const created = await api('POST', '/v1/webhooks', {
      url: `${base}/hooks/a`,
      eventTypes: ['employee.*'],
      description: 'HRIS sync',
    });
    expect(created.statusCode, created.body).toBe(201);
    const ep = created.json();
    expect(ep.secret).toMatch(/^whsec_/);
    expect((await api('GET', '/v1/webhooks')).body).not.toContain(ep.secret);

    const employeeId = await hire();
    await tick(); // outbox → subscriber → job → attempt 1 (500)
    expect(at('/hooks/a')).toHaveLength(1);
    let log = (await api('GET', `/v1/webhooks/${ep.id}/deliveries`)).json();
    expect(log.data).toHaveLength(1);
    expect(log.data[0]).toMatchObject({
      eventType: 'employee.created',
      status: 'retrying',
      attempts: 1,
      lastResponseStatus: 500,
    });

    await tick(); // not due yet (30 s backoff)
    expect(at('/hooks/a')).toHaveLength(1);
    await advance(31); // attempt 2 (503), next in 60 s
    expect(at('/hooks/a')).toHaveLength(2);
    await advance(30);
    expect(at('/hooks/a')).toHaveLength(2);
    await advance(31); // attempt 3 (200)
    expect(at('/hooks/a')).toHaveLength(3);

    log = (await api('GET', `/v1/webhooks/${ep.id}/deliveries`)).json();
    expect(log.data[0]).toMatchObject({
      status: 'succeeded',
      attempts: 3,
      lastResponseStatus: 200,
      nextAttemptAt: null,
    });
    const detail = (await api('GET', `/v1/webhooks/deliveries/${log.data[0].id}`)).json();
    expect(detail.attemptLog.map((a: { responseStatus: number }) => a.responseStatus)).toEqual([
      500, 503, 200,
    ]);
    expect(detail.attemptLog.every((a: { durationMs: number }) => a.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('receiver body');

    // every attempt: same event, valid signature (reference SDK verifier), no personal data in the payload
    const deliveries = at('/hooks/a');
    for (const r of deliveries) {
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['thapsus-event-type']).toBe('employee.created');
      expect(r.headers['thapsus-event-id']).toBe(deliveries[0]!.headers['thapsus-event-id']);
      const ts = Number(/t=(\d+)/.exec(String(r.headers['thapsus-signature']))![1]);
      expect(
        verifyWebhookSignature({
          payload: r.body,
          header: String(r.headers['thapsus-signature']),
          secrets: [ep.secret],
          now: ts,
        }),
      ).toBe(true);
      expect(
        verifyWebhookSignature({
          payload: r.body,
          header: String(r.headers['thapsus-signature']),
          secrets: ['whsec_wrong'],
          now: ts,
        }),
      ).toBe(false);
    }
    const payload = JSON.parse(deliveries[0]!.body);
    expect(payload).toMatchObject({ type: 'employee.created', data: { employeeId } });
    expect(deliveries[0]!.body).not.toContain('Hookworth');
    expect(deliveries.map((d) => d.headers['thapsus-delivery-attempt'])).toEqual(['1', '2', '3']);

    // replay: a new delivery of the same event, signed again
    const replay = await api('POST', `/v1/webhooks/deliveries/${log.data[0].id}/replay`);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ replayOf: log.data[0].id, eventId: payload.id, status: 'pending' });
    await tick();
    const replayed = at('/hooks/a').at(-1)!;
    expect(at('/hooks/a')).toHaveLength(4);
    expect(replayed.headers['thapsus-event-id']).toBe(payload.id);
    expect(replayed.body).toBe(deliveries[0]!.body);
    // the original delivery is never re-sent by the outbox (exactly one delivery per endpoint and event)
    await tick();
    expect(at('/hooks/a')).toHaveLength(4);
  });

  it('give up after the maximum number of attempts', async () => {
    plan.set('/hooks/down', Array(20).fill(500));
    const ep = (
      await api('POST', '/v1/webhooks', { url: `${base}/hooks/down`, eventTypes: ['employee.created'] })
    ).json();
    await hire('Downley');
    await tick();
    for (let i = 0; i < 12; i++) await advance(6 * 3600);
    await relogin();
    const log = (await api('GET', `/v1/webhooks/${ep.id}/deliveries`)).json();
    expect(log.data[0]).toMatchObject({ status: 'failed', attempts: 8, nextAttemptAt: null });
    expect(at('/hooks/down')).toHaveLength(8);
    await api('PATCH', `/v1/webhooks/${ep.id}`, { status: 'disabled' });
  });

  it('sign with both secrets while a rotation is in its grace period, then only the new one', async () => {
    const ep = (
      await api('POST', '/v1/webhooks', { url: `${base}/hooks/rotate`, eventTypes: ['webhook.ping'] })
    ).json();
    const rotated = (await api('POST', `/v1/webhooks/${ep.id}/rotate-secret`, { graceHours: 24 })).json();
    expect(rotated.secret).not.toBe(ep.secret);
    expect(rotated.secrets).toHaveLength(2);
    expect((await api('POST', `/v1/webhooks/${ep.id}/ping`)).statusCode).toBe(202);
    await tick();
    const first = at('/hooks/rotate').at(-1)!;
    const header = String(first.headers['thapsus-signature']);
    const ts = Number(/t=(\d+)/.exec(header)![1]);
    expect(header.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    expect(JSON.parse(first.body).type).toBe('webhook.ping');
    for (const s of [ep.secret, rotated.secret])
      expect(verifyWebhookSignature({ payload: first.body, header, secrets: [s], now: ts })).toBe(true);

    ctx.clock.advanceMinutes(25 * 60);
    await relogin();
    expect((await api('POST', `/v1/webhooks/${ep.id}/ping`)).statusCode).toBe(202);
    await tick();
    const later = at('/hooks/rotate').at(-1)!;
    const h2 = String(later.headers['thapsus-signature']);
    expect(h2.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(1);
    const ts2 = Number(/t=(\d+)/.exec(h2)![1]);
    expect(
      verifyWebhookSignature({ payload: later.body, header: h2, secrets: [rotated.secret], now: ts2 }),
    ).toBe(true);
    expect(verifyWebhookSignature({ payload: later.body, header: h2, secrets: [ep.secret], now: ts2 })).toBe(
      false,
    );
  });

  it('are not created while the webhooks feature is off', async () => {
    const ep = (
      await api('POST', '/v1/webhooks', { url: `${base}/hooks/flag`, eventTypes: ['employee.created'] })
    ).json();
    expect((await api('PUT', '/v1/settings/features/webhooks', { enabled: false })).statusCode).toBe(200);
    await hire('Flagless');
    await tick();
    expect(at('/hooks/flag')).toHaveLength(0);
    expect((await api('GET', `/v1/webhooks/${ep.id}/deliveries`)).statusCode).toBe(403);
    await api('PUT', '/v1/settings/features/webhooks', { enabled: true });
    const count = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.webhook_deliveries WHERE endpoint_id = $1', [
        ep.id,
      ]),
    );
    expect(count.n).toBe(0);
  });
});

describe('SSRF protection', () => {
  it('refuses private, loopback, metadata and non-https destinations under the production policy', async () => {
    const o = await ownerSession(strict);
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://10.0.0.8/x',
      'https://localhost/x',
      'https://user:pw@hooks.example.com/x',
    ]) {
      const res = await strict.app.inject({
        method: 'POST',
        url: '/v1/webhooks',
        headers: { cookie: o.cookie },
        payload: { url, eventTypes: ['employee.created'] },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().detail).toBe('unsafeUrl');
    }
    const ok = await strict.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { cookie: o.cookie },
      payload: { url: 'https://hooks.example.com/thapsus', eventTypes: ['employee.created'] },
    });
    expect(ok.statusCode).toBe(201);
    const unknown = await strict.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { cookie: o.cookie },
      payload: { url: 'https://hooks.example.com/x', eventTypes: ['tenant.created'] },
    });
    expect(unknown.statusCode).toBe(400);
  });
});
