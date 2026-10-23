import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  PASSWORD,
  startTestApp,
  type TestContext,
} from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';

/**
 * Read endpoints (and the few small mutations) added so admins can configure the workspace from
 * the app: SSO connections, sign-in policy, SCIM tokens, approval chains, delegations and the
 * leave/absence lists. Each is permission-checked and every mutation is audit-logged.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) =>
  ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);
const audited = (action: string, targetId: string) =>
  tx((t) => t.query(`SELECT 1 FROM audit.events WHERE action = $1 AND target_id = $2`, [action, targetId]));

/** A signed-in user with one built-in role (fictional). */
async function login(role: string, displayName: string) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  const userId = await tx(async (t) => {
    const u = await t.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
      [email, displayName],
    );
    await t.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(t, u.id, role, {
      type: role === 'employee' ? 'self' : role === 'manager' ? 'own_team' : 'all',
    });
    return u.id;
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: owner.slug, email, password: PASSWORD },
    remoteAddress: `10.71.${Math.floor(Math.random() * 250)}.3`,
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = cookieFrom(res);
  // admin roles must complete MFA before anything else
  if (role === 'hr_admin') await enrolTotp(ctx, cookie);
  return { cookie, userId };
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('sign-in settings', () => {
  it('lists SSO connections with the values to copy into the IdP, never the client secret', async () => {
    const created = await api('POST', '/v1/settings/sso-connections', {
      protocol: 'oidc',
      name: 'Fictional IdP',
      oidc: {
        issuer: 'https://idp.example.test',
        clientId: 'thapsus-client',
        clientSecret: 'fictional-secret-value',
      },
    });
    expect(created.statusCode).toBe(201);
    const { id, redirectUri, spEntityId } = created.json() as {
      id: string;
      redirectUri: string;
      spEntityId: string;
    };
    const list = await api('GET', '/v1/settings/sso-connections');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('fictional-secret-value');
    expect(list.body).not.toContain('clientSecretEnc');
    expect(list.json()).toEqual([
      expect.objectContaining({
        id,
        protocol: 'oidc',
        name: 'Fictional IdP',
        enabled: true,
        idpUrl: 'https://idp.example.test',
        clientId: 'thapsus-client',
        hasClientSecret: true,
        redirectUri,
        spEntityId,
        testSignInUrl: `${ctx.base}/v1/auth/sso/start?tenant=${owner.slug}&connection=${id}`,
      }),
    ]);
  });

  it('turns a connection off and on, refuses to leave enforced SSO without a connection, and deletes', async () => {
    const id = (
      await api('POST', '/v1/settings/sso-connections', {
        protocol: 'saml',
        name: 'Fictional SAML',
        saml: { entryPoint: 'https://idp.example.test/sso', idpCert: 'MIIFICTIONALCERTIFICATEVALUE' },
      })
    ).json().id as string;
    // only this one is left enabled once the OIDC connection from the first test is turned off
    const others = (await api('GET', '/v1/settings/sso-connections')).json() as Array<{ id: string }>;
    for (const o of others.filter((c) => c.id !== id))
      expect(
        (await api('PATCH', `/v1/settings/sso-connections/${o.id}`, { enabled: false })).statusCode,
      ).toBe(200);
    expect((await api('PATCH', '/v1/settings/security', { ssoEnforced: true })).statusCode).toBe(200);
    expect((await api('GET', '/v1/settings/security')).json()).toMatchObject({
      ssoEnforced: true,
      sessionIdleMinutes: 30,
      sessionAbsoluteHours: 12,
    });
    expect((await api('PATCH', `/v1/settings/sso-connections/${id}`, { enabled: false })).statusCode).toBe(
      422,
    );
    expect((await api('DELETE', `/v1/settings/sso-connections/${id}`)).statusCode).toBe(422);
    expect((await api('PATCH', '/v1/settings/security', { ssoEnforced: false })).statusCode).toBe(200);
    const off = await api('PATCH', `/v1/settings/sso-connections/${id}`, {
      enabled: false,
      jitProvisioning: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, jitProvisioning: false });
    expect(await audited('sso.connection_updated', id)).toHaveLength(1);
    expect((await api('DELETE', `/v1/settings/sso-connections/${id}`)).statusCode).toBe(204);
    expect(await audited('sso.connection_deleted', id)).toHaveLength(1);
    expect((await api('DELETE', `/v1/settings/sso-connections/${id}`)).statusCode).toBe(404);
  });

  it('lists SCIM tokens without the secret and revokes one so it stops working', async () => {
    const created = (
      await api('POST', '/v1/settings/scim-tokens', { name: 'Fictional directory' })
    ).json() as { id: string; token: string };
    const scim = () =>
      ctx.app.inject({
        method: 'GET',
        url: '/scim/v2/Users',
        headers: { authorization: `Bearer ${created.token}` },
      });
    expect((await scim()).statusCode).toBe(200);
    const list = await api('GET', '/v1/settings/scim-tokens');
    expect(list.body).not.toContain(created.token.split('.').at(-1)!);
    expect(list.json()).toEqual([
      expect.objectContaining({ id: created.id, name: 'Fictional directory', revokedAt: null }),
    ]);
    expect((list.json() as Array<{ lastUsedAt: string | null }>)[0]!.lastUsedAt).not.toBeNull();
    expect((await api('DELETE', `/v1/settings/scim-tokens/${created.id}`)).statusCode).toBe(204);
    expect((await scim()).statusCode).toBe(401);
    expect((await api('GET', '/v1/settings/scim-tokens')).json()[0].revokedAt).not.toBeNull();
    expect(await audited('scim.token_revoked', created.id)).toHaveLength(1);
    expect((await api('DELETE', `/v1/settings/scim-tokens/${created.id}`)).statusCode).toBe(404);
  });

  it('lets HR admins read but not change sign-in settings, and employees neither', async () => {
    const hr = await login('hr_admin', 'Hana Fictional');
    const emp = await login('employee', 'Eli Fictional');
    for (const url of ['/v1/settings/sso-connections', '/v1/settings/scim-tokens', '/v1/settings/security']) {
      expect((await api('GET', url, undefined, hr.cookie)).statusCode, url).toBe(200);
      expect((await api('GET', url, undefined, emp.cookie)).statusCode, url).toBe(403);
    }
    const tok = (await api('POST', '/v1/settings/scim-tokens', { name: 'Kept' })).json().id as string;
    expect((await api('DELETE', `/v1/settings/scim-tokens/${tok}`, undefined, hr.cookie)).statusCode).toBe(
      403,
    );
  });
});

