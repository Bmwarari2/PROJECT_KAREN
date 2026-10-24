import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBillingConfig, quote } from '@thapsus/core/billing';
import { getPool, withTenant } from '@thapsus/db';
import { DIRECTORY_FIELDS } from '../src/lib/directory';
import {
  FakeBillingProvider,
  type CustomerInput,
  type SubscriptionInput,
} from '../src/modules/billing/provider';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { hire, injector, legalEntity, staffSession, WEBHOOK_SECRET } from './phase10-helpers';
import { elevate, enrolStaff, staffCookieFrom, staffReauth, staffSignIn } from './staff-helpers';
import { SoftAuthenticator } from './soft-authenticator';
import {
  createStaff,
  issueStaffEnrolment,
  staffRelyingParty,
  STAFF_ENROLMENT_HOURS,
} from '../src/modules/backoffice/auth';
import { onSecurityEvent, type SecurityEvent } from '../src/lib/security-events';

/**
 * Thapsus back office (PROGRESS 10.2, 10.5, 15.7): staff sign-in with a passkey only, just-in-time
 * elevation and short sessions (ADR-0174), tenants of this cell
 * and the cross-region directory view, usage aggregates, enterprise contracts with custom pricing,
 * invoice collection, PO numbers and multi-entity billing accounts, the staff audit trail — and
 * personal data only through granted, logged support access.
 */
