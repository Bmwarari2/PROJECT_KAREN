import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { withTenant, type JobRow } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  randomIp,
  startTestApp,
  type TestContext,
} from './helpers';
import { jobHandlers } from '../src/worker';
import { CONFIG_TABLES, TABLE_CLASSES } from '../src/modules/platform/sandbox-tables';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * Phase 9.4 — sandbox tenants are created from production CONFIGURATION with SYNTHETIC people only.
 *  1. every tenant table is classified (config / personal / operational / secret) — a new table fails here;
 *  2. configuration tables are copied (person references removed);
 *  3. no personal data is copied: every personal-data column of the source is compared against the
 *     sandbox (zero overlap of names, emails and identifiers), and personal, operational and secret
 *     tables never receive source rows.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let db: pg.Client;
let sandbox: { id: string; sandboxTenantId: string; slug: string };
const api = (method: string, url: string, payload?: unknown, cookie = owner.cookie) =>
  ctx.app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    headers: { cookie },
    remoteAddress: randomIp(),
  });
const src = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);

/** Personal-data columns of the personal tables the sandbox populates (compared value by value). */
const PERSONAL_COLUMNS: Record<string, string[]> = {
  'app.employees': ['id', 'employee_number', 'work_email', 'work_phone', 'display_name', 'preferred_name'],
  'app.employee_personal': [
    'id',
    'employee_id',
    'legal_first_name',
    'legal_last_name',
    'preferred_name',
    'pronouns',
    'personal_email',
    'personal_phone',
    'date_of_birth',
    'address',
  ],
  'app.employee_jobs': ['id', 'employee_id'],
  'app.employee_pay': ['id', 'employee_id'],
  'app.employee_contracts': ['id', 'employee_id'],
  'app.reporting_lines': ['id', 'employee_id', 'manager_id'],
  'app.users': ['id', 'email', 'display_name', 'external_id', 'employee_id'],
  'app.role_assignments': ['id', 'user_id'],
  'audit.events': ['id', 'actor_id', 'request_id', 'ip', 'user_agent'],
};
/** Columns of those tables that are not personal (categorical values the generator may share). */
const NON_PERSONAL = new Set([
  'tenant_id',
  'status',
  'start_date',
  'end_date',
  'job_title',
  'department_id',
  'location_id',
  'entity_id',
  'country',
  'region_code',
  'manager_id',
  'time_zone',
  'search',
  'current_as_of',
  'created_at',
  'updated_at',
  'valid_from',
  'valid_to',
  'nationality',
  'created_by',
  'position_id',
  'cost_centre_id',
  'grade_id',
  'employment_type',
  'fte',
  'weekly_hours',
  'work_pattern',
  'flsa_status',
  'reason',
  'amount_minor',
  'currency',
  'frequency',
  'contract_type',
  'notice_period_days',
  'probation_end_date',
  'leaver_type',
  'notification_prefs',
  'document_id',
  'kind',
  'locale',
  'scim_managed',
  'failed_attempts',
  'locked_until',
  'last_login_at',
  'role_id',
  'scope_type',
  'scope_values',
  'at',
  'actor_type',
  'action',
  'target_type',
  'target_id',
  'diff',
  'sensitive',
  'seq',
  'prev_hash',
  'hash',
]);