describe('approval chains and delegations', () => {
  it('lists and edits an approval chain; in-flight requests keep their original steps', async () => {
    const id = (
      await api('POST', '/v1/approval-policies', {
        subject: 'leave.request',
        name: 'Long leave',
        condition: { field: 'amountDays', op: 'gte', value: 10 },
        steps: [{ approver: { type: 'manager' } }],
      })
    ).json().id as string;
    const list = await api('GET', '/v1/approval-policies');
    expect(list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          subject: 'leave.request',
          name: 'Long leave',
          enabled: true,
          priority: 100,
          condition: { field: 'amountDays', op: 'gte', value: 10 },
          steps: [{ approver: { type: 'manager' } }],
        }),
      ]),
    );
    const edited = await api('PUT', `/v1/approval-policies/${id}`, {
      subject: 'leave.request',
      name: 'Long leave (two steps)',
      condition: null,
      priority: 10,
      enabled: false,
      steps: [
        { approver: { type: 'manager' }, timeoutHours: 48, escalateTo: { type: 'role', value: 'hr_admin' } },
        {
          approver: { type: 'role', value: 'hr_admin' },
          condition: { field: 'amountDays', op: 'gt', value: 15 },
        },
      ],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      name: 'Long leave (two steps)',
      condition: null,
      priority: 10,
      enabled: false,
    });
    expect(edited.json().steps).toHaveLength(2);
    expect(await audited('approval_policy.updated', id)).toHaveLength(1);
    expect(
      (
        await api('PUT', `/v1/approval-policies/${crypto.randomUUID()}`, {
          subject: 'leave.request',
          name: 'x',
          steps: [{ approver: { type: 'manager' } }],
        })
      ).statusCode,
    ).toBe(404);
    const mgr = await login('manager', 'Mona Fictional');
    expect((await api('GET', '/v1/approval-policies', undefined, mgr.cookie)).statusCode).toBe(403);
    expect(
      (
        await api(
          'PUT',
          `/v1/approval-policies/${id}`,
          { subject: 'leave.request', name: 'x', steps: [{ approver: { type: 'manager' } }] },
          mgr.cookie,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('a manager finds a colleague, delegates for a period, both see it, and only the giver can end it', async () => {
    const mgr = await login('manager', 'Max Fictional');
    const deputy = await login('manager', 'Dana Fictional');
    const candidates = (
      await api('GET', '/v1/delegations/candidates?q=Dana', undefined, mgr.cookie)
    ).json() as Array<{ userId: string; displayName: string }>;
    expect(candidates).toEqual([
      expect.objectContaining({ userId: deputy.userId, displayName: 'Dana Fictional' }),
    ]);
    expect(
      JSON.stringify(await (await api('GET', '/v1/delegations/candidates', undefined, mgr.cookie)).json()),
    ).not.toContain(mgr.userId);
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const id = (
      await api('POST', '/v1/delegations', { toUserId: deputy.userId, startsAt, endsAt }, mgr.cookie)
    ).json().id as string;
    const future = (
      await api(
        'POST',
        '/v1/delegations',
        {
          toUserId: deputy.userId,
          startsAt: endsAt,
          endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        },
        mgr.cookie,
      )
    ).json().id as string;
    expect((await api('GET', '/v1/delegations', undefined, mgr.cookie)).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          direction: 'given',
          toName: 'Dana Fictional',
          fromName: 'Max Fictional',
        }),
      ]),
    );
    expect((await api('GET', '/v1/delegations', undefined, deputy.cookie)).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, direction: 'received' })]),
    );
    expect((await api('DELETE', `/v1/delegations/${id}`, undefined, deputy.cookie)).statusCode).toBe(404);
    expect((await api('DELETE', `/v1/delegations/${id}`, undefined, mgr.cookie)).statusCode).toBe(204);
    const ended = await tx((t) =>
      t.one<{ active: boolean }>(
        'SELECT now() >= starts_at AND now() < ends_at AS active FROM app.delegations WHERE id = $1',
        [id],
      ),
    );
    expect(ended.active).toBe(false);
    expect((await api('DELETE', `/v1/delegations/${future}`, undefined, mgr.cookie)).statusCode).toBe(204);
    expect(await tx((t) => t.query('SELECT 1 FROM app.delegations WHERE id = $1', [future]))).toHaveLength(0);
    expect(await audited('delegation.ended', id)).toHaveLength(1);
    expect((await api('DELETE', `/v1/delegations/${id}`, undefined, mgr.cookie)).statusCode).toBe(404);
  });
});

