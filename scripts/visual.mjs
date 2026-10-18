// Visual regression: runs Chromium inside the official Playwright Linux container (pinned to the
// same version as @playwright/test) so screenshots are identical on every developer OS and in CI.
// UPDATE_SNAPSHOTS=1 regenerates baselines.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('node_modules/.pnpm/node_modules/@playwright/test/package.json', 'utf8')).version;
const image = `mcr.microsoft.com/playwright:v${version}-noble`;
const name = 'thr-playwright-server';
const port = 3333;

const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
sh(`docker run -d --rm --name ${name} -p ${port}:${port} --add-host=host.docker.internal:host-gateway --ipc=host ${image} /bin/sh -c "npx -y playwright@${version} run-server --port ${port} --host 0.0.0.0"`);
try {
  // wait for the server to accept connections
  for (let i = 0; i < 60; i++) {
    const ok = spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout.includes('Listening');
    if (ok) break;
    execSync(process.platform === 'win32' ? 'powershell -Command "Start-Sleep -Seconds 2"' : 'sleep 2');
  }
  const all = ['visual-desktop-light', 'visual-desktop-dark', 'visual-phone-light', 'visual-phone-dark'];
  const projects = (process.env.VISUAL_PROJECTS?.split(',') ?? all).map((p) => `--project ${p}`).join(' ');
  // 'missing' writes only baselines that do not exist yet; 'all' rewrites every baseline
  const update = process.env.UPDATE_SNAPSHOTS ? ` --update-snapshots=${process.env.UPDATE_SNAPSHOTS === 'all' ? 'all' : 'missing'}` : '';
  const r = spawnSync(`pnpm --filter @thapsus/web exec playwright test ${projects}${update}`, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, PW_REMOTE_WS: `ws://127.0.0.1:${port}/` },
  });
  process.exitCode = r.status ?? 1;
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
