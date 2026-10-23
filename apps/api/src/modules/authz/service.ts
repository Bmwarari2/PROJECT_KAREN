import type { Tx } from '@thapsus/db';
import {
  checkAssignment,
  excessFieldAccess,
  fieldAccessProblem,
  fieldProbes,
  isAdminGrade,
  permissionProblem,
  uncoveredPermissions,
  VALUED_SCOPES,
  type Assignee,
  type RoleDefinition,
} from '@thapsus/core/access';
import type { FieldAccess, Principal, Scope, ScopeType } from '@thapsus/core/permissions';
import { ApiError } from '../../http/errors';
import { loadTarget } from '../employees/service';

/** Role and assignment rules for role management (ADR-0120, ADR-0121). */

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  built_in: boolean;
  is_admin: boolean;
  permissions: string[];
  field_access: Record<string, FieldAccess>;
  updated_at: string;
  assignment_count?: number | string;
}

export const toRole = (r: RoleRow) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  builtIn: r.built_in,
  isAdmin: r.is_admin,
  permissions: r.permissions,
  fieldAccess: r.field_access,
  assignmentCount: Number(r.assignment_count ?? 0),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export const ROLE_SELECT = `SELECT r.id, r.key, r.name, r.description, r.built_in, r.is_admin, r.permissions, r.field_access, r.updated_at,
  (SELECT count(*) FROM app.role_assignments a WHERE a.tenant_id = r.tenant_id AND a.role_id = r.id) AS assignment_count
  FROM app.roles r`;

/** The tenant's custom field and custom object keys (field-level access may name them as `employee.custom.<key>`). */
export async function customKeys(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ key: string }>(
    `SELECT key FROM app.custom_field_definitions WHERE entity_type = 'employee' UNION SELECT key FROM app.custom_object_types`,
  );
  return rows.map((r) => r.key);
}

/** Rejects (400) permission and field keys that are not in the catalogue. */
export function validateDefinition(def: RoleDefinition, custom: string[]) {
  const errors: Array<{ path: string; message: string }> = [];
  def.permissions.forEach((perm, i) => {
    const problem = permissionProblem(perm);
    if (problem) errors.push({ path: `/permissions/${i}`, message: problem });
  });
  for (const [key, level] of Object.entries(def.fieldAccess)) {
    const problem = fieldAccessProblem(key, level, custom);
    if (problem) errors.push({ path: `/fieldAccess/${key}`, message: problem });
  }
  if (errors.length) throw new ApiError('validation', undefined, { errors });
}

/** Admin-grade permissions always make a role an admin role, so MFA cannot be avoided by unticking a box. */
export const effectiveIsAdmin = (requested: boolean | undefined, permissions: string[]) =>
  !!requested || isAdminGrade(permissions);

export function exceeds(permissions: string[], fields: string[]) {
  return new ApiError('forbidden', 'The role grants more than you hold', {
    reason: 'exceedsYourAccess',
    permissions,
    fields,
  });
}

/** Subset rule for defining a role: everything it grants must be held by the caller (at some scope). */
export function assertWithinCaller(caller: Principal, def: RoleDefinition, custom: string[]) {
  const permissions = uncoveredPermissions(caller.grants, def.permissions);
  const fields = excessFieldAccess(caller.grants, def.fieldAccess, fieldProbes(custom));
  if (permissions.length || fields.length) throw exceeds(permissions, fields);
}

/** What `next` grants beyond `prev` (used so narrowing a role is never blocked by existing assignments). */
export function additions(prev: RoleDefinition, next: RoleDefinition, custom: string[]) {
  return {
    permissions: new Set(uncoveredPermissions([{ permissions: prev.permissions }], next.permissions)),
    fields: new Set(
      excessFieldAccess([{ fieldAccess: prev.fieldAccess }], next.fieldAccess, fieldProbes(custom)),
    ),
  };
}

export interface AssigneeRow {
  id: string;
  display_name: string;
  email: string;
  employee_id: string | null;
  status: string;
}

/** Facts about the assignee that self and own-team scopes depend on. */
export async function assigneeFacts(tx: Tx, caller: Principal, user: AssigneeRow): Promise<Assignee> {
  if (!user.employee_id) return { isCaller: user.id === caller.userId };
  const target = await loadTarget(tx, user.employee_id);
  let inCallersTeam = false;
  if (caller.employeeId && caller.employeeId !== user.employee_id) {
    // Solid line only: dotted-line reports' own teams are not inside the caller's team.
    const row = await tx.maybe(
      `WITH RECURSIVE up AS (
         SELECT id, manager_id, 0 AS depth FROM app.employees WHERE id = $1
         UNION ALL SELECT e.id, e.manager_id, up.depth + 1 FROM app.employees e JOIN up ON e.id = up.manager_id WHERE up.depth < 50
       ) SELECT 1 FROM up WHERE manager_id = $2 LIMIT 1`,
      [user.employee_id, caller.employeeId],
    );
    inCallersTeam = !!row;
  }
  return {
    target,
    isCaller: user.id === caller.userId || user.employee_id === caller.employeeId,
    inCallersTeam,
  };
}

