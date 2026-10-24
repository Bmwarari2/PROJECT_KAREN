import { scrubString } from '@thapsus/core/scrub';
import { closeAllPools, TenantRouter } from '@thapsus/db';
import { depsFromEnv } from '../deps';
import { directoryFromEnv } from '../lib/directory';
import { keyProviderFromEnv } from '../lib/kms';
import { MemoryObjectStore, objectStoreFromEnv } from '../lib/object-store';
import { StagingConfigError, stagingConfigFromEnv } from './staging/config';
import { RESET_CONFIRMATION, resetStagingWorkspace } from './staging/reset';
import { seedStaging } from './staging/seed';

/**
 * `pnpm db:seed:staging` — the fictional staging workspace "kestrel" (Kestrel Fictional Group Ltd, UK home
 * region): about 300 employees in UK, Ireland and US entities with lived-in data across every module, and one
 * login per built-in role (owner, hr_admin, payroll_admin, manager, employee) from STAGING_LOGINS. Idempotent:
 * re-running only brings the logins up to date. Runs as the app role (RLS applies), never the owner role.
 *
 * Environment: DATABASE_URL or DATABASE_SECRET (+ DATABASE_HOST); the directory, key provider and object
 * store selected by their usual variables; STAGING_LOGINS (required outside local dev). Refuses APP_ENV=prod.
 * STAGING_RESET=delete-fictional-test-workspace first deletes the workspace the seed made before (verified
 * purge, ADR-0185) and seeds it from scratch.
 * Output never contains personal data or secrets: outside local development it names roles only.
 */
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
try {
  const cfg = stagingConfigFromEnv(process.env);
  const local = cfg.appEnv === 'dev' || cfg.appEnv === 'test';
  const objects = objectStoreFromEnv('uk');
  // Files written to an in-memory store vanish with this process: only acceptable for local development.
  if (objects instanceof MemoryObjectStore && !local)
    throw new StagingConfigError('No object store is configured: documents and payslips would be lost');
  // STAGING_RESET deletes the fictional test workspace first, so the seed builds it again (ADR-0185).
  if (process.env.STAGING_RESET) {
    if (process.env.STAGING_RESET !== RESET_CONFIRMATION)
      throw new StagingConfigError(
        `STAGING_RESET must be "${RESET_CONFIRMATION}" to delete the test workspace`,
      );
    log(`reset: ${await resetStagingWorkspace(await depsFromEnv(), cfg.workspace, log)}`);
  }
  const result = await seedStaging(
    {
      router: TenantRouter.fromEnv(),
      directory: await directoryFromEnv(),
      keys: keyProviderFromEnv('uk'),
      objects,
    },
    { workspace: cfg.workspace, logins: cfg.logins, size: cfg.size, log },
  );
  log(result.dataSeeded ? 'data seeded' : 'data already present: left as it is');
  for (const [entity, n] of Object.entries(result.employeesByEntity)) log(`  ${entity}: ${n} employees`);
  log(
    `workspace "${cfg.workspace}": passwords set for ${result.passwordsSet.join(', ') || 'no login (unchanged)'}`,
  );
  // The generated local logins (fictional emails, fresh passwords) are printed once so a developer can sign in.
  if (cfg.generated)
    for (const l of cfg.logins) console.log(`  ${l.role.padEnd(13)} ${l.email}  ${l.password}`);
  log(`done in ${result.seconds}s`);
  await closeAllPools();
  process.exit(0);
} catch (err) {
  const e = err as Error & { code?: string };
  console.error(
    err instanceof StagingConfigError
      ? `staging seed refused: ${err.message}`
      : `staging seed failed: ${e.name}${e.code ? ` (${e.code})` : ''}: ${scrubString(e.message ?? String(err))}\n${scrubString(e.stack ?? '')}`,
  );
  await closeAllPools();
  process.exit(1);
}
