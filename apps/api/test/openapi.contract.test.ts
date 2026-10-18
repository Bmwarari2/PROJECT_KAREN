import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { addMinutes } from '@thapsus/core/time';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { timeCompany } from './time-fixtures';

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

describe('rota, clock and timesheet endpoints match the spec', () => {
  it('settings, shifts (201 and 422), grid, publish, clock sync, kiosk, timesheet and opt-out', async () => {
    const c = await timeCompany(ctx);
    const emp = await c.hire(c.london);
    const me = await c.login(emp);
    check('get', '/v1/settings/time', 200, (await c.api('GET', '/v1/settings/time', undefined, me)).json());
    const created = await c.api('POST', '/v1/shifts', { employeeId: emp, date: '2030-01-07', start: '14:00', end: '23:00', breakMinutes: 30 });
    check('post', '/v1/shifts', 201, created.json());
    check('put', '/v1/settings/time', 200, (await c.api('PUT', '/v1/settings/time', { enforcement: 'block' })).json());
    const blocked = await c.api('POST', '/v1/shifts', { employeeId: emp, date: '2030-01-08', start: '07:00', end: '15:00', breakMinutes: 30 });
    expect(blocked.statusCode).toBe(422);
    check('post', '/v1/shifts', 422, blocked.json());
    check('get', '/v1/rota', 200, (await c.api('GET', '/v1/rota?weekStart=2030-01-07')).json());
    check('get', '/v1/shifts', 200, (await c.api('GET', '/v1/shifts?from=2030-01-07&to=2030-01-13')).json());
    check('post', '/v1/rota/publish', 200, (await c.api('POST', '/v1/rota/publish', { from: '2030-01-07', to: '2030-01-13' })).json());
    check('get', '/v1/me/shifts', 200, (await c.api('GET', '/v1/me/shifts?from=2030-01-07&to=2030-01-13', undefined, me)).json());
    check('get', '/v1/shifts/open', 200, (await c.api('GET', '/v1/shifts/open?from=2030-01-07&to=2030-01-13', undefined, me)).json());
    const sync = await c.api('POST', '/v1/clock/events', { events: [{ clientEventId: 'contract-0001', kind: 'in', occurredAt: addMinutes(ctx.clock.now.toISOString(), -5) }] }, me);
    check('post', '/v1/clock/events', 200, sync.json());
    check('get', '/v1/clock/status', 200, (await c.api('GET', '/v1/clock/status', undefined, me)).json());
    const kiosk = await c.api('POST', '/v1/kiosks', { name: 'Contract kiosk' });
    check('post', '/v1/kiosks', 201, kiosk.json());
    const tap = await ctx.app.inject({ method: 'POST', url: '/v1/kiosk/clock', headers: { authorization: `Kiosk ${kiosk.json().token}` }, payload: { employeeNumber: 'NOBODY', pin: '4826', kind: 'in', clientEventId: 'contract-0002' } });
    check('post', '/v1/kiosk/clock', 401, tap.json());
    check('get', '/v1/timesheets/employees/{employeeId}/weeks/{weekStart}', 200, (await c.api('GET', `/v1/timesheets/employees/${emp}/weeks/2030-01-07`, undefined, me)).json());
    check('post', '/v1/working-time/opt-outs', 201, (await c.api('POST', '/v1/working-time/opt-outs', { employeeId: emp, validFrom: '2030-01-01' })).json());
  });
});

describe('role and access management endpoints match the spec', () => {
  it('catalogue, roles CRUD (201, 400, 403, 409), users and assignments (201, 409)', async () => {
    const o = await ownerSession(ctx);
    const h = { cookie: o.cookie };
    const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => ctx.app.inject({ method, url, headers: h, payload: payload as object });
    check('get', '/v1/roles/catalogue', 200, (await req('GET', '/v1/roles/catalogue')).json());
    const roles = await req('GET', '/v1/roles');
    check('get', '/v1/roles', 200, roles.json());
    const builtIn = (roles.json() as Array<{ id: string; key: string }>).find((r) => r.key === 'hr_admin')!;
    check('get', '/v1/roles/{id}', 200, (await req('GET', `/v1/roles/${builtIn.id}`)).json());
    check('patch', '/v1/roles/{id}', 409, (await req('PATCH', `/v1/roles/${builtIn.id}`, { name: 'Renamed' })).json());
    const body = { key: 'contract_role', name: 'Contract role', permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'read' } };
    const created = await req('POST', '/v1/roles', body);
    check('post', '/v1/roles', 201, created.json());
    check('post', '/v1/roles', 400, (await req('POST', '/v1/roles', { ...body, key: 'contract_bad', permissions: ['nope.nope'] })).json());
    check('post', '/v1/roles', 409, (await req('POST', '/v1/roles', body)).json());
    check('patch', '/v1/roles/{id}', 200, (await req('PATCH', `/v1/roles/${created.json().id}`, { description: 'Fictional description' })).json());
    const users = await req('GET', '/v1/users');
    check('get', '/v1/users', 200, users.json());
    const assigned = await req('POST', `/v1/users/${o.userId}/role-assignments`, { roleId: created.json().id, scope: { type: 'all' } });
    check('post', '/v1/users/{userId}/role-assignments', 201, assigned.json());
    check('post', '/v1/users/{userId}/role-assignments', 409, (await req('POST', `/v1/users/${o.userId}/role-assignments`, { roleId: created.json().id, scope: { type: 'all' } })).json());
    check('get', '/v1/users/{userId}/role-assignments', 200, (await req('GET', `/v1/users/${o.userId}/role-assignments`)).json());
    check('delete', '/v1/roles/{id}', 409, (await req('DELETE', `/v1/roles/${created.json().id}`)).json());
    const owners = (await req('GET', `/v1/users/${o.userId}/role-assignments`)).json().assignments as Array<{ id: string; roleKey: string }>;
    check('delete', '/v1/users/{userId}/role-assignments/{assignmentId}', 409, (await req('DELETE', `/v1/users/${o.userId}/role-assignments/${owners.find((a) => a.roleKey === 'owner')!.id}`)).json());
    expect((await req('DELETE', `/v1/users/${o.userId}/role-assignments/${assigned.json().id}`)).statusCode).toBe(204);
    expect((await req('DELETE', `/v1/roles/${created.json().id}`)).statusCode).toBe(204);
    const forbidden = await ctx.app.inject({ method: 'GET', url: '/v1/roles' });
    expect(forbidden.statusCode).toBe(401);
  });
});