async function drainSandboxJob() {
  const jobs = await src((t) =>
    t.query<JobRow>(
      `UPDATE app.jobs SET status = 'running', attempts = attempts + 1 WHERE kind = 'sandbox.create' AND status = 'queued' RETURNING id, tenant_id, kind, idempotency_key, input, attempts, created_by`,
    ),
  );
  for (const job of jobs) {
    const result = await jobHandlers[job.kind]!({
      tenantId: owner.tenantId,
      job,
      deps: ctx.deps,
      tx: (fn) => src(fn),
      progress: async () => undefined,
    });
    await src((t) =>
      t.exec(`UPDATE app.jobs SET status = 'succeeded', result = $2 WHERE id = $1`, [
        job.id,
        JSON.stringify(result ?? {}),
      ]),
    );
  }
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  db = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await db.connect();

  // ---- production configuration -------------------------------------------------------------------
  const entity = (
    await api('POST', '/v1/org/legal-entities', {
      name: 'Fictional Sandbox Source Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
      registrationNumber: '00000001',
    })
  ).json();
  const location = (
    await api('POST', '/v1/org/locations', {
      name: 'Fictional HQ',
      entityId: entity.id,
      country: 'GB',
      timeZone: 'Europe/London',
    })
  ).json();
  const parent = (await api('POST', '/v1/org/departments', { name: 'Operations' })).json();
  await api('POST', '/v1/org/departments', { name: 'Warehouse', parentId: parent.id });
  await api('POST', '/v1/org/grades', {
    code: 'G1',
    name: 'Grade one',
    currency: 'GBP',
    minMinor: 2_000_000,
    maxMinor: 3_000_000,
  });
  await api('POST', '/v1/org/cost-centres', { code: 'CC1', name: 'Central', entityId: entity.id });
  await api('POST', '/v1/org/positions', {
    title: 'Picker',
    departmentId: parent.id,
    entityId: entity.id,
    locationId: location.id,
  });
  await src(async (t) => {
    await t.exec(
      `INSERT INTO app.roles (tenant_id, key, name, is_admin, permissions, field_access) VALUES (app.current_tenant(), 'site_lead', 'Site lead', false, '{employees.read,rota.*}', '{"employee.*":"read"}')`,
    );
    await t.exec(
      `INSERT INTO app.custom_field_definitions (tenant_id, entity_type, key, label, field_type) VALUES (app.current_tenant(), 'employee', 'shoe_size', '{"en-GB":"Shoe size"}', 'number')`,
    );
    await t.exec(
      `INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), 'leave', 'Leave approval', $1)`,
      [
        JSON.stringify([
          { approver: { type: 'user', value: owner.userId } },
          { approver: { type: 'manager' } },
        ]),
      ],
    );
    await t.exec(
      `INSERT INTO app.workflow_templates (tenant_id, kind, name, tasks) VALUES (app.current_tenant(), 'onboarding', 'Starter', $1)`,
      [JSON.stringify([{ title: 'Order laptop', assignee: { type: 'user', value: owner.userId } }])],
    );
    await t.exec(
      `INSERT INTO app.rota_templates (tenant_id, name, location_id, slots) VALUES (app.current_tenant(), 'Week', $1, $2)`,
      [
        location.id,
        JSON.stringify([{ weekday: 1, start: '09:00', end: '17:00', employeeId: crypto.randomUUID() }]),
      ],
    );
    await t.exec(
      `INSERT INTO app.automation_rules (tenant_id, name, trigger, conditions, actions, created_by) VALUES (app.current_tenant(), 'Notify', '{"event":"employee.created"}', '[]', $1, $2)`,
      [JSON.stringify([{ type: 'notify', userId: owner.userId }]), owner.userId],
    );
    await t.exec(
      `UPDATE app.tenants SET features = jsonb_set(features, '{flags}', '{"webhooks": false}'), security = security || '{"ssoEnforced": true, "sessionIdleMinutes": 45}'`,
    );
    // secrets and integrations that must never reach a sandbox
    await t.exec(
      `INSERT INTO app.sso_connections (tenant_id, protocol, name, config) VALUES (app.current_tenant(), 'oidc', 'Prod IdP', '{"clientSecret":"fictional"}')`,
    );
  });
  await api('POST', '/v1/settings/domains', { domain: `${owner.slug}.example.test` });
  await api('POST', '/v1/webhooks', {
    url: 'https://hooks.example.com/prod',
    eventTypes: ['employee.created'],
  });
  await api('POST', '/v1/settings/api-keys', {
    name: 'Prod key',
    scopes: ['employees:read'],
    roleKey: 'hr_admin',
  });
  const objects = ctx.deps.objects as MemoryObjectStore;
  await objects.put(
    `${owner.tenantId}/branding/logo-fixture.png`,
    Buffer.from('fictional-logo'),
    'image/png',
  );
  await src((t) =>
    t.exec(
      `UPDATE app.tenants SET branding = '{"accentLight":"#1f3a8a","logo":{"key":"${owner.tenantId}/branding/logo-fixture.png","contentType":"image/png","bytes":14,"sha256":"00","updatedAt":"2026-10-01T00:00:00Z"}}'`,
    ),
  );

  // ---- production people (fictional) --------------------------------------------------------------
  const names: Array<[string, string]> = [
    ['Amelia', 'Thornbury'],
    ['Rohan', 'Castellane'],
    ['Ingrid', 'Ashworth'],
    ['Tobias', 'Fernleigh'],
    ['Avery', 'Example'],
  ];
  for (const [i, [first, last]] of names.entries()) {
    const e = await api('POST', '/v1/employees', {
      startDate: '2025-04-01',
      legalFirstName: first,
      legalLastName: last,
      preferredName: `${first[0]}.`,
      workEmail: `${first}.${last}@source.example.test`.toLowerCase(),
      personalEmail: `${first}${i}@home.example.test`.toLowerCase(),
      personalPhone: `+44 7700 900${String(100 + i)}`,
      dateOfBirth: '1990-01-0' + (i + 1),
      entityId: entity.id,
      jobTitle: 'Analyst',
      payAmountMinor: 3_000_000,
      payCurrency: 'GBP',
      payFrequency: 'annual',
      contractType: 'permanent',
      employeeNumber: `SRC${i + 1}`,
    });
    expect(e.statusCode, e.body).toBe(201);
    await api('PUT', `/v1/employees/${e.json().id}/emergency-contacts`, [
      { name: `${last} Relative`, relationship: 'sibling', phone: '+44 7700 900999' },
    ]);
  }
});
afterAll(async () => {
  await db.end();
  await ctx.close();
  await closeDb();
});