const cfg = loadBillingConfig('builtin:billing-config-v1');
let ctx: TestContext;
let fake: FakeBillingProvider;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let api: ReturnType<typeof injector>;
let support: Awaited<ReturnType<typeof staffSession>>;
let billingStaff: Awaited<ReturnType<typeof staffSession>>;
let entityA: string;
let entityB: string;
let employeeId: string;
const bo = () => getPool(ctx.deps.backofficeDbUrl!);

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  fake = new FakeBillingProvider(() => ctx.clock.now);
  ctx.deps.billing = fake;
  ctx.deps.stripeWebhookSecret = WEBHOOK_SECRET;
  api = injector(ctx);
  owner = await ownerSession(ctx);
  entityA = await legalEntity(ctx, owner.cookie, 'Fictional Holdings Ltd');
  entityB = await legalEntity(ctx, owner.cookie, 'Fictional GmbH', 'DE', 'EUR', 'Europe/Berlin');
  employeeId = await hire(ctx, owner.cookie, entityA, {
    legalFirstName: 'Gale',
    legalLastName: 'Fictitious',
    workEmail: 'gale.fictitious@holdings.example.test',
  });
  for (let i = 0; i < 3; i++)
    await hire(ctx, owner.cookie, entityB, { legalFirstName: `Ulla${i}`, legalLastName: 'Beispiel' });
  // the support-grant tests below use a customer's grant, which needs a support_grant elevation
  support = await staffSession(ctx, 'support', { elevate: ['support_grant'] });
  billingStaff = await staffSession(ctx, 'billing');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('staff sign-in', () => {
  it('staff sign in only with a passkey: no password or code routes, a one-time enrolment link, and tenant sessions never work there', async () => {
    // the password and authenticator-code sign-in routes are gone
    expect(
      (await api('POST', '/v1/backoffice/auth/login', { email: 'x@thapsus.example.test', password: 'x' }, ''))
        .statusCode,
    ).toBe(404);
    expect((await api('POST', '/v1/backoffice/auth/totp', { code: '123456' }, '')).statusCode).toBe(404);
    // an enrolment link registers one key, once, and expires
    const email = `enrol.${Math.random().toString(36).slice(2, 7)}@thapsus.example.test`;
    const created = await createStaff(ctx.app, email, 'Fictional Staff Member', 'support');
    expect(created.enrolmentUrl).toMatch(/\/backoffice\/enrol#token=[A-Za-z0-9_-]{40,}$/);
    expect(created.expiresAt.getTime() - ctx.clock.now.getTime()).toBe(STAFF_ENROLMENT_HOURS * 3_600_000);
    const rp = staffRelyingParty(ctx.deps);
    const key = new SoftAuthenticator(rp.rpID, rp.origin);
    const options = (
      await api('POST', '/v1/backoffice/auth/enrol/options', { token: created.enrolmentToken }, '')
    ).json();
    expect(options.options.authenticatorSelection).toMatchObject({ userVerification: 'required' });
    const enrolled = await api(
      'POST',
      '/v1/backoffice/auth/enrol/verify',
      {
        token: created.enrolmentToken,
        challengeId: options.challengeId,
        response: key.register(options.options),
      },
      '',
    );
    expect(enrolled.statusCode, enrolled.body).toBe(204);
    const cookie = staffCookieFrom(enrolled);
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, cookie)).json()).toMatchObject({
      role: 'support',
      cell: 'uk',
      elevations: [],
    });
    const again = await api(
      'POST',
      '/v1/backoffice/auth/enrol/options',
      { token: created.enrolmentToken },
      '',
    );
    expect(again.statusCode).toBe(401);
    const stale = await issueStaffEnrolment({ deps: ctx.deps }, created.id);
    ctx.clock.advanceMinutes(STAFF_ENROLMENT_HOURS * 60 + 1);
    expect(
      (await api('POST', '/v1/backoffice/auth/enrol/options', { token: stale.token }, '')).statusCode,
    ).toBe(401);
    ctx.clock.advanceMinutes(-(STAFF_ENROLMENT_HOURS * 60 + 1));
    // sign-in is a WebAuthn assertion with user verification; without it, refused
    const signedIn = await staffSignIn(ctx, key);
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, signedIn)).statusCode).toBe(200);
    const o = (await api('POST', '/v1/backoffice/auth/passkey/options', {}, '')).json();
    const noUv = await api(
      'POST',
      '/v1/backoffice/auth/passkey/verify',
      { challengeId: o.challengeId, response: key.assert(o.options, { userVerified: false }) },
      '',
    );
    expect(noUv.statusCode).toBe(401);
    // a key from another (unregistered) authenticator is refused
    const stranger = new SoftAuthenticator(rp.rpID, rp.origin);
    stranger.userHandle = Buffer.from(created.id.replace(/-/g, ''), 'hex').toString('base64url');
    const o2 = (await api('POST', '/v1/backoffice/auth/passkey/options', {}, '')).json();
    expect(
      (
        await api(
          'POST',
          '/v1/backoffice/auth/passkey/verify',
          { challengeId: o2.challengeId, response: stranger.assert(o2.options) },
          '',
        )
      ).statusCode,
    ).toBe(401);
    expect((await api('GET', '/v1/backoffice/tenants', undefined, owner.cookie)).statusCode).toBe(401);
    const out = await api('POST', '/v1/backoffice/auth/logout', undefined, signedIn);
    expect(out.statusCode).toBe(204);
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, signedIn)).statusCode).toBe(401);
  });

  it('staff sessions end after 15 idle minutes or 4 hours, and destructive actions need a fresh key', async () => {
    const s = await enrolStaff(ctx, 'support');
    ctx.clock.advanceMinutes(14);
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, s.cookie)).statusCode).toBe(200);
    ctx.clock.advanceMinutes(16);
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, s.cookie)).statusCode).toBe(401);
    const active = await staffSignIn(ctx, s.key);
    for (let i = 0; i < 17; i++) {
      ctx.clock.advanceMinutes(14);
      expect((await api('GET', '/v1/backoffice/auth/session', undefined, active)).statusCode).toBe(200);
    }
    ctx.clock.advanceMinutes(14); // 4 h 12 min after the sign-in, though active all along
    expect((await api('GET', '/v1/backoffice/auth/session', undefined, active)).statusCode).toBe(401);
    // destructive: notifying controllers of a breach needs a key assertion within 5 minutes
    const fresh = { ...s, cookie: await staffSignIn(ctx, s.key) };
    const breach = await api(
      'POST',
      '/v1/backoffice/breaches',
      {
        title: 'Fictional drill entry',
        summary: 'A fictional breach-register entry for the re-authentication test.',
        awareAt: ctx.clock.now.toISOString(),
        affectedTenantIds: [],
      },
      fresh.cookie,
    );
    expect(breach.statusCode, breach.body).toBe(201);
    ctx.clock.advanceMinutes(6);
    const notify = () =>
      api('POST', `/v1/backoffice/breaches/${breach.json().id}/notify-controllers`, {}, fresh.cookie);
    const stale = await notify();
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('reauthenticationRequired');
    await staffReauth(ctx, fresh);
    const sent = await notify();
    expect(sent.statusCode, sent.body).toBe(200);
    ctx.clock.advanceMinutes(-(14 + 16 + 17 * 14 + 14 + 6));
  });

  it('super admins hold no standing access: an elevation needs a reason, a second staff member and expires', async () => {
    const events: SecurityEvent[] = [];
    const stop = onSecurityEvent((e) => void events.push(e));
    try {
      const admin = await enrolStaff(ctx, 'super_admin');
      const audit = () =>
        api(
          'GET',
          '/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z',
          undefined,
          admin.cookie,
        );
      const refused = await audit();
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ reason: 'elevationRequired', scope: 'super_admin' });
      // overview and session stay reachable (company-level counts only)
      expect((await api('GET', '/v1/backoffice/overview', undefined, admin.cookie)).statusCode).toBe(200);
      const tooShort = await api(
        'POST',
        '/v1/backoffice/elevations',
        { scope: 'super_admin', reason: 'short', minutes: 30 },
        admin.cookie,
      );
      expect(tooShort.statusCode).toBe(400);
      const request = await api(
        'POST',
        '/v1/backoffice/elevations',
        { scope: 'super_admin', reason: 'Fictional incident 77: export the staff trail', minutes: 30 },
        admin.cookie,
      );
      expect(request.statusCode).toBe(201);
      const id = request.json().id as string;
      // nobody approves their own request; support cannot approve a super-admin elevation
      expect(
        (await api('POST', `/v1/backoffice/elevations/${id}/approve`, {}, admin.cookie)).json().reason,
      ).toBe('ownRequest');
      expect(
        (await api('POST', `/v1/backoffice/elevations/${id}/approve`, {}, support.cookie)).json().reason,
      ).toBe('scopeNotForYourRole');
      const second = await enrolStaff(ctx, 'super_admin');
      expect(
        (await api('GET', '/v1/backoffice/elevations', undefined, second.cookie)).json().toApprove,
      ).toEqual([expect.objectContaining({ id, status: 'pending', staffEmail: admin.email })]);
      // approving needs a fresh key assertion
      ctx.clock.advanceMinutes(6);
      const stale = await api('POST', `/v1/backoffice/elevations/${id}/approve`, {}, second.cookie);
      expect(stale.statusCode).toBe(403);
      expect(stale.json().code).toBe('reauthenticationRequired');
      await staffReauth(ctx, second);
      const approved = await api('POST', `/v1/backoffice/elevations/${id}/approve`, {}, second.cookie);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ status: 'active', approvedBy: second.staffId });
      expect((await audit()).statusCode).toBe(200);
      ctx.clock.advanceMinutes(31);
      const signedIn = { ...admin, cookie: await staffSignIn(ctx, admin.key) };
      expect(
        (
          await api(
            'GET',
            '/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z',
            undefined,
            signedIn.cookie,
          )
        ).statusCode,
      ).toBe(403);
      // revoked elevations stop at once
      const again = await elevate(ctx, signedIn, 'super_admin', {
        approver: { ...second, cookie: await staffSignIn(ctx, second.key) },
      });
      expect(
        (
          await api(
            'GET',
            '/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z',
            undefined,
            signedIn.cookie,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await api('POST', `/v1/backoffice/elevations/${again}/revoke`, {}, signedIn.cookie)).statusCode,
      ).toBe(204);
      expect(
        (
          await api(
            'GET',
            '/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z',
            undefined,
            signedIn.cookie,
          )
        ).statusCode,
      ).toBe(403);
      ctx.clock.advanceMinutes(-37);
      const trail = (
        await bo().query<{ action: string }>(
          `SELECT action FROM backoffice.staff_audit WHERE action LIKE 'staff.elevation_%' AND detail->>'id' = $1 ORDER BY id`,
          [id],
        )
      ).rows.map((r) => r.action);
      expect(trail).toEqual(['staff.elevation_requested', 'staff.elevation_approved']);
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'staff.elevation_missing',
          'staff.elevation_requested',
          'staff.elevation_approved',
          'staff.elevation_revoked',
        ]),
      );
      expect(JSON.stringify(events)).not.toContain(admin.email);
    } finally {
      stop();
    }
  });

  it("support-grant use needs a support_grant elevation, even with the customer's grant", async () => {
    const plain = await enrolStaff(ctx, 'support');
    const r = await api(
      'GET',
      `/v1/backoffice/tenants/${owner.tenantId}/employees/${employeeId}`,
      undefined,
      plain.cookie,
    );
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ reason: 'elevationRequired', scope: 'support_grant' });
    // a billing staff member cannot ask for it
    expect(
      (
        await api(
          'POST',
          '/v1/backoffice/elevations',
          { scope: 'support_grant', reason: 'Fictional ticket 12: look at a record', minutes: 30 },
          billingStaff.cookie,
        )
      ).json().reason,
    ).toBe('scopeNotForYourRole');
  });

  it('enforces roles (support cannot manage contracts; only super admins read the staff trail)', async () => {
    expect((await api('GET', '/v1/backoffice/contracts', undefined, support.cookie)).statusCode).toBe(403);
    expect(
      (
        await api(
          'GET',
          `/v1/backoffice/audit?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
          undefined,
          support.cookie,
        )
      ).statusCode,
    ).toBe(403);
    expect((await api('GET', '/v1/backoffice/rules/catalogue', undefined, support.cookie)).statusCode).toBe(
      403,
    );
  });
});

describe('tenants, regions and usage', () => {
  it("lists this cell's tenants with usage aggregates only (counts and bytes)", async () => {
    const refresh = await api(
      'POST',
      `/v1/backoffice/tenants/${owner.tenantId}/usage/refresh`,
      undefined,
      support.cookie,
    );
    expect(refresh.statusCode, refresh.body).toBe(200);
    expect(refresh.json()).toMatchObject({ headcount: 4, activeUsers: 1 });
    const list = (
      await api('GET', `/v1/backoffice/tenants?q=${owner.slug}`, undefined, support.cookie)
    ).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      tenantId: owner.tenantId,
      slug: owner.slug,
      region: 'uk',
      usage: { headcount: 4 },
    });
    expect(JSON.stringify(list)).not.toMatch(/Gale|Fictitious|Beispiel|@holdings/);
  });

  it('shows every region from the global directory only (ids, slugs, regions, plan, status)', async () => {
    const all = (await api('GET', '/v1/backoffice/tenants/all-regions', undefined, support.cookie)).json();
    const mine = all.find((e: { tenantId: string }) => e.tenantId === owner.tenantId);
    expect(mine).toEqual({
      tenantId: owner.tenantId,
      slug: owner.slug,
      region: 'uk',
      status: 'active',
      planRef: 'trial',
    });
    for (const e of all)
      expect(Object.keys(e).sort()).toEqual(['planRef', 'region', 'slug', 'status', 'tenantId']);
    expect(DIRECTORY_FIELDS).not.toContain('name');
  });

  it('tenant detail shows the billing structure but never billing contacts or employee data', async () => {
    const acct = (await api('GET', '/v1/billing', undefined, owner.cookie)).json().accounts[0];
    await api(
      'PUT',
      `/v1/billing/accounts/${acct.id}/details`,
      {
        name: 'Fictional Holdings Ltd',
        address: { line1: '2 Example Road', city: 'Leeds', postalCode: 'LS1 1AA', country: 'GB' },
        contacts: [{ name: 'Petra Payables', email: 'payables@holdings.example.test', isPrimary: true }],
      },
      owner.cookie,
    );
    const d = await api('GET', `/v1/backoffice/tenants/${owner.tenantId}`, undefined, support.cookie);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({
      name: `Fictional ${owner.slug} Ltd`,
      entities: expect.arrayContaining([expect.objectContaining({ name: 'Fictional GmbH', country: 'DE' })]),
      grant: null,
    });
    expect(d.json().billingAccounts[0]).toMatchObject({ isDefault: true, detailsComplete: true });
    expect(JSON.stringify(d.json())).not.toMatch(/Petra|payables@|Gale|gale\.fictitious/);
    expect(
      (
        await api(
          'GET',
          `/v1/backoffice/tenants/00000000-0000-4000-8000-000000000000`,
          undefined,
          support.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('personal data only through granted, logged support access', () => {
  const view = () =>
    api('GET', `/v1/backoffice/tenants/${owner.tenantId}/employees/${employeeId}`, undefined, support.cookie);
  const fix = () =>
    api(
      'PATCH',
      `/v1/backoffice/tenants/${owner.tenantId}/employees/${employeeId}`,
      { workPhone: '+44 113 000 0000' },
      support.cookie,
    );
  const grant = async (accessLevel: 'read' | 'read_write') => {
    const r = await api(
      'POST',
      '/v1/settings/support-grants',
      { staffId: support.staffId, accessLevel, hours: 2, reason: 'Ticket T-0000FEED: export question' },
      owner.cookie,
    );
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const supportAudit = () =>
    withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM audit.events WHERE actor_type = 'support' AND action LIKE 'support.%' ORDER BY id`,
      ),
    );
  const staffTrail = async () =>
    (
      await bo().query<{ action: string; subject_tenant_id: string }>(
        `SELECT action, subject_tenant_id FROM backoffice.staff_audit WHERE staff_id = $1 AND action LIKE 'support.%' ORDER BY id`,
        [support.staffId],
      )
    ).rows;

  it('no grant → 403 (and the denied attempt is in the staff trail)', async () => {
    expect((await view()).statusCode).toBe(403);
    expect((await fix()).statusCode).toBe(403);
    expect((await staffTrail()).map((r) => r.action)).toEqual([
      'support.access_denied',
      'support.access_denied',
    ]);
  });

  it('with a read grant → the record, written to the customer audit log AND the staff trail; a read grant cannot write', async () => {
    const id = await grant('read');
    const r = await view();
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.stringify(r.json())).toContain('Gale');
    expect((await supportAudit()).filter((a) => a.action === 'support.view_employee')).toEqual([
      { action: 'support.view_employee', actor_id: support.staffId },
    ]);
    expect((await staffTrail()).filter((a) => a.action === 'support.view_employee')).toEqual([
      { action: 'support.view_employee', subject_tenant_id: owner.tenantId },
    ]);
    expect((await fix()).statusCode).toBe(403);
    expect(
      (await api('GET', '/v1/backoffice/grants', undefined, support.cookie))
        .json()
        .find((g: { id: string }) => g.id === id),
    ).toMatchObject({ accessLevel: 'read', active: true });
    expect(
      (await api('GET', `/v1/backoffice/tenants/${owner.tenantId}`, undefined, support.cookie)).json().grant,
    ).toMatchObject({ id, accessLevel: 'read' });
    // revoked → 403
    expect(
      (await api('DELETE', `/v1/settings/support-grants/${id}`, undefined, owner.cookie)).statusCode,
    ).toBe(204);
    expect((await view()).statusCode).toBe(403);
  });

  it('expired grants → 403', async () => {
    await grant('read');
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.exec(
        `UPDATE app.support_grants SET starts_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' WHERE revoked_at IS NULL`,
      ),
    );
    expect((await view()).statusCode).toBe(403);
  });

  it('a read-and-write grant allows the correction, audited in both logs', async () => {
    await grant('read_write');
    const r = await fix();
    expect(r.statusCode, r.body).toBe(204);
    const phone = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.one<{ work_phone: string }>('SELECT work_phone FROM app.employees WHERE id = $1', [employeeId]),
    );
    expect(phone.work_phone).toBe('+44 113 000 0000');
    const actions = (await supportAudit()).map((a) => a.action);
    expect(actions).toContain('support.update_employee');
    const all = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string }>(
        `SELECT action FROM audit.events WHERE action = 'employee.updated_by_support'`,
      ),
    );
    expect(all).toHaveLength(1);
    expect((await staffTrail()).map((a) => a.action)).toContain('support.update_employee');
  });
});

