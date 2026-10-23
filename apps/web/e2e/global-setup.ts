import { rmSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../../../packages/db/src/migrate';
import { E2E_APP_PASSWORD, E2E_DB, e2eMailDir } from './env';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';

/** Fresh, migrated database for every e2e run. */
export default async function globalSetup() {
  rmSync(e2eMailDir(), { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();
  await migrate({
    ownerUrl: `${OWNER}/${E2E_DB}`,
    rolePasswords: {
      thapsus_app: E2E_APP_PASSWORD,
      thapsus_backoffice: E2E_APP_PASSWORD,
      thapsus_reporting: E2E_APP_PASSWORD,
    },
  });
}
