import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { withTenant } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import type { ScopeType } from '@thapsus/core/permissions';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { LOGIN_ROLES, MIN_SIZE, type LoginRole, type StagingLogin } from '../src/cli/staging/config';
import { seedStaging } from '../src/cli/staging/seed';
import { hashPassword } from '../src/modules/auth/tokens';
import { assignRole } from '../src/modules/authz/principal';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  startTestApp,
  uniq,
  type TestContext,
} from './helpers';
import { legalEntity } from './phase10-helpers';

/**
 * Broken object level authorisation (IDOR/BOLA, OWASP API1; plan §5): generated from the published OpenAPI
 * document. Every operation that addresses an object by id is called
 *
 *  - as every built-in role of workspace A (a fresh sign-up) with the real ids of workspace B (the seeded
 *    fictional company): another tenant; and
 *  - as B's own scoped roles (manager: own team; employee: self; entity HR admin: one legal entity) with the
 *    ids of people outside their scope and of those people's records: another team,
 *
 * with a body generated from the operation's schema. Each answer must be a refusal (4xx), never a success
 * or a server error, and must not contain a foreign id it was not sent or a planted personal-data
 * sentinel; afterwards workspace B's rows are byte-for-byte unchanged. A new route whose id cannot be
 * mapped to a table fails the walk until it is mapped here. Fictional data only (the staging seed).
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SENTINEL = {
  pay: 7_314_159,
  email: 'bola.sentinel@personal.example.test',
  phone: '+44 7700 900417',
  contact: 'Sentinel Contact Bola',
};
const SENTINELS = [String(SENTINEL.pay), SENTINEL.email, SENTINEL.phone, SENTINEL.contact];

/**
 * Path params that do not address a tenant object: they take a fixed, valid value and do not make an
 * operation id-addressed on their own.
 */
const VALUE_PARAMS: Record<string, string> = {
  provider: 'google_workspace',
  jurisdiction: 'GB',
  key: 'ask_hr',
  template: 'employee',
  slug: 'getting-started',
  weekStart: '2026-10-19',
  ruleId: 'THR-CRED-001',
};

/**
 * Where the literal path segment does not name the table, keyed by the path up to and including the param.
 * `staff` objects live in the back office (never a workspace's); `global` objects are Thapsus-HR's own
 * published content, the same for every workspace.
 */
type Target = string | { staff: true } | { global: string };
const TABLE_FOR: Record<string, Target> = {
  '/v1/auth/sso/saml/metadata/{tenantId}/{connectionId}': 'app.sso_connections',
  '/v1/settings/domains/{id}': 'app.verified_domains',
  '/v1/org-chart/{id}': 'app.employees',
  '/v1/hr-requests/{id}': 'app.tasks',
  '/v1/approvals/{id}': 'app.approval_requests',
  '/v1/imports/{id}': 'app.import_batches',
  '/v1/sickness/{id}': 'app.sickness_records',
  '/v1/compliance/right-to-work/checks/{id}': 'app.rtw_checks',
  '/v1/compliance/i9/{id}': 'app.i9_records',
  '/v1/compliance/law-changes/{id}': {
    global: `SELECT id::text FROM backoffice.law_changes WHERE status = 'published' ORDER BY id LIMIT 1`,
  },
  '/v1/payroll/periods/{id}': 'app.pay_periods',
  '/v1/payslips/batches/{id}/items/{itemId}': 'app.payslips',
  '/v1/integrations/it/rules/{id}': 'app.it_mapping_rules',
  '/v1/reports/ready/{id}': { global: `SELECT 'headcount' AS id` },
  '/v1/reports/saved/{id}': 'app.saved_reports',
  '/v1/data-exports/destinations/{id}': 'app.export_destinations',
  '/v1/privacy/requests/{id}': 'app.dsr_requests',
  '/v1/webhooks/{id}': 'app.webhook_endpoints',
  '/v1/support/tickets/{id}/attachments/{attachmentId}': 'app.support_ticket_attachments',
  '/v1/backoffice/support/tickets/{tenantId}/{ticketId}/attachments/{attachmentId}':
    'app.support_ticket_attachments',
  '/v1/backoffice/tenants/{id}': 'app.tenants',
  '/v1/settings/security-centre/alerts/{id}': 'app.security_alerts',
};

