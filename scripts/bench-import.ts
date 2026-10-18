// Bulk-import benchmark: a 200,000-row employee file imported as a background job (PROGRESS 1.4).
// Run: node --env-file=.env --import tsx scripts/bench-import.ts   (IMPORT_ROWS to change the size)
// A fresh fictional tenant is created each run. Steps: upload → validation preview → run as a job on the
// worker engine while polling GET /v1/jobs/:id for progress → error report → re-run (same batch reuses
// the job; the same file uploaded again changes nothing). Results → .verify/bench-import.json; exits 1
// if any check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
// scripts/ has no workspace dependencies of its own: import through relative paths
import { buildApp } from '../apps/api/src/app';
import { depsFromEnv } from '../apps/api/src/deps';
import { eventSubscribers, jobHandlers } from '../apps/api/src/worker';
import { Engine, MemoryPublisher } from '../apps/worker/src/engine';
import { prng } from '../apps/api/src/cli/fixtures';
import { totpCode } from './lib/totp';

const N = Number(process.env.IMPORT_ROWS ?? 200_000);
const BAD_EVERY = 20_000; // rows with an invalid date, so the error report is exercised
const PASSWORD = 'Import-Bench-Password-2026';
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const checks: Array<{ check: string; pass: boolean; detail?: unknown }> = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ check: name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
};

const deps = await depsFromEnv();
const app = await buildApp(deps, { logger: false });
await app.ready();
const engine = new Engine({ router: deps.router, deps, handlers: jobHandlers, subscribers: eventSubscribers, publisher: new MemoryPublisher() });

// ---- a fresh fictional workspace with an MFA-verified owner ------------------------------------------
const slug = `import-bench-${Date.now().toString(36)}`;
const signup = await app.inject({ method: 'POST', url: '/v1/signup', remoteAddress: '10.201.0.1', payload: { companyName: 'Import Bench Fictional Ltd', slug, region: deps.config.cell, ownerName: 'Ivy Importer', ownerEmail: `owner@${slug}.example.test`, password: PASSWORD, acceptDpa: true } });
if (signup.statusCode !== 201) throw new Error(`signup failed: ${signup.body}`);
const { tenantId } = signup.json() as { tenantId: string };
const cookie = String(signup.headers['set-cookie']).split(';')[0]!;
const enrol = (await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie } })).json() as { secret: string };
await app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/confirm', headers: { cookie }, payload: { code: totpCode(enrol.secret) } });
const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as object, headers: { cookie } });
  if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.json();
};
await api('POST', '/v1/org/legal-entities', { name: 'Bench Fictional Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' });
const DEPARTMENTS = ['Engineering', 'Operations', 'Sales', 'Finance', 'People', 'Support', 'Marketing', 'Legal'];
for (const name of DEPARTMENTS) await api('POST', '/v1/org/departments', { name });

