import { expect } from 'vitest';
import { withTenant, type JobRow, type Tx } from '@thapsus/db';
import { cookieFrom, enrolTotp, ownerSession, PASSWORD, randomIp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { eventSubscribers, jobHandlers } from '../src/worker';

/** A fictional UK company for the payroll, payslip, IT and asset tests. All people and data are invented. */
export async function phase6Company(ctx: TestContext) {
  const owner = await ownerSession(ctx);
  const api = (
    method: string,
    url: string,
    payload?: unknown,
    cookie = owner.cookie,
    headers: Record<string, string> = {},
  ) =>
    ctx.app.inject({
      method: method as 'GET',
      url,
      payload: payload as object,
      headers: { cookie, ...headers },
      remoteAddress: randomIp(),
    });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(ctx.deps.router, owner.tenantId, fn);
  const post = async (url: string, body: unknown) => {
    const r = await api('POST', url, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const entity = await post('/v1/org/legal-entities', {
    name: 'Fictional Payroll UK Ltd',
    country: 'GB',
    regionCode: 'GB-ENG',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  const london = await post('/v1/org/locations', {
    name: 'Fictional Office London',
    country: 'GB',
    regionCode: 'GB-ENG',
    timeZone: 'Europe/London',
    entityId: entity,
  });
  let n = 0;
  async function hire(v: Record<string, unknown> = {}) {
    n++;
    const r = await api('POST', '/v1/employees', {
      startDate: '2024-01-08',
      legalFirstName: `Person${n}`,
      legalLastName: 'Fictional',
      jobTitle: 'Analyst',
      entityId: entity,
      locationId: london,
      weeklyHours: 40,
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
      ...v,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  async function login(
    employeeId: string | null,
    role = 'employee',
    scope: { type: 'self' | 'own_team' | 'all' } = {
      type: role === 'manager' ? 'own_team' : role === 'employee' ? 'self' : 'all',
    },
  ) {
    const email = `${role}.${Math.random().toString(36).slice(2, 8)}@${owner.slug}.example.test`;
    await tx(async (t) => {
      const u = await t.one<{ id: string }>(
        `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`,
        [email, employeeId],
      );
      await t.exec(
        'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
        [u.id, await hashPassword(PASSWORD)],
      );
      await assignRole(t, u.id, role, scope);
      if (role !== 'employee' && employeeId) await assignRole(t, u.id, 'employee', { type: 'self' });
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email, password: PASSWORD },
      remoteAddress: randomIp(),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const cookie = cookieFrom(res);
    if (['payroll_admin', 'hr_admin', 'entity_hr_admin', 'owner'].includes(role))
      await enrolTotp(ctx, cookie);
    return cookie;
  }

  /** Runs outbox subscribers and every job due by `now` (default: the later of the test clock and real time), like the worker. */
  async function drain(now: Date = new Date(Math.max(ctx.clock.now.getTime(), Date.now()) + 1000)) {
    const ran: JobRow[] = [];
    for (let round = 0; round < 10; round++) {
      const events = await tx((t) =>
        t.query<{
          id: string;
          topic: string;
          aggregate_type: string | null;
          aggregate_id: string | null;
          payload: Record<string, unknown>;
          created_at: string;
        }>(
          `UPDATE app.outbox SET published_at = now() WHERE published_at IS NULL RETURNING id, topic, aggregate_type, aggregate_id, payload, created_at`,
        ),
      );
      for (const ev of events.sort((a, b) => Number(a.id) - Number(b.id))) {
        for (const [pattern, subs] of Object.entries(eventSubscribers)) {
          if (pattern === ev.topic || (pattern.endsWith('.*') && ev.topic.startsWith(pattern.slice(0, -1)))) {
            for (const s of subs)
              await tx((t) =>
                s(t, {
                  tenantId: owner.tenantId,
                  id: ev.id,
                  topic: ev.topic,
                  aggregateType: ev.aggregate_type,
                  aggregateId: ev.aggregate_id,
                  payload: ev.payload,
                  createdAt: ev.created_at,
                }),
              );
          }
        }
      }
      const jobs = await tx((t) =>
        t.query<JobRow>(
          `UPDATE app.jobs SET status = 'running', attempts = attempts + 1 WHERE status = 'queued' AND run_after <= $1 RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`,
          [now.toISOString()],
        ),
      );
      if (!events.length && !jobs.length) return ran;
      for (const job of jobs.sort((a, b) => (a.kind < b.kind ? -1 : 1))) {
        try {
          const result = await jobHandlers[job.kind]!({
            tenantId: owner.tenantId,
            job,
            deps: ctx.deps,
            tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn, { actorId: job.created_by }),
            progress: async () => undefined,
          });
          await tx((t) =>
            t.exec(`UPDATE app.jobs SET status = 'succeeded', result = $2 WHERE id = $1`, [
              job.id,
              JSON.stringify(result ?? {}),
            ]),
          );
        } catch (err) {
          await tx((t) =>
            t.exec(`UPDATE app.jobs SET status = 'failed', error = $2 WHERE id = $1`, [
              job.id,
              String((err as Error).message).slice(0, 500),
            ]),
          );
        }
        ran.push(job);
      }
    }
    return ran;
  }
  return { owner, api, tx, post, hire, login, drain, entity, london };
}
export type Phase6Company = Awaited<ReturnType<typeof phase6Company>>;

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  json?: unknown;
  form?: Record<string, string>;
}
export type MockResponse = { status: number; json?: unknown };

/**
 * A fake `fetch` for provider APIs: routes by method + URL to handlers and records every request, so
 * tests assert the exact request shapes sent to Xero, Microsoft Graph and the Google Admin SDK.
 */
export function mockProviders() {
  const calls: RecordedCall[] = [];
  const routes: Array<{
    method: string;
    pattern: RegExp;
    handler: (call: RecordedCall, m: RegExpExecArray) => MockResponse | Promise<MockResponse>;
  }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    const body = typeof init.body === 'string' ? init.body : undefined;
    const call: RecordedCall = { method: init.method ?? 'GET', url, headers, body };
    if (body && headers['content-type']?.includes('json')) call.json = JSON.parse(body);
    if (body && headers['content-type']?.includes('x-www-form-urlencoded'))
      call.form = Object.fromEntries(new URLSearchParams(body));
    calls.push(call);
    for (const r of routes) {
      const m = r.pattern.exec(url);
      if (m && r.method === call.method) {
        const res = await r.handler(call, m);
        return new Response(res.json === undefined ? null : JSON.stringify(res.json), {
          status: res.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'NotMocked' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    on(
      method: string,
      pattern: RegExp,
      handler: (call: RecordedCall, m: RegExpExecArray) => MockResponse | Promise<MockResponse>,
    ) {
      routes.unshift({ method, pattern, handler });
    },
    reset() {
      calls.length = 0;
    },
  };
}
export type MockProviders = ReturnType<typeof mockProviders>;
