import { defineConfig, devices } from '@playwright/test';
import { e2eEnv } from './e2e/env';

/**
 * - `functional` (local Chromium): flows, accessibility (axe), PWA.
 * - `visual-*` (Linux Chromium in the official Playwright container via run-server, so screenshots are
 *   identical on Windows, macOS and CI): light/dark × phone/desktop.
 */
const env = e2eEnv();
const remote = process.env.PW_REMOTE_WS;
const hostForBrowser = remote ? (process.env.PW_HOST_FROM_BROWSER ?? 'host.docker.internal') : '127.0.0.1';
const webPort = Number(env.WEB_PORT);

const visual = (name: string, device: object, colorScheme: 'light' | 'dark') => ({
  name: `visual-${name}-${colorScheme}`,
  testMatch: /visual\.spec\.ts/,
  use: {
    ...device,
    colorScheme,
    reducedMotion: 'reduce' as const,
    baseURL: `http://${hostForBrowser}:${webPort}`,
    ...(remote ? { connectOptions: { wsEndpoint: remote } } : {}),
  },
});

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  timeout: 240_000,
  // Screenshots come from one pinned Linux container, so they are pixel-stable: allow only a handful of
  // differing pixels (a ratio of 1% hid whole new sidebar sections on a desktop page).
  expect: { timeout: 60_000, toHaveScreenshot: { maxDiffPixels: 50, animations: 'disabled', caret: 'hide' } },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  projects: [
    {
      name: 'functional',
      testIgnore: /visual\.spec\.ts/,
      // PW_CHROMIUM_PATH: use a pre-installed Chromium where `playwright install` is unavailable (CI installs its own).
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${webPort}`, launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {} },
    },
    visual('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, 'light'),
    visual('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, 'dark'),
    visual('phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, 'light'),
    visual('phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, 'dark'),
  ],
  webServer: [
    {
      command: 'npx tsx ../api/src/main.ts',
      url: `http://127.0.0.1:${env.API_PORT}/health`,
      env,
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: 'ignore',
    },
    {
      command: `npx next start -p ${webPort} -H 0.0.0.0`,
      url: `http://127.0.0.1:${webPort}/health`,
      env: { ...env, API_PROXY_URL: `http://127.0.0.1:${env.API_PORT}` },
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: 'ignore',
    },
  ],
});
