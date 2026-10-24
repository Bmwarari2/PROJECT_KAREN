// Secret scan over every tracked and untracked (non-ignored) file. Fails on AWS keys, private keys,
// tokens and high-entropy credentials. Test fixtures that intentionally look secret are allow-listed
// by exact path + pattern below (none are real).
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/\.(png|jpg|jpeg|gif|webp|avif|woff2?|ico|pdf|zip)$/i.test(f) && f !== 'pnpm-lock.yaml');

const RULES = [
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['AWS secret access key', /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Stripe live key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Generic password assignment', /(?:password|passwd|secret)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];
const ALLOW = [
  // fictional test fixtures and local-only defaults, never used outside dev/test
  [/test\/|e2e\/|\.test\.ts$/, /Generic password assignment/],
  // Docker-local Postgres role password shared by dev and the test suites (never used in AWS), and the
  // fictional sign-ins of the local phone screenshot tour
  [
    /^scripts\/(dev-setup|lighthouse|phone-tour)\.mjs$|^packages\/db\/src\/testing\.ts$/,
    /Generic password assignment/,
  ],
];

const findings = [];
for (const f of files) {
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re] of RULES) {
    if (re.test(text) && !ALLOW.some(([p, r]) => p.test(f) && r.test(name))) findings.push(`${f}: ${name}`);
  }
}
if (findings.length) {
  console.error('Secret scan FAILED:\n' + findings.join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files).`);
