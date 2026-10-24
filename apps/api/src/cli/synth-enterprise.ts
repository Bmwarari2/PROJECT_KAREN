import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { closeAllPools, secretToUrl, TenantRouter, withTenant } from '@thapsus/db';
import { directoryFromEnv } from '../lib/directory';
import { hashPassword } from '../modules/auth/tokens';
import { provisionTenant } from './provision';
import { DEPARTMENTS, FIRST_NAMES, JOB_TITLES, LAST_NAMES, prng } from './fixtures';

/**
 * `pnpm synth:enterprise` — deterministically generates a 200,000-employee tenant ("enterprise")
 * with 50 legal entities across the UK, EU and US, full effective-dated history, a manager tree and
 * SYNTH_USERS sign-in users for load testing. Bulk-loaded with COPY (as the owner role; COPY does not
 * support RLS-protected inserts). All data is fictional.
 */
// In AWS this runs as the cell's migrator task (scripts/deploy.mjs `synth-<cell>`, load tests only),
// which receives the database credentials as Secrets Manager values rather than URLs.
if (!process.env.DATABASE_URL && !process.env.DATABASE_SECRET && process.env.APP_DATABASE_SECRET)
  process.env.DATABASE_SECRET = process.env.APP_DATABASE_SECRET;
if (!process.env.MIGRATOR_DATABASE_URL && process.env.OWNER_DATABASE_SECRET)
  process.env.MIGRATOR_DATABASE_URL = secretToUrl(
    process.env.OWNER_DATABASE_SECRET,
    process.env.DATABASE_HOST,
  );
if (process.env.APP_ENV === 'prod') throw new Error('synthetic data is never generated in production');
const N = Number(process.env.SYNTH_EMPLOYEES ?? 200_000);
const USERS = Number(process.env.SYNTH_USERS ?? 6_000);
const SEED = 424242;
const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Password-2026';
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const ENTITY_COUNTRIES: Array<
  [country: string, region: string, currency: string, tz: string, count: number]
> = [
  ['GB', 'GB-ENG', 'GBP', 'Europe/London', 5],
  ['GB', 'GB-SCT', 'GBP', 'Europe/London', 1],
  ['GB', 'GB-WLS', 'GBP', 'Europe/London', 1],
  ['GB', 'GB-NIR', 'GBP', 'Europe/London', 1],
  ['IE', 'IE', 'EUR', 'Europe/Dublin', 1],
  ['DE', 'DE-BE', 'EUR', 'Europe/Berlin', 3],
  ['DE', 'DE-BY', 'EUR', 'Europe/Berlin', 1],
  ['FR', 'FR-IDF', 'EUR', 'Europe/Paris', 3],
  ['NL', 'NL-NH', 'EUR', 'Europe/Amsterdam', 2],
  ['ES', 'ES-MD', 'EUR', 'Europe/Madrid', 2],
  ['IT', 'IT-25', 'EUR', 'Europe/Rome', 2],
  ['PL', 'PL-14', 'PLN', 'Europe/Warsaw', 2],
  ['SE', 'SE-AB', 'SEK', 'Europe/Stockholm', 1],
  ['DK', 'DK-84', 'DKK', 'Europe/Copenhagen', 1],
  ['BE', 'BE-BRU', 'EUR', 'Europe/Brussels', 1],
  ['AT', 'AT-9', 'EUR', 'Europe/Vienna', 1],
  ['PT', 'PT-11', 'EUR', 'Europe/Lisbon', 1],
  ['CZ', 'CZ-10', 'CZK', 'Europe/Prague', 1],
  ['RO', 'RO-B', 'RON', 'Europe/Bucharest', 1],
  ['US', 'US-CA', 'USD', 'America/Los_Angeles', 4],
  ['US', 'US-NY', 'USD', 'America/New_York', 3],
  ['US', 'US-TX', 'USD', 'America/Chicago', 3],
  ['US', 'US-WA', 'USD', 'America/Los_Angeles', 2],
  ['US', 'US-IL', 'USD', 'America/Chicago', 2],
  ['US', 'US-MA', 'USD', 'America/New_York', 1],
  ['US', 'US-FL', 'USD', 'America/New_York', 1],
  ['US', 'US-CO', 'USD', 'America/Denver', 1],
  ['US', 'US-GA', 'USD', 'America/New_York', 1],
  ['US', 'US-OR', 'USD', 'America/Los_Angeles', 1],
];

