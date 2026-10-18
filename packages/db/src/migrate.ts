import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Expand-and-contract lint: destructive statements are only allowed in a migration that declares
 * `-- contract: <release that stopped using it>` at the top.
 */
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+(COLUMN|TO)\b/i,
  /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i,
  /\bALTER\s+COLUMN\s+\w+\s+SET\s+NOT\s+NULL\b/i,
];
export function lintMigration(m: Pick<MigrationFile, 'name' | 'sql'>): string[] {
  const contract = /^--\s*contract:\s*\S+/m.test(m.sql);
  if (contract) return [];
  const body = m.sql.replace(/--.*$/gm, '');
  return DESTRUCTIVE.filter((re) => re.test(body)).map((re) => `${m.name}: destructive statement ${re} needs a "-- contract:" header`);
}

export interface MigrateOptions {
  ownerUrl: string;
  dir?: string;
  rolePasswords?: Partial<Record<'thapsus_app' | 'thapsus_backoffice' | 'thapsus_reporting', string>>;
  log?: (msg: string) => void;
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const m of loadMigrations(opts.dir)) {
      const prev = done.get(m.name);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied`);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      applied.push(m.name);
    }
    for (const [role, password] of Object.entries(opts.rolePasswords ?? {})) {
      if (password) await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