describe('enterprise contracts and multi-entity billing (configured in the back office)', () => {
  let contractId: string;
  let secondAccount: string;

  it('groups legal entities into a separately invoiced billing account with its own currency and PO number', async () => {
    const r = await api(
      'POST',
      `/v1/backoffice/tenants/${owner.tenantId}/billing-accounts`,
      {
        name: 'Fictional GmbH (Germany)',
        currency: 'EUR',
        entityIds: [entityB],
        collection: 'send_invoice',
        paymentTermsDays: 30,
        poNumber: 'PO-DE-2027-001',
      },
      billingStaff.cookie,
    );
    expect(r.statusCode, r.body).toBe(201);
    secondAccount = r.json().id;
    expect(
      (
        await api(
          'POST',
          `/v1/backoffice/tenants/${owner.tenantId}/billing-accounts`,
          { name: 'x', currency: 'EUR', entityIds: [], collection: 'send_invoice' },
          billingStaff.cookie,
        )
      ).statusCode,
    ).toBe(400);
    const b = (await api('GET', '/v1/billing', undefined, owner.cookie)).json();
    expect(b.accounts.map((a: { headcount: number }) => a.headcount).sort()).toEqual([1, 3]);
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ actor_type: string }>(
        `SELECT actor_type FROM audit.events WHERE action = 'billing.account_created'`,
      ),
    );
    expect(audit).toEqual([{ actor_type: 'support' }]);
  });

  it('records a draft contract whose prices come from the contract record, never code (validated)', async () => {
    const base = {
      tenantId: owner.tenantId,
      reference: `C-${owner.slug}`,
      planId: 'enterprise',
      currency: 'GBP',
      term: 'annual',
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
      renewal: 'manual',
      renewalNoticeDays: 90,
      collection: 'send_invoice',
      paymentTermsDays: 45,
    };
    expect(
      (await api('POST', '/v1/backoffice/contracts', { ...base, pricing: {} }, billingStaff.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await api(
          'POST',
          '/v1/backoffice/contracts',
          { ...base, pricing: { unitAmountMinor: 1, flatAmountMinor: 2 } },
          billingStaff.cookie,
        )
      ).statusCode,
    ).toBe(400);
    const r = await api(
      'POST',
      '/v1/backoffice/contracts',
      {
        ...base,
        pricing: { unitAmountMinor: 7200, minimumEmployees: 1 },
        notes: 'Fictional negotiated rate',
      },
      billingStaff.cookie,
    );
    expect(r.statusCode, r.body).toBe(201);
    contractId = r.json().id;
    expect(r.json()).toMatchObject({ status: 'draft', pricing: { unitAmountMinor: 7200 } });
    expect(
      (
        await api(
          'POST',
          '/v1/backoffice/contracts',
          { ...base, pricing: { unitAmountMinor: 1 } },
          billingStaff.cookie,
        )
      ).statusCode,
    ).toBe(409);
    const patched = await api(
      'PATCH',
      `/v1/backoffice/contracts/${contractId}`,
      { paymentTermsDays: 30 },
      billingStaff.cookie,
    );
    expect(patched.json().paymentTermsDays).toBe(30);
  });

  it('activation bills each billing account by invoice with payment terms, custom pricing and PO numbers; accounts without details wait', async () => {
    const r = await api(
      'POST',
      `/v1/backoffice/contracts/${contractId}/activate`,
      undefined,
      billingStaff.cookie,
    );
    expect(r.statusCode, r.body).toBe(200);
    const byAccount = Object.fromEntries(
      r.json().accounts.map((a: { accountId: string; status: string }) => [a.accountId, a.status]),
    );
    expect(byAccount[secondAccount]).toBe('pending_details');
    const created = fake.calls
      .filter((c) => c.op === 'createSubscription')
      .map((c) => c.input as SubscriptionInput);
    expect(created).toHaveLength(1);
    const q = quote(cfg, {
      planId: 'enterprise',
      term: 'annual',
      currency: 'GBP',
      headcount: 1,
      contract: {
        planId: 'enterprise',
        currency: 'GBP',
        term: 'annual',
        unitAmountMinor: 7200,
        minimumEmployees: 1,
      },
    });
    expect(created[0]).toMatchObject({
      planId: 'enterprise',
      interval: 'year',
      currency: 'GBP',
      unitAmountMinor: 7200,
      quantity: q.quantity,
      collection: 'send_invoice',
      daysUntilDue: 30,
    });
    // self-serve is replaced: no self-serve changes, and the customer sees the contract
    const b = (await api('GET', '/v1/billing', undefined, owner.cookie)).json();
    expect(b.selfServe).toBe(false);
    expect(b.contract).toMatchObject({
      reference: `C-${owner.slug}`,
      planId: 'enterprise',
      paymentTermsDays: 30,
      collection: 'send_invoice',
    });
    expect(
      (
        await api(
          'POST',
          '/v1/billing/subscription/change',
          { planId: 'plus', term: 'monthly' },
          owner.cookie,
        )
      ).statusCode,
    ).toBe(409);
    // the second account starts once the customer enters its billing contact; its PO number goes on its invoices
    await api(
      'PUT',
      `/v1/billing/accounts/${secondAccount}/details`,
      {
        name: 'Fictional GmbH',
        address: { line1: 'Beispielstraße 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
        contacts: [{ name: 'Rena Rechnung', email: 'rechnung@gmbh.example.test', isPrimary: true }],
      },
      owner.cookie,
    );
    const de = fake.calls
      .filter((c) => c.op === 'createSubscription')
      .map((c) => c.input as SubscriptionInput)
      .find((s) => s.billingAccountId === secondAccount);
    expect(de).toMatchObject({
      currency: 'GBP',
      quantity: 3,
      unitAmountMinor: 7200,
      collection: 'send_invoice',
    });
    const deCustomer = fake.calls
      .filter((c) => c.op === 'upsertCustomer')
      .map((c) => c.input as CustomerInput)
      .find((c) => c.billingAccountId === secondAccount);
    expect(deCustomer?.poNumber).toBe('PO-DE-2027-001');
    // changing the PO number refreshes the provider customer (next invoices carry it)
    await api(
      'PATCH',
      `/v1/backoffice/tenants/${owner.tenantId}/billing-accounts/${secondAccount}`,
      { poNumber: 'PO-DE-2027-002' },
      billingStaff.cookie,
    );
    expect(
      (fake.calls.filter((c) => c.op === 'upsertCustomer').at(-1)!.input as CustomerInput).poNumber,
    ).toBe('PO-DE-2027-002');
    const trail = (
      await bo().query<{ action: string }>(
        `SELECT action FROM backoffice.staff_audit WHERE subject_tenant_id = $1 AND action LIKE 'contract.%' ORDER BY id`,
        [owner.tenantId],
      )
    ).rows.map((r) => r.action);
    expect(trail).toEqual(['contract.created', 'contract.updated', 'contract.activated']);
    expect(ctx.directory.entries.get(owner.tenantId)?.planRef).toBe('enterprise');
  });

  it('active contracts keep their commercial terms; renewal is flagged within the notice window; ending stops billing at the end date', async () => {
    expect(
      (
        await api(
          'PATCH',
          `/v1/backoffice/contracts/${contractId}`,
          { pricing: { unitAmountMinor: 1 } },
          billingStaff.cookie,
        )
      ).statusCode,
    ).toBe(409);
    const list = (await api('GET', '/v1/backoffice/contracts', undefined, billingStaff.cookie)).json();
    const c = list.find((x: { id: string }) => x.id === contractId);
    expect(c).toMatchObject({ status: 'active', slug: owner.slug });
    const saved = ctx.clock.now;
    try {
      const at = async (iso: string) => {
        ctx.clock.now = new Date(iso);
        const s = await staffSession(ctx, 'billing'); // sessions are dated by the clock too
        return (await api('GET', '/v1/backoffice/contracts', undefined, s.cookie))
          .json()
          .find((x: { id: string }) => x.id === contractId).renewalDue;
      };
      expect(await at('2027-10-15T12:00:00Z')).toBe(true); // within 90 days of 2027-12-31
      expect(await at('2027-03-01T12:00:00Z')).toBe(false);
    } finally {
      ctx.clock.now = saved;
    }
    const end = await api(
      'POST',
      `/v1/backoffice/contracts/${contractId}/end`,
      undefined,
      billingStaff.cookie,
    );
    expect(end.json().endsAt).toBe('2028-01-01T00:00:00Z');
    expect(
      fake.calls
        .filter((x) => x.op === 'setCancelAt')
        .every((x) => (x.input as { at: string }).at === '2028-01-01T00:00:00Z'),
    ).toBe(true);
  });
});