const VALUE_TABLE: Partial<Record<ScopeType, string>> = {
  entity: 'app.legal_entities',
  department: 'app.departments',
  location: 'app.locations',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Scope values must name things that exist in this tenant; scopes without values must carry none. */
export async function normaliseScope(tx: Tx, scope: Scope): Promise<Scope> {
  const values = [...new Set(scope.values ?? [])];
  if (!VALUED_SCOPES.includes(scope.type)) {
    if (values.length)
      throw new ApiError('validation', undefined, {
        errors: [{ path: '/scope/values', message: 'scopeTakesNoValues' }],
      });
    return { type: scope.type, values: [] };
  }
  if (!values.length)
    throw new ApiError('validation', undefined, {
      errors: [{ path: '/scope/values', message: 'scopeNeedsValues' }],
    });
  let known: Set<string>;
  if (scope.type === 'country') {
    if (values.some((v) => !/^[A-Z]{2}$/.test(v)))
      throw new ApiError('validation', undefined, {
        errors: [{ path: '/scope/values', message: 'unknownScopeValue' }],
      });
    const rows = await tx.query<{ country: string }>(
      `SELECT country FROM app.legal_entities WHERE country = ANY($1) UNION SELECT country FROM app.locations WHERE country = ANY($1)`,
      [values],
    );
    known = new Set(rows.map((r) => r.country.trim()));
  } else {
    if (values.some((v) => !UUID_RE.test(v)))
      throw new ApiError('validation', undefined, {
        errors: [{ path: '/scope/values', message: 'unknownScopeValue' }],
      });
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM ${VALUE_TABLE[scope.type]} WHERE id = ANY($1::uuid[])`,
      [values],
    );
    known = new Set(rows.map((r) => r.id));
  }
  const unknown = values.filter((v) => !known.has(v));
  if (unknown.length)
    throw new ApiError('validation', undefined, {
      errors: unknown.map(() => ({ path: '/scope/values', message: 'unknownScopeValue' })),
    });
  return { type: scope.type, values: values.sort() };
}

/** Human labels for scope values (org unit names are reference data, not personal data). */
export async function scopeLabels(tx: Tx, scope: Scope): Promise<string[]> {
  const values = scope.values ?? [];
  const table = VALUE_TABLE[scope.type];
  if (!values.length || !table) return values;
  const rows = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${table} WHERE id = ANY($1::uuid[])`,
    [values],
  );
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return values.map((v) => names.get(v) ?? v);
}

/** Whether the caller could grant (and therefore may revoke) `def` at `scope` for this assignee. */
export function mayHandOut(
  caller: Principal,
  def: RoleDefinition,
  scope: Scope,
  assignee: Assignee,
  custom: string[],
) {
  const check = checkAssignment(caller, def, scope, assignee, fieldProbes(custom));
  return { ...check, ok: check.mayAssign && !check.permissions.length && !check.fields.length };
}

/**
 * Locks the owner role and counts the owner assignments (scope all) held by active users, so two
 * concurrent revocations cannot both remove "the second-last" owner.
 */
export async function activeOwnerAssignments(tx: Tx): Promise<string[]> {
  await tx.query(`SELECT id FROM app.roles WHERE key = 'owner' AND built_in FOR UPDATE`);
  const rows = await tx.query<{ id: string }>(
    `SELECT a.id FROM app.role_assignments a
       JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
       JOIN app.users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id
      WHERE r.key = 'owner' AND r.built_in AND a.scope_type = 'all' AND u.status = 'active'`,
  );
  return rows.map((r) => r.id);
}

/** Stable, redaction-safe audit snapshot of a role definition (field keys such as employee.bank.* stay visible). */
export function roleSnapshot(r: {
  key: string;
  name: string;
  description: string | null;
  isAdmin: boolean;
  permissions: string[];
  fieldAccess: Record<string, FieldAccess>;
}) {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    isAdmin: r.isAdmin,
    permissions: [...r.permissions].sort(),
    fieldAccess: Object.entries(r.fieldAccess)
      .map(([k, v]) => `${k}=${v}`)
      .sort(),
  };
}
