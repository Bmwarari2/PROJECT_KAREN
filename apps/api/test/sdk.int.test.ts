import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createThapsusClient, getClientCredentialsToken, paginate } from '@thapsus/sdk';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * Phase 9.1 — the generated TypeScript SDK (packages/sdk, openapi-fetch over the published spec) works
 * against a running API with a scoped API key and with an OAuth 2.0 client-credentials token.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let entityId: string;

beforeAll(async () => {
  ctx = await startTestApp({ listen: true });
  owner = await ownerSession(ctx);
  const e = await ctx.app.inject({ method: 'POST', url: '/v1/org/legal-entities', headers: { cookie: owner.cookie }, payload: { name: 'Fictional SDK Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' } });
  entityId = e.json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('TypeScript SDK', () => {
  it('reads and writes with a scoped API key, paginates, and sends idempotency keys', async () => {
    const key = (await ctx.app.inject({ method: 'POST', url: '/v1/settings/api-keys', headers: { cookie: owner.cookie }, payload: { name: 'SDK', scopes: ['employees:write', 'org:write'], roleKey: 'hr_admin' } })).json().key as string;
    let n = 0;
    const client = createThapsusClient({ baseUrl: ctx.base, token: key, idempotencyKey: () => `sdk-test-${++n}` });

    for (const last of ['Alderwick', 'Brackenford', 'Cindersby']) {
      const { data, error, response } = await client.POST('/v1/employees', {
        body: { startDate: '2026-03-02', legalFirstName: 'Fictional', legalLastName: last, entityId, jobTitle: 'Analyst', payAmountMinor: 3_000_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent' },
      });
      expect(error, JSON.stringify(error)).toBeUndefined();
      expect(response.status).toBe(201);
      expect(data!.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const names: string[] = [];
    for await (const e of paginate((cursor) => client.GET('/v1/employees', { params: { query: { limit: 2, cursor } } }))) names.push(e.displayName ?? '');
    expect(names).toEqual(expect.arrayContaining(['Fictional Alderwick', 'Fictional Brackenford', 'Fictional Cindersby']));

    // the SDK's idempotency key makes a retried create safe
    const retry = createThapsusClient({ baseUrl: ctx.base, token: key, idempotencyKey: () => 'sdk-fixed-key' });
    const a = await retry.POST('/v1/org/departments', { body: { name: 'Fictional SDK Dept' } });
    const b = await retry.POST('/v1/org/departments', { body: { name: 'Fictional SDK Dept' } });
    expect(b.data).toEqual(a.data);
    expect(b.response.headers.get('idempotent-replayed')).toBe('true');
    expect(a.response.headers.get('cache-control')).toBe('private, no-store');

    // typed problem responses
    const denied = await client.GET('/v1/settings/domains');
    expect(denied.response.status).toBe(403);
  });

  it('gets an OAuth 2.0 client-credentials token and calls the API with it', async () => {
    const c = (await ctx.app.inject({ method: 'POST', url: '/v1/settings/oauth-clients', headers: { cookie: owner.cookie }, payload: { name: 'SDK OAuth', scopes: ['employees:read'], roleKey: 'hr_admin' } })).json();
    const token = await getClientCredentialsToken({ baseUrl: ctx.base, clientId: c.clientId, clientSecret: c.clientSecret, scope: ['employees:read'] });
    expect(token).toMatchObject({ token_type: 'Bearer', scope: 'employees:read' });
    const client = createThapsusClient({ baseUrl: ctx.base, token: token.access_token });
    const { data, response } = await client.GET('/v1/employees', { params: { query: { limit: 50 } } });
    expect(response.status).toBe(200);
    expect(data!.data.length).toBeGreaterThanOrEqual(3);
    expect(response.headers.get('ratelimit-limit')).toBe('600');
    await expect(getClientCredentialsToken({ baseUrl: ctx.base, clientId: c.clientId, clientSecret: 'thr_cs_wrong' })).rejects.toThrow('invalid_client');
  });
});
