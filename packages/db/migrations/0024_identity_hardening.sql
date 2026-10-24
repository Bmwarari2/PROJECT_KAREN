-- Security hardening P0, customer identity (docs/SECURITY_HARDENING.md §2.1, ADR-0170 to ADR-0172).
-- Expand only: new tables, and nullable or defaulted columns; nothing dropped or renamed. Safe to re-run.

-- Versioned sign-in policy defaults (ADR-0170). A tenant's `security` JSON holds only the values its
-- admins chose; every other value comes from the defaults of its version:
--   1 = workspaces created before this migration: two-step verification required for admins only,
--       and "Trust IdP MFA" on (their behaviour until now);
--   2 = workspaces created from now on: two-step verification for everyone, "Trust IdP MFA" off.
-- ADD COLUMN ... DEFAULT 1 gives every existing row 1 without rewriting it, and the new default 2 then
-- applies to every later INSERT (sign-up, the provisioning CLI, the staging seed, sandboxes). DDL only, so
-- it behaves the same for a managed-Postgres migrator that row level security keeps away from the rows.
ALTER TABLE app.tenants ADD COLUMN IF NOT EXISTS security_defaults_version smallint NOT NULL DEFAULT 1;
ALTER TABLE app.tenants ALTER COLUMN security_defaults_version SET DEFAULT 2;
DO $$ BEGIN
  ALTER TABLE app.tenants ADD CONSTRAINT tenants_security_defaults_version CHECK (security_defaults_version IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Emailed one-time links are scoped to one purpose (ADR-0171): a sign-in link cannot reset a password
-- and a reset link cannot sign anyone in. Existing rows are sign-in links and invitations, which both
-- sign the person in. issued_by is the admin who sent a reset link (NULL when the person asked).
ALTER TABLE app.magic_links ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'sign_in';
ALTER TABLE app.magic_links ADD COLUMN IF NOT EXISTS issued_by uuid;
DO $$ BEGIN
  ALTER TABLE app.magic_links ADD CONSTRAINT magic_links_purpose CHECK (purpose IN ('sign_in', 'invitation', 'password_reset'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS magic_links_user_purpose ON app.magic_links (tenant_id, user_id, purpose) WHERE used_at IS NULL;

-- SSO identity binding (ADR-0172, ASVS V6.8.1, V10.5.2): after the first SSO sign-in through a connection,
-- the person is linked to the identity provider's (issuer, subject) pair. A later sign-in for the same
-- email with another subject is refused; the subject, not the email, then identifies the person.
CREATE TABLE IF NOT EXISTS app.sso_identities (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, issuer, subject),
  UNIQUE (tenant_id, connection_id, user_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES app.sso_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sso_identities_user ON app.sso_identities (tenant_id, user_id);
SELECT app.enable_tenant_rls('app.sso_identities');
GRANT SELECT, INSERT, UPDATE, DELETE ON app.sso_identities TO thapsus_app;

-- Admin sessions re-authenticate when the network changes (ADR-0170): the autonomous system the session
-- was last authenticated from, when the cell has that signal (NULL otherwise).
ALTER TABLE app.sessions ADD COLUMN IF NOT EXISTS network text;
