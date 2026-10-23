// One-time local setup: writes git-ignored .env files with random local secrets, creates the
// local databases and applies migrations. Safe to re-run (keeps an existing .env).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import pg from 'pg';
import webpush from 'web-push';

const OWNER = 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';
const rand = (n = 24) => randomBytes(n).toString('base64url');

if (!existsSync('.env')) {
  const vapid = webpush.generateVAPIDKeys();
  // Postgres roles are cluster-wide: local dev and the test suites share this local-only password.
  const appPw = 'local_dev_only_password';
  const boPw = appPw;
  const repPw = appPw;
  const env = {
    APP_ENV: 'dev',
    CELL_REGION: 'uk',
    THAPSUS_HR_DOMAIN: 'thapsus-hr.localhost',
    APP_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: 'http://localhost:3000',
    GLOBAL_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: `postgres://thapsus_app:${appPw}@127.0.0.1:5432/thapsus`,
    BACKOFFICE_DATABASE_URL: `postgres://thapsus_backoffice:${boPw}@127.0.0.1:5432/thapsus`,
    REPORTING_DATABASE_URL: `postgres://thapsus_reporting:${repPw}@127.0.0.1:5432/thapsus`,
    MIGRATOR_DATABASE_URL: `${OWNER}/thapsus`,
    APP_DB_PASSWORD: appPw,
    BACKOFFICE_DB_PASSWORD: boPw,
    REPORTING_DB_PASSWORD: repPw,
    DIRECTORY_DATABASE_URL: `${OWNER}/thapsus_global`,
    VALKEY_URL: 'redis://127.0.0.1:6379',
    SMTP_URL: 'smtp://127.0.0.1:1025',
    MAIL_FROM: 'no-reply@thapsus-hr.localhost',
    FILES_BUCKET: 'thapsus-dev-files',
    S3_ENDPOINT: 'http://127.0.0.1:9090',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    LOCAL_KMS_KEY: randomBytes(32).toString('hex'),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:dev@thapsus-hr.localhost',
    INTERNAL_TOKEN: rand(),
    MOCK_IDP_ENABLED: 'true',
    OTEL_SDK_DISABLED: 'true',
    LOG_LEVEL: 'info',
  };
  writeFileSync(
    '.env',
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  console.log('wrote .env (git-ignored, local-only secrets)');
}
writeFileSync('apps/web/.env.local', 'API_PROXY_URL=http://127.0.0.1:4000\n');

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
await admin.connect();
for (const db of ['thapsus', 'thapsus_global']) {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE ${db}`);
    console.log(`created database ${db}`);
  }
}
await admin.end();
execSync('pnpm --filter @thapsus/db migrate', { stdio: 'inherit', env: { ...process.env, ...env } });
console.log('local setup complete — run `pnpm db:seed` then `pnpm dev`');
