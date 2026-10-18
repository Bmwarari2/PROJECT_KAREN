// Rota benchmark: 10,000 fictional shift workers and a week of 50,000 shifts in one tenant, on a
// dedicated throwaway database. Measures the rota API the virtualised grid uses (keyset pages) and
// a whole-week publish. Results → .verify/bench-rota.json (see docs/PERFORMANCE.md "Rota (Phase 4)").
// Run: TEST_PG_OWNER_URL=postgres://thapsus_owner:…@127.0.0.1:5432 BENCH_DB=thapsus_bench_rota npx tsx scripts/bench-rota.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { closeAllPools, migrate, TenantRouter, withTenant } from '../packages/db/src/index';
import { buildApp } from '../apps/api/src/app';
import type { Deps } from '../apps/api/src/deps';
import { InMemoryDirectory } from '../apps/api/src/lib/directory';
import { LocalKeyProvider } from '../apps/api/src/lib/kms';
import { MemoryMailer } from '../apps/api/src/lib/mailer';
import { MemoryRateLimiter } from '../apps/api/src/lib/rate-limit';
import { MemoryObjectStore } from '../apps/api/src/lib/object-store';
import { totpCode } from '../apps/api/test/helpers';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
const DB = process.env.BENCH_DB ?? 'thapsus_bench_rota';
const APP_PW = 'local_dev_only_password'; // local Docker Postgres only (same as the test suites)
const PASSWORD = process.env.BENCH_PASSWORD ?? 'Correct-Horse-Battery-9'; // fictional bench tenant only
const WORKERS = Number(process.env.BENCH_WORKERS ?? 10_000);
const WEEK = '2030-01-07'; // a fixed Monday, so the benchmark never depends on today's date
const host = new URL(OWNER).host;
const appUrl = (role: string) => `postgres://${role}:${APP_PW}@${host}/${DB}`;

// ---- fresh database ----------------------------------------------------------------------------------
const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
await migrate({ ownerUrl: `${OWNER}/${DB}`, rolePasswords: { thapsus_app: APP_PW, thapsus_backoffice: APP_PW, thapsus_reporting: APP_PW } });

const now = { at: new Date() };
const deps: Deps = {
  config: { env: 'test', cell: 'uk', domain: 'thapsus-hr.test', appBaseUrl: 'http://localhost:3000', apiBaseUrl: 'http://localhost:4000', globalBaseUrl: 'http://localhost:3000' },
  router: new TenantRouter({ cell: 'uk', databases: { shared: appUrl('thapsus_app') }, cacheTtlMs: 0, poolMax: 10 }),
  directory: new InMemoryDirectory(),
  mailer: new MemoryMailer('uk'),
  keys: new LocalKeyProvider('33'.repeat(32)),
  limiter: new MemoryRateLimiter(),
  dns: { resolveTxt: async () => [] },
  objects: new MemoryObjectStore(),
  now: () => now.at,
  regionalAppUrls: { uk: 'http://localhost:3000', eu: 'http://localhost:3000', us: 'http://localhost:3000' },
  regionalApiUrls: { uk: 'http://localhost:4000', eu: 'http://localhost:4000', us: 'http://localhost:4000' },
  backofficeDbUrl: appUrl('thapsus_backoffice'),
  fetch: globalThis.fetch,
  serviceRole: 'cell',
  mockIdp: false,
};
const app = await buildApp(deps, { logger: false });
await app.ready();

// ---- fictional tenant with 10,000 shift workers and 50,000 draft shifts ---------------------------------
const cookieOf = (r: { headers: Record<string, unknown> }) => String(([] as string[]).concat((r.headers['set-cookie'] as string[] | string) ?? [])[0] ?? '').split(';')[0]!;
const signup = await app.inject({ method: 'POST', url: '/v1/signup', remoteAddress: '10.201.0.1', payload: { companyName: 'Fictional Bench Retail Ltd', slug: 'bench-rota', region: 'uk', ownerName: 'Olive Owner', ownerEmail: 'owner@bench-rota.example.test', password: PASSWORD, acceptDpa: true } });
if (signup.statusCode !== 201) throw new Error(`signup failed: ${signup.body}`);
const tenantId = signup.json().tenantId as string;
const cookie = cookieOf(signup);
const enrol = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie } });
const code = totpCode(enrol.json().secret, now.at);
await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/confirm', headers: { cookie }, payload: { code } });
const post = async (url: string, payload: unknown) => {
  const r = await app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });
  if (r.statusCode >= 300) throw new Error(`${url} ${r.statusCode} ${r.body}`);
  return r.json();
};
const entity = (await post('/v1/org/legal-entities', { name: 'Fictional Bench Retail Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' })).id;
const stores = [];
for (let i = 0; i < 20; i++) stores.push((await post('/v1/org/locations', { name: `Fictional Store ${i + 1}`, country: 'GB', regionCode: 'GB-ENG', timeZone: 'Europe/London', entityId: entity })).id as string);

