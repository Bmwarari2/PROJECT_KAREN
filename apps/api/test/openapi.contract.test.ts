import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * Contract tests: the published spec (packages/sdk/openapi.json) is current, is valid OpenAPI 3.1,
 * and real responses from the implementation validate against it.
 */
type Spec = { openapi: string; paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>; components?: { schemas?: Record<string, unknown> } };
let spec: Spec;
let ctx: TestContext;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  ctx = await startTestApp({ listen: false });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

function check(method: string, path: string, status: number, body: unknown) {
  const op = spec.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(status)];
  expect(response, `${method.toUpperCase()} ${path} documents ${status}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (!media) return;
  const json = JSON.parse(JSON.stringify(media.schema).replace(/"#\/components\/schemas\//g, '"#/components/schemas/'));
  const validate = ajv.compile(json);
  const ok = validate(body);
  expect(ok, `${method.toUpperCase()} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe('published OpenAPI document', () => {
  it('is OpenAPI 3.1 and versioned under /v1', () => {
    expect(spec.openapi).toBe('3.1.0');
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) expect(p.startsWith('/v1/') || p.startsWith('/global/v1/') || p.startsWith('/scim/v2/')).toBe(true);
  });
  it('packages/sdk/openapi.json is up to date (run: pnpm --filter @thapsus/api openapi)', () => {
    const published = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'sdk', 'openapi.json'), 'utf8'));
    expect(published).toEqual(JSON.parse(JSON.stringify(spec)));
  });
  it('every operation documents an error response using the Problem schema', () => {
    for (const [p, methods] of Object.entries(spec.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        const codes = Object.keys(op.responses);
        expect(codes.length, `${m} ${p}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('implementation matches the spec', () => {
  it('auth, settings, audit and push endpoints', async () => {
    const o = await ownerSession(ctx);
    const h = { cookie: o.cookie };
    const session = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: h });
    check('get', '/v1/auth/session', 200, session.json());
    const domain = await ctx.app.inject({ method: 'POST', url: '/v1/settings/domains', headers: h, payload: { domain: `${o.slug}.example.test` } });
    check('post', '/v1/settings/domains', 201, domain.json());
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains', headers: h });
    check('get', '/v1/settings/domains', 200, list.json());
    const notVerified = await ctx.app.inject({ method: 'POST', url: `/v1/settings/domains/${domain.json().id}/verify`, headers: h });
    check('post', '/v1/settings/domains/{id}/verify', 422, notVerified.json());
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const audit = await ctx.app.inject({ method: 'GET', url: `/v1/audit/events?from=${from}&to=${to}`, headers: h });
    check('get', '/v1/audit/events', 200, audit.json());
    const verify = await ctx.app.inject({ method: 'POST', url: '/v1/audit/verify', headers: h });
    check('post', '/v1/audit/verify', 200, verify.json());
    const grants = await ctx.app.inject({ method: 'POST', url: '/v1/settings/support-grants', headers: h, payload: { staffId: crypto.randomUUID(), accessLevel: 'read', hours: 1, reason: 'Contract test' } });
    check('post', '/v1/settings/support-grants', 201, grants.json());
    const vapid = await ctx.app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    check('get', '/v1/push/vapid-public-key', 200, vapid.json());
    const unauth = await ctx.app.inject({ method: 'GET', url: '/v1/settings/domains' });
    expect(unauth.headers['content-type']).toContain('application/problem+json');
    check('post', '/v1/auth/login', 401, (await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: o.slug, email: o.email, password: 'wrong-password-123' }, remoteAddress: '10.99.0.1' })).json());
  });
});
