-- Security hardening P0, Thapsus staff (docs/SECURITY_HARDENING.md §2.2, ADR-0173). Expand only: the
-- staff password and TOTP columns stay (nothing reads them any more) until a later contract migration
-- drops them. Safe to re-run.

-- Staff sign in only with a passkey or hardware security key (WebAuthn, user verification required).
CREATE TABLE IF NOT EXISTS backoffice.staff_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES backoffice.staff_users (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS staff_passkeys_staff ON backoffice.staff_passkeys (staff_id);

-- One-time enrolment links, issued only by the operator CLI (database access required). Hashed, short-lived.
CREATE TABLE IF NOT EXISTS backoffice.staff_enrolments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES backoffice.staff_users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- WebAuthn challenges for staff (sign-in, re-authentication, enrolment); each is consumed once.
CREATE TABLE IF NOT EXISTS backoffice.staff_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid REFERENCES backoffice.staff_users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('login', 'reauth', 'enrol')),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS staff_challenges_expiry ON backoffice.staff_challenges (expires_at);

-- Staff sessions re-authenticate before destructive actions; the time of the last proof is kept.
ALTER TABLE backoffice.staff_sessions ADD COLUMN IF NOT EXISTS reauthenticated_at timestamptz;

-- Just-in-time elevation: no standing access for super-admin actions, rule publishing or support-grant
-- use. A request names a scope, a reason and a duration; another staff member approves it; it then
-- lasts until expires_at (time-boxed) unless revoked. Rows are never deleted (history for reviews).
CREATE TABLE IF NOT EXISTS backoffice.staff_elevations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES backoffice.staff_users (id),
  scope text NOT NULL CHECK (scope IN ('super_admin', 'rules_publish', 'support_grant')),
  subject_tenant_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  minutes integer NOT NULL CHECK (minutes BETWEEN 5 AND 240),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES backoffice.staff_users (id),
  approved_at timestamptz,
  expires_at timestamptz,
  denied_by uuid REFERENCES backoffice.staff_users (id),
  denied_at timestamptz,
  revoked_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> staff_id),
  CHECK ((approved_at IS NULL) = (expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS staff_elevations_staff ON backoffice.staff_elevations (staff_id, expires_at);
CREATE INDEX IF NOT EXISTS staff_elevations_pending ON backoffice.staff_elevations (requested_at) WHERE approved_at IS NULL AND denied_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON backoffice.staff_passkeys, backoffice.staff_enrolments,
  backoffice.staff_challenges, backoffice.staff_elevations TO thapsus_backoffice;
