import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, writeAudit } from '@thapsus/db';
import { verifyWebhookSignature } from '@thapsus/sdk';
import { closeDb, cookieFrom, ownerSession, PASSWORD, randomIp, startTestApp, totpCode, type TestContext } from '@thapsus/api/testing';
import { eventSubscribers, jobHandlers, periodic } from '@thapsus/api/worker';
import { AwsCrossAccountS3 } from '../../api/src/modules/platform/siem-s3';
import type { Deps } from '../../api/src/deps';
import { Engine, MemoryPublisher } from '../src/engine';

/**
 * Phase 9.3 — audit log streaming to a customer SIEM through the real worker engine: incremental cursor
 * over sealed audit rows, filters, idempotent batches (a retry resends the same range with the same
 * batch id / S3 key), signed HTTPS delivery and S3 delivery via a cross-account role (STS + S3 clients
 * from the residency-guarded factory, pointed at a local mock), and a delivery log.
 */
interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let engine: Engine<Deps>;
let siem: Server;
let aws: Server;
let siemUrl: string;
const siemHits: Hit[] = [];
const awsHits: Hit[] = [];
const siemPlan: number[] = [];
const s3Plan: number[] = [];

function listen(s: Server) {
  return new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}
const collect = (sink: Hit[], respond: (h: Hit, res: import('node:http').ServerResponse) => void) =>
  createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const h = { method: req.method!, path: req.url!, headers: req.headers, body };
      sink.push(h);
      respond(h, res);
    });
  });

const api = (method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie: owner.cookie }, remoteAddress: randomIp() });
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);
const nextMinute = async () => {
  ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
  await engine.processTenant(owner.tenantId);
};
async function relogin() {
  const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email: owner.email, password: PASSWORD }, remoteAddress: randomIp() });
  owner.cookie = cookieFrom(login);
  await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie: owner.cookie }, payload: { code: totpCode(owner.totpSecret, ctx.clock.now) } });
}

