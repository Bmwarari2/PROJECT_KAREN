import { createHash } from 'node:crypto';
import type { Principal } from '@thapsus/core/permissions';
import type { Tx } from '@thapsus/db';
import type { RuleBook } from '@thapsus/rules';
import type { KeyProvider } from '../../lib/kms';
import type { ObjectStore } from '../../lib/object-store';
import { Vault, type VaultActor } from '../../modules/vault/service';
import type { LoginRole } from './config';
import type { DeptKey, EntityKey, LocationKey, Plan } from './plan';

/** State shared by the seed steps (one tenant transaction; RLS applies to every statement). */
export interface SeedCtx {
  tx: Tx;
  tenantId: string;
  book: RuleBook;
  keys: KeyProvider;
  objects: ObjectStore;
  plan: Plan;
  /** Today in the company's home zone: the date the history is built around. */
  anchor: string;
  vault: Vault;
  /** The seed acts as the system (nil actor id), like the app's scheduled jobs. */
  system: VaultActor;
  ids: {
    entity: Record<EntityKey, string>;
    location: Record<LocationKey, string>;
    dept: Record<DeptKey, string>;
    /** Employee id by plan index. */
    employee: string[];
    user: Record<LoginRole, string>;
    leaveType: Record<string, string>;
    costCentre: Record<string, string>;
    grade: Record<string, string>;
  };
  counts: Record<string, number>;
  log: (message: string) => void;
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const SYSTEM_PRINCIPAL: Principal = {
  userId: NIL_UUID,
  employeeId: null,
  grants: [
    {
      roleKey: 'system',
      isAdmin: true,
      permissions: ['*'],
      fieldAccess: { '*': 'write' },
      scope: { type: 'all' },
    },
  ],
  kind: 'system',
};

export function newSeedVault(keys: KeyProvider) {
  return {
    vault: new Vault(keys),
    system: { principal: SYSTEM_PRINCIPAL, actorType: 'system' as const, requestId: 'staging-seed' },
  };
}

/** Deterministic UUID (v4 layout) for seeded rows, so a re-seeded database gets the same ids. */
export function seedUuid(kind: string, key: string | number): string {
  const h = createHash('sha256').update(`kestrel-staging:${kind}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const bump = (ctx: SeedCtx, key: string, n = 1) => {
  ctx.counts[key] = (ctx.counts[key] ?? 0) + n;
};

/**
 * Multi-row INSERT for one tenant table (tenant_id from the transaction's tenant context, so RLS
 * WITH CHECK applies). Values are bound parameters; objects and arrays named in `json` are sent as JSON,
 * other arrays as Postgres arrays. Chunked below the 65,535 bind-parameter limit.
 */
export async function insertRows<T extends Record<string, unknown> = Record<string, unknown>>(
  tx: Tx,
  table: string,
  rows: Array<Record<string, unknown>>,
  opts: { json?: string[]; returning?: string; onConflict?: string } = {},
): Promise<T[]> {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]!);
  const json = new Set(opts.json ?? []);
  const per = Math.max(1, Math.floor(20_000 / cols.length));
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + per).map((r) => {
      const ph = cols.map((c) => {
        const v = r[c];
        params.push(
          v !== null && v !== undefined && (json.has(c) || (typeof v === 'object' && !Array.isArray(v)))
            ? JSON.stringify(v)
            : (v ?? null),
        );
        return `$${params.length}`;
      });
      return `(app.current_tenant(), ${ph.join(', ')})`;
    });
    const sql = `INSERT INTO ${table} (tenant_id, ${cols.join(', ')}) VALUES ${values.join(', ')}${opts.onConflict ? ` ${opts.onConflict}` : ''}${opts.returning ? ` RETURNING ${opts.returning}` : ''}`;
    out.push(...(await tx.query<T>(sql, params)));
  }
  return out;
}

/** Runs `fn` over items with at most `limit` in flight (object-store uploads; no database work). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
