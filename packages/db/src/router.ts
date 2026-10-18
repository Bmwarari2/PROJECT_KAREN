import type pg from 'pg';
import { getPool } from './client';

export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super('Tenant not found in this cell');
    this.name = 'TenantNotFoundError';
  }
}
export class TenantUnavailableError extends Error {
  constructor(readonly tenantId: string, readonly status: string) {
    super(`Tenant is ${status}`);
    this.name = 'TenantUnavailableError';
  }
}

export interface RouterConfig {
  /** Logical database key → connection URL (application role). From configuration, never code. */
  databases: Record<string, string>;
  /** Key of the shared database that also holds the regional registry. */
  registryKey?: string;
  cacheTtlMs?: number;
  poolMax?: number;
}

export interface RegistryEntry {
  tenant_id: string;
  slug: string;
  home_region: string;
  db_key: string;
  status: string;
}

/**
 * Routes a tenant to its database using the regional registry (registry.tenants.db_key) and the
 * configured database map. Moving a tenant to a dedicated database is a data + configuration change only.
 */
export class TenantRouter {
  private cache = new Map<string, { entry: RegistryEntry; at: number }>();
  readonly registryKey: string;

  constructor(readonly config: RouterConfig) {
    this.registryKey = config.registryKey ?? 'shared';
    if (!config.databases[this.registryKey]) throw new Error(`No database configured for key "${this.registryKey}"`);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TenantRouter {
    const databases: Record<string, string> = env.DATABASES ? JSON.parse(env.DATABASES) : {};
    if (!databases.shared) {
      if (!env.DATABASE_URL) throw new Error('DATABASE_URL or DATABASES must be configured');
      databases.shared = env.DATABASE_URL;
    }
    return new TenantRouter({ databases, poolMax: env.DB_POOL_MAX ? Number(env.DB_POOL_MAX) : undefined });
  }

  registryPool(): pg.Pool {
    return this.pool(this.registryKey);
  }

  pool(dbKey: string): pg.Pool {
    const url = this.config.databases[dbKey];
    if (!url) throw new Error(`No database configured for key "${dbKey}"`);
    return getPool(url, { max: this.config.poolMax });
  }

  async lookup(tenantId: string): Promise<RegistryEntry> {
    const hit = this.cache.get(tenantId);
    const ttl = this.config.cacheTtlMs ?? 15_000;
    if (hit && Date.now() - hit.at < ttl) return hit.entry;
    const res = await this.registryPool().query<RegistryEntry>(
      'SELECT tenant_id, slug, home_region, db_key, status FROM registry.tenants WHERE tenant_id = $1',
      [tenantId],
    );
    const entry = res.rows[0];
    if (!entry) throw new TenantNotFoundError(tenantId);
    this.cache.set(tenantId, { entry, at: Date.now() });
    return entry;
  }

  async lookupSlug(slug: string): Promise<RegistryEntry | undefined> {
    const res = await this.registryPool().query<RegistryEntry>(
      'SELECT tenant_id, slug, home_region, db_key, status FROM registry.tenants WHERE slug = $1',
      [slug],
    );
    return res.rows[0];
  }

  async poolFor(tenantId: string, opts: { allowMoving?: boolean } = {}): Promise<pg.Pool> {
    const entry = await this.lookup(tenantId);
    if (entry.status === 'deleted' || entry.status === 'suspended') throw new TenantUnavailableError(tenantId, entry.status);
    if (entry.status === 'moving' && !opts.allowMoving) throw new TenantUnavailableError(tenantId, entry.status);
    return this.pool(entry.db_key);
  }

  invalidate(tenantId?: string) {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}
