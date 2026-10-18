import { expect } from 'vitest';
import { withTenant, type Tx } from '@thapsus/db';
import { cookieFrom, ownerSession, PASSWORD, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';

/** Fictional-company fixtures for the leave and absence integration suites. */
export async function leaveFixtures(ctx: TestContext) {
  const owner = await ownerSession(ctx);
  const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) => ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(ctx.deps.router, owner.tenantId, fn);
  const created = async (method: string, url: string, payload: unknown, cookie?: string) => {
    const r = await api(method, url, payload, cookie);
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json();
  };

  async function entity(v: { name: string; country: string; regionCode?: string; currency: string; timeZone: string }) {
    return (await created('POST', '/v1/org/legal-entities', v)).id as string;
  }
  async function location(v: { name: string; country: string; regionCode?: string; timeZone: string; entityId: string; geofence?: { lat: number; lng: number; radiusMetres: number } }) {
    return (await created('POST', '/v1/org/locations', v)).id as string;
  }
  const defaultEntity = await entity({ name: 'Fictional Absence Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });

  async function hire(v: Record<string, unknown> = {}) {
    const r = await api('POST', '/v1/employees', { startDate: '2025-01-06', legalFirstName: 'Fictional', legalLastName: 'Person', jobTitle: 'Analyst', entityId: defaultEntity, weeklyHours: 37.5, payAmountMinor: 3_120_000, payCurrency: 'GBP', payFrequency: 'annual', contractType: 'permanent', ...v });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  /** A signed-in user linked to the employee, holding `role` (plus the employee role). */
  async function login(employeeId: string | null, role: string, scope: { type: 'self' | 'own_team' | 'all' } = { type: 'self' }) {
    const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
    const userId = await tx(async (t) => {
      const u = await t.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional', $2) RETURNING id`, [email, employeeId]);
      await t.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
      await assignRole(t, u.id, role, scope);
      if (role !== 'employee') await assignRole(t, u.id, 'employee', { type: 'self' });
      return u.id;
    });
    const cookie = cookieFrom(await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email, password: PASSWORD }, remoteAddress: `10.81.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }));
    return { cookie, userId };
  }

  /** A custom (non-admin) tenant role. */
  async function customRole(key: string, permissions: string[]) {
    await tx((t) => t.exec(`INSERT INTO app.roles (tenant_id, key, name, permissions) VALUES (app.current_tenant(), $1, $2, $3) ON CONFLICT (tenant_id, key) DO NOTHING`, [key, `Fictional ${key}`, permissions]));
  }

  const types = Object.fromEntries(((await api('GET', '/v1/leave/types')).json() as Array<{ key: string; id: string }>).map((t) => [t.key, t.id])) as Record<string, string>;

  /** A policy scoped to an otherwise unused country so it never becomes another employee's default. */
  async function policy(name: string, config: Record<string, unknown>, leaveType = 'annual') {
    return (await created('POST', '/v1/leave/policies', { name, leaveTypeId: types[leaveType], country: 'MT', config: { unit: 'days', yearStart: '01-01', proRata: true, includesPublicHolidays: false, waitingDays: 0, allowNegativeDays: 0, rounding: 'none', ...config } })).id as string;
  }
  async function assign(policyId: string, employeeIds: string[], validFrom: string) {
    await created('POST', `/v1/leave/policies/${policyId}/assign`, { employeeIds, validFrom });
  }
  async function balance(employeeId: string, asOf: string, leaveType = 'annual', cookie?: string) {
    const r = await api('GET', `/v1/leave/balances/${employeeId}?asOf=${asOf}`, undefined, cookie);
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as Array<Record<string, unknown> & { leaveType: string }>).find((b) => b.leaveType === leaveType)!;
  }
  /** Approves a pending approval for `leaveRequestId` as the given approver. */
  async function approve(leaveRequestId: string, approverCookie: string) {
    const inbox = (await api('GET', '/v1/approvals', undefined, approverCookie)).json() as Array<{ id: string; payload: { leaveRequestId?: string } }>;
    const ar = inbox.find((a) => a.payload.leaveRequestId === leaveRequestId);
    expect(ar, 'approval in the approver inbox').toBeDefined();
    expect((await api('POST', `/v1/approvals/${ar!.id}/decide`, { decision: 'approve' }, approverCookie)).json().status).toBe('approved');
  }
  async function auditRows(action: string, targetId: string) {
    return tx((t) => t.query<{ action: string; sensitive: boolean; diff: Record<string, unknown> | null }>(`SELECT action, sensitive, diff FROM audit.events WHERE action = $1 AND target_id = $2`, [action, targetId]));
  }

  return { owner, api, tx, created, entity, location, defaultEntity, hire, login, customRole, types, policy, assign, balance, approve, auditRows };
}