describe('table classification', () => {
  it('classifies every tenant-scoped table (a new table must be classified as config, personal, operational or secret)', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('app', 'vault', 'audit') ORDER BY 1`,
    );
    const unclassified = rows.map((r) => r.name).filter((t) => !(t in TABLE_CLASSES));
    expect(unclassified, 'add these tables to apps/api/src/modules/platform/sandbox-tables.ts').toEqual([]);
    const stale = Object.keys(TABLE_CLASSES).filter((t) => !rows.some((r) => r.name === t));
    expect(stale).toEqual([]);
    for (const t of CONFIG_TABLES) expect(TABLE_CLASSES[t]).toBe('config');
  });
});

describe('creating a sandbox', () => {
  it('copies configuration only and generates synthetic people', async () => {
    const res = await api('POST', '/v1/sandboxes', { syntheticPeople: 30 });
    expect(res.statusCode, res.body).toBe(202);
    sandbox = res.json();
    expect(res.json().status).toBe('creating');
    await drainSandboxJob();
    const ready = (await api('GET', `/v1/sandboxes/${sandbox.id}`)).json();
    expect(ready.status).toBe('ready');
    expect(ready.report.syntheticPeople).toBe(30);
    expect(ready.report.copied['app.approval_policies']).toBe(1);

    const sb = sandbox.sandboxTenantId;
    const count = async (table: string, tenant: string) =>
      Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0].n);
    // configuration copied with the same identifiers (custom roles only; built-in roles are seeded)
    for (const table of CONFIG_TABLES) {
      if (table === 'app.tenants' || table === 'app.roles') continue;
      expect(await count(table, sb), table).toBe(await count(table, owner.tenantId));
    }
    expect(
      (await db.query(`SELECT key FROM app.roles WHERE tenant_id = $1 AND NOT built_in`, [sb])).rows,
    ).toEqual([{ key: 'site_lead' }]);
    const t = (
      await db.query(`SELECT kind, security, branding, features FROM app.tenants WHERE tenant_id = $1`, [sb])
    ).rows[0];
    expect(t.kind).toBe('sandbox');
    expect(t.security).toMatchObject({ ssoEnforced: false, sessionIdleMinutes: 45 });
    expect(t.features.flags).toMatchObject({ webhooks: false, sandboxes: false });
    expect(t.branding.accentLight).toBe('#1f3a8a');
    expect(t.branding.logo.key.startsWith(`${sb}/branding/`)).toBe(true);
    // person references are removed from copied configuration
    const steps = (await db.query(`SELECT steps FROM app.approval_policies WHERE tenant_id = $1`, [sb]))
      .rows[0].steps;
    expect(steps[0].approver).toEqual({ type: 'role', value: 'hr_admin' });
    expect(
      JSON.stringify(
        (await db.query(`SELECT tasks FROM app.workflow_templates WHERE tenant_id = $1`, [sb])).rows[0].tasks,
      ),
    ).not.toContain(owner.userId);
    expect(
      (await db.query(`SELECT slots FROM app.rota_templates WHERE tenant_id = $1`, [sb])).rows[0].slots[0]
        .employeeId,
    ).toBeNull();
    const rule = (
      await db.query(`SELECT created_by, actions FROM app.automation_rules WHERE tenant_id = $1`, [sb])
    ).rows[0];
    expect(rule.created_by).toBeNull();
    expect(JSON.stringify(rule.actions)).not.toContain(owner.userId);
  });

  it('copies NO personal data: zero overlap in every personal-data column, and no source rows in personal, operational or secret tables', async () => {
    const sb = sandbox.sandboxTenantId;
    // every text-like column of the compared personal tables is either personal (compared) or explicitly non-personal
    for (const [table, cols] of Object.entries(PERSONAL_COLUMNS)) {
      const { rows } = await db.query<{ c: string; t: string }>(
        `SELECT attname AS c, format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`,
        [table],
      );
      for (const { c } of rows)
        expect(cols.includes(c) || NON_PERSONAL.has(c), `${table}.${c} must be classified in this test`).toBe(
          true,
        );
      for (const col of cols) {
        const values = async (tenant: string) =>
          new Set(
            (
              await db.query(
                `SELECT DISTINCT lower(${col}::text) AS v FROM ${table} WHERE tenant_id = $1 AND ${col} IS NOT NULL`,
                [tenant],
              )
            ).rows.map((r) => r.v as string),
          );
        const [a, b] = [await values(owner.tenantId), await values(sb)];
        const overlap = [...a].filter((v) => b.has(v));
        expect(overlap, `${table}.${col} overlaps between source and sandbox`).toEqual([]);
      }
    }
    // names: no synthetic first or last name equals any source name
    const sourceNames = (
      await db.query(
        `SELECT lower(legal_first_name) AS f, lower(legal_last_name) AS l FROM app.employee_personal WHERE tenant_id = $1`,
        [owner.tenantId],
      )
    ).rows;
    const sandboxNames = (
      await db.query(
        `SELECT lower(legal_first_name) AS f, lower(legal_last_name) AS l FROM app.employee_personal WHERE tenant_id = $1`,
        [sb],
      )
    ).rows;
    expect(sandboxNames).toHaveLength(30);
    expect(sourceNames).toHaveLength(5); // the comparison is meaningful: the source really holds people
    expect(
      Number(
        (
          await db.query(`SELECT count(*) AS n FROM app.emergency_contacts WHERE tenant_id = $1`, [
            owner.tenantId,
          ])
        ).rows[0].n,
      ),
    ).toBe(5);
    const all = new Set(sourceNames.flatMap((r) => [r.f, r.l]));
    expect(sandboxNames.filter((r) => all.has(r.f) || all.has(r.l))).toEqual([]);
    // identifiers: no row id of any personal table is shared
    for (const [table, cls] of Object.entries(TABLE_CLASSES)) {
      if (cls === 'config') continue;
      const hasId = (
        await db.query(
          `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'id' AND NOT attisdropped`,
          [table],
        )
      ).rowCount;
      if (hasId) {
        const shared = await db.query(
          `SELECT count(*)::int AS n FROM ${table} s JOIN ${table} p ON p.id = s.id WHERE s.tenant_id = $1 AND p.tenant_id = $2`,
          [sb, owner.tenantId],
        );
        expect(shared.rows[0].n, `${table} shares row ids with the source`).toBe(0);
      }
      // operational and secret tables start empty, and personal tables the generator does not fill stay empty
      const generated = [
        'app.employees',
        'app.employee_personal',
        'app.employee_jobs',
        'app.employee_pay',
        'app.employee_contracts',
        'app.reporting_lines',
        'app.users',
        'app.role_assignments',
        'audit.events',
        'audit.chain_heads',
      ];
      if (!generated.includes(table))
        expect(
          Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [sb])).rows[0].n),
          `${table} must be empty in a new sandbox`,
        ).toBe(0);
    }
    // the only sandbox user is its synthetic owner; the sandbox's audit trail starts fresh
    expect((await db.query(`SELECT email FROM app.users WHERE tenant_id = $1`, [sb])).rows).toEqual([
      { email: `owner@${sandbox.slug}.sandbox.example` },
    ]);
    expect(
      (await db.query(`SELECT action FROM audit.events WHERE tenant_id = $1`, [sb])).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['tenant.sandbox_created']);
  });

  it('opens with a one-time sign-in link for the synthetic owner (MFA enrolment required) and shows only synthetic people', async () => {
    const link = await api('POST', `/v1/sandboxes/${sandbox.id}/sign-in-link`);
    expect(link.statusCode, link.body).toBe(200);
    const token = new URL(link.json().url).searchParams.get('token')!;
    const consume = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token },
      remoteAddress: randomIp(),
    });
    expect(consume.statusCode, consume.body).toBe(200);
    expect(consume.json()).toMatchObject({ tenantId: sandbox.sandboxTenantId, mfaEnrollmentRequired: true });
    const cookie = cookieFrom(consume);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/magic-link/consume',
          payload: { token },
          remoteAddress: randomIp(),
        })
      ).statusCode,
    ).toBe(401);
    await enrolTotp(ctx, cookie);
    const people = (await api('GET', '/v1/employees?limit=200', undefined, cookie)).json();
    expect(people.data).toHaveLength(30);
    expect(JSON.stringify(people)).not.toMatch(
      /Thornbury|Castellane|Ashworth|Fernleigh|source\.example\.test/,
    );
    // no sandbox inside a sandbox
    expect((await api('POST', '/v1/sandboxes', {}, cookie)).statusCode).toBe(403);
  });
});
