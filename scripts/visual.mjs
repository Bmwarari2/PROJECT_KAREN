// Visual regression: runs Chromium inside the official Playwright Linux container (pinned to the
// same version as @playwright/test) so screenshots are identical on every developer OS and in CI.
// UPDATE_SNAPSHOTS=1 regenerates baselines.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';

const version = JSON.parse(
  readFileSync('node_modules/.pnpm/node_modules/@playwright/test/package.json', 'utf8'),
).version;
const image = `mcr.microsoft.com/playwright:v${version}-noble`;
// VISUAL_SERVER_PORT lets parallel checkouts on one machine each run their own browser container.
const port = Number(process.env.VISUAL_SERVER_PORT ?? 3333);
const name = port === 3333 ? 'thr-playwright-server' : `thr-playwright-server-${port}`;

const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
// The server comes from the host's own (lockfile-pinned) playwright-core, mounted read-only, so the
// container needs no network access (no `npx` download) and always matches the client version.
const core = realpathSync('node_modules/.pnpm/node_modules/playwright-core');
// --unsafe lets the visual projects pass Chromium flags (greyscale text anti-aliasing, sRGB) so
// screenshots repeat exactly; the port is published on the loopback interface only.
sh(
  `docker run -d --rm --name ${name} -p 127.0.0.1:${port}:${port} --add-host=host.docker.internal:host-gateway --ipc=host -v "${core}:/opt/playwright-core:ro" ${image} node /opt/playwright-core/cli.js run-server --port ${port} --host 0.0.0.0 --unsafe`,
);
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
  const update = process.env.UPDATE_SNAPSHOTS
    ? ` --update-snapshots=${process.env.UPDATE_SNAPSHOTS === 'all' ? 'all' : 'missing'}`
    : '';
  const r = spawnSync(`pnpm --filter @thapsus/web exec playwright test ${projects}${update}`, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, PW_REMOTE_WS: `ws://127.0.0.1:${port}/` },
  });
  process.exitCode = r.status ?? 1;
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