/**
 * Operations that may answer 2xx to a foreign id, and why. Their answers are still checked for foreign ids
 * and sentinels; `refused` must also hold for the answer (a batch that refuses item by item).
 */
type Allowance = string | { reason: string; refused: (answer: Json) => boolean };
const BATCH: Record<string, Allowance> = {
  'POST /v1/approvals/bulk': {
    reason: 'a batch decision answers per item: every foreign or out-of-scope item must be in `failed`',
    refused: (a) => (a.succeeded as unknown[]).length === 0,
  },
  'POST /v1/employees/bulk-change': {
    reason: 'a batch change answers per item: nothing updated and nothing sent for approval',
    refused: (a) => a.updated === 0 && a.pendingApproval === 0,
  },
  'POST /v1/people/visibility': {
    reason:
      'answers which of the ids sent the caller may open; it names no record. A caller who may open every profile gets the ids back without a lookup, and opening one then answers 404',
    refused: (a) => a.all === true || (a.visible as unknown[]).length === 0,
  },
};
const SUCCESS_ALLOWED_CROSS_TENANT: Record<string, Allowance> = {
  ...BATCH,
  'POST /v1/settings/support-grants':
    'the id in the body names a Thapsus-HR staff member (back office), not an object of any workspace',
};
const ORG_CHART =
  'the org chart is visible to everyone in the workspace (names, job titles and reporting lines; the personal-data sentinels are still checked)';
const SUCCESS_ALLOWED_TEAM: Record<string, Allowance> = {
  ...BATCH,
  'GET /v1/org-chart/{id}/children': ORG_CHART,
  'GET /v1/org-chart/{id}/focus': ORG_CHART,
};

type Json = Record<string, unknown>;
interface Op {
  method: (typeof METHODS)[number];
  path: string;
  params: Array<{ name: string; schema: Json }>;
  body?: Json;
}
interface Person {
  role: string;
  cookie: string;
}

let ctx: TestContext;
let owner: pg.Client;
let spec: { paths: Record<string, Record<string, Json>>; components?: { schemas?: Record<string, Json> } };
let ops: Op[];
let tables: Map<string, { employeeColumn: string | null }>;
/** The attacker: a fresh sign-up holding every built-in role. Its ids are random. */
const A = { slug: uniq('bola-a'), tenantId: '' };
/**
 * The victim and the team walk's workspace: the staging seed. Its ids are deterministic (the same in every
 * seeded workspace), so a cross-tenant id is always one that A does not hold.
 */
const B = { slug: uniq('bola-b'), tenantId: '' };

const logins = (slug: string): StagingLogin[] =>
  LOGIN_ROLES.map((role) => ({
    role,
    email: `${role.replace('_', '-')}@${slug}.example.test`,
    password: `Harbour-Lantern-${role.length}-${slug}-Qz`,
  }));

async function signIn(slug: string, email: string, password: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: slug, email, password },
    remoteAddress: '10.62.0.1',
  });
  if (res.statusCode !== 200) throw new Error(`sign-in ${email}: ${res.statusCode} ${res.body}`);
  const cookie = cookieFrom(res);
  if ((res.json() as { mfaEnrollmentRequired?: boolean }).mfaEnrollmentRequired) await enrolTotp(ctx, cookie);
  return cookie;
}

const deref = (s: Json | undefined): Json | undefined => {
  let x = s;
  for (let i = 0; x && typeof x.$ref === 'string' && i < 10; i++)
    x = spec.components?.schemas?.[(x.$ref as string).split('/').pop()!];
  return x;
};

