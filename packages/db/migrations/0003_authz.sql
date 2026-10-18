-- Roles, scoped role assignments, manager delegation and customer-granted Thapsus support access.

CREATE TABLE app.roles (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  description text,
  built_in boolean NOT NULL DEFAULT false,
  is_admin boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT '{}',
  field_access jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.roles');
CREATE TRIGGER roles_touch BEFORE UPDATE ON app.roles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.role_assignments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  scope_type text NOT NULL DEFAULT 'all'
    CHECK (scope_type IN ('all', 'entity', 'country', 'department', 'location', 'own_team', 'self')),
  scope_values text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.roles (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX role_assignments_user ON app.role_assignments (tenant_id, user_id);
SELECT app.enable_tenant_rls('app.role_assignments');

CREATE TABLE app.delegations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL,
  to_user_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (from_user_id <> to_user_id),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, from_user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX delegations_to ON app.delegations (tenant_id, to_user_id);
SELECT app.enable_tenant_rls('app.delegations');

-- Thapsus staff (back office). Not customer data; one table per regional cell.
CREATE TABLE backoffice.staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'support', 'rules_editor', 'billing')),
  password_hash text,
  totp_secret_enc jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backoffice.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES backoffice.staff_users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  mfa_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
-- Append-only trail of staff actions (subject_tenant_id names the customer affected, if any).
CREATE TABLE backoffice.staff_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  staff_id uuid,
  action text NOT NULL,
  subject_tenant_id uuid,
  target text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  request_id text
);
GRANT SELECT, INSERT, UPDATE ON backoffice.staff_users, backoffice.staff_sessions TO thapsus_backoffice;
GRANT SELECT, INSERT ON backoffice.staff_audit TO thapsus_backoffice;
GRANT USAGE ON SEQUENCE backoffice.staff_audit_id_seq TO thapsus_backoffice;

-- Customer-granted, time-limited, revocable support access. Staff can only reach tenant data through an
-- active grant (enforced in the support-access helper, and audited).
CREATE TABLE app.support_grants (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  granted_by_user_id uuid NOT NULL,
  access_level text NOT NULL DEFAULT 'read' CHECK (access_level IN ('read', 'read_write')),
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (expires_at <= starts_at + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by_user_id) REFERENCES app.users (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.support_grants');

-- Back office may see which grants exist for a staff member (no personal data), never other tables.
CREATE POLICY backoffice_grants_read ON app.support_grants FOR SELECT TO thapsus_backoffice USING (true);
GRANT SELECT (tenant_id, id, staff_id, access_level, starts_at, expires_at, revoked_at) ON app.support_grants TO thapsus_backoffice;
