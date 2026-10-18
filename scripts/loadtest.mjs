// `pnpm loadtest` — k6 scenarios for brief §3 (loadtest/k6/thapsus.js), against either:
//   --target <https://cell-alb-or-app-url>   an environment that already holds the synthetic tenant, or
//   --provision                              a temporary `loadtest` environment created for this run:
//                                            global + UK cell → 200,000-employee synthetic tenant →
//                                            k6 → results → teardown (asks first unless --yes; --keep skips it).
// Options: --profile smoke|full (default full) · --insecure-tls (self-signed staging/loadtest certs)
//          --param Key=Value (CloudFormation parameters, e.g. CertificateArn) · --record (append to PERFORMANCE.md)
// k6 runs from a local `k6` binary when present, else the pinned grafana/k6 container.
// AWS credentials: an SSO/assumed-role session for the staging account (never long-lived keys).
// Cost: the temporary environment is billed only while it exists (docs/COSTS.md); teardown deletes it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';

const K6_IMAGE = 'grafana/k6:1.3.0';
const ENV = 'loadtest';
const CELL = 'uk';
const CELL_REGION = 'eu-west-2';
const STACKS = { global: `ThapsusHr-${ENV}-global`, cell: `ThapsusHr-${ENV}-cell-${CELL}` };

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const params = args.flatMap((a, i) => (a === '--param' ? ['--param', args[i + 1]] : []));
const profile = value('profile') ?? 'full';
const teardownOnly = flag('teardown-only');
const provision = flag('provision') || teardownOnly;
let target = value('target');
if (!provision && !target) {
  console.error('loadtest: pass --target <url> or --provision (see the header of scripts/loadtest.mjs)');
  process.exit(2);
}

const run = (cmd, a, env = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
};
const deploy = (only, region, extra = []) =>
  run('node', ['--import', 'tsx', 'scripts/deploy.mjs', '--env', ENV, '--only', only, ...params, ...extra], {
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  });