/** A small valid value for a JSON schema; uuids come from `id` (the foreign ids under test). */
function sample(raw: Json | undefined, id: () => string, depth = 0): unknown {
  const s = deref(raw);
  if (!s || depth > 8) return undefined;
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum)) return s.enum[0];
  const alt = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (alt) return sample(alt.find((x) => deref(x)?.type !== 'null') ?? alt[0], id, depth + 1);
  if (Array.isArray(s.allOf))
    return Object.assign({}, ...(s.allOf as Json[]).map((x) => sample(x, id, depth + 1) as Json));
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string);
  switch (type) {
    case 'object': {
      const out: Json = {};
      const props = (s.properties ?? {}) as Record<string, Json>;
      for (const k of (s.required ?? []) as string[]) out[k] = sample(props[k], id, depth + 1);
      return out;
    }
    case 'array':
      return Array.from({ length: Number(s.minItems ?? 0) }, () => sample(s.items as Json, id, depth + 1));
    case 'integer':
    case 'number': {
      const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? Number(s.exclusiveMinimum) + 1 : 1);
      return Math.min(Number(min), Number(s.maximum ?? Number.MAX_SAFE_INTEGER));
    }
    case 'boolean':
      return false;
    case 'string': {
      const f = s.format as string | undefined;
      if (f === 'uuid') return id();
      if (f === 'date') return '2026-11-02';
      if (f === 'date-time') return '2026-11-02T09:00:00.000Z';
      if (f === 'email') return 'bola.probe@example.test';
      if (f === 'uri') return 'https://example.test/bola';
      const min = Number(s.minLength ?? 1);
      const candidates = ['GB', 'GBP', '2026-11-02', '09:00', 'Europe/London', 'x'.repeat(Math.max(min, 1))];
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern as string);
        return candidates.find((c) => re.test(c) && c.length >= min) ?? candidates.at(-1);
      }
      return 'Fictional probe'.padEnd(min, 'x');
    }
    default:
      return undefined;
  }
}

/** The table a path param addresses, from the explicit map or the literal segments before it. */
function tableFor(path: string, name: string): Target | undefined {
  const at = path.indexOf(`{${name}}`);
  const upTo = path.slice(0, at + name.length + 2);
  if (TABLE_FOR[upTo]) return TABLE_FOR[upTo];
  if (name === 'employeeId') return 'app.employees';
  if (name === 'userId') return 'app.users';
  if (name === 'tenantId') return 'app.tenants';
  const literals = path
    .slice(0, at)
    .split('/')
    .filter((s) => s && !s.startsWith('{') && s !== 'v1')
    .map((s) => s.replace(/-/g, '_'));
  const [prev, last] = [literals.at(-2), literals.at(-1)];
  const singular = (w?: string) => w?.replace(/s$/, '');
  for (const c of [`${prev}_${last}`, `${singular(prev)}_${last}`, `${last}`])
    if (tables.has(`app.${c}`)) return `app.${c}`;
  if (path.startsWith('/v1/backoffice/')) return { staff: true };
  return undefined;
}

const isObjectParam = (name: string) => !(name in VALUE_PARAMS) && name !== 'typeKey';

/** Whether the generated body sends an id (a required uuid field): the operation then addresses objects too. */
const sendsIds = (op: Op) =>
  op.method !== 'get' &&
  !!op.body &&
  JSON.stringify(sample(op.body, () => crypto.randomUUID()) ?? {}).match(UUID) !== null;
const addressesObjects = (op: Op) => op.params.some((p) => isObjectParam(p.name)) || sendsIds(op);

/** One id of a row the tenant holds in a table (optionally filtered, and not also an id in `notIn`'s rows). */
async function idsOf(
  table: string,
  tenantId: string,
  opts: { where?: string; args?: unknown[]; notIn?: string } = {},
) {
  if (table === 'app.tenants') return [tenantId];
  const args = [tenantId, ...(opts.args ?? [])];
  const not = opts.notIn
    ? ` AND id NOT IN (SELECT id FROM ${table} WHERE tenant_id = $${args.push(opts.notIn)})`
    : '';
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text FROM ${table} WHERE tenant_id = $1 AND ${opts.where ?? 'true'}${not} ORDER BY id LIMIT 1`,
    args,
  );
  return rows.map((r) => r.id);
}

/** Every uuid in a tenant's rows (the ids a leak would carry). */
async function allIds(tenantId: string): Promise<Set<string>> {
  const out = new Set<string>([tenantId]);
  for (const t of tables.keys()) {
    const { rows } = await owner.query<{ id: string }>(`SELECT id::text FROM ${t} WHERE tenant_id = $1`, [
      tenantId,
    ]);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** A digest of every row the tenant holds in the app, vault and audit schemas. */
async function fingerprint(tenantId: string): Promise<Record<string, string>> {
  const { rows: rels } = await owner.query<{ t: string }>(
    `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN ('app', 'vault', 'audit')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { t } of rels) {
    const { rows } = await owner.query<{ d: string }>(
      `SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS d FROM ${t} x WHERE tenant_id = $1`,
      [tenantId],
    );
    out[t] = rows[0]!.d;
  }
  return out;
}

