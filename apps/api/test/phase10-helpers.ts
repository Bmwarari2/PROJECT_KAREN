import Stripe from 'stripe';
import { withTenant, type JobRow } from '@thapsus/db';
import { cookieFrom, PASSWORD, totpCode, type TestContext } from './helpers';
import { hashPassword } from '../src/modules/auth/tokens';
import { assignRole } from '../src/modules/authz/principal';
import { createStaff, STAFF_COOKIE, type StaffRole } from '../src/modules/backoffice/auth';
import { jobHandlers } from '../src/worker';

/** Shared fixtures for the phase 10 suites (fictional companies, people and Stripe-style ids only). */
export const WEBHOOK_SECRET = 'whsec_fictional_phase10_test_only';

export const injector =
  (ctx: TestContext) => (method: string, url: string, payload: unknown, cookie: string) =>
    ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });

export async function legalEntity(
  ctx: TestContext,
  cookie: string,
  name = 'Fictional Widgets Ltd',
  country = 'GB',
  currency = 'GBP',
  timeZone = 'Europe/London',
) {
  const r = await injector(ctx)(
    'POST',
    '/v1/org/legal-entities',
    { name, country, currency, timeZone },
    cookie,
  );
  if (r.statusCode !== 201) throw new Error(`entity ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

export async function hire(
  ctx: TestContext,
  cookie: string,
  entityId: string,
  values: Record<string, unknown> = {},
) {
  const r = await injector(ctx)(
    'POST',
    '/v1/employees',
    {
      startDate: '2025-02-03',
      legalFirstName: 'Avery',
      legalLastName: 'Example',
      jobTitle: 'Analyst',
      entityId,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
      ...values,
    },
    cookie,
  );
  if (r.statusCode !== 201) throw new Error(`hire ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

/** A signed-in tenant user with one built-in role (password sign-in; employees need no MFA). */
export async function userSession(
  ctx: TestContext,
  owner: { tenantId: string; slug: string },
  role = 'employee',
  name = 'Fictional Employee',
) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  const userId = await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, $2) RETURNING id`,
      [email, name],
    );
    await tx.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(tx, u.id, role, role === 'employee' ? { type: 'self' } : { type: 'all' });
    if (role !== 'employee') await assignRole(tx, u.id, 'employee', { type: 'self' });
    return u.id;
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: owner.slug, email, password: PASSWORD },
    remoteAddress: `10.61.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
  return { cookie: cookieFrom(res), userId, email };
}

/**
 * A custom, non-admin role that may contact Thapsus-HR support (ADR-0163: built-in employees and
 * managers ask their own HR team instead). Returns its key for `userSession`.
 */
export async function supportContactRole(ctx: TestContext, owner: { tenantId: string }) {
  await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
    tx.exec(
      `INSERT INTO app.roles (tenant_id, key, name, built_in, is_admin, permissions)
       VALUES (app.current_tenant(), 'support_contact', 'Fictional support contact', false, false, ARRAY['support.ticket', 'help.read'])
       ON CONFLICT (tenant_id, key) DO NOTHING`,
    ),
  );
  return 'support_contact';
}

/** Staff sign-in: password, then the mandatory TOTP step. */
export async function staffSession(ctx: TestContext, role: StaffRole, verify = true) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@thapsus.example.test`;
  const s = await createStaff(ctx.app, email, 'Fictional Staff Member', role);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/backoffice/auth/login',
    payload: { email, password: s.password },
    remoteAddress: `10.62.${Math.floor(Math.random() * 250)}.1`,
  });
  if (login.statusCode !== 200) throw new Error(`staff login ${login.statusCode} ${login.body}`);
  const cookie = `${STAFF_COOKIE}=${String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]}`;
  if (verify) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/v1/backoffice/auth/totp',
      headers: { cookie },
      payload: { code: totpCode(s.totpSecret, ctx.clock.now) },
    });
    if (r.statusCode !== 204) throw new Error(`staff totp ${r.statusCode} ${r.body}`);
  }
  return { cookie, staffId: s.id, email, totpSecret: s.totpSecret };
}

/** Runs the queued jobs of one kind for a tenant (as the worker would) and marks them done. */
export async function runQueued(ctx: TestContext, tenantId: string, kind: string) {
  const jobs = await withTenant(ctx.deps.router, tenantId, (tx) =>
    tx.query<JobRow>(
      `SELECT id, tenant_id, kind, idempotency_key, input, attempts, created_by FROM app.jobs WHERE kind = $1 AND status = 'queued' ORDER BY created_at`,
      [kind],
    ),
  );
  const results: unknown[] = [];
  for (const job of jobs) {
    results.push(
      await jobHandlers[kind]!({
        tenantId,
        job,
        deps: ctx.deps,
        tx: (fn) => withTenant(ctx.deps.router, tenantId, fn),
        progress: async () => undefined,
      }),
    );
    await withTenant(ctx.deps.router, tenantId, (tx) =>
      tx.exec(`UPDATE app.jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [job.id]),
    );
  }
  return results;
}

/** Runs a job handler directly with a synthetic job row. */
export async function runJob(
  ctx: TestContext,
  tenantId: string,
  kind: string,
  input: Record<string, unknown> = {},
) {
  return jobHandlers[kind]!({
    tenantId,
    job: { id: 'j', tenant_id: tenantId, kind, idempotency_key: 'k', input, attempts: 1, created_by: null },
    deps: ctx.deps,
    tx: (fn) => withTenant(ctx.deps.router, tenantId, fn),
    progress: async () => undefined,
  });
}

/** A Stripe-style event signed with the official SDK test helper. */
export function signedEvent(
  ctx: TestContext,
  type: string,
  object: Record<string, unknown>,
  id = `evt_test_${Math.random().toString(36).slice(2, 14)}`,
  secret = WEBHOOK_SECRET,
) {
  const payload = JSON.stringify({
    id,
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: Math.floor(ctx.clock.now.getTime() / 1000),
    type,
    data: { object },
  });
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: Math.floor(ctx.clock.now.getTime() / 1000),
  });
  return { id, payload, header };
}

export async function postWebhook(ctx: TestContext, e: { payload: string; header: string }) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/billing/webhooks/stripe',
    payload: e.payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': e.header },
  });
}

export const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
