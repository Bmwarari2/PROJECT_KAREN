-- 2026-10-24 (ADR-0196): authorised signatories, the people who may sign documents for the company (PROGRESS 16.12).
-- Expand only: one new tenant table. A workspace with no rows uses the default (ADR-0187): HR admins and owners.
-- Whoever is listed signs only after a step-up re-authentication and never on their own document.

CREATE TABLE app.document_signatories (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- everyone holding a role (value is the role key), or one person (user_id)
  kind text NOT NULL CHECK (kind IN ('role', 'user')),
  role_key text CHECK (role_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  user_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'role') = (role_key IS NOT NULL)),
  CHECK ((kind = 'user') = (user_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX document_signatories_role ON app.document_signatories (tenant_id, role_key) WHERE kind = 'role';
CREATE UNIQUE INDEX document_signatories_user ON app.document_signatories (tenant_id, user_id) WHERE kind = 'user';
SELECT app.enable_tenant_rls('app.document_signatories');
