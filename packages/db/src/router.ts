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
  /**
   * Optional read-only reader per logical database key (reporting role on a read replica / reader
   * endpoint). A dedicated database may have its own reader; a key without one falls back to its writer,
   * never to another database's reader.
   */
  readers?: Record<string, string>;
  /** Key of the shared database that also holds the regional registry. */
  registryKey?: string;
  cacheTtlMs?: number;
  poolMax?: number;
  /** Home region served by this cell; tenants homed elsewhere are treated as unknown here. */
  cell?: string;
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
      if (env.DATABASE_SECRET) databases.shared = secretToUrl(env.DATABASE_SECRET, env.DATABASE_HOST);
      else if (env.DATABASE_URL) databases.shared = env.DATABASE_URL;
      else throw new Error('DATABASE_URL, DATABASE_SECRET or DATABASES must be configured');
    }
    // Dedicated databases: DEDICATED_DATABASE_HOSTS={"acme": "host"} reuse the app role secret.
    if (env.DEDICATED_DATABASE_HOSTS && env.DATABASE_SECRET) {
      for (const [key, host] of Object.entries(JSON.parse(env.DEDICATED_DATABASE_HOSTS) as Record<string, string>)) {
        databases[key] = secretToUrl(env.DATABASE_SECRET, host);
      }
    }
    return new TenantRouter({ databases, readers: readersFromEnv(env), poolMax: env.DB_POOL_MAX ? Number(env.DB_POOL_MAX) : undefined, cell: env.CELL_REGION });
  }

  registryPool(): pg.Pool {
    return this.pool(this.registryKey);
  }

  pool(dbKey: string): pg.Pool {
    const url = this.config.databases[dbKey];
    if (!url) throw new Error(`No database configured for key "${dbKey}"`);
    return getPool(url, { max: this.config.poolMax });
  }

  /** True when a dedicated reader is configured for the database key. */
  hasReader(dbKey: string): boolean {
    return !!this.config.readers?.[dbKey];
  }

  /** Read-only pool for a database key: its configured reader, else its own writer. */
  readerPool(dbKey: string): { pool: pg.Pool; reader: boolean } {
    const url = this.config.readers?.[dbKey];
    if (!url) return { pool: this.pool(dbKey), reader: false };
    return { pool: getPool(url, { max: this.config.poolMax, applicationName: `${process.env.SERVICE_NAME ?? 'thapsus'}-reader` }), reader: true };
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
    if (!entry || (this.config.cell && entry.home_region !== this.config.cell)) throw new TenantNotFoundError(tenantId);
    this.cache.set(tenantId, { entry, at: Date.now() });
    return entry;
  }

  async lookupSlug(slug: string): Promise<RegistryEntry | undefined> {
    const res = await this.registryPool().query<RegistryEntry>(
      'SELECT tenant_id, slug, home_region, db_key, status FROM registry.tenants WHERE slug = $1',
      [slug],
    );
    const entry = res.rows[0];
    return entry && (!this.config.cell || entry.home_region === this.config.cell) ? entry : undefined;
  }

  async poolFor(tenantId: string, opts: { allowMoving?: boolean } = {}): Promise<pg.Pool> {
    const entry = await this.lookup(tenantId);
    if (entry.status === 'deleted' || entry.status === 'suspended') throw new TenantUnavailableError(tenantId, entry.status);
    if (entry.status === 'moving' && !opts.allowMoving) throw new TenantUnavailableError(tenantId, entry.status);
    return this.pool(entry.db_key);
  }

  /** Reader pool for the tenant's database (same status rules as poolFor; reads may continue while moving). */
  async readerPoolFor(tenantId: string, opts: { allowMoving?: boolean } = {}): Promise<{ pool: pg.Pool; reader: boolean; dbKey: string }> {
    const entry = await this.lookup(tenantId);
    if (entry.status === 'deleted' || entry.status === 'suspended') throw new TenantUnavailableError(tenantId, entry.status);
    if (entry.status === 'moving' && !opts.allowMoving) throw new TenantUnavailableError(tenantId, entry.status);
    return { ...this.readerPool(entry.db_key), dbKey: entry.db_key };
  }

  invalidate(tenantId?: string) {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }
}

/**
 * Reader configuration (all optional):
 *  - READER_DATABASES='{"shared": "postgres://…", "acme": "postgres://…"}' explicit reader URLs per key;
 *  - REPORTING_DATABASE_URL: reader for the shared database (local dev / tests);
 *  - REPORTING_DATABASE_SECRET + REPORTING_DATABASE_HOST: the reporting role on the cell's reader endpoint;
 *  - DEDICATED_READER_HOSTS='{"acme": "host"}': readers for dedicated databases (reporting role secret).
 */
export function readersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const readers: Record<string, string> = env.READER_DATABASES ? JSON.parse(env.READER_DATABASES) : {};
  if (!readers.shared) {
    if (env.REPORTING_DATABASE_URL) readers.shared = env.REPORTING_DATABASE_URL;
    else if (env.REPORTING_DATABASE_SECRET && env.REPORTING_DATABASE_HOST) readers.shared = secretToUrl(env.REPORTING_DATABASE_SECRET, env.REPORTING_DATABASE_HOST);
  }
  if (env.DEDICATED_READER_HOSTS && env.REPORTING_DATABASE_SECRET) {
    for (const [key, host] of Object.entries(JSON.parse(env.DEDICATED_READER_HOSTS) as Record<string, string>)) {
      readers[key] ??= secretToUrl(env.REPORTING_DATABASE_SECRET, host);
    }
  }
  return readers;
}

/** Builds a connection URL from a Secrets Manager database secret ({username, password, host, port, dbname}). */
export function secretToUrl(secretJson: string, hostOverride?: string): string {
  const s = JSON.parse(secretJson) as { username: string; password: string; host?: string; port?: number; dbname?: string };
  const host = hostOverride ?? s.host;
  if (!host) throw new Error('database secret has no host');
  // verify-full: TLS with certificate and host name checks (never the libpq "require" that skips them)
  const sslmode = /amazonaws\.com$/.test(host) ? '?sslmode=verify-full' : '';
  return `postgres://${encodeURIComponent(s.username)}:${encodeURIComponent(s.password)}@${host}:${s.port ?? 5432}/${s.dbname ?? 'thapsus'}${sslmode}`;
}
