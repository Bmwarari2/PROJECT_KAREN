import { withTenant, type JobRow, type Tx } from '@thapsus/db';
import { cookieFrom, ownerSession, PASSWORD, type TestContext } from './helpers';
import { assignRole, loadPrincipal } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers, periodic } from '../src/worker';
import { Vault } from '../src/modules/vault/service';
import { loadTarget } from '../src/modules/employees/service';

/**
 * A fictional company with UK, California and Texas sites, used by the privacy integration tests.
 * Every name, email and number is invented.
 */
export async function privacyCompany(ctx: TestContext) {
  const owner = await ownerSession(ctx);
  const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) =>
    ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(ctx.deps.router, owner.tenantId, fn);
  const post = async (url: string, body: unknown) => {
    const r = await api('POST', url, body);
    if (r.statusCode >= 300) throw new Error(`${url} ${r.statusCode} ${r.body}`);
    return r.json().id as string;
  };
  const gb = await post('/v1/org/legal-entities', {
    name: 'Fictional Widgets Ltd',
    country: 'GB',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  const us = await post('/v1/org/legal-entities', {
    name: 'Fictional Widgets Inc',
    country: 'US',
    currency: 'USD',
    timeZone: 'America/Los_Angeles',
  });
  const london = await post('/v1/org/locations', {
    name: 'London studio',
    entityId: gb,
    country: 'GB',
    regionCode: 'GB-ENG',
    timeZone: 'Europe/London',
  });
  const sf = await post('/v1/org/locations', {
    name: 'San Francisco studio',
    entityId: us,
    country: 'US',
    regionCode: 'US-CA',
    timeZone: 'America/Los_Angeles',
  });
  const austin = await post('/v1/org/locations', {
    name: 'Austin studio',
    entityId: us,
    country: 'US',
    regionCode: 'US-TX',
    timeZone: 'America/Chicago',
  });
  const sites = {
    london: { entityId: gb, locationId: london, currency: 'GBP' },
    sf: { entityId: us, locationId: sf, currency: 'USD' },
    austin: { entityId: us, locationId: austin, currency: 'USD' },
  } as const;

  let n = 0;
  async function hire(site: keyof typeof sites = 'london', values: Record<string, unknown> = {}) {
    n++;
    const s = sites[site];
    const res = await api('POST', '/v1/employees', {
      startDate: '2024-03-04',
      legalFirstName: 'Fictional',
      legalLastName: `Person${n}${Math.random().toString(36).slice(2, 6)}`,
      personalEmail: `person${n}.${Math.random().toString(36).slice(2, 6)}@home.example.test`,
      dateOfBirth: '1990-01-01',
      jobTitle: 'Analyst',
      entityId: s.entityId,
      locationId: s.locationId,
      payAmountMinor: 3_000_000,
      payCurrency: s.currency,
      payFrequency: 'annual',
      contractType: 'permanent',
      ...values,
    });
    if (res.statusCode !== 201) throw new Error(`hire ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  }

  /** Creates a sign-in for an employee with a role and returns its session cookie. */
  async function loginAs(employeeId: string | null, role: string) {
    const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
    const userId = await tx(async (t) => {
      const u = await t.one<{ id: string }>(
        `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`,
        [email, employeeId],
      );
      await t.exec(
        'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
        [u.id, await hashPassword(PASSWORD)],
      );
      await assignRole(t, u.id, role, { type: role === 'employee' ? 'self' : 'all' });
      return u.id;
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email, password: PASSWORD },
      remoteAddress: `10.81.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
    });
    return { userId, email, cookie: cookieFrom(res) };
  }

  /** Stores a sensitive value for the employee through the vault (as the owner). */
  async function putSensitive(
    employeeId: string,
    category: 'sickness' | 'immigration' | 'diversity',
    field: string,
    value: string,
  ) {
    const vault = new Vault(ctx.deps.keys);
    return tx(async (t) =>
      vault.put(
        t,
        { principal: await loadPrincipal(t, owner.userId), actorType: 'user' },
        owner.tenantId,
        await loadTarget(t, employeeId),
        category,
        field,
        value,
      ),
    );
  }

  /** Runs the queued jobs of a kind (optionally only those whose idempotency key starts with a prefix) like the worker would, progress included, returning their results. */
  async function runQueued(kind: string, keyPrefix = '') {
    const jobs = await tx((t) =>
      t.query<JobRow>(
        `UPDATE app.jobs SET status = 'running', attempts = attempts + 1 WHERE status = 'queued' AND kind = $1 AND starts_with(idempotency_key, $2) RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`,
        [kind, keyPrefix],
      ),
    );
    const out: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const result =
        (await jobHandlers[kind]!({
          tenantId: owner.tenantId,
          job,
          deps: ctx.deps,
          tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn, { actorId: job.created_by }),
          progress: (d, total) =>
            tx((t) =>
              t.exec(
                'UPDATE app.jobs SET progress_done = $2, progress_total = coalesce($3, progress_total) WHERE id = $1',
                [job.id, d, total ?? null],
              ),
            ).then(() => undefined),
        })) ?? {};
      out.push(result);
      await tx((t) =>
        t.exec(`UPDATE app.jobs SET status = 'succeeded', result = $2 WHERE id = $1`, [
          job.id,
          JSON.stringify(result),
        ]),
      ).catch(() => undefined);
    }
    return out;
  }

  /** Runs a job handler directly with the given input (periodic jobs keyed by date). */
  async function runJob(
    kind: string,
    input: Record<string, unknown>,
    createdBy: string | null = owner.userId,
  ) {
    const job: JobRow = {
      id: crypto.randomUUID(),
      tenant_id: owner.tenantId,
      kind,
      idempotency_key: `test:${Math.random()}`,
      input,
      attempts: 1,
      created_by: createdBy,
    };
    return (
      (await jobHandlers[kind]!({
        tenantId: owner.tenantId,
        job,
        deps: ctx.deps,
        tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn),
        progress: async () => undefined,
      })) ?? {}
    );
  }

  /** Runs every registered periodic hook for this tenant at a fixed instant, as the worker's sweep does (no real clock). */
  async function runPeriodic(at: string) {
    const now = new Date(at);
    await tx(async (t) => {
      for (const hook of periodic) await hook(t, now);
    });
  }

  /** The tenant's jobs of a kind (optionally only idempotency keys starting with a prefix), ordered by key. */
  const jobsOf = (kind: string, keyPrefix = '') =>
    tx((t) =>
      t.query<{
        id: string;
        idempotency_key: string;
        input: Record<string, unknown>;
        status: string;
        created_by: string | null;
      }>(
        `SELECT id, idempotency_key, input, status, created_by FROM app.jobs WHERE kind = $1 AND starts_with(idempotency_key, $2) ORDER BY idempotency_key`,
        [kind, keyPrefix],
      ),
    );

  return { owner, api, tx, sites, hire, loginAs, putSensitive, runQueued, runJob, runPeriodic, jobsOf };
}

export type PrivacyCompany = Awaited<ReturnType<typeof privacyCompany>>;