describe('time off and absence lists', () => {
  it('lists leave policies (with assignment counts), absence triggers, cover rules and company calendars', async () => {
    const types = (await api('GET', '/v1/leave/types')).json() as Array<{ id: string; key: string }>;
    const annual = types.find((x) => x.key === 'annual')!.id;
    const config = {
      accrual: { method: 'monthly', days: 30 },
      unit: 'days',
      yearStart: '04-01',
      proRata: true,
      includesPublicHolidays: false,
      waitingDays: 90,
      carryOver: { maxDays: 8, expiresAfterMonths: 6 },
      capDays: 35,
      allowNegativeDays: 2,
      rounding: 'nearest_half_day',
    };
    const policy = (
      await api('POST', '/v1/leave/policies', {
        name: 'Fictional generous leave',
        leaveTypeId: annual,
        country: 'GB',
        config,
      })
    ).json().id as string;
    const entity = (
      await api('POST', '/v1/org/legal-entities', {
        name: 'Fictional Ltd',
        country: 'GB',
        currency: 'GBP',
        timeZone: 'Europe/London',
      })
    ).json().id as string;
    const emp = (
      await api('POST', '/v1/employees', {
        startDate: '2025-01-06',
        legalFirstName: 'Pia',
        legalLastName: 'Fictional',
        jobTitle: 'Analyst',
        entityId: entity,
        payAmountMinor: 3_000_000,
        payCurrency: 'GBP',
        payFrequency: 'annual',
        contractType: 'permanent',
      })
    ).json().id as string;
    expect(
      (
        await api('POST', `/v1/leave/policies/${policy}/assign`, {
          employeeIds: [emp],
          validFrom: '2025-01-06',
        })
      ).statusCode,
    ).toBe(200);
    const policies = (await api('GET', '/v1/leave/policies')).json() as Array<Record<string, unknown>>;
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: policy,
          leaveTypeKey: 'annual',
          country: 'GB',
          config,
          assignedEmployees: 1,
          effectiveFrom: '2000-01-01',
          effectiveTo: null,
        }),
      ]),
    );
    expect(policies.some((p) => p.leaveTypeKey === 'toil')).toBe(true);

    const trig = (
      await api('POST', '/v1/absence/triggers', {
        name: 'Bradford 200',
        bradfordThreshold: 200,
        windowDays: 365,
      })
    ).json().id as string;
    expect((await api('GET', '/v1/absence/triggers')).json()).toEqual([
      {
        id: trig,
        name: 'Bradford 200',
        bradfordThreshold: 200,
        spellsThreshold: null,
        windowDays: 365,
        notifyRole: 'hr_admin',
        notifyManager: true,
      },
    ]);
    const cover = (
      await api('POST', '/v1/leave/cover-rules', {
        name: 'Two on shift',
        minPresent: 2,
        enforcement: 'block',
      })
    ).json().id as string;
    expect((await api('GET', '/v1/leave/cover-rules')).json()).toEqual([
      {
        id: cover,
        name: 'Two on shift',
        departmentId: null,
        locationId: null,
        minPresent: 2,
        enforcement: 'block',
      },
    ]);
    const cal = (
      await api('POST', '/v1/settings/company-calendars', {
        name: 'Winter closure',
        entityId: entity,
        days: [
          { date: '2026-12-29', name: 'Closure' },
          { date: '2026-12-24', name: 'Christmas Eve' },
        ],
      })
    ).json().id as string;
    expect((await api('GET', '/v1/settings/company-calendars')).json()).toEqual([
      {
        id: cal,
        name: 'Winter closure',
        entityId: entity,
        locationId: null,
        days: [
          { date: '2026-12-24', name: 'Christmas Eve' },
          { date: '2026-12-29', name: 'Closure' },
        ],
      },
    ]);

    const emp2 = await login('employee', 'Elle Fictional');
    for (const url of [
      '/v1/leave/policies',
      '/v1/absence/triggers',
      '/v1/leave/cover-rules',
      '/v1/settings/company-calendars',
    ])
      expect((await api('GET', url, undefined, emp2.cookie)).statusCode, url).toBe(403);
  });
});