// ---- a deterministic 200,000-row file with a manager hierarchy ----------------------------------------
const num = (i: number) => `IB${String(i + 1).padStart(6, '0')}`;
const lines = ['Employee ID,First name,Last name,Start date,Job title,Entity,Department,Salary,Currency,Pay frequency,Contract type,Manager'];
for (let i = 0; i < N; i++) {
  const r = prng(777 + i);
  const start = `${2010 + Math.floor(r() * 16)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
  const bad = i > 0 && i % BAD_EVERY === 0;
  lines.push([num(i), `Imp${i % 997}`, `Fictional${i % 991}`, bad ? '2026-02-30' : start, 'Analyst', 'Bench Fictional Ltd', DEPARTMENTS[i % DEPARTMENTS.length], `${30000 + (i % 40000)}.${String(i % 100).padStart(2, '0')}`, 'GBP', 'annual', 'permanent', i === 0 ? '' : num(Math.floor((i - 1) / 8))].join(','));
}
const csv = Buffer.from(lines.join('\n'));
const badRows = Math.floor((N - 1) / BAD_EVERY);
log(`generated ${N} rows (${(csv.length / 2 ** 20).toFixed(1)} MiB, ${badRows} invalid)`);

const upload = async () => {
  const boundary = `----bench${Date.now()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="people.csv"\r\nContent-Type: text/csv\r\n\r\n`), csv, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/v1/imports', payload, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  if (r.statusCode !== 201) throw new Error(`upload failed: ${r.body}`);
  return r.json() as { id: string; suggestedMapping: Record<string, string> };
};

async function runImport(label: string) {
  let t = Date.now();
  const up = await upload();
  const uploadMs = Date.now() - t;
  const mapping = { ...up.suggestedMapping, 'Start date': 'startDate', 'Job title': 'jobTitle', 'Pay frequency': 'payFrequency', 'Contract type': 'contractType' };
  t = Date.now();
  const preview = await api('POST', `/v1/imports/${up.id}/preview`, { mapping });
  const previewMs = Date.now() - t;
  const run = await api('POST', `/v1/imports/${up.id}/run`, {});
  log(`${label}: uploaded in ${uploadMs} ms, previewed in ${previewMs} ms (${preview.valid} valid, ${preview.errors.length} errors), job ${run.jobId}`);
  // the worker engine runs the job; meanwhile poll the public job endpoint like the UI does
  t = Date.now();
  const progress: Array<{ atMs: number; done: number; total: number | null; status: string }> = [];
  let finished = false;
  const worker = engine.processTenant(tenantId).finally(() => (finished = true));
  while (!finished) {
    const j = await api('GET', `/v1/jobs/${run.jobId}`);
    const snap = { atMs: Date.now() - t, done: Number(j.progressDone), total: j.progressTotal === null ? null : Number(j.progressTotal), status: j.status as string };
    if (!progress.length || progress.at(-1)!.done !== snap.done || progress.at(-1)!.status !== snap.status) {
      progress.push(snap);
      log(`${label}: ${snap.status} ${snap.done}/${snap.total ?? '?'}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await worker;
  const jobMs = Date.now() - t;
  const job = await api('GET', `/v1/jobs/${run.jobId}`);
  if (job.status !== 'succeeded') log(`${label}: job ${job.status}: ${job.error}`);
  const status = await api('GET', `/v1/imports/${up.id}`);
  log(`${label}: job ${job.status} in ${(jobMs / 1000).toFixed(1)} s: ${JSON.stringify(status.stats)}`);
  return { batchId: up.id, jobId: run.jobId as string, uploadMs, previewMs, jobMs, preview: { rows: preview.rows, valid: preview.valid, errors: preview.errors.length }, progress, job: { status: job.status, progressDone: job.progressDone, progressTotal: job.progressTotal }, stats: status.stats, errorReport: !!status.errorReportUrl };
}

const first = await runImport('first import');
check('first import job succeeded', first.job.status === 'succeeded', first.job.status);
check('every valid row was created', first.stats.created === N - badRows, first.stats);
check('invalid rows are reported, not imported', first.stats.failed === badRows && first.errorReport, { failed: first.stats.failed, errorReport: first.errorReport });
const updates = first.progress.filter((p) => p.status === 'running');
check('progress was reported while the job ran', updates.length >= 3 && updates.every((p, i) => i === 0 || p.done >= updates[i - 1]!.done) && first.job.progressDone === String(N), { updates: updates.length, final: `${first.job.progressDone}/${first.job.progressTotal}` });

const rerunSameBatch = await api('POST', `/v1/imports/${first.batchId}/run`, {});
check('running the same batch again reuses its job', rerunSameBatch.jobId === first.jobId && rerunSameBatch.created === false, rerunSameBatch);

const second = await runImport('same file again');
check('re-importing the same file changes nothing', second.job.status === 'succeeded' && second.stats.created === 0 && second.stats.updated === 0 && second.stats.unchanged === N - badRows, second.stats);

const machine = { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version };
mkdirSync('.verify', { recursive: true });
writeFileSync('.verify/bench-import.json', JSON.stringify({ at: new Date().toISOString(), rows: N, machine, first, second, checks }, null, 2));
const failed = checks.filter((c) => !c.pass);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall import checks passed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
await app.close();
process.exit(failed.length ? 1 : 0);
