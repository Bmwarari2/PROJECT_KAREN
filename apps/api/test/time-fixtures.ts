import { expect } from 'vitest';
import { withTenant, type Tx } from '@thapsus/db';
import { cookieFrom, ownerSession, PASSWORD, randomIp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';

/** A fictional company with sites in England, California, Spain and Germany. All data is invented. */
export async function timeCompany(ctx: TestContext) {
  const owner = await ownerSession(ctx);
  const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) => ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie }, remoteAddress: randomIp() });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(ctx.deps.router, owner.tenantId, fn);
  const post = async (url: string, body: unknown) => {
    const r = await api('POST', url, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const gbEntity = await post('/v1/org/legal-entities', { name: 'Fictional Rota UK Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });
  const usEntity = await post('/v1/org/legal-entities', { name: 'Fictional Rota US Inc', country: 'US', regionCode: 'US-CA', currency: 'USD', timeZone: 'America/Los_Angeles' });
  const esEntity = await post('/v1/org/legal-entities', { name: 'Fictional Rota España SL', country: 'ES', regionCode: 'ES-MD', currency: 'EUR', timeZone: 'Europe/Madrid' });
  const deEntity = await post('/v1/org/legal-entities', { name: 'Fictional Rota GmbH', country: 'DE', regionCode: 'DE-BE', currency: 'EUR', timeZone: 'Europe/Berlin' });
  const london = await post('/v1/org/locations', { name: 'Fictional Store London', country: 'GB', regionCode: 'GB-ENG', timeZone: 'Europe/London', entityId: gbEntity, geofence: { lat: 51.5, lng: -0.12, radiusMetres: 200 } });
  const leeds = await post('/v1/org/locations', { name: 'Fictional Store Leeds', country: 'GB', regionCode: 'GB-ENG', timeZone: 'Europe/London', entityId: gbEntity });
  const sanJose = await post('/v1/org/locations', { name: 'Fictional Store San Jose', country: 'US', regionCode: 'US-CA', timeZone: 'America/Los_Angeles', entityId: usEntity });
  const madrid = await post('/v1/org/locations', { name: 'Fictional Tienda Madrid', country: 'ES', regionCode: 'ES-MD', timeZone: 'Europe/Madrid', entityId: esEntity });
  const berlin = await post('/v1/org/locations', { name: 'Fictional Laden Berlin', country: 'DE', regionCode: 'DE-BE', timeZone: 'Europe/Berlin', entityId: deEntity, geofence: { lat: 52.52, lng: 13.405, radiusMetres: 200 } });
  const entityFor: Record<string, string> = { [london]: gbEntity, [leeds]: gbEntity, [sanJose]: usEntity, [madrid]: esEntity, [berlin]: deEntity };

  let n = 0;
  async function hire(locationId: string, v: Record<string, unknown> = {}) {
    n++;
    const r = await api('POST', '/v1/employees', { startDate: '2025-01-06', legalFirstName: `Shift${n}`, legalLastName: 'Worker', jobTitle: 'Store associate', entityId: entityFor[locationId], locationId, weeklyHours: 40, payAmountMinor: 1500, payCurrency: 'GBP', payFrequency: 'hourly', contractType: 'permanent', ...v });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  async function login(employeeId: string, role = 'employee', scope: { type: 'self' | 'own_team' | 'all' } = { type: role === 'manager' ? 'own_team' : 'self' }) {
    const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
    await tx(async (t) => {
      const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional', $2) RETURNING id`, [email, employeeId]);
      await t.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
      await assignRole(t, u.id, role, scope);
      if (role !== 'employee') await assignRole(t, u.id, 'employee', { type: 'self' });
    });
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: randomIp() });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return cookieFrom(res);
  }
  return { owner, api, tx, hire, login, gbEntity, usEntity, esEntity, deEntity, london, leeds, sanJose, madrid, berlin };
}
export type TimeCompany = Awaited<ReturnType<typeof timeCompany>>;

/** Fixed "now" for date-independent tests: Wednesday 10 June 2026, 12:00 UTC. */
export const NOW = new Date('2026-06-10T12:00:00Z');
