// Phone tour: the staging test organisation ("kestrel", ADR-0158) on a local build, photographed at phone
// size for UI reviews. It seeds a fresh local database with the staging seed, starts the API and the
// production web build, signs in as each role and saves full-page screenshots of the screens that role
// uses most, in dark and light mode.
//
//   pnpm exec turbo run build --filter=@thapsus/web && node --import tsx scripts/phone-tour.mjs
//
// TOUR_OUT=<dir> (default .verify/phone-tour), TOUR_ROLES=employee,hr_admin, TOUR_SCHEMES=dark,light,
// TOUR_PAGES=/app,/app/me (limit the pages). Needs the local Postgres and S3 mock (docker compose up).
// Every name, email and password here is fictional and local-only.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const require = createRequire(pathToFileURL(`${process.cwd()}/apps/web/package.json`));
const playwright = await import(pathToFileURL(require.resolve('@playwright/test')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const OTPAuth = await import(
  pathToFileURL(createRequire(pathToFileURL(`${process.cwd()}/apps/api/package.json`)).resolve('otpauth'))
    .href
);
const { migrate } = await import(pathToFileURL(`${process.cwd()}/packages/db/src/migrate.ts`).href);

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
const DB = 'thapsus_tour';
const GLOBAL_DB = 'thapsus_tour_global';
const PW = 'local_dev_only_password';
const WEB = Number(process.env.TOUR_WEB_PORT ?? 3300);
const API = Number(process.env.TOUR_API_PORT ?? 4300);
const OUT = process.env.TOUR_OUT ?? '.verify/phone-tour';
const base = `http://127.0.0.1:${WEB}`;
const LOGIN_PASSWORD = 'Amber-Lantern-Orbit-9157';
const ROLES = ['owner', 'hr_admin', 'payroll_admin', 'manager', 'employee'];
const LOGINS = {
  workspace: 'kestrel',
  logins: [
    { role: 'owner', email: 'owner@kestrel.example.test' },
    { role: 'hr_admin', email: 'hr.admin@kestrel.example.test' },
    { role: 'payroll_admin', email: 'payroll@kestrel.example.test' },
    { role: 'manager', email: 'manager@kestrel.example.test' },
    { role: 'employee', email: 'employee@kestrel.example.test' },
  ].map((l) => ({ ...l, password: LOGIN_PASSWORD })),
};

/** The screens each role uses most. `:person` is replaced by a colleague's profile from the directory. */
const PAGES = {
  employee: [
    '/app',
    '/app/me',
    '/app/me/details',
    '/app/notifications',
    '/app/tasks',
    '/app/approvals',
    '/app/documents',
    ':toSign',
    '/app/payslips',
    ':payslip',
    '/app/time-off',
    '/app/rota',
    '/app/assets',
    '/app/help',
    '/app/support',
  ],
  manager: ['/app', '/app/people', '/app/approvals', '/app/time-off', '/app/rota', '/app/timesheets'],
  hr_admin: [
    '/app',
    '/app/people',
    ':person',
    '/app/compliance',
    '/app/compliance/right-to-work',
    ':countersign',
    ':evidence',
    '/app/approvals',
    '/app/tasks',
    '/app/documents',
    '/app/reports',
    '/app/settings',
    '/app/notifications',
  ],
  payroll_admin: ['/app', '/app/payroll', '/app/payslips'],
  owner: ['/app', '/app/billing', '/app/settings'],
};
const roles = process.env.TOUR_ROLES ? process.env.TOUR_ROLES.split(',') : ['employee', 'hr_admin'];
const schemes = process.env.TOUR_SCHEMES ? process.env.TOUR_SCHEMES.split(',') : ['dark', 'light'];
const only = process.env.TOUR_PAGES?.split(',');

const host = new URL(OWNER).host;
const env = {
  ...process.env,
  APP_ENV: 'dev',
  CELL_REGION: 'uk',
  PORT: String(API),
  APP_BASE_URL: base,
  API_BASE_URL: base,
  GLOBAL_BASE_URL: base,
  DATABASE_URL: `postgres://thapsus_app:${PW}@${host}/${DB}`,
  BACKOFFICE_DATABASE_URL: `postgres://thapsus_backoffice:${PW}@${host}/${DB}`,
  REPORTING_DATABASE_URL: `postgres://thapsus_reporting:${PW}@${host}/${DB}`,
  DIRECTORY_DATABASE_URL: `${OWNER}/${GLOBAL_DB}`,
  FILES_BUCKET: 'thapsus-dev-files',
  S3_ENDPOINT: 'http://127.0.0.1:9090',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  LOCAL_KMS_KEY: '44'.repeat(32),
  MAIL_TRANSPORT: 'file',
  STAGING_LOGINS: JSON.stringify(LOGINS),
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'warn',
  API_PROXY_URL: `http://127.0.0.1:${API}`,
  NEXT_TELEMETRY_DISABLED: '1',
};

const procs = [];
const start = (cmd, cwd) => {
  const p = spawn(cmd, { cwd, shell: true, env, stdio: 'ignore', detached: true });
  procs.push(p);
};
const run = (cmd, cwd) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, { cwd, shell: true, env, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
const waitFor = async (url) => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${url}`);
};
const stopAll = () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
};

async function resetDbs() {
  const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  for (const db of [DB, GLOBAL_DB]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();
  await migrate({
    ownerUrl: `${OWNER}/${DB}`,
    rolePasswords: { thapsus_app: PW, thapsus_backoffice: PW, thapsus_reporting: PW },
  });
}

/** Signs in through the API (enrolling an authenticator when the role must have one) and returns the cookie. */
async function signIn(email) {
  const r = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: LOGINS.workspace, email, password: LOGIN_PASSWORD }),
  });
  if (r.status !== 200) throw new Error(`sign-in failed for a ${email.split('@')[0]} login: ${r.status}`);
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => /^(__Host-)?thr_sid=/.test(c));
  const login = await r.json();
  if (login.mfaEnrollmentRequired) {
    const enrol = await (
      await fetch(`${base}/v1/auth/mfa/totp/enroll`, { method: 'POST', headers: { cookie } })
    ).json();
    const code = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(enrol.secret),
      digits: 6,
      period: 30,
    }).generate();
    const ok = await fetch(`${base}/v1/auth/mfa/totp/confirm`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (ok.status !== 204) throw new Error(`authenticator enrolment failed: ${ok.status}`);
  }
  return cookie;
}

async function colleagueProfile(cookie) {
  const r = await fetch(`${base}/v1/employees?limit=5`, { headers: { cookie } });
  if (!r.ok) return null;
  const body = await r.json();
  const list = Array.isArray(body) ? body : (body.data ?? body.items ?? body.employees ?? []);
  return list[1]?.id ? `/app/people/${list[1].id}` : null;
}

/**
 * A document waiting for the employee's signature, their latest payslip, one waiting for HR's countersignature, or a
 * person's documents with right-to-work evidence.
 */
async function seededPage(token, cookie) {
  const get = async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).json();
  if (token === ':toSign') {
    const sr = (await get('/v1/signature-requests')).filter((x) => x.status === 'pending');
    return sr.length ? `/app/documents/${sr.at(-1).documentId}` : null;
  }
  if (token === ':payslip') {
    const p = (await get('/v1/me/payslips')).find((x) => x.hasStatement);
    return p ? `/app/payslips/${p.id}` : null;
  }
  if (token === ':evidence') {
    // a person with right-to-work evidence, on their profile's Documents tab
    const d = (await get('/v1/documents')).find((x) => x.attachmentType === 'right_to_work');
    return d ? `/app/people/${d.employeeId}?tab=documents` : null;
  }
  if (token === ':countersign') {
    const a = (await get('/v1/approvals?view=mine')).find((x) => x.subject === 'document.countersign');
    return a ? `/app/documents/${a.payload.documentId}` : null;
  }
  return null;
}

const slugOf = (path) => path.replace(/^\/app\/?/, '').replace(/[/:?=&]+/g, '-') || 'home';

try {
  for (const port of [WEB, API]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    if (busy) throw new Error(`port ${port} is already in use; stop the server on it and run again`);
  }
  await resetDbs();
  await run('npx tsx src/cli/seed-staging.ts', 'apps/api');
  start('npx tsx src/main.ts', 'apps/api');
  start(`npx next start -p ${WEB}`, 'apps/web');
  await waitFor(`http://127.0.0.1:${API}/health`);
  await waitFor(`${base}/health`);
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  for (const role of roles) {
    if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    const cookie = await signIn(LOGINS.logins.find((l) => l.role === role).email);
    const [name, value] = cookie.split('=');
    for (const scheme of schemes) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: scheme,
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ name, value, url: base }]);
      const page = await context.newPage();
      const dir = join(OUT, role, scheme);
      mkdirSync(dir, { recursive: true });
      for (let path of PAGES[role]) {
        if (path === ':person') path = (await colleagueProfile(cookie)) ?? '/app/people';
        else if (path.startsWith(':')) {
          const resolved = await seededPage(path, cookie);
          if (!resolved) continue;
          path = resolved;
        }
        if (only && !only.includes(path)) continue;
        const res = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(dir, `${slugOf(path)}.png`), fullPage: true });
        console.log(`${role} ${scheme} ${path} -> ${res?.status()}`);
      }
      await context.close();
    }
  }
  await browser.close();
  console.log(`screenshots in ${OUT}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  stopAll();
}