const seedStart = performance.now();
await withTenant(deps.router, tenantId, async (tx) => {
  await tx.exec(
    `INSERT INTO app.employees (tenant_id, employee_number, start_date, status, display_name, job_title, location_id, entity_id, country, region_code, time_zone)
     SELECT app.current_tenant(), 'B' || lpad(g::text, 6, '0'), '2025-01-06', 'active', 'Bench ' || lpad(g::text, 5, '0') || ' Fictional', 'Store associate',
            ($2::uuid[])[1 + (g % array_length($2::uuid[], 1))], $3, 'GB', 'GB-ENG', 'Europe/London'
       FROM generate_series(1, $1::int) g`,
    [WORKERS, stores, entity],
  );
  await tx.exec(
    `INSERT INTO app.shifts (tenant_id, employee_id, location_id, shift_date, start_local, end_local, zone, starts_at, ends_at, break_minutes, status)
     SELECT app.current_tenant(), e.id, e.location_id, d::date, to_char(d, 'YYYY-MM-DD') || 'T07:00', to_char(d, 'YYYY-MM-DD') || 'T15:00', 'Europe/London',
            (d::date + time '07:00') AT TIME ZONE 'Europe/London', (d::date + time '15:00') AT TIME ZONE 'Europe/London', 30, 'draft'
       FROM app.employees e CROSS JOIN generate_series($1::date, $1::date + 4, interval '1 day') d WHERE e.employee_number LIKE 'B%'`,
    [WEEK],
  );
});
const ownerConn = new pg.Client({ connectionString: `${OWNER}/${DB}` });
await ownerConn.connect();
await ownerConn.query('ANALYZE');
const counts = (await ownerConn.query<{ e: string; s: string }>(`SELECT (SELECT count(*) FROM app.employees) AS e, (SELECT count(*) FROM app.shifts) AS s`)).rows[0]!;
await ownerConn.end();
const seedMs = Math.round(performance.now() - seedStart);
console.log(`seeded ${counts.e} employees and ${counts.s} shifts in ${seedMs} ms`);

// ---- measurements ------------------------------------------------------------------------------------
const stats = (name: string, times: number[], extra: Record<string, unknown> = {}) => {
  const t = [...times].sort((a, b) => a - b);
  const pct = (p: number) => t[Math.min(t.length - 1, Math.ceil((p / 100) * t.length) - 1)]!;
  const out = { name, samples: t.length, p50: Math.round(pct(50)), p95: Math.round(pct(95)), max: Math.round(t.at(-1)!), ...extra };
  console.log(`${name.padEnd(48)} n=${String(out.samples).padStart(3)}  p50 ${out.p50} ms  p95 ${out.p95} ms  max ${out.max} ms`);
  return out;
};
const get = async (url: string) => {
  const started = performance.now();
  const r = await app.inject({ method: 'GET', url, headers: { cookie } });
  const ms = performance.now() - started;
  if (r.statusCode !== 200) throw new Error(`${url} ${r.statusCode} ${r.body.slice(0, 300)}`);
  return { ms, body: r.json(), bytes: r.rawPayload.length };
};

/** Walks every keyset page of the grid (what scrolling the whole rota fetches). */
async function walkGrid(limit: number, filter = '') {
  const times: number[] = [];
  let cursor: string | null = null;
  let rows = 0;
  let shifts = 0;
  let bytes = 0;
  do {
    const r: { ms: number; body: { rows: Array<{ shifts: unknown[] }>; nextCursor: string | null }; bytes: number } = await get(`/v1/rota?weekStart=${WEEK}&limit=${limit}${filter}${cursor ? `&cursor=${cursor}` : ''}`);
    times.push(r.ms);
    rows += r.body.rows.length;
    shifts += r.body.rows.reduce((a, x) => a + x.shifts.length, 0);
    bytes += r.bytes;
    cursor = r.body.nextCursor;
  } while (cursor);
  return { times, rows, shifts, bytes };
}

const publishStart = performance.now();
const pub = await post('/v1/rota/publish', { from: WEEK, to: '2030-01-13' });
const publishMs = Math.round(performance.now() - publishStart);
console.log(`publish week: ${pub.published} shifts in ${publishMs} ms`);

await walkGrid(200); // warm-up
const results = [];
const firsts: number[] = [];
for (let i = 0; i < 20; i++) firsts.push((await get(`/v1/rota?weekStart=${WEEK}&limit=200`)).ms);
results.push(stats('rota grid: first page (200 rows + total)', firsts));
const walks = [];
for (let i = 0; i < 3; i++) walks.push(await walkGrid(200));
results.push(stats('rota grid: every keyset page (200 rows)', walks.flatMap((w) => w.times), { rows: walks[0]!.rows, shifts: walks[0]!.shifts, kbPerPage: Math.round(walks[0]!.bytes / walks[0]!.times.length / 1024) }));
const store = await walkGrid(200, `&locationId=${stores[3]}`);
results.push(stats('rota grid: one store (~500 people)', store.times, { rows: store.rows }));
const search: number[] = [];
for (let i = 0; i < 20; i++) search.push((await get(`/v1/rota?weekStart=${WEEK}&limit=200&q=${String(1000 + i * 37).slice(0, 4)}`)).ms);
results.push(stats('rota grid: name search', search));
const shiftPages: number[] = [];
let sc: string | null = null;
let shiftRows = 0;
do {
  const r: { ms: number; body: { data: unknown[]; nextCursor: string | null } } = await get(`/v1/shifts?from=${WEEK}&to=2030-01-13&limit=500${sc ? `&cursor=${sc}` : ''}`);
  shiftPages.push(r.ms);
  shiftRows += r.body.data.length;
  sc = r.body.nextCursor;
} while (sc);
results.push(stats('shift list: every keyset page (500 shifts)', shiftPages, { shifts: shiftRows }));

mkdirSync('.verify', { recursive: true });
const report = { at: new Date().toISOString(), workers: Number(counts.e), shifts: Number(counts.s), seedMs, publish: { shifts: pub.published, ms: publishMs }, results };
writeFileSync('.verify/bench-rota.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await app.close();
await closeAllPools();
process.exit(0);