beforeAll(async () => {
  siem = collect(siemHits, (_h, res) => {
    res.writeHead(siemPlan.length ? siemPlan.shift()! : 202);
    res.end();
  });
  // Minimal STS (AssumeRole, AWS query protocol) + S3 (path-style PutObject) emulator.
  aws = collect(awsHits, (h, res) => {
    if (h.method === 'POST' && h.body.includes('Action=AssumeRole')) {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIAFICTIONAL0000001</AccessKeyId><SecretAccessKey>fictional-secret</SecretAccessKey><SessionToken>fictional-session</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>AROAFICTIONAL:thapsus</AssumedRoleId><Arn>arn:aws:sts::123456789012:assumed-role/ThapsusAudit/thapsus</Arn></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></AssumeRoleResponse>`);
      return;
    }
    if (h.method === 'PUT') {
      const status = s3Plan.length ? s3Plan.shift()! : 200;
      res.writeHead(status, status === 200 ? { etag: '"fictional"' } : { 'content-type': 'application/xml' });
      res.end(status === 200 ? '' : '<Error><Code>InternalError</Code><Message>try again</Message></Error>');
      return;
    }
    res.writeHead(400);
    res.end();
  });
  siemUrl = await listen(siem);
  const awsUrl = await listen(aws);
  // The STS client in a cell uses the task role; tests use fictional static credentials.
  process.env.AWS_ACCESS_KEY_ID ??= 'AKIAFICTIONAL0000000';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'fictional-test-secret';
  ctx = await startTestApp({ listen: false, overrides: { outbound: { allowHttp: true, allowPrivateNetworks: true }, siemS3: new AwsCrossAccountS3('uk', { s3: awsUrl, sts: awsUrl }) } });
  ctx.clock.now = new Date(Date.now() + 120_000);
  owner = await ownerSession(ctx);
  engine = new Engine({ router: ctx.deps.router, deps: ctx.deps, handlers: jobHandlers, subscribers: eventSubscribers, periodic, publisher: new MemoryPublisher(), now: () => ctx.clock.now });
});
afterAll(async () => {
  siem.close();
  aws.close();
  await ctx.close();
  await closeDb();
});

describe('HTTPS SIEM stream', () => {
  it('delivers new sealed events matching the filters in signed, idempotent batches and advances the cursor', async () => {
    const created = await api('POST', '/v1/settings/audit-streams', { name: 'Fictional SIEM', kind: 'https', url: `${siemUrl}/ingest`, filters: { actions: ['org.', 'domain.'] } });
    expect(created.statusCode, created.body).toBe(201);
    const stream = created.json();
    expect(stream.secret).toMatch(/^whsec_/);
    const startCursor = BigInt(stream.cursorSeq);
    expect(startCursor).toBeGreaterThan(0n); // "now": history before the stream is not back-filled

    await api('POST', '/v1/org/departments', { name: 'Fictional Audit Dept' });
    await api('POST', '/v1/settings/domains', { domain: `siem.${owner.slug}.example.test` });
    await api('PATCH', '/v1/me/preferences', { locale: 'en-US' }); // not matched by the filter
    await nextMinute();
    expect(siemHits).toHaveLength(1);
    const first = siemHits[0]!;
    const batch = JSON.parse(first.body);
    const ts = Number(/t=(\d+)/.exec(String(first.headers['thapsus-signature']))![1]);
    expect(verifyWebhookSignature({ payload: first.body, header: String(first.headers['thapsus-signature']), secrets: [stream.secret], now: ts })).toBe(true);
    expect(first.headers['thapsus-batch-id']).toBe(batch.batchId);
    expect(batch.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['org.departments.created', 'domain.added']));
    expect(batch.events.every((e: { action: string; hash: string; seq: string }) => /^(org|domain)\./.test(e.action) && /^[0-9a-f]{64}$/.test(e.hash) && BigInt(e.seq) > startCursor)).toBe(true);
    expect(batch.events.length).toBeGreaterThanOrEqual(2);

    const after = (await api('GET', '/v1/settings/audit-streams')).json().data[0];
    expect(BigInt(after.cursorSeq)).toBeGreaterThanOrEqual(BigInt(batch.toSeq));
    expect(after.lastDeliveredAt).not.toBeNull();

    // nothing new → nothing sent
    await nextMinute();
    const otherEvents = siemHits.filter((h) => JSON.parse(h.body).events.some((e: { action: string }) => !/^(org|domain)\./.test(e.action)));
    expect(otherEvents).toHaveLength(0);

    // a failed batch is retried with the SAME batch id and range; later events go in the next batch
    siemPlan.push(500);
    await api('POST', '/v1/org/departments', { name: 'Fictional Retry Dept' });
    await nextMinute();
    const failed = siemHits.at(-1)!;
    let log = (await api('GET', `/v1/settings/audit-streams/${stream.id}/batches`)).json().data;
    expect(log[0]).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 500 });
    await nextMinute();
    const retried = siemHits.at(-1)!;
    expect(retried.headers['thapsus-batch-id']).toBe(failed.headers['thapsus-batch-id']);
    expect(JSON.parse(retried.body).fromSeq).toBe(JSON.parse(failed.body).fromSeq);
    expect(JSON.parse(retried.body).toSeq).toBe(JSON.parse(failed.body).toSeq);
    log = (await api('GET', `/v1/settings/audit-streams/${stream.id}/batches`)).json().data;
    expect(log[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    await relogin();
  });

  it('streams sensitive-only and actor-type filtered views, without sensitive values', async () => {
    const stream = (await api('POST', '/v1/settings/audit-streams', { name: 'Sensitive only', kind: 'https', url: `${siemUrl}/sensitive`, filters: { sensitiveOnly: true } })).json();
    await tx((t) => writeAudit(t, { actorType: 'user', actorId: owner.userId, action: 'vault.read', targetType: 'employee', targetId: 'fictional', diff: { category: 'health', value: 'never streamed' }, sensitive: true }));
    await api('POST', '/v1/org/departments', { name: 'Not sensitive' });
    await nextMinute();
    const hit = siemHits.filter((h) => h.path === '/sensitive').at(-1)!;
    const events = JSON.parse(hit.body).events as Array<{ action: string; diff: unknown; sensitive: boolean }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.sensitive && e.diff === null)).toBe(true);
    expect(hit.body).not.toContain('never streamed');
    await api('PATCH', `/v1/settings/audit-streams/${stream.id}`, { status: 'paused' });
  });
});

describe('S3 SIEM stream (cross-account role, home region only)', () => {
  it('writes NDJSON objects with deterministic keys through STS AssumeRole with the external id', async () => {
    const bad = await api('POST', '/v1/settings/audit-streams', { name: 'Wrong region', kind: 's3', bucket: 'fictional-audit', region: 'eu-central-1', roleArn: 'arn:aws:iam::123456789012:role/ThapsusAudit' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ detail: 'regionNotAllowed', allowed: ['eu-west-2'] });

    const res = await api('POST', '/v1/settings/audit-streams', { name: 'Customer bucket', kind: 's3', bucket: 'fictional-audit', prefix: 'thapsus/', roleArn: 'arn:aws:iam::123456789012:role/ThapsusAudit', filters: { actions: ['org.'] } });
    expect(res.statusCode, res.body).toBe(201);
    const stream = res.json();
    expect(stream.s3).toMatchObject({ bucket: 'fictional-audit', region: 'eu-west-2', prefix: 'thapsus/' });
    expect(stream.s3.externalId).toMatch(/^thapsus-/);
    expect(stream.secret).toBeNull();

    s3Plan.push(500, 500, 500, 500); // the SDK retries; make the first sync fail
    await api('POST', '/v1/org/departments', { name: 'Fictional S3 Dept' });
    await nextMinute();
    let log = (await api('GET', `/v1/settings/audit-streams/${stream.id}/batches`)).json().data;
    expect(log[0].status).toBe('failed');
    const key = log[0].objectKey as string;
    expect(key).toMatch(/^thapsus\/\d{4}\/\d{2}\/\d{2}\/\d{12}-\d{12}\.ndjson$/);
    s3Plan.length = 0;
    await nextMinute();
    log = (await api('GET', `/v1/settings/audit-streams/${stream.id}/batches`)).json().data;
    expect(log[0]).toMatchObject({ status: 'delivered', objectKey: key });

    const assume = awsHits.filter((h) => h.body.includes('Action=AssumeRole')).at(-1)!;
    const form = new URLSearchParams(assume.body);
    expect(form.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/ThapsusAudit');
    expect(form.get('ExternalId')).toBe(stream.s3.externalId);
    const puts = awsHits.filter((h) => h.method === 'PUT');
    expect(new Set(puts.map((p) => p.path.split('?')[0]))).toEqual(new Set([`/fictional-audit/${key}`])); // retries reuse the key
    const lines = puts.at(-1)!.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l: { action: string; hash: string }) => l.action.startsWith('org.') && /^[0-9a-f]{64}$/.test(l.hash))).toBe(true);
    expect(puts.at(-1)!.headers['x-amz-security-token']).toBe('fictional-session');
  });

  it('stops when the feature is off', async () => {
    await api('PUT', '/v1/settings/features/auditStreaming', { enabled: false });
    expect((await api('GET', '/v1/settings/audit-streams')).statusCode).toBe(403);
    const before = siemHits.length + awsHits.length;
    await api('POST', '/v1/org/departments', { name: 'Flag off dept' });
    await nextMinute();
    expect(siemHits.length + awsHits.length).toBe(before);
    await api('PUT', '/v1/settings/features/auditStreaming', { enabled: null });
  });
});
