// Core HR benchmark on the synthetic enterprise tenant (`pnpm synth:enterprise` first).
// Run: node --env-file=.env --import tsx scripts/bench-corehr.ts
// Results → .verify/bench-corehr.json. Exits 1 when any p95 breaches its threshold (PROGRESS 1.1, 1.2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
// scripts/ has no workspace dependencies of its own: import through relative paths
import { withTenant } from '../packages/db/src/index';
import { depsFromEnv } from '../apps/api/src/deps';
import { totpCode } from './lib/totp';
import { buildApp } from '../apps/api/src/app';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Password-2026';
const RUNS = Number(process.env.BENCH_RUNS ?? 30);
/** p95 budgets in milliseconds (acceptance criteria: list < 1 s; org chart first render < 1 s, expand < 300 ms). */
const THRESHOLDS: Record<string, number> = {
  'employees list, first page (50)': 1000,
  'employees list, page ~4,000 deep (200)': 1000,
  'employees list as a manager (own team, 50)': 1000,
  'employees search by name': 1000,
  'employees fuzzy search (misspelt name)': 1000,
  'employees filter by country': 1000,
  'employee profile (as-of today)': 1000,
  'org chart first render (roots)': 1000,
  'org chart expand node': 300,
  'org chart focus on person': 1000,
  'org chart search': 1000,
  'directory search': 1000,
};

const deps = await depsFromEnv();
const app = await buildApp(deps, { logger: false });
await app.ready();

const cookieOf = (r: { headers: Record<string, unknown> }) => String((r.headers['set-cookie'] as string[] | string) ?? '').split(';')[0]!;
const login = async (email: string, ip: string) => {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: 'enterprise', email, password: PASSWORD }, remoteAddress: ip });
  if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.body}`);
  return cookieOf(r);
};

// Owner (admin): MFA is required. The TOTP secret of this synthetic, local-only tenant is kept in the
// git-ignored .verify/ folder so the benchmark can be re-run.
const totpFile = '.verify/bench-owner-totp.json';
const cookie = await login('owner@enterprise.example.test', '10.200.0.1');
const code = (secret: string) => totpCode(secret);
const enrol = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie } });
mkdirSync('.verify', { recursive: true });
if (enrol.statusCode === 200) {
  const secret = enrol.json().secret as string;
  writeFileSync(totpFile, JSON.stringify({ secret }));
  await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/confirm', headers: { cookie }, payload: { code: code(secret) } });
} else {
  const secret = process.env.BENCH_TOTP_SECRET ?? (existsSync(totpFile) ? (JSON.parse(readFileSync(totpFile, 'utf8')) as { secret: string }).secret : undefined);
  if (!secret) throw new Error('owner already has MFA: set BENCH_TOTP_SECRET or keep .verify/bench-owner-totp.json');
  let v = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: code(secret) } });
  if (v.statusCode >= 300) {
    // a code is accepted once: when re-run within the same 30 s step, wait for the next one
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));
    v = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: code(secret) } });
  }
  if (v.statusCode >= 300) throw new Error(`MFA verify failed: ${v.body}`);
}
// user1 is linked to the managing director of the first legal entity (a team of thousands)
const managerCookie = await login('user1@globex.example.test', '10.200.0.2');

async function measure(name: string, url: string, as = cookie) {
  const times: number[] = [];
  let status = 0;
  for (let i = 0; i < RUNS + 3; i++) {
    const started = performance.now();
    const r = await app.inject({ method: 'GET', url, headers: { cookie: as } });
    const ms = performance.now() - started;
    status = r.statusCode;
    if (status !== 200) throw new Error(`${name}: HTTP ${status} ${r.body.slice(0, 200)}`);
    if (i >= 3) times.push(ms); // three warm-up requests
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!;
  const threshold = THRESHOLDS[name]!;
  const out = { name, status, runs: RUNS, p50: Math.round(pct(50)), p95: Math.round(pct(95)), max: Math.round(times.at(-1)!), thresholdP95: threshold, pass: pct(95) < threshold };
  console.log(`${out.pass ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} p50 ${String(out.p50).padStart(4)} ms  p95 ${String(out.p95).padStart(4)} ms  (budget ${threshold} ms)`);
  return out;
}

const tenantId = (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).json().tenantId as string;
const counts = await withTenant(deps.router, tenantId, (tx) =>
  tx.one<{ employees: number; active: number; jobs: number; pg: string }>(
    `SELECT (SELECT count(*)::int FROM app.employees) AS employees, (SELECT count(*)::int FROM app.employees WHERE status = 'active') AS active,
            (SELECT count(*)::int FROM app.employee_jobs) AS jobs, current_setting('server_version') AS pg`,
  ),
);
console.log(`tenant: ${counts.employees} employees (${counts.active} active), ${counts.jobs} job records, PostgreSQL ${counts.pg}`);

const first = (await app.inject({ method: 'GET', url: '/v1/employees?limit=50', headers: { cookie } })).json();
let deepCursor = first.nextCursor as string;
for (let i = 0; i < 20; i++) deepCursor = (await app.inject({ method: 'GET', url: `/v1/employees?limit=200&cursor=${deepCursor}`, headers: { cookie } })).json().nextCursor;
const roots = (await app.inject({ method: 'GET', url: '/v1/org-chart/roots', headers: { cookie } })).json() as Array<{ id: string; directReports: number }>;
const someone = first.data[10].id as string;
const expandable = roots.find((r) => r.directReports > 0)!;

const results = [
  await measure('employees list, first page (50)', '/v1/employees?limit=50'),
  await measure('employees list, page ~4,000 deep (200)', `/v1/employees?limit=200&cursor=${deepCursor}`),
  await measure('employees list as a manager (own team, 50)', '/v1/employees?limit=50', managerCookie),
  await measure('employees search by name', '/v1/employees?limit=50&q=Avery'),
  await measure('employees fuzzy search (misspelt name)', '/v1/employees?limit=50&q=Averyy'),
  await measure('employees filter by country', '/v1/employees?limit=50&country=DE'),
  await measure('employee profile (as-of today)', `/v1/employees/${someone}`),
  await measure('org chart first render (roots)', '/v1/org-chart/roots'),
  await measure('org chart expand node', `/v1/org-chart/${expandable.id}/children`),
  await measure('org chart focus on person', `/v1/org-chart/${someone}/focus`),
  await measure('org chart search', '/v1/org-chart/search?q=Avery'),
  await measure('directory search', '/v1/directory?q=Sample'),
];
const machine = { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version };
const failed = results.filter((r) => !r.pass);
writeFileSync('.verify/bench-corehr.json', JSON.stringify({ at: new Date().toISOString(), tenant: counts, machine, results, failed: failed.map((f) => f.name) }, null, 2));
console.log(failed.length ? `\n${failed.length} benchmark(s) over budget: ${failed.map((f) => f.name).join('; ')}` : '\nall benchmarks within budget');
await app.close();
process.exit(failed.length ? 1 : 0);
