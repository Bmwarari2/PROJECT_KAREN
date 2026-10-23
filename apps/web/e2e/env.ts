import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolated environment for e2e: its own database and ports; no external services required. */
export const E2E_DB = 'thapsus_e2e';
/** Emails the e2e API sends are written here as JSON files (MAIL_TRANSPORT=file) so tests can follow links. */
export const e2eMailDir = () => join(tmpdir(), `thapsus-e2e-mail-${process.env.E2E_API_PORT ?? '4100'}`);
const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
export const E2E_APP_PASSWORD = 'local_dev_only_password';

export function e2eEnv(): Record<string, string> {
  const host = new URL(OWNER).host;
  const webPort = process.env.E2E_WEB_PORT ?? '3100';
  const apiPort = process.env.E2E_API_PORT ?? '4100';
  const browserHost = process.env.PW_REMOTE_WS ? (process.env.PW_HOST_FROM_BROWSER ?? 'host.docker.internal') : '127.0.0.1';
  const origin = `http://${browserHost}:${webPort}`;
  return {
    WEB_PORT: webPort,
    API_PORT: apiPort,
    PORT: apiPort,
    APP_ENV: 'test',
    CELL_REGION: 'uk',
    THAPSUS_HR_DOMAIN: 'thapsus-hr.test',
    APP_BASE_URL: origin,
    API_BASE_URL: origin,
    GLOBAL_BASE_URL: origin,
    DATABASE_URL: `postgres://thapsus_app:${E2E_APP_PASSWORD}@${host}/${E2E_DB}`,
    BACKOFFICE_DATABASE_URL: `postgres://thapsus_backoffice:${E2E_APP_PASSWORD}@${host}/${E2E_DB}`,
    // reports run on the read-only reporting role, as on the Aurora reader in a cell (ADR-0071)
    REPORTING_DATABASE_URL: `postgres://thapsus_reporting:${E2E_APP_PASSWORD}@${host}/${E2E_DB}`,
    MIGRATOR_DATABASE_URL: `${OWNER}/${E2E_DB}`,
    LOCAL_KMS_KEY: '22'.repeat(32),
    MOCK_IDP_ENABLED: 'true',
    // Ask HR uses the deterministic fake model in e2e (never a real model).
    AI_PROVIDER: 'fake',
    OTEL_SDK_DISABLED: 'true',
    LOG_LEVEL: 'warn',
    INTERNAL_TOKEN: 'e2e-internal-token',
    // every spec signs up its own fictional workspaces from 127.0.0.1; the per-IP limits (10 sign-ups an hour) would block the suite
    IP_THROTTLE_MULTIPLIER: '50',
    MAIL_TRANSPORT: 'file',
    MAIL_DIR: e2eMailDir(),
    NEXT_TELEMETRY_DISABLED: '1',
  };
}
