-- OWASP ASVS level 2 review (docs/ASVS.md, ADR-0131). Expand only: nullable or defaulted columns,
-- nothing dropped or renamed. Safe to re-run.

-- Step-up re-authentication (ASVS V7.5.1): when this session last proved the user's identity again
-- (POST /v1/auth/reauth or a password change). The sign-in itself is created_at.
ALTER TABLE app.sessions ADD COLUMN IF NOT EXISTS reauthenticated_at timestamptz;

-- Back-office staff (ASVS V6.5.1, V7.3.1): each TOTP time step is accepted once, and staff sessions
-- also end after 30 minutes without activity (the 8-hour absolute limit stays).
ALTER TABLE backoffice.staff_users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
ALTER TABLE backoffice.staff_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
