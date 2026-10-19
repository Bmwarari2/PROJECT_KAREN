/**
 * Permission engine (deny by default). Used identically by the API (enforcement) and the web app
 * (hiding what the API would refuse), so UI and API never disagree.
 *
 *  - Actions: dotted strings, e.g. "employees.read", "leave.approve", "vault.read:health".
 *    Grants may use wildcards: "*", "employees.*", "vault.read:*".
 *  - Field access: per resource field ("employee.salary") → none | read | write, with wildcard keys
 *    ("employee.*", "employee.pay.*"); the most specific key wins, then the highest access across grants.
 *  - Scope: all, entity, country, department, location, own_team (incl. delegation), self.
 */
export type FieldAccess = 'none' | 'read' | 'write';
export type ScopeType = 'all' | 'entity' | 'country' | 'department' | 'location' | 'own_team' | 'self';

export interface Scope {
  type: ScopeType;
  values?: string[];
}

export interface RoleGrant {
  roleKey: string;
  isAdmin: boolean;
  permissions: string[];
  fieldAccess: Record<string, FieldAccess>;
  scope: Scope;
}

export interface Principal {
  userId: string;
  employeeId?: string | null;
  grants: RoleGrant[];
  /** Employee ids of managers who delegated their team authority to this principal (active now). */
  delegatedFromEmployeeIds?: string[];
  kind?: 'user' | 'support' | 'api_client' | 'scim' | 'system';
}

export interface Target {
  employeeId?: string | null;
  entityId?: string | null;
  country?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  /** Employee ids of the target's managers (solid line, plus matrix/dotted if the action allows). */
  managerChain?: string[];
}

const RANK: Record<FieldAccess, number> = { none: 0, read: 1, write: 2 };

export function actionMatches(grant: string, action: string): boolean {
  if (grant === '*' || grant === action) return true;
  if (grant.endsWith('.*')) return action.startsWith(grant.slice(0, -1));
  if (grant.endsWith(':*')) return action.startsWith(grant.slice(0, -1));
  return false;
}

export function scopeMatches(principal: Principal, scope: Scope, target?: Target): boolean {
  if (scope.type === 'all') return true;
  if (!target) return false;
  const values = scope.values ?? [];
  switch (scope.type) {
    case 'entity':
      return !!target.entityId && values.includes(target.entityId);
    case 'country':
      return !!target.country && values.includes(target.country);
    case 'department':
      return !!target.departmentId && values.includes(target.departmentId);
    case 'location':
      return !!target.locationId && values.includes(target.locationId);
    case 'self':
      return !!principal.employeeId && target.employeeId === principal.employeeId;
    case 'own_team': {
      const managers = new Set([principal.employeeId, ...(principal.delegatedFromEmployeeIds ?? [])].filter(Boolean));
      return (target.managerChain ?? []).some((m) => managers.has(m));
    }
    default:
      return false;
  }
}

/** True when at least one grant both allows the action and covers the target. */
export function can(principal: Principal, action: string, target?: Target): boolean {
  return principal.grants.some(
    (g) => g.permissions.some((p) => actionMatches(p, action)) && scopeMatches(principal, g.scope, target),
  );
}

/** Whether the principal holds the action for at least some scope (used for list endpoints and menus). */
export function canSome(principal: Principal, action: string): boolean {
  return principal.grants.some((g) => g.permissions.some((p) => actionMatches(p, action)));
}

export function isAdmin(principal: Principal): boolean {
  return principal.grants.some((g) => g.isAdmin);
}

/** Access one grant gives to a field key (most specific wildcard wins); undefined when it says nothing. */
export function grantFieldAccess(grant: RoleGrant, key: string): FieldAccess | undefined {
  if (key in grant.fieldAccess) return grant.fieldAccess[key];
  // most specific wildcard: employee.pay.salary → employee.pay.* → employee.*  → *
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const wildcard = `${parts.slice(0, i).join('.')}.*`;
    if (wildcard in grant.fieldAccess) return grant.fieldAccess[wildcard];
  }
  return grant.fieldAccess['*'];
}

export function fieldAccess(principal: Principal, resource: string, field: string, target?: Target): FieldAccess {
  let best: FieldAccess = 'none';
  for (const g of principal.grants) {
    if (!scopeMatches(principal, g.scope, target)) continue;
    const a = grantFieldAccess(g, `${resource}.${field}`) ?? 'none';
    if (RANK[a] > RANK[best]) best = a;
  }
  return best;
}

/** Returns a copy with fields the principal may not read removed. */
export function filterReadable<T extends Record<string, unknown>>(
  principal: Principal,
  resource: string,
  record: T,
  target?: Target,
  alwaysVisible: string[] = ['id'],
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(record)) {
    if (alwaysVisible.includes(k) || RANK[fieldAccess(principal, resource, k, target)] >= RANK.read) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Field names in `changes` the principal may not write. */
export function unwritableFields(principal: Principal, resource: string, fields: string[], target?: Target): string[] {
  return fields.filter((f) => fieldAccess(principal, resource, f, target) !== 'write');
}
