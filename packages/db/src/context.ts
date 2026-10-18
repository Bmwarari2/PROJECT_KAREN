import type pg from 'pg';
import { Tx } from './client';
import type { TenantRouter } from './router';

export interface TenantContextOptions {
  actorId?: string | null;
  readOnly?: boolean;
  /** Allows read-only access while a tenant is being moved between databases. */
  allowMoving?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runInTransaction<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  setup?: (tx: Tx) => Promise<void>,
  readOnly = false,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const tx = new Tx(client);
    if (setup) await setup(tx);
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The ONLY way application code reaches tenant data. Sets app.tenant_id (and app.actor_id) with
 * set_config(..., true) so the values are transaction-local and cannot leak between pooled connections
 * (safe behind RDS Proxy).
 */
export async function withTenant<T>(
  router: TenantRouter,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: TenantContextOptions = {},
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenant id');
  if (opts.actorId && !UUID_RE.test(opts.actorId)) throw new Error('Invalid actor id');
  const pool = await router.poolFor(tenantId, { allowMoving: opts.allowMoving && opts.readOnly });
  return runInTransaction(
    pool,
    fn,
    async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)", [
        tenantId,
        opts.actorId ?? '',
      ]);
    },
    opts.readOnly,
  );
}

/**
 * Read-only tenant context on the tenant's READER (reporting role on a read replica), falling back to the
 * writer when no reader is configured for the tenant's database. Same transaction-local tenant setting,
 * so forced RLS applies exactly as on the writer. Used for reports and data exports only.
 */
export async function withTenantReader<T>(
  router: TenantRouter,
  tenantId: string,
  fn: (tx: Tx, info: { reader: boolean; dbKey: string }) => Promise<T>,
  opts: Pick<TenantContextOptions, 'actorId'> = {},
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenant id');
  if (opts.actorId && !UUID_RE.test(opts.actorId)) throw new Error('Invalid actor id');
  const { pool, reader, dbKey } = await router.readerPoolFor(tenantId, { allowMoving: true });
  return runInTransaction(
    pool,
    (tx) => fn(tx, { reader, dbKey }),
    async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)", [tenantId, opts.actorId ?? '']);
    },
    true,
  );
}

/** Registry-level access (no tenant data). */
export async function withRegistry<T>(router: TenantRouter, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTransaction(router.registryPool(), fn);
}
