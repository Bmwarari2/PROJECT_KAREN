// Core HR benchmark on the synthetic enterprise tenant (pnpm synth:enterprise first).
// Run: node --env-file=.env --import tsx scripts/bench-corehr.ts  — results → .verify/bench-corehr.json
import { mkdirSync, writeFileSync } from 'node:fs';
import * as OTPAuth from 'otpauth';
import { depsFromEnv } from '../apps/api/src/deps';
import { buildApp } from '../apps/api/src/app';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Password-2026';
const deps = await depsFromEnv();
const app = await buildApp(deps, { logger: false });
await app.ready();

const cookieOf = (r: { headers: Record<string, unknown> }) => String((r.headers['set-cookie'] as string[] | string) ?? '').split(';')[0]!;
const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: 'enterprise', email: 'owner@enterprise.example.test', password: PASSWORD }, remoteAddress: '10.200.0.1' });
if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
const cookie = cookieOf(login);
const enrol = await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie } });
if (enrol.statusCode === 200) {
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrol.json().secret), digits: 6, period: 30 }).generate();
  await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/confirm', headers: { cookie }, payload: { code } });
} else {
  console.log('owner already has MFA; set BENCH_TOTP_SECRET to reuse it');
  const secret = process.env.BENCH_TOTP_SECRET;
  if (secret) await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/verify', headers: { cookie }, payload: { code: new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate() } });
}

async function measure(name: string, url: string | (() => string), runs = 20) {
  const times: number[] = [];
  let status = 0;
  for (let i = 0; i < runs + 2; i++) {
    const started = performance.now();
    const r = await app.inject({ method: 'GET', url: typeof url === 'string' ? url : url(), headers: { cookie } });
    const ms = performance.now() - started;
    status = r.statusCode;
    if (i >= 2) times.push(ms); // two warm-up requests
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!;
  const out = { name, status, runs, p50: Math.round(pct(50)), p95: Math.round(pct(95)), max: Math.round(times.at(-1)!) };
  console.log(`${name.padEnd(42)} status ${status}  p50 ${out.p50} ms  p95 ${out.p95} ms`);
  return out;
}

const first = (await app.inject({ method: 'GET', url: '/v1/employees?limit=50', headers: { cookie } })).json();
let deepCursor = first.nextCursor as string;
for (let i = 0; i < 20; i++) deepCursor = (await app.inject({ method: 'GET', url: `/v1/employees?limit=200&cursor=${deepCursor}`, headers: { cookie } })).json().nextCursor;
const roots = (await app.inject({ method: 'GET', url: '/v1/org-chart/roots', headers: { cookie } })).json() as Array<{ id: string }>;
const someone = first.data[10].id as string;

const results = [
  await measure('employees list, first page (50)', '/v1/employees?limit=50'),
  await measure('employees list, page ~4,000 deep (200)', `/v1/employees?limit=200&cursor=${deepCursor}`),
  await measure('employees search by name', '/v1/employees?limit=50&q=Avery'),
  await measure('employees filter by country', '/v1/employees?limit=50&country=DE'),
  await measure('employee profile (as-of today)', `/v1/employees/${someone}`),
  await measure('org chart first render (roots)', '/v1/org-chart/roots'),
  await measure('org chart expand node', `/v1/org-chart/${roots[0]!.id}/children`),
  await measure('org chart focus on person', `/v1/org-chart/${someone}/focus`),
  await measure('directory search', '/v1/directory?q=Sample'),
];
mkdirSync('.verify', { recursive: true });
writeFileSync('.verify/bench-corehr.json', JSON.stringify({ at: new Date().toISOString(), employees: 200_000, results }, null, 2));
await app.close();
process.exit(0);