describe('plans, rules catalogue and the staff audit trail', () => {
  it('plans come from the billing config location', async () => {
    const r = (await api('GET', '/v1/backoffice/plans', undefined, billingStaff.cookie)).json();
    expect(r).toMatchObject({
      location: 'builtin:billing-config-v1',
      version: cfg.version,
      trialDays: cfg.trial.days,
    });
  });

  it('rules editors get the catalogue for the rule-editing screen', async () => {
    const editor = await staffSession(ctx, 'rules_editor');
    const r = (await api('GET', '/v1/backoffice/rules/catalogue', undefined, editor.cookie)).json();
    expect(r.jurisdictions.find((j: { code: string }) => j.code === 'GB')).toBeTruthy();
    expect(r.keys.map((k: { key: string }) => k.key)).toContain('minimum_wage.rates');
  });

  it('super admins export the append-only staff trail as CSV; the export is itself recorded', async () => {
    const admin = await staffSession(ctx, 'super_admin');
    const from = new Date(ctx.clock.now.getTime() - 3_600_000).toISOString();
    const to = new Date(ctx.clock.now.getTime() + 3_600_000).toISOString();
    const json = (
      await api('GET', `/v1/backoffice/audit?from=${from}&to=${to}`, undefined, admin.cookie)
    ).json();
    expect(json.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        'staff.login',
        'staff.enrolled',
        'staff.elevation_approved',
        'support.view_employee',
        'contract.activated',
        'tenant.viewed',
      ]),
    );
    const csv = await api(
      'GET',
      `/v1/backoffice/audit?from=${from}&to=${to}&format=csv`,
      undefined,
      admin.cookie,
    );
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe(
      'id,at,staffId,staffEmail,action,subjectTenantId,target,detail,ip,requestId',
    );
    const exported = (
      await bo().query(
        `SELECT 1 FROM backoffice.staff_audit WHERE staff_id = $1 AND action = 'staff_audit.exported'`,
        [admin.staffId],
      )
    ).rows;
    expect(exported).toHaveLength(1);
    await expect(
      getPool(ctx.deps.backofficeDbUrl!).query(`UPDATE backoffice.staff_audit SET action = 'x'`),
    ).rejects.toThrow();
  });
});
