import type { Tx } from '@thapsus/db';
import type { FieldAccess, Principal, RoleGrant, ScopeType } from '@thapsus/core/permissions';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';

/** Loads the principal (roles, scopes, active delegations) for a user inside the tenant context. */
export async function loadPrincipal(tx: Tx, userId: string, kind: Principal['kind'] = 'user'): Promise<Principal> {
  const user = await tx.maybe<{ employee_id: string | null }>('SELECT employee_id FROM app.users WHERE id = $1', [userId]);
  const rows = await tx.query<{
    key: string;
    is_admin: boolean;
    permissions: string[];
    field_access: Record<string, FieldAccess>;
    scope_type: ScopeType;
    scope_values: string[];
  }>(
    `SELECT r.key, r.is_admin, r.permissions, r.field_access, a.scope_type, a.scope_values
       FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
      WHERE a.user_id = $1`,
    [userId],
  );
  const grants: RoleGrant[] = rows.map((r) => ({
    roleKey: r.key,
    isAdmin: r.is_admin,
    permissions: r.permissions,
    fieldAccess: r.field_access,
    scope: { type: r.scope_type, values: r.scope_values },
  }));
  const delegated = await tx.query<{ employee_id: string }>(
    `SELECT u.employee_id FROM app.delegations d JOIN app.users u ON u.tenant_id = d.tenant_id AND u.id = d.from_user_id
      WHERE d.to_user_id = $1 AND now() >= d.starts_at AND now() < d.ends_at AND u.employee_id IS NOT NULL`,
    [userId],
  );
  return {
    userId,
    employeeId: user?.employee_id ?? null,
    grants,
    delegatedFromEmployeeIds: delegated.map((d) => d.employee_id),
    kind,
  };
}

/** Seeds the built-in roles for a new tenant (idempotent). */
export async function seedBuiltInRoles(tx: Tx): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const r of BUILT_IN_ROLES) {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO app.roles (tenant_id, key, name, built_in, is_admin, permissions, field_access)
       VALUES (app.current_tenant(), $1, $2, true, $3, $4, $5)
       ON CONFLICT (tenant_id, key) DO UPDATE SET permissions = EXCLUDED.permissions, field_access = EXCLUDED.field_access,
         is_admin = EXCLUDED.is_admin, name = EXCLUDED.name
       RETURNING id`,
      [r.key, r.name, r.isAdmin, r.permissions, JSON.stringify(r.fieldAccess)],
    );
    ids[r.key] = row.id;
  }
  return ids;
}

export async function assignRole(
  tx: Tx,
  userId: string,
  roleKey: string,
  scope: { type: ScopeType; values?: string[] } = { type: BUILT_IN_ROLES.find((r) => r.key === roleKey)?.defaultScope ?? 'self' },
) {
  await tx.exec(
    `INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type, scope_values)
     SELECT app.current_tenant(), $1, r.id, $3, $4 FROM app.roles r WHERE r.key = $2
       AND NOT EXISTS (SELECT 1 FROM app.role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id AND a.scope_type = $3 AND a.scope_values = $4)`,
    [userId, roleKey, scope.type, scope.values ?? []],
  );
}
