// Lighthouse (mobile, default throttling) against a production build: marketing pages, auth pages
// and signed-in app screens. Fails if performance < 90 or accessibility < 95 on any page.
// Results are written to .verify/lighthouse.json and summarised for docs/PERFORMANCE.md.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const require = createRequire(pathToFileURL(`${process.cwd()}/apps/web/package.json`));
const lighthouse = (await import(pathToFileURL(require.resolve('lighthouse')).href)).default;
const chromeLauncher = await import(pathToFileURL(require.resolve('chrome-launcher')).href);
// @playwright/test is CommonJS: depending on the loader its exports arrive as named exports or only on `default`.
const playwright = await import(pathToFileURL(require.resolve('@playwright/test')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const OTPAuth = await import(
  pathToFileURL(createRequire(pathToFileURL(`${process.cwd()}/apps/api/package.json`)).resolve('otpauth'))
    .href
);
const { migrate } = await import(pathToFileURL(`${process.cwd()}/packages/db/src/migrate.ts`).href).catch(
  () => ({ migrate: null }),
);

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
const DB = 'thapsus_lighthouse';
const PW = 'local_dev_only_password';
const WEB = Number(process.env.LIGHTHOUSE_WEB_PORT ?? 3200);
const API = Number(process.env.LIGHTHOUSE_API_PORT ?? 4200);
const base = `http://127.0.0.1:${WEB}`;
const THRESHOLDS = { performance: 90, accessibility: 95 };
const ALL_PAGES = [
  { path: '/', label: 'Marketing home' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/trust', label: 'Trust centre' },
  { path: '/status', label: 'Status page' },
  { path: '/developers', label: 'Developers' },
  { path: '/signin', label: 'Sign in' },
  { path: '/signup', label: 'Sign up' },
  { path: '/app', label: 'App home (signed in)', auth: true },
  { path: '/app/me', label: 'Me hub (signed in)', auth: true },
  { path: '/app/people', label: 'People (signed in)', auth: true },
  { path: '/app/time-off', label: 'Time off (signed in)', auth: true },
  { path: '/app/rota', label: 'Rota (signed in)', auth: true },
  { path: '/app/timesheets', label: 'Timesheets (signed in)', auth: true },
  { path: '/app/reports', label: 'Reports catalogue (signed in)', auth: true },
  { path: '/app/reports/builder', label: 'Report builder (signed in)', auth: true },
  { path: '/app/settings', label: 'Settings (signed in)', auth: true },
  { path: '/app/notifications', label: 'Notifications and preferences (signed in)', auth: true },
  { path: '/app/security', label: 'App security (signed in)', auth: true },
];
// LIGHTHOUSE_ONLY=/app/me,/signin limits a run to some pages (debugging); verify always runs them all.
const PAGES = process.env.LIGHTHOUSE_ONLY
  ? ALL_PAGES.filter((p) => process.env.LIGHTHOUSE_ONLY.split(',').includes(p.path))
  : ALL_PAGES;

async function resetDb() {
  const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  if (!migrate) throw new Error('run with tsx-capable node (node --import tsx)');
  await migrate({
    ownerUrl: `${OWNER}/${DB}`,
    rolePasswords: { thapsus_app: PW, thapsus_backoffice: PW, thapsus_reporting: PW },
  });
}

const host = new URL(OWNER).host;
const env = {
  ...process.env,
  PORT: String(API),
  APP_ENV: 'test',
  CELL_REGION: 'uk',
  APP_BASE_URL: base,
  API_BASE_URL: base,
  GLOBAL_BASE_URL: base,
  DATABASE_URL: `postgres://thapsus_app:${PW}@${host}/${DB}`,
  LOCAL_KMS_KEY: '33'.repeat(32),
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'warn',
  API_PROXY_URL: `http://127.0.0.1:${API}`,
  NEXT_TELEMETRY_DISABLED: '1',
};

const procs = [];
const start = (cmd, cwd) => {
  // Own process group, so stopAll ends npm, next-server and tsx too (killing only the shell left them running).
  const p = spawn(cmd, { cwd, shell: true, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  procs.push(p);
};
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
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' });
    else {
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
};

async function sessionCookie() {
  const slug = `lh-${Date.now().toString(36)}`;
  const r = await fetch(`${base}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: 'Fictional Lighthouse Ltd',
      slug,
      region: 'uk',
      ownerName: 'Lee Lighthouse',
      ownerEmail: `owner@${slug}.example.test`,
      password: 'Correct-Horse-Battery-9',
      acceptDpa: true,
    }),
  });
  if (r.status !== 201) throw new Error(`signup failed ${r.status}`);
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => /^(__Host-)?thr_sid=/.test(c)); // __Host-thr_sid behind HTTPS
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
  if (ok.status !== 204) throw new Error('mfa confirm failed');
  return cookie;
}

mkdirSync('.verify', { recursive: true });
let failed = false;
const report = [];
try {
  // A server left on these ports (e.g. by another checkout) would be audited instead of this build.
  for (const port of [WEB, API]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    if (busy) throw new Error(`port ${port} is already in use; stop the server on it and run again`);
  }
  await resetDb();
  start('npx tsx src/main.ts', 'apps/api');
  start(`npx next start -p ${WEB}`, 'apps/web');
  await waitFor(`http://127.0.0.1:${API}/health`);
  await waitFor(`${base}/health`);
  const cookie = await sessionCookie();
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.PW_CHROMIUM_PATH ?? chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });
  try {
    for (const p of PAGES) {
      await fetch(base + p.path).catch(() => undefined); // warm the server
      const scores = [];
      // median of three runs smooths noise on small machines
      for (let run = 0; run < 3; run++) {
        const res = await lighthouse(base + p.path, {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance', 'accessibility', 'best-practices'],
          formFactor: 'mobile',
          extraHeaders: p.auth ? { Cookie: cookie } : undefined,
          disableStorageReset: false,
        });
        if (res.lhr.runtimeError)
          throw new Error(
            `Lighthouse could not audit ${p.path}: ${res.lhr.runtimeError.code} ${res.lhr.runtimeError.message}`,
          );
        for (const id of ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time']) {
          const a = res.lhr.audits[id];
          if (typeof a?.numericValue !== 'number')
            throw new Error(`Lighthouse audit ${id} failed on ${p.path}: ${a?.errorMessage ?? 'no value'}`);
        }
        // The largest-paint element, printed for failing pages (and every run with LIGHTHOUSE_DEBUG=1).
        const lcpNode = Object.entries(res.lhr.audits)
          .filter(([id]) => /lcp|largest/i.test(id))
          .map(([, a]) =>
            a.details?.items
              ?.flatMap?.((x) => x.items ?? [x])
              .map((x) => (x?.type === 'node' ? x : x?.node))
              .find(Boolean),
          )
          .find(Boolean);
        const lcpElement = lcpNode
          ? `${lcpNode.selector} "${String(lcpNode.nodeLabel ?? '').slice(0, 60)}"`
          : 'unknown';
        if (process.env.LIGHTHOUSE_DEBUG) {
          // where the time goes: first paint, server response, page weight and the scripts that cost most
          const a = res.lhr.audits;
          const ms = (id) => Math.round(a[id]?.numericValue ?? 0);
          const scripts = (a['bootup-time']?.details?.items ?? [])
            .slice(0, 3)
            .map((x) => `${String(x.url).split('/').pop()} ${Math.round(x.total)}ms`)
            .join(', ');
          console.log(`  ${p.path} run ${run + 1}: LCP element ${lcpElement}`);
          const a11yMisses = res.lhr.categories.accessibility.auditRefs
            .filter((r) => r.weight > 0 && a[r.id]?.score !== null && a[r.id]?.score < 1)
            .map((r) => r.id);
          if (a11yMisses.length) console.log(`    accessibility audits not passed: ${a11yMisses.join(', ')}`);
          console.log(
            `    FCP ${ms('first-contentful-paint')}ms  LCP ${ms('largest-contentful-paint')}ms  TTFB ${ms('server-response-time')}ms  bytes ${Math.round((a['total-byte-weight']?.numericValue ?? 0) / 1024)}KiB  main thread ${ms('mainthread-work-breakdown')}ms  scripts: ${scripts}`,
          );
        }
        const c = res.lhr.categories;
        scores.push({
          lcpElement,
          performance: Math.round(c.performance.score * 100),
          accessibility: Math.round(c.accessibility.score * 100),
          bestPractices: Math.round(c['best-practices'].score * 100),
          lcp: res.lhr.audits['largest-contentful-paint'].numericValue,
          cls: res.lhr.audits['cumulative-layout-shift'].numericValue,
          tbt: res.lhr.audits['total-blocking-time'].numericValue,
        });
      }
      scores.sort((a, b) => a.performance - b.performance);
      const median = scores[1];
      const pass =
        median.performance >= THRESHOLDS.performance && median.accessibility >= THRESHOLDS.accessibility;
      if (!pass) failed = true;
      report.push({ ...p, ...median, pass });
      console.log(
        `${pass ? 'PASS' : 'FAIL'}  ${p.label.padEnd(28)} perf ${median.performance}  a11y ${median.accessibility}  best ${median.bestPractices}  LCP ${Math.round(median.lcp)}ms  CLS ${median.cls.toFixed(3)}  TBT ${Math.round(median.tbt)}ms`,
      );
      if (!pass) console.log(`      largest paint: ${median.lcpElement}`);
    }
  } finally {
    await chrome.kill();
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  stopAll();
}
writeFileSync(
  '.verify/lighthouse.json',
  JSON.stringify({ at: new Date().toISOString(), thresholds: THRESHOLDS, report }, null, 2),
);
process.exit(failed ? 1 : 0);