interface Finding {
  who: string;
  op: string;
  status: number;
  problem: string;
  /** The start of the answer, to judge a finding by (fictional data only). */
  answer: string;
}

/** Calls one operation with the given param values and checks the answer. */
async function probe(
  person: Person,
  op: Op,
  values: Record<string, string>,
  bodyId: () => string,
  foreign: Set<string>,
  allowed: Record<string, Allowance>,
  findings: Finding[],
  stats: { calls: number; validation: number },
) {
  const url = op.path.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(values[n]!));
  const payload = op.body && op.method !== 'get' ? (sample(op.body, bodyId) as Json) : undefined;
  const res = await ctx.app.inject({
    method: op.method.toUpperCase() as 'GET',
    url,
    headers: { cookie: person.cookie },
    ...(payload !== undefined ? { payload } : {}),
    remoteAddress: '10.62.0.2',
  });
  stats.calls++;
  if (res.statusCode === 400) stats.validation++;
  const key = `${op.method.toUpperCase()} ${op.path}`;
  const record = (problem: string) =>
    findings.push({
      who: person.role,
      op: key,
      status: res.statusCode,
      problem,
      answer: res.body.slice(0, 200),
    });
  const allowance = allowed[key];
  if (res.statusCode >= 500) record('server error');
  else if (res.statusCode < 400) {
    if (!allowance) record('succeeded');
    else if (typeof allowance !== 'string' && !allowance.refused(res.json() as Json))
      record('succeeded in a batch');
  }
  const sent = new Set([...Object.values(values), ...(JSON.stringify(payload ?? {}).match(UUID) ?? [])]);
  const leaked = [...new Set(res.body.match(UUID) ?? [])].filter((u) => foreign.has(u) && !sent.has(u));
  if (leaked.length) record(`returned ${leaked.length} foreign id(s)`);
  for (const s of SENTINELS) if (res.body.includes(s)) record(`returned a personal-data sentinel`);
}

/** Workspace A's people, one per built-in role. */
let attackers: Record<string, Person>;
/** Workspace B's own scoped people. */
let insiders: Record<string, Person>;
/** The person in B outside each scoped role's reach, holding the planted sentinels. */
let teamTargets: Record<string, string>;
const ANY = new Proxy({} as Record<string, Allowance>, { get: () => 'published content' });

const valueParam = (name: string, schema: Json) =>
  Array.isArray(schema.enum) ? String(schema.enum[0]) : VALUE_PARAMS[name]!;

async function typeKeyOf(tenantId: string) {
  const { rows } = await owner.query<{ key: string }>(
    'SELECT key FROM app.custom_object_types WHERE tenant_id = $1 ORDER BY key LIMIT 1',
    [tenantId],
  );
  return rows[0]?.key ?? 'fictional_type';
}

async function userOf(employeeId: string) {
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id::text FROM app.users WHERE tenant_id = $1 AND employee_id = $2 LIMIT 1',
    [B.tenantId, employeeId],
  );
  return rows[0]?.id ?? null;
}

