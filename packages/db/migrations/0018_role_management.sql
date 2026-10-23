-- Role and access management (ADR-0120). Expand only: one nullable column, one index and an additive
-- permission update; nothing is dropped or renamed. Safe to re-run.

-- Who granted an assignment (null for assignments made by the system: sign-up, SSO, SCIM, onboarding).
ALTER TABLE app.role_assignments ADD COLUMN IF NOT EXISTS created_by uuid;
-- "Is this role in use?" and "how many owners are left?" stay index-backed at enterprise scale.
CREATE INDEX IF NOT EXISTS role_assignments_role ON app.role_assignments (tenant_id, role_id);

-- Built-in role rows of existing tenants get the role-management keys their code definitions hold
-- (packages/core/src/roles.ts): the owner holds `*` (which covers roles.read, roles.manage and
-- roles.assign) and the HR admin holds roles.read. Keys are appended, never removed, so other
-- releases' additions are kept. Custom roles (built_in = false) are never touched, whatever their key.
-- As in 0007b, FORCE RLS is lifted only inside this transaction so the owner can see every tenant's
-- rows; the application role never owns the table, so its policy applies throughout.
ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY;
UPDATE app.roles SET permissions = permissions || ARRAY['*']
 WHERE built_in AND key = 'owner' AND NOT ('*' = ANY (permissions));
UPDATE app.roles SET permissions = permissions || ARRAY['roles.read']
 WHERE built_in AND key = 'hr_admin' AND NOT ('roles.read' = ANY (permissions)) AND NOT ('roles.*' = ANY (permissions));
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
