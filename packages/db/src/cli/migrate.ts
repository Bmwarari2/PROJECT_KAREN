import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from '../migrate';
import { secretToUrl } from '../router';

/**
 * Applies migrations as the owner role and sets application role passwords.
 * Locally: MIGRATOR_DATABASE_URL + APP_DB_PASSWORD from .env. In AWS: OWNER_DATABASE_SECRET and the
 * role secrets injected by ECS from Secrets Manager.
 */
const env = process.env;
const ownerUrl =
  env.MIGRATOR_DATABASE_URL ??
  (env.OWNER_DATABASE_SECRET ? secretToUrl(env.OWNER_DATABASE_SECRET, env.DATABASE_HOST) : undefined);
if (!ownerUrl) {
  console.error('MIGRATOR_DATABASE_URL or OWNER_DATABASE_SECRET is required');
  process.exit(2);
}
const pw = (v?: string) => (v?.startsWith('{') ? (JSON.parse(v) as { password: string }).password : v);
// When bundled, migrations are copied next to the bundle.
const bundled = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const applied = await migrate({
  ownerUrl,
  dir: existsSync(bundled) ? bundled : undefined,
  rolePasswords: {
    thapsus_app: pw(env.APP_DB_PASSWORD ?? env.APP_DATABASE_SECRET),
    thapsus_backoffice: pw(env.BACKOFFICE_DB_PASSWORD ?? env.BACKOFFICE_DATABASE_SECRET),
    thapsus_reporting: pw(env.REPORTING_DB_PASSWORD ?? env.REPORTING_DATABASE_SECRET),
  },
  log: (m) => console.log(m),
});
console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
