// Local-development smoke check (a `pnpm verify` step): on a fresh database, `pnpm db:migrate` and
// `pnpm db:seed` produce a working demo company, `pnpm dev` serves web + api + worker, sign-in works
// through the web proxy, mail reaches Mailpit, and the api and worker restart on a source change.
// Uses its own database and the dev ports (3000/4000); stop a running `pnpm dev` first.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
const DB = 'thapsus_devsmoke';
const PW = 'local_dev_only_password';
const host = new URL(OWNER).host;
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const env = {
  ...process.env,
  APP_ENV: 'dev',
  CELL_REGION: 'uk',
  THAPSUS_HR_DOMAIN: 'thapsus-hr.localhost',
  APP_BASE_URL: 'http://localhost:3000',
  API_BASE_URL: 'http://localhost:3000',
  GLOBAL_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: `postgres://thapsus_app:${PW}@${host}/${DB}`,
  BACKOFFICE_DATABASE_URL: `postgres://thapsus_backoffice:${PW}@${host}/${DB}`,
  REPORTING_DATABASE_URL: `postgres://thapsus_reporting:${PW}@${host}/${DB}`,
  MIGRATOR_DATABASE_URL: `${OWNER}/${DB}`,
  DIRECTORY_DATABASE_URL: `${OWNER}/${DB}`,
  APP_DB_PASSWORD: PW,
  BACKOFFICE_DB_PASSWORD: PW,
  REPORTING_DB_PASSWORD: PW,
  SMTP_URL: process.env.SMTP_URL ?? 'smtp://127.0.0.1:1025',
  MAIL_FROM: 'no-reply@thapsus-hr.localhost',
  LOCAL_KMS_KEY: '66'.repeat(32),
  INTERNAL_TOKEN: 'dev-smoke-internal-token',
  MOCK_IDP_ENABLED: 'true',
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'info',
  NEXT_TELEMETRY_DISABLED: '1',
  API_PROXY_URL: 'http://127.0.0.1:4000',
  FORCE_COLOR: '0',
};

const fail = (m) => {
  throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, seconds = 180) {
  for (let i = 0; i < seconds; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(1000);
  }
  fail(`timed out waiting for ${what}`);
}
const health = async (url) => {
  const r = await fetch(url);
  return r.ok ? r.json().catch(() => ({})) : undefined;
};

const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

console.log('› pnpm db:migrate && pnpm db:seed');
execSync('pnpm db:migrate', { stdio: 'inherit', env });
execSync('pnpm db:seed', { stdio: 'inherit', env });

// `next dev` rewrites next-env.d.ts to point at .next/dev types; restore the committed file afterwards.
const NEXT_ENV = 'apps/web/next-env.d.ts';
const nextEnv = readFileSync(NEXT_ENV, 'utf8');

console.log('› pnpm dev');
let output = '';
const dev = spawn('pnpm', ['dev'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
dev.stdout.on('data', (d) => (output += d));
dev.stderr.on('data', (d) => (output += d));
const stop = () => {
  try {
    process.kill(-dev.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};
process.on('exit', stop);

try {
  const first = await waitFor(() => health('http://127.0.0.1:4000/health'), 'api /health');
  await waitFor(() => health('http://127.0.0.1:3000/health'), 'web /health');
  await waitFor(async () => /worker started/.test(output), 'worker start');
  console.log('✓ web, api and worker are running');

  // the seeded demo company works end to end through the web's /v1 proxy
  const login = await fetch('http://127.0.0.1:3000/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: 'demo', email: 'manager@demo.example.test', password: process.env.SEED_PASSWORD ?? 'Demo-Password-2026' }),
  });
  if (login.status !== 200) fail(`demo sign-in failed: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('thr_sid='));
  const session = await (await fetch('http://127.0.0.1:3000/v1/auth/session', { headers: { cookie } })).json();
  if (!session.employeeId) fail('demo manager is not linked to an employee');
  console.log('✓ demo company sign-in through the web proxy');

  // mail goes to Mailpit
  const marker = `devsmoke-${Date.now()}`;
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);
  const ml = await fetch('http://127.0.0.1:3000/v1/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', 'x-smoke': marker }, body: JSON.stringify({ tenant: 'demo', email: 'employee@demo.example.test' }) });
  if (ml.status >= 400) fail(`magic link request failed: ${ml.status}`);
  await waitFor(async () => {
    const r = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    return r.messages?.some((m) => m.To?.some((t) => t.Address === 'employee@demo.example.test'));
  }, 'magic-link email in Mailpit', 60);
  console.log('✓ email delivered to Mailpit');

  // hot reload: touching api and worker sources restarts them
  const now = new Date();
  const workerStarts = (output.match(/worker started/g) ?? []).length;
  utimesSync('apps/api/src/app.ts', now, now);
  utimesSync('apps/worker/src/main.ts', now, now);
  await waitFor(async () => {
    const h = await health('http://127.0.0.1:4000/health');
    return h && h.bootId !== first.bootId;
  }, 'api restart after a source change', 90);
  await waitFor(async () => (output.match(/worker started/g) ?? []).length > workerStarts, 'worker restart after a source change', 90);
  console.log('✓ api and worker hot reload');
  console.log('dev smoke passed');
} catch (err) {
  console.error(output.split('\n').slice(-40).join('\n'));
  console.error(err);
  process.exitCode = 1;
} finally {
  stop();
  writeFileSync(NEXT_ENV, nextEnv);
}
