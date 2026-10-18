import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';

/**
 * Moves one tenant between cell databases (e.g. shared → dedicated) with no application change:
 *  1. registry status → 'moving' (the router refuses writes; reads may continue), wait for caches
 *  2. COPY every tenant-scoped table, parents before children (FK order)
 *  3. verify per-table row counts match
 *  4. registry db_key → target, status → 'active'
 *  5. (optional) purge the tenant's rows from the source
 * Runbook: docs/runbooks/move-tenant-to-dedicated-db.md
 */
export interface MoveOptions {
  tenantId: string;
  /** Owner (migrator) URLs keyed by database key, e.g. { shared: ..., dedicated: ... }. */
  ownerUrls: Record<string, string>;
  registryKey?: string;
  targetKey: string;
  settleMs?: number;
  purgeSource?: boolean;
  log?: (msg: string) => void;
}

export interface MoveReport {
  from: string;
  to: string;
  tables: Array<{ table: string; rows: number }>;
  purged: boolean;
}

const TENANT_SCHEMAS = ['app', 'vault', 'audit'];

async function connect(url: string, tenantId: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  // Owners are subject to FORCE RLS on managed Postgres, so the tenant context is set for the session.
  await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
  return c;
}

/** Tenant tables in foreign-key dependency order (parents first). */
export async function tenantTablesInOrder(client: pg.Client): Promise<string[]> {
  const { rows: tables } = await client.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ANY($1)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`,
    [TENANT_SCHEMAS],
  );
  const { rows: deps } = await client.query<{ child: string; parent: string }>(
    `SELECT format('%I.%I', cn.nspname, c.relname) AS child, format('%I.%I', pn.nspname, p.relname) AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE k.contype = 'f' AND k.conrelid <> k.confrelid`,
  );
  const names = tables.map((t) => t.name);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (ordered.includes(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const d of deps.filter((x) => x.child === t && names.includes(x.parent))) visit(d.parent);
    ordered.push(t);
  };
  for (const t of names) visit(t);
  return ordered;
}

async function columns(client: pg.Client, table: string): Promise<string> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS c FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
    [table],
  );
  return rows[0]!.c;
}

async function count(client: pg.Client, table: string, tenantId: string) {
  const r = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0]!.n);
}

export async function moveTenant(opts: MoveOptions): Promise<MoveReport> {
  const log = opts.log ?? (() => undefined);
  const registryKey = opts.registryKey ?? 'shared';
  const registry = new pg.Client({ connectionString: opts.ownerUrls[registryKey] });
  await registry.connect();
  try {
    const entry = (await registry.query<{ db_key: string; status: string }>('SELECT db_key, status FROM registry.tenants WHERE tenant_id = $1', [opts.tenantId])).rows[0];
    if (!entry) throw new Error('tenant not found in registry');
    if (entry.db_key === opts.targetKey) throw new Error('tenant already on target database');
    if (entry.status !== 'active') throw new Error(`tenant status is ${entry.status}`);
    const sourceUrl = opts.ownerUrls[entry.db_key];
    const targetUrl = opts.ownerUrls[opts.targetKey];
    if (!sourceUrl || !targetUrl) throw new Error('owner URL missing for source or target');

    await registry.query(`UPDATE registry.tenants SET status = 'moving' WHERE tenant_id = $1`, [opts.tenantId]);
    log(`tenant ${opts.tenantId}: marked moving; waiting ${opts.settleMs ?? 0} ms for router caches`);
    if (opts.settleMs) await new Promise((r) => setTimeout(r, opts.settleMs));

    const source = await connect(sourceUrl, opts.tenantId);
    const target = await connect(targetUrl, opts.tenantId);
    const report: MoveReport = { from: entry.db_key, to: opts.targetKey, tables: [], purged: false };
    try {
      const tables = await tenantTablesInOrder(source);
      await target.query('BEGIN');
      for (const table of tables) {
        if ((await count(target, table, opts.tenantId)) > 0) throw new Error(`${table} already has rows for this tenant on the target`);
        const cols = await columns(source, table);
        const out = source.query(copyTo(`COPY (SELECT ${cols} FROM ${table} WHERE tenant_id = '${opts.tenantId}') TO STDOUT WITH (FORMAT binary)`));
        const inp = target.query(copyFrom(`COPY ${table} (${cols}) FROM STDIN WITH (FORMAT binary)`));
        await pipeline(out, inp);
        const [a, b] = [await count(source, table, opts.tenantId), await count(target, table, opts.tenantId)];
        if (a !== b) throw new Error(`row count mismatch on ${table}: ${a} vs ${b}`);
        report.tables.push({ table, rows: b });
        log(`copied ${table}: ${b} rows`);
      }
      // bigserial sequences on the target must stay ahead of copied ids
      await target.query(`
        DO $$ DECLARE r record; BEGIN
          FOR r IN SELECT s.seqrelid::regclass AS seq, d.refobjid::regclass AS tbl, a.attname AS col
                     FROM pg_sequence s JOIN pg_depend d ON d.objid = s.seqrelid AND d.deptype = 'a'
                     JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid LOOP
            EXECUTE format('SELECT setval(%L, greatest((SELECT coalesce(max(%I), 0) FROM %s), (SELECT last_value FROM %s), 1))', r.seq, r.col, r.tbl, r.seq);
          END LOOP; END $$`);
      await target.query('COMMIT');

      await registry.query(`UPDATE registry.tenants SET db_key = $2, status = 'active' WHERE tenant_id = $1`, [opts.tenantId, opts.targetKey]);
      log(`routing switched to ${opts.targetKey}`);

      if (opts.purgeSource) {
        await source.query('BEGIN');
        // FK and append-only triggers are bypassed only for this purge of an already-copied tenant.
        await source.query('SET LOCAL session_replication_role = replica');
        for (const table of [...tables].reverse()) await source.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [opts.tenantId]);
        await source.query('COMMIT');
        report.purged = true;
        log('source purged');
      }
      return report;
    } catch (err) {
      await target.query('ROLLBACK').catch(() => undefined);
      await registry.query(`UPDATE registry.tenants SET status = 'active' WHERE tenant_id = $1 AND status = 'moving'`, [opts.tenantId]);
      throw err;
    } finally {
      await source.end();
      await target.end();
    }
  } finally {
    await registry.end();
  }
}
