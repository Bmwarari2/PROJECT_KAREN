import pg from 'pg';

const { Pool, types } = pg;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

// Return `date` columns as 'YYYY-MM-DD' strings (calendar dates are never converted to JS Date),
// timestamptz as ISO strings and bigint/numeric as strings to avoid floating point.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1184, (v) => new Date(v).toISOString());
types.setTypeParser(1114, (v) => v);
types.setTypeParser(20, (v) => v);
types.setTypeParser(1700, (v) => v);

const pools = new Map<string, pg.Pool>();

export interface PoolOptions {
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

/**
 * TLS for database connections (ASVS V12.3.1 to V12.3.4). AWS endpoints (RDS Proxy, Aurora) always
 * use TLS with the server certificate verified against the trust store: RDS Proxy presents an ACM
 * certificate (publicly trusted) and the Aurora endpoints the Amazon RDS CA bundle that the image
 * adds through NODE_EXTRA_CA_CERTS. Local Docker Postgres has no TLS, and neither has a Cloud SQL unix
 * socket. A `sslmode` in the URL takes precedence in node-postgres; secretToUrl() writes `verify-full` for AWS.
 */
export function tlsFor(url: string): { rejectUnauthorized: true } | undefined {
  let host: string;
  try {
    const u = new URL(url);
    // A unix socket (Cloud SQL on Cloud Run, ADR-0156): the Cloud SQL connector behind it already encrypts the
    // connection with mutual TLS, and the socket speaks plain PostgreSQL. secretToUrl() writes no sslmode for it.
    if (u.searchParams.get('host')?.startsWith('/')) return undefined;
    host = u.hostname;
  } catch {
    return undefined;
  }
  return /\.amazonaws\.com$/.test(host) || /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(url)
    ? { rejectUnauthorized: true }
    : undefined;
}

export function getPool(url: string, opts: PoolOptions = {}): pg.Pool {
  const key = url;
  let pool = pools.get(key);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: opts.max ?? Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      application_name: opts.applicationName ?? process.env.SERVICE_NAME ?? 'thapsus',
      statement_timeout: opts.statementTimeoutMs ?? 30_000,
      ssl: tlsFor(url),
    });
    pool.on('error', () => {
      /* idle client errors are surfaced on next checkout */
    });
    pools.set(key, pool);
  }
  return pool;
}

export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => undefined)));
}

/** Thin typed wrapper around a pg client bound to one transaction. */
export class Tx {
  constructor(readonly client: PoolClient) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query<T>(text, params as unknown[]);
    return res.rows;
  }
  async one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(text, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  }
  async maybe<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }
  async exec(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(text, params as unknown[]);
    return res.rowCount ?? 0;
  }
}
