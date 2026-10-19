import type { Tx } from '@thapsus/db';
import { canSome, fieldAccess, grantFieldAccess, type Principal, type Target } from '@thapsus/core/permissions';
import { ApiError } from '../../http/errors';
import { grantScopeSql, scopePredicate } from '../employees/service';

/** Report features are open to holders of either permission; rows are always limited by scope. */
export const REPORT_ACCESS = ['reports.run', 'reports.read_team'] as const;

export function canUseReports(p: Principal): boolean {
  return REPORT_ACCESS.some((a) => canSome(p, a));
}

export function assertReportAccess(p: Principal) {
  if (!canUseReports(p)) throw new ApiError('forbidden');
}

/** Builds `$n` placeholders into a shared parameter list. */
export function paramAdder(params: unknown[]) {
  return (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
}

export function rowScope(p: Principal, action: string, params: unknown[]): string {
  return scopePredicate(p, action, params);
}

const RANK = { none: 0, read: 1, write: 2 } as const;

/**
 * SQL (alias `e`) that is true exactly for the rows on which the principal may read employee field `perm`:
 * the same rule as fieldAccess() — some grant whose scope covers the row gives at least read access.
 * Used to mask columns inside report SQL, so filters, grouping and aggregates never see a hidden value.
 */
export function readableSql(p: Principal, perm: string, add: (v: unknown) => string): string {
  const ors: string[] = [];
  for (const g of p.grants) {
    if (RANK[grantFieldAccess(g, `employee.${perm}`) ?? 'none'] < RANK.read) continue;
    if (g.scope.type === 'all') return 'true';
    const sql = grantScopeSql(p, g, add);
    if (sql !== 'false') ors.push(sql);
  }
  return ors.length ? `(${ors.join(' OR ')})` : 'false';
}

/** True when some grant gives read access to the field (it may still be hidden on particular rows). */
export function fieldVisibleSomewhere(p: Principal, perm: string): boolean {
  return p.grants.some((g) => RANK[grantFieldAccess(g, `employee.${perm}`) ?? 'none'] >= RANK.read);
}

/**
 * Per-row field checks in JS (ready-made reports). Team membership for own_team grants is resolved once,
 * so the targets match what loadTarget() would give for scope checks.
 */
export class FieldGate {
  private constructor(
    private readonly p: Principal,
    private readonly team: Set<string>,
  ) {}

  static async create(tx: Tx, p: Principal): Promise<FieldGate> {
    const team = new Set<string>();
    if (p.grants.some((g) => g.scope.type === 'own_team')) {
      const params: unknown[] = [];
      const g = p.grants.find((x) => x.scope.type === 'own_team')!;
      const sql = grantScopeSql(p, g, paramAdder(params));
      if (sql !== 'false') for (const r of await tx.query<{ id: string }>(`SELECT e.id FROM app.employees e WHERE ${sql}`, params)) team.add(r.id);
    }
    return new FieldGate(p, team);
  }

  target(r: { id: string; entity_id?: string | null; country?: string | null; department_id?: string | null; location_id?: string | null }): Target {
    const root = this.p.employeeId ?? this.p.delegatedFromEmployeeIds?.[0];
    return {
      employeeId: r.id,
      entityId: r.entity_id ?? null,
      country: r.country ?? null,
      departmentId: r.department_id ?? null,
      locationId: r.location_id ?? null,
      managerChain: root && this.team.has(r.id) ? [root] : [],
    };
  }

  readable(perm: string, target: Target): boolean {
    return fieldAccess(this.p, 'employee', perm, target) !== 'none';
  }
}