const uuid = (kind: string, i: number) => {
  const h = createHash('md5').update(`${SEED}:${kind}:${i}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const csv = (v: unknown) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
const row = (...vs: unknown[]) => vs.map(csv).join(',') + '\n';

async function copy(client: pg.Client, table: string, columns: string, rows: () => Generator<string>) {
  const stream = client.query(copyFrom(`COPY ${table} (${columns}) FROM STDIN WITH (FORMAT csv)`));
  await pipeline(Readable.from(rows(), { objectMode: false }), stream);
}

const router = TenantRouter.fromEnv();
const directory = await directoryFromEnv();
const { tenantId, created } = await provisionTenant(router, directory, {
  slug: 'enterprise',
  name: 'Globex Fictional Group',
  region: 'uk',
  ownerEmail: 'owner@enterprise.example.test',
  ownerName: 'Ola Owner',
  password: PASSWORD,
  // The load test signs its synthetic employees in with a password only: it measures the app, not an
  // authenticator step (the owner still enrols one, as every admin must). ADR-0170.
  security: { requireMfaForEveryone: false },
});
if (!created) {
  const n = await withTenant(router, tenantId, (tx) =>
    tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.employees'),
  );
  log(`enterprise tenant already exists with ${n.n} employees — nothing to do`);
  await closeAllPools();
  process.exit(0);
}

const ownerUrl = process.env.MIGRATOR_DATABASE_URL;
if (!ownerUrl) throw new Error('MIGRATOR_DATABASE_URL is required for bulk COPY');
const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
await client.query('BEGIN');

// ---- organisation --------------------------------------------------------------------------
const entities: Array<{
  id: string;
  country: string;
  region: string;
  currency: string;
  tz: string;
  locations: string[];
}> = [];
for (const [country, region, currency, tz, count] of ENTITY_COUNTRIES) {
  for (let k = 0; k < count; k++)
    entities.push({ id: uuid('entity', entities.length), country, region, currency, tz, locations: [] });
}
if (entities.length !== 50) throw new Error(`expected 50 entities, got ${entities.length}`);
await copy(
  client,
  'app.legal_entities',
  'tenant_id, id, name, country, region_code, currency, time_zone',
  function* () {
    for (const [i, e] of entities.entries())
      yield row(
        tenantId,
        e.id,
        `Globex Fictional ${e.country} ${i + 1}`,
        e.country,
        e.region,
        e.currency,
        e.tz,
      );
  },
);
let locIndex = 0;
await copy(
  client,
  'app.locations',
  'tenant_id, id, name, entity_id, country, region_code, time_zone',
  function* () {
    for (const e of entities) {
      for (let k = 0; k < 3; k++) {
        const id = uuid('location', locIndex++);
        e.locations.push(id);
        yield row(tenantId, id, `Site ${locIndex}`, e.id, e.country, e.region, e.tz);
      }
    }
  },
);
const departments = DEPARTMENTS.map((name, i) => ({ id: uuid('dept', i), name }));
await copy(client, 'app.departments', 'tenant_id, id, name, code', function* () {
  for (const [i, d] of departments.entries()) yield row(tenantId, d.id, d.name, `D${i + 1}`);
});
log('organisation: 50 entities, 150 locations, 10 departments');

// ---- employees: distribute across entities, heap-ordered manager tree per entity (span 8) -------
const weights = entities.map((_, i) => 0.5 + prng(SEED + i)());
const totalW = weights.reduce((a, b) => a + b, 0);
const sizes = weights.map((w) => Math.floor((w / totalW) * N));
sizes[0]! += N - sizes.reduce((a, b) => a + b, 0);
const entityOf = new Int32Array(N);
const offsetOf: number[] = [];
{
  let k = 0;
  for (const [ei, size] of sizes.entries()) {
    offsetOf.push(k);
    for (let j = 0; j < size; j++) entityOf[k++] = ei;
  }
}
const managerIndex = (i: number) => {
  const off = offsetOf[entityOf[i]!]!;
  const local = i - off;
  return local === 0 ? -1 : off + Math.floor((local - 1) / 8);
};
const attrs = (i: number) => {
  const r = prng(SEED * 31 + i);
  const first = FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]!;
  const year = 2008 + Math.floor(r() * 18);
  const start = `${year}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
  const e = entities[entityOf[i]!]!;
  const title =
    managerIndex(i) === -1 ? 'Country managing director' : JOB_TITLES[Math.floor(r() * JOB_TITLES.length)]!;
  const dept = departments[Math.floor(r() * departments.length)]!;
  const location = e.locations[Math.floor(r() * e.locations.length)]!;
  const partTime = r() < 0.18;
  const hourly = e.country === 'US' && r() < 0.4;
  const salary = 2_200_000 + Math.floor(r() * 9_000_000);
  return { first, last, start, e, title, dept, location, partTime, hourly, salary, leaver: r() < 0.06, r };
};

await copy(
  client,
  'app.employees',
  'tenant_id, id, employee_number, status, start_date, end_date, work_email, display_name, job_title, department_id, location_id, entity_id, country, region_code, time_zone, manager_id, current_as_of',
  function* () {
    for (let i = 0; i < N; i++) {
      const a = attrs(i);
      const m = managerIndex(i);
      const end = a.leaver ? `${2026}-0${1 + (i % 9)}-15` : null;
      yield row(
        tenantId,
        uuid('emp', i),
        `GX${String(i + 1).padStart(6, '0')}`,
        end ? 'leaver' : 'active',
        a.start,
        end,
        `${a.first}.${a.last}.${i + 1}@globex.example.test`.toLowerCase(),
        `${a.first} ${a.last}`,
        a.title,
        a.dept.id,
        a.location,
        a.e.id,
        a.e.country,
        a.e.region,
        a.e.tz,
        m === -1 ? null : uuid('emp', m),
        new Date().toISOString().slice(0, 10),
      );
    }
  },
);
log(`employees: ${N}`);
await copy(
  client,
  'app.employee_personal',
  'tenant_id, employee_id, valid_from, legal_first_name, legal_last_name, date_of_birth, personal_email',
  function* () {
    for (let i = 0; i < N; i++) {
      const a = attrs(i);
      yield row(
        tenantId,
        uuid('emp', i),
        a.start,
        a.first,
        a.last,
        `${1960 + (i % 40)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        `p${i + 1}@personal.example.test`,
      );
    }
  },
);
await copy(
  client,
  'app.employee_jobs',
  'tenant_id, employee_id, valid_from, valid_to, job_title, department_id, location_id, entity_id, employment_type, fte, weekly_hours, flsa_status',
  function* () {
    for (let i = 0; i < N; i++) {
      const a = attrs(i);
      const flsa = a.e.country === 'US' ? (a.hourly ? 'non_exempt' : 'exempt') : null;
      // every 5th employee has a promotion: an earlier job record closed at the promotion date
      if (i % 5 === 0 && a.start < '2024-01-01') {
        yield row(
          tenantId,
          uuid('emp', i),
          a.start,
          '2024-01-01',
          'Associate',
          a.dept.id,
          a.location,
          a.e.id,
          'full_time',
          1,
          40,
          flsa,
        );
        yield row(
          tenantId,
          uuid('emp', i),
          '2024-01-01',
          null,
          a.title,
          a.dept.id,
          a.location,
          a.e.id,
          a.partTime ? 'part_time' : 'full_time',
          a.partTime ? 0.6 : 1,
          a.partTime ? 24 : 40,
          flsa,
        );
      } else {
        yield row(
          tenantId,
          uuid('emp', i),
          a.start,
          null,
          a.title,
          a.dept.id,
          a.location,
          a.e.id,
          a.partTime ? 'part_time' : 'full_time',
          a.partTime ? 0.6 : 1,
          a.partTime ? 24 : 40,
          flsa,
        );
      }
    }
  },
);
await copy(
  client,
  'app.employee_pay',
  'tenant_id, employee_id, valid_from, amount_minor, currency, frequency',
  function* () {
    for (let i = 0; i < N; i++) {
      const a = attrs(i);
      yield row(
        tenantId,
        uuid('emp', i),
        a.start,
        a.hourly ? 1800 + (i % 2500) : a.salary,
        a.e.currency,
        a.hourly ? 'hourly' : 'annual',
      );
    }
  },
);
await copy(
  client,
  'app.employee_contracts',
  'tenant_id, employee_id, valid_from, contract_type, notice_period_days',
  function* () {
    for (let i = 0; i < N; i++)
      yield row(tenantId, uuid('emp', i), attrs(i).start, i % 17 === 0 ? 'fixed_term' : 'permanent', 30);
  },
);
await copy(
  client,
  'app.reporting_lines',
  'tenant_id, employee_id, manager_id, kind, valid_from',
  function* () {
    for (let i = 0; i < N; i++) {
      const m = managerIndex(i);
      if (m !== -1) yield row(tenantId, uuid('emp', i), uuid('emp', m), 'solid', '2000-01-01');
      if (i % 50 === 7 && m > 0)
        yield row(tenantId, uuid('emp', i), uuid('emp', offsetOf[entityOf[i]!]!), 'dotted', '2000-01-01');
    }
  },
);
log('effective-dated history and reporting lines loaded');

// ---- sign-in users for load tests (first USERS employees; managers get the manager role) -----
const hash = await hashPassword(PASSWORD);
const roles = (
  await client.query<{ key: string; id: string }>('SELECT key, id FROM app.roles WHERE tenant_id = $1', [
    tenantId,
  ])
).rows;
const roleId = (k: string) => roles.find((r) => r.key === k)!.id;
await copy(client, 'app.users', 'tenant_id, id, email, display_name, employee_id', function* () {
  for (let i = 0; i < USERS; i++) {
    const a = attrs(i);
    yield row(
      tenantId,
      uuid('user', i),
      `user${i + 1}@globex.example.test`,
      `${a.first} ${a.last}`,
      uuid('emp', i),
    );
  }
});
await copy(client, 'app.password_credentials', 'tenant_id, user_id, password_hash', function* () {
  for (let i = 0; i < USERS; i++) yield row(tenantId, uuid('user', i), hash);
});
await copy(client, 'app.role_assignments', 'tenant_id, user_id, role_id, scope_type', function* () {
  for (let i = 0; i < USERS; i++) {
    yield row(tenantId, uuid('user', i), roleId('employee'), 'self');
    if (i < USERS / 8) yield row(tenantId, uuid('user', i), roleId('manager'), 'own_team');
  }
});
await client.query(
  `UPDATE app.employees SET search = to_tsvector('simple', display_name || ' ' || employee_number || ' ' || coalesce(work_email::text, '') || ' ' || coalesce(job_title, '')) WHERE tenant_id = $1`,
  [tenantId],
);
await client.query('COMMIT');
await client.query(
  'ANALYZE app.employees; ANALYZE app.employee_jobs; ANALYZE app.reporting_lines; ANALYZE app.users',
);
await client.end();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
log(
  `done: ${N} employees, 50 entities, ${USERS} users in ${seconds}s (workspace "enterprise", user1@globex.example.test … / ${PASSWORD})`,
);
await closeAllPools();
process.exit(0);
