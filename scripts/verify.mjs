// `pnpm verify` — the full quality gate. Runs every step in order, never stops early, prints a
// pass/fail table and exits non-zero if any step failed.
//   VERIFY_ONLY=lint,unit    run a subset        VERIFY_SKIP=lighthouse   skip steps (reported as SKIPPED)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const isWin = process.platform === 'win32';
const steps = [
  { id: 'deps', name: 'Local services (Postgres, Valkey)', cmd: 'docker compose up -d --wait postgres valkey' },
  { id: 'lint', name: 'Lint (ESLint + i18n hard-coded string rule)', cmd: 'pnpm exec eslint . --max-warnings=0' },
  { id: 'typecheck', name: 'Typecheck (tsc strict, all packages)', cmd: 'pnpm -r --workspace-concurrency=1 run typecheck' },
  { id: 'unit', name: 'Unit tests', cmd: 'pnpm exec vitest run --project unit' },
  { id: 'integration', name: 'Integration tests (real PostgreSQL)', cmd: 'pnpm exec vitest run --project integration' },
  { id: 'contract', name: 'Contract tests (OpenAPI 3.1)', cmd: 'pnpm exec vitest run --project contract' },
  { id: 'isolation', name: 'Tenant isolation (RLS)', cmd: 'pnpm exec vitest run --project isolation' },
  { id: 'residency', name: 'Data residency (every region pair)', cmd: 'pnpm exec vitest run --project residency' },
  { id: 'build', name: 'Build (web, api, worker)', cmd: 'pnpm --filter @thapsus/web build && node scripts/bundle.mjs apps/api/src/main.ts apps/api/dist/main.mjs && node scripts/bundle.mjs apps/worker/src/main.ts apps/worker/dist/main.mjs' },
  { id: 'e2e', name: 'End-to-end + axe (Playwright)', cmd: 'pnpm --filter @thapsus/web exec playwright test --project functional' },
  { id: 'visual', name: 'Visual regression (light/dark × phone/desktop)', cmd: 'node scripts/visual.mjs' },
  { id: 'lighthouse', name: 'Lighthouse (mobile: perf ≥90, a11y ≥95)', cmd: 'node --import tsx scripts/lighthouse.mjs' },
  { id: 'security', name: 'Security scan (pnpm audit high + secret scan)', cmd: 'pnpm audit --audit-level high --prod && node scripts/secret-scan.mjs' },
  { id: 'synth', name: 'CDK synth (all environments × regions)', cmd: 'pnpm --filter @thapsus/infra synth' },
];

const only = process.env.VERIFY_ONLY?.split(',');
const skip = new Set(process.env.VERIFY_SKIP?.split(',') ?? []);
mkdirSync('.verify', { recursive: true });

function run(cmd, id) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1' } });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      writeFileSync(`.verify/${id}.log`, out);
      resolve({ code, seconds: (Date.now() - started) / 1000, tail: out.trim().split('\n').slice(-3).join(' | ') });
    });
  });
}

const results = [];
for (const s of steps) {
  if ((only && !only.includes(s.id)) || skip.has(s.id)) {
    results.push({ ...s, status: 'SKIPPED', seconds: 0 });
    continue;
  }
  console.log(`\n━━ ${s.name} ━━`);
  const r = await run(s.cmd, s.id);
  results.push({ ...s, status: r.code === 0 ? 'PASS' : 'FAIL', seconds: r.seconds, tail: r.tail });
}

const pad = (v, n) => String(v).padEnd(n);
const lines = [
  '',
  'Thapsus-HR verify summary',
  `${pad('Step', 52)} ${pad('Result', 8)} Time`,
  `${'-'.repeat(52)} ${'-'.repeat(8)} ${'-'.repeat(8)}`,
  ...results.map((r) => `${pad(r.name, 52)} ${pad(r.status, 8)} ${r.seconds.toFixed(0)}s`),
];
const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIPPED');
lines.push('', failed.length ? `RESULT: FAIL (${failed.map((f) => f.id).join(', ')})` : skipped.length ? `RESULT: PASS with ${skipped.length} step(s) skipped (${skipped.map((s) => s.id).join(', ')})` : 'RESULT: PASS (all steps)');
const summary = lines.join('\n');
console.log(summary);
writeFileSync('.verify/summary.txt', summary + '\n');
process.exit(failed.length ? 1 : 0);
void isWin;
