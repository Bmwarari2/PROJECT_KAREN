// `pnpm verify` step `gcp`: the Google Cloud staging cell (infra/gcp/staging) is formatted, valid and
// passes its offline tests (mock providers; no Google Cloud calls, no credentials). Needs OpenTofu
// 1.13+ on PATH (CI installs it), or TOFU_BIN pointing at it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tofu = process.env.TOFU_BIN ?? 'tofu';
const cwd = fileURLToPath(new URL('../infra/gcp/staging', import.meta.url));
const run = (bin, args, dir = cwd) =>
  execFileSync(bin, args, { cwd: dir, stdio: 'inherit', env: process.env });

try {
  execFileSync(tofu, ['version'], { stdio: 'ignore' });
} catch {
  console.error(
    'OpenTofu is not installed: get 1.13+ from https://opentofu.org/docs/intro/install/ (or set VERIFY_SKIP=gcp).',
  );
  process.exit(1);
}
run('bash', ['-n', 'bootstrap.sh'], fileURLToPath(new URL('../infra/gcp', import.meta.url)));
run(tofu, ['fmt', '-check', '-recursive', '-diff']);
run(tofu, ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color']);
run(tofu, ['validate', '-no-color']);
run(tofu, ['test', '-no-color']);