/** The ids of a person's own records in B (every row with their employee id), not the person's own id. */
async function recordsOf(employeeId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [t, { employeeColumn }] of tables) {
    if (!employeeColumn) continue;
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id::text FROM ${t} WHERE tenant_id = $1 AND employee_id = $2`,
      [B.tenantId, employeeId],
    );
    for (const r of rows) out.add(r.id);
  }
  return out;
}

async function stillSignedIn(person: Person) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { cookie: person.cookie },
    remoteAddress: '10.62.0.2',
  });
  expect(res.statusCode, `${person.role} lost its session during the walk`).toBe(200);
}

/** A user of the workspace with one built-in role (and the employee role, as the product grants it). */
async function newLogin(
  w: { slug: string; tenantId: string },
  role: string,
  scope: { type: ScopeType; values?: string[] },
) {
  const email = `${role.replace(/_/g, '-')}.login@${w.slug}.example.test`;
  const password = `Harbour-Lantern-${role}-Qz-41`;
  await withTenant(ctx.deps.router, w.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name) VALUES (app.current_tenant(), $1, 'Fictional Login') RETURNING id`,
      [email],
    );
    await tx.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(password)],
    );
    await assignRole(tx, u.id, role, scope);
    if (role !== 'employee') await assignRole(tx, u.id, 'employee', { type: 'self' });
  });
  return { role, cookie: await signIn(w.slug, email, password) };
}

/** Plants recognisable fictional personal data on a person in B, so a leak of it shows in any answer. */
async function plantSentinels(employeeId: string) {
  await owner.query(
    'UPDATE app.employee_pay SET amount_minor = $3 WHERE tenant_id = $1 AND employee_id = $2',
    [B.tenantId, employeeId, SENTINEL.pay],
  );
  await owner.query(
    'UPDATE app.employee_personal SET personal_email = $3, personal_phone = $4 WHERE tenant_id = $1 AND employee_id = $2',
    [B.tenantId, employeeId, SENTINEL.email, SENTINEL.phone],
  );
  await owner.query(
    `INSERT INTO app.emergency_contacts (tenant_id, employee_id, name, relationship, phone, priority, valid_from)
     VALUES ($1, $2, $3, 'Sibling', $4, 9, '2020-01-06')`,
    [B.tenantId, employeeId, SENTINEL.contact, SENTINEL.phone],
  );
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await owner.connect();
  B.tenantId = (
    await seedStaging(
      { router: ctx.deps.router, directory: ctx.directory, keys: ctx.deps.keys, objects: ctx.deps.objects },
      { workspace: B.slug, logins: logins(B.slug), size: MIN_SIZE },
    )
  ).tenantId;

  const { rows: rels } = await owner.query<{ t: string; emp: string | null }>(
    `SELECT n.nspname || '.' || c.relname AS t,
            (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'employee_id' AND NOT a.attisdropped) AS emp
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN ('app', 'vault')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND a.atttypid = 'uuid'::regtype)`,
  );
  tables = new Map(rels.map((r) => [r.t, { employeeColumn: r.emp }]));

  spec = (await ctx.app.inject({ method: 'GET', url: '/openapi.json' })).json();
  ops = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
        name: name!,
        schema:
          ((op.parameters as Json[] | undefined)?.find((p) => p.in === 'path' && p.name === name)
            ?.schema as Json) ?? {},
      }));
      const body = (op.requestBody as { content?: Record<string, { schema?: Json }> } | undefined)?.content?.[
        'application/json'
      ]?.schema;
      ops.push({ method, path, params, body });
    }

  // A: every built-in role, each with its default scope (the entity HR admin over A's own entity)
  const ownerA = await ownerSession(ctx, A.slug);
  A.tenantId = ownerA.tenantId;
  const entityA = await legalEntity(ctx, ownerA.cookie);
  attackers = { owner: { role: 'owner', cookie: ownerA.cookie } };
  for (const r of BUILT_IN_ROLES.filter((x) => x.key !== 'owner'))
    attackers[r.key] = await newLogin(
      A,
      r.key,
      r.defaultScope === 'entity' ? { type: 'entity', values: [entityA] } : { type: r.defaultScope },
    );

  // B: the seed's manager and employee, and an entity HR admin for the GB entity
  const bLogins = Object.fromEntries(logins(B.slug).map((l) => [l.role, l])) as Record<
    LoginRole,
    StagingLogin
  >;
  const gb = (
    await owner.query<{ id: string }>(
      `SELECT id::text FROM app.legal_entities WHERE tenant_id = $1 AND country = 'GB' ORDER BY created_at LIMIT 1`,
      [B.tenantId],
    )
  ).rows[0]!.id;
  insiders = { entity_hr_admin: await newLogin(B, 'entity_hr_admin', { type: 'entity', values: [gb] }) };

  // B fills the collections the seed leaves empty through its own API (webhooks, keys, tickets…), with
  // generated bodies, so more of the cross-tenant ids are real rows
  const bOwner = await signIn(B.slug, bLogins.owner.email, bLogins.owner.password);
  const [bPerson] = await idsOf('app.employees', B.tenantId);
  const collections = new Set(
    ops.flatMap((o) =>
      o.params
        .filter((p) => isObjectParam(p.name))
        .map((p) => o.path.slice(0, o.path.indexOf(`{${p.name}}`) - 1)),
    ),
  );
  for (const c of collections) {
    const create = ops.find((o) => o.method === 'post' && o.path === c && !c.startsWith('/v1/backoffice/'));
    if (!create) continue;
    const payload = create.body ? (sample(create.body, () => bPerson!) as Json) : undefined;
    await ctx.app.inject({
      method: 'POST',
      url: c,
      headers: { cookie: bOwner },
      ...(payload !== undefined ? { payload } : {}),
      remoteAddress: '10.62.0.3',
    });
  }
  for (const role of ['manager', 'employee'] as const)
    insiders[role] = { role, cookie: await signIn(B.slug, bLogins[role].email, bLogins[role].password) };

  // outside the manager's team (and not the employee login): the HR admin login's own employee record;
  // outside the entity HR admin's entity: an active person employed by another legal entity
  const linked = async (email: string) =>
    (
      await owner.query<{ employee_id: string }>(
        'SELECT employee_id::text FROM app.users WHERE tenant_id = $1 AND email = $2',
        [B.tenantId, email],
      )
    ).rows[0]!.employee_id;
  const manager = await linked(bLogins.manager.email);
  const { rows: team } = await owner.query<{ id: string }>(
    `WITH RECURSIVE t AS (SELECT id FROM app.employees WHERE tenant_id = $1 AND manager_id = $2
       UNION SELECT e.id FROM app.employees e JOIN t ON e.manager_id = t.id WHERE e.tenant_id = $1)
     SELECT id::text FROM t`,
    [B.tenantId, manager],
  );
  const outside = await linked(bLogins.hr_admin.email);
  expect(team.map((r) => r.id)).not.toContain(outside);
  expect([manager, await linked(bLogins.employee.email)]).not.toContain(outside);
  const { rows: other } = await owner.query<{ id: string }>(
    `SELECT e.id::text FROM app.employees e WHERE e.tenant_id = $1 AND e.status = 'active' AND e.entity_id <> $2
      ORDER BY (SELECT count(*) FROM app.leave_requests l WHERE l.employee_id = e.id) DESC, e.id LIMIT 1`,
    [B.tenantId, gb],
  );
  teamTargets = { manager: outside, employee: outside, entity_hr_admin: other[0]!.id };
  for (const id of new Set(Object.values(teamTargets))) await plantSentinels(id);
}, 600_000);