async function confirm(question) {
  if (flag('yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function k6(base) {
  mkdirSync('.loadtest', { recursive: true });
  const name = `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const summary = `.loadtest/${name}`;
  const local = spawnSync('k6', ['version'], { stdio: 'ignore' }).status === 0;
  const env = {
    BASE_URL: base,
    PROFILE: profile,
    INSECURE_TLS: flag('insecure-tls') ? 'true' : 'false',
    SYNTH_USERS: value('users') ?? '26000',
    SUMMARY_FILE: local ? summary : `/out/${name}`, // inside the container .loadtest is mounted at /out
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = local
    ? spawnSync('k6', ['run', ...envArgs, 'loadtest/k6/thapsus.js'], { stdio: 'inherit' })
    : spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          '-v',
          `${resolve('loadtest/k6')}:/scripts:ro`,
          '-v',
          `${resolve('.loadtest')}:/out`,
          K6_IMAGE,
          'run',
          ...envArgs,
          '/scripts/thapsus.js',
        ],
        { stdio: 'inherit' },
      );
  // k6 exits 99 when a threshold fails; any other non-zero code is an execution error.
  return { code: r.status ?? 1, summary };
}

function record(summaryFile, passed, base) {
  if (!existsSync(summaryFile)) return;
  const m = JSON.parse(readFileSync(summaryFile, 'utf8')).metrics;
  const p95 = (k) => (m[k] ? `${Math.round(m[k].values['p(95)'])} ms` : 'n/a');
  const row = `| ${new Date().toISOString().slice(0, 10)} | ${provision ? `${ENV} (${CELL_REGION})` : new URL(base).host} | ${profile} | ${m.vus_max?.values.max ?? 'n/a'} | ${p95('http_req_duration{type:read}')} | ${p95('http_req_duration{type:list}')} | ${m.clock_ins_created?.values.count ?? 0} | ${p95('http_req_duration{type:clock}')} | ${((m.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)} % | ${passed ? 'PASS' : 'FAIL'} |`;
  const doc = readFileSync('docs/PERFORMANCE.md', 'utf8');
  const header =
    '| Date | Environment | Profile | Peak VUs | Reads p95 | Lists p95 | Clock-ins | Clock p95 | Failed | Result |';
  const next = doc.includes(header)
    ? doc.replace(
        header + '\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        (h) => `${h}\n${row}`,
      )
    : doc.replace(
        /(## 3\. Load tests against AWS[^\n]*\n)/,
        `$1\n${header}\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${row}\n`,
      );
  writeFileSync('docs/PERFORMANCE.md', next);
  console.log('recorded in docs/PERFORMANCE.md §3');
}

let exitCode = 0;
try {
  if (teardownOnly) {
    // nothing to run: only the teardown in `finally`
  } else {
    if (provision) {
      console.log(`\n== provisioning the temporary ${ENV} environment (global + ${CELL} cell) ==`);
      deploy('global', 'eu-west-2');
      deploy(`cell-${CELL}`, CELL_REGION, flag('insecure-tls') ? ['--self-signed-tls'] : []);
      deploy(`synth-${CELL}`, CELL_REGION, [
        '--employees',
        value('employees') ?? '200000',
        '--users',
        value('users') ?? '26000',
      ]);
      const out = JSON.parse(readFileSync(`.deploy/${STACKS.cell}.json`, 'utf8'))[STACKS.cell];
      target = `https://${out.AlbDnsName}`;
    }
    console.log(`\n== k6 (${profile}) against ${target} ==`);
    const { code, summary } = k6(target);
    const passed = code === 0;
    if (code !== 0 && code !== 99) throw new Error(`k6 failed to run (exit ${code})`);
    console.log(passed ? 'load test thresholds: PASS' : 'load test thresholds: FAIL (see the summary above)');
    if (flag('record') || provision) record(summary, passed, target);
    exitCode = passed ? 0 : 1;
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (provision && !flag('keep')) {
    if (
      await confirm(
        `Delete the temporary ${ENV} stacks (${STACKS.cell}, ${STACKS.global}) and all their data now?`,
      )
    ) {
      try {
        await teardown();
        console.log(
          'teardown complete (KMS keys stay in "pending deletion" for 7 days, then disappear; see docs/runbooks/load-test.md).',
        );
      } catch (err) {
        console.error(err);
        console.error(
          'teardown did not finish: follow docs/runbooks/load-test.md → "Manual teardown" so nothing keeps costing money.',
        );
        exitCode = 1;
      }
    } else
      console.log(
        `kept the ${ENV} environment: run \`pnpm loadtest --teardown-only\` when finished (it costs money while it exists).`,
      );
  }
}
process.exit(exitCode);

/** Empties the versioned buckets and the backup vault (CloudFormation cannot delete non-empty ones), then destroys the stacks. */
async function teardown() {
  const awsJson = (region, ...a) => {
    const out = execFileSync('aws', ['--region', region, '--output', 'json', ...a], { encoding: 'utf8' });
    return out.trim() ? JSON.parse(out) : {};
  };
  const account = awsJson(CELL_REGION, 'sts', 'get-caller-identity').Account;
  for (const bucket of [
    `thapsus-hr-${ENV}-${CELL_REGION}-files-${account}`,
    `thapsus-hr-${ENV}-${CELL_REGION}-logs-${account}`,
    `thapsus-hr-${ENV}-eu-west-2-global-logs-${account}`,
  ]) {
    if (
      spawnSync('aws', ['--region', CELL_REGION, 's3api', 'head-bucket', '--bucket', bucket], {
        stdio: 'ignore',
      }).status !== 0
    )
      continue;
    console.log(`emptying s3://${bucket} (all versions)`);
    for (;;) {
      const page = awsJson(
        CELL_REGION,
        's3api',
        'list-object-versions',
        '--bucket',
        bucket,
        '--max-items',
        '1000',
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key,
        VersionId: v.VersionId,
      }));
      if (!objects.length) break;
      awsJson(
        CELL_REGION,
        's3api',
        'delete-objects',
        '--bucket',
        bucket,
        '--delete',
        JSON.stringify({ Objects: objects, Quiet: true }),
      );
    }
  }
  const vault = `thapsus-hr-${ENV}-${CELL}`;
  const points = spawnSync(
    'aws',
    [
      '--region',
      CELL_REGION,
      '--output',
      'json',
      'backup',
      'list-recovery-points-by-backup-vault',
      '--backup-vault-name',
      vault,
    ],
    { encoding: 'utf8' },
  );
  if (points.status === 0) {
    for (const rp of JSON.parse(points.stdout).RecoveryPoints ?? []) {
      console.log(`deleting recovery point ${rp.RecoveryPointArn}`);
      awsJson(
        CELL_REGION,
        'backup',
        'delete-recovery-point',
        '--backup-vault-name',
        vault,
        '--recovery-point-arn',
        rp.RecoveryPointArn,
      );
    }
  }
  for (const [stack, region] of [
    [STACKS.cell, CELL_REGION],
    [STACKS.global, 'eu-west-2'],
  ]) {
    execFileSync(
      'pnpm',
      ['--filter', '@thapsus/infra', 'exec', 'cdk', 'destroy', stack, '-c', `env=${ENV}`, '--force'],
      { stdio: 'inherit', env: { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region } },
    );
  }
}
