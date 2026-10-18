-- Identity: users, credentials, MFA factors, passkeys, sessions, magic links, SSO, SCIM, verified domains.
-- Every user belongs to exactly one tenant, so all identity data is tenant-scoped and protected by RLS.

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thapsus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO thapsus_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO thapsus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA vault GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thapsus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.tenants TO thapsus_app;
GRANT SELECT ON app.tenants TO thapsus_reporting;

CREATE TABLE app.users (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  display_name text NOT NULL,
  locale text,
  time_zone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'deactivated')),
  employee_id uuid,
  external_id text,
  scim_managed boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_external ON app.users (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX users_email_lookup ON app.users (email);
SELECT app.enable_tenant_rls('app.users');
CREATE TRIGGER users_touch BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.password_credentials (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.password_credentials');

CREATE TABLE app.totp_factors (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  secret_enc jsonb NOT NULL,
  verified_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX totp_factors_user ON app.totp_factors (tenant_id, user_id);
SELECT app.enable_tenant_rls('app.totp_factors');

CREATE TABLE app.passkeys (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  credential_id text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, credential_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.passkeys');

CREATE TABLE app.auth_challenges (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  kind text NOT NULL,
  challenge text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX auth_challenges_expiry ON app.auth_challenges (tenant_id, expires_at);
SELECT app.enable_tenant_rls('app.auth_challenges');

CREATE TABLE app.sessions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  auth_method text NOT NULL,
  mfa_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user ON app.sessions (tenant_id, user_id);
SELECT app.enable_tenant_rls('app.sessions');

CREATE TABLE app.magic_links (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.magic_links');

CREATE TABLE app.sso_connections (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  name text NOT NULL,
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  jit_provisioning boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.sso_connections');

CREATE TABLE app.scim_tokens (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash)
);
SELECT app.enable_tenant_rls('app.scim_tokens');

CREATE TABLE app.groups (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, display_name)
);
SELECT app.enable_tenant_rls('app.groups');

CREATE TABLE app.group_members (
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, group_id, user_id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES app.groups (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.group_members');

CREATE TABLE app.verified_domains (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  domain citext NOT NULL,
  verification_token text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, domain)
);
CREATE UNIQUE INDEX verified_domains_unique_verified ON app.verified_domains (domain) WHERE verified_at IS NOT NULL;
SELECT app.enable_tenant_rls('app.verified_domains');

CREATE TABLE app.push_subscriptions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, endpoint),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.push_subscriptions');

-- "Find my workspace": returns only tenant ids for an email address, never user data.
-- Runs as a NOLOGIN role that can read just three columns of app.users across tenants.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_lookup') THEN
    CREATE ROLE thapsus_lookup NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT thapsus_lookup TO %I', current_user);
END $$;
GRANT USAGE ON SCHEMA app TO thapsus_lookup;
GRANT SELECT (tenant_id, email, status) ON app.users TO thapsus_lookup;
CREATE POLICY lookup_by_email ON app.users FOR SELECT TO thapsus_lookup USING (true);

CREATE OR REPLACE FUNCTION app.tenants_for_email(p_email citext) RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS
$$ SELECT DISTINCT u.tenant_id FROM app.users u WHERE u.email = p_email AND u.status <> 'deactivated' $$;
ALTER FUNCTION app.tenants_for_email(citext) OWNER TO thapsus_lookup;
REVOKE ALL ON FUNCTION app.tenants_for_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenants_for_email(citext) TO thapsus_app;