afterAll(async () => {
  await owner?.end();
  await ctx?.close();
  await closeDb();
});

describe('object level authorisation, generated from the OpenAPI document', () => {
  it('every id-addressed operation maps its ids to a table, and every built-in role takes part', () => {
    const addressed = ops.filter((o) => o.params.some((p) => isObjectParam(p.name)));
    expect(addressed.length).toBeGreaterThan(150);
    const unmapped = addressed.flatMap((o) =>
      o.params
        .filter((p) => isObjectParam(p.name) && !tableFor(o.path, p.name))
        .map((p) => `${o.method.toUpperCase()} ${o.path} {${p.name}}`),
    );
    expect(unmapped).toEqual([]);
    expect(Object.keys(attackers).sort()).toEqual(BUILT_IN_ROLES.map((r) => r.key).sort());
  });

  it("no role of one workspace can read or change another workspace's objects by id", async () => {
    const before = await fingerprint(B.tenantId);
    const mine = await allIds(A.tenantId);
    const foreign = new Set([...(await allIds(B.tenantId))].filter((id) => !mine.has(id)));
    const typeKey = await typeKeyOf(B.tenantId);
    const [bEmployee] = await idsOf('app.employees', B.tenantId);
    const findings: Finding[] = [];
    const stats = { calls: 0, validation: 0 };
    const absent = new Set<string>();
    let addressed = 0;
    for (const op of ops) {
      if (!addressesObjects(op)) continue;
      const values: Record<string, string> = {};
      let tenantObject = sendsIds(op);
      for (const p of op.params) {
        if (!isObjectParam(p.name)) {
          values[p.name] = p.name === 'typeKey' ? typeKey : valueParam(p.name, p.schema);
          continue;
        }
        const t = tableFor(op.path, p.name)!;
        if (typeof t === 'string') {
          tenantObject = true;
          const [id] = await idsOf(t, B.tenantId, { notIn: A.tenantId });
          if (!id) absent.add(t);
          values[p.name] = id ?? crypto.randomUUID();
        } else if ('staff' in t) values[p.name] = crypto.randomUUID();
        else
          values[p.name] = (await owner.query<{ id: string }>(t.global)).rows[0]?.id ?? crypto.randomUUID();
      }
      addressed++;
      // only Thapsus-HR's own published content may answer, and still never with B's ids
      const allowed =
        tenantObject || op.path.startsWith('/v1/backoffice/') ? SUCCESS_ALLOWED_CROSS_TENANT : ANY;
      for (const person of Object.values(attackers))
        await probe(person, op, values, () => bEmployee!, foreign, allowed, findings, stats);
    }
    for (const person of Object.values(attackers)) await stillSignedIn(person);
    console.log(
      `cross-tenant walk: ${addressed} operations x ${Object.keys(attackers).length} roles = ${stats.calls} calls; ` +
        `${stats.validation} stopped at validation; B has no rows in ${absent.size} addressed tables (random ids used): ${[...absent].sort().join(', ')}`,
    );
    expect(findings).toEqual([]);
    expect(await fingerprint(B.tenantId)).toEqual(before);
    // the walk stays meaningful: most calls get past validation, and most foreign ids are real rows
    expect(addressed).toBeGreaterThan(200);
    expect(stats.validation / stats.calls).toBeLessThan(0.15);
    expect(absent.size).toBeLessThan(25);
  });

  it("the scoped roles cannot reach people outside their scope, or those people's records, by id", async () => {
    const findings: Finding[] = [];
    const stats = { calls: 0, validation: 0 };
    const typeKey = await typeKeyOf(B.tenantId);
    const covered: Record<string, number> = {};
    for (const [role, target] of Object.entries(teamTargets)) {
      const person = insiders[role]!;
      const foreign = await recordsOf(target);
      covered[role] = 0;
      for (const op of ops) {
        if (!addressesObjects(op)) continue;
        const values: Record<string, string> = {};
        // a body id is the person outside the scope
        let owned = sendsIds(op);
        let usable = true;
        for (const p of op.params) {
          if (!isObjectParam(p.name)) {
            values[p.name] = p.name === 'typeKey' ? typeKey : valueParam(p.name, p.schema);
            continue;
          }
          const t = tableFor(op.path, p.name)!;
          let id: string | undefined;
          if (typeof t !== 'string') id = 'staff' in t ? crypto.randomUUID() : undefined;
          else if (t === 'app.employees') [id, owned] = [target, true];
          else if (t === 'app.users') {
            id = (await userOf(target)) ?? undefined;
            owned ||= !!id;
          } else if (t === 'app.tenants') id = B.tenantId;
          else if (tables.get(t)?.employeeColumn) {
            [id] = await idsOf(t, B.tenantId, { where: 'employee_id = $2', args: [target] });
            owned ||= !!id;
          } else [id] = await idsOf(t, B.tenantId);
          if (!id) usable = false;
          else values[p.name] = id;
        }
        if (!owned || !usable) continue;
        covered[role]++;
        await probe(person, op, values, () => target, foreign, SUCCESS_ALLOWED_TEAM, findings, stats);
      }
      await stillSignedIn(person);
    }
    console.log(
      `team walk: ${JSON.stringify(covered)} operations; ${stats.calls} calls; ${stats.validation} stopped at validation`,
    );
    expect(findings).toEqual([]);
    for (const n of Object.values(covered)) expect(n).toBeGreaterThan(60);
    expect(stats.validation / stats.calls).toBeLessThan(0.15);
  });
});
