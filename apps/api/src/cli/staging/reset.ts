import { withRegistry, withTenant } from '@thapsus/db';
import { purgeTenant, type PurgeDeps } from '../../modules/privacy/company';
import { StagingConfigError } from './config';
import { SEED_MARKER } from './seed';

/** The value `STAGING_RESET` must hold for the seed to delete the test workspace first (ADR-0185). */
export const RESET_CONFIRMATION = 'delete-fictional-test-workspace';

export type ResetOutcome = 'nothing to reset' | 'reset';

/**
 * Deletes the staging test workspace so the seed can build it again with the current data (ADR-0185).
 * It refuses any workspace the staging seed did not create (no seed-completed marker in its audit
 * trail), deletes through the same verified purge as a customer's account closure (every table, the
 * audit trail, files with their versions, cache keys; a deletion certificate in the registry), and
 * then retires the old name in the registry and the directory so the workspace name is free again.
 */
export async function resetStagingWorkspace(
  deps: PurgeDeps,
  slug: string,
  log: (m: string) => void,
): Promise<ResetOutcome> {
  const entry = await deps.directory.bySlug(slug);
  if (!entry || entry.status === 'deleted') return 'nothing to reset';
  const seeded = await withTenant(deps.router, entry.tenantId, (tx) =>
    tx.maybe('SELECT 1 FROM audit.events WHERE action = $1 LIMIT 1', [SEED_MARKER]),
  );
  if (!seeded)
    throw new StagingConfigError(
      `Workspace "${slug}" was not created by the staging seed, so it is not deleted`,
    );
  const now = deps.now().toISOString();
  const closureId = await withTenant(deps.router, entry.tenantId, async (tx) => {
    const r = await tx.one<{ id: string }>(
      `INSERT INTO app.account_closures (tenant_id, grace_days, purge_after, reason)
       VALUES (app.current_tenant(), 0, $1, $2) RETURNING id`,
      [now, 'Staging reset of the fictional test workspace'],
    );
    return r.id;
  });
  const purged = await purgeTenant(deps, entry.tenantId, closureId);
  if (!purged.certificate) throw new Error(`The test workspace was not deleted: ${purged.skipped}`);
  const retired = `${slug}-r${now.replace(/\D/g, '').slice(0, 12)}`;
  await withRegistry(deps.router, (tx) =>
    tx.exec('UPDATE registry.tenants SET slug = $2 WHERE tenant_id = $1', [entry.tenantId, retired]),
  );
  await deps.directory.update(entry.tenantId, { slug: retired });
  log(
    `deleted the test workspace (${purged.certificate.database.rowsDeleted} rows, ${purged.certificate.files.objectsDeleted} files; certificate ${purged.sha256?.slice(0, 12)})`,
  );
  return 'reset';
}
