-- Phase 9 (brief §6.10), expand only: sandbox tenants and tracked dedicated-database moves.

-- Sandboxes created from this (production) tenant. The sandbox is its own tenant in the SAME home
-- region (registry row, forced RLS); only configuration is copied and people are synthetic.
CREATE TABLE app.sandboxes (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sandbox_tenant_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  synthetic_people integer NOT NULL CHECK (synthetic_people BETWEEN 0 AND 2000),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'ready', 'failed')),
  job_id uuid,
  report jsonb,
  error text CHECK (length(error) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sandbox_tenant_id)
);
SELECT app.enable_tenant_rls('app.sandboxes');

-- Back-office requests to move a tenant to a dedicated database (runbook:
-- docs/runbooks/move-tenant-to-dedicated-db.md). Staff create requests; the move runner (a one-off
-- task with owner credentials) claims them, runs packages/db move-tenant and records progress.
-- No tenant data: the tenant is referenced by subject_tenant_id only.
CREATE TABLE backoffice.tenant_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_tenant_id uuid NOT NULL,
  target_db_key text NOT NULL CHECK (target_db_key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  purge_source boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  progress text[] NOT NULL DEFAULT '{}',
  report jsonb,
  error text CHECK (length(error) <= 1000)
);
CREATE UNIQUE INDEX tenant_moves_one_open ON backoffice.tenant_moves (subject_tenant_id) WHERE status IN ('requested', 'running');
CREATE INDEX tenant_moves_queue ON backoffice.tenant_moves (status, requested_at);
GRANT SELECT, INSERT ON backoffice.tenant_moves TO thapsus_backoffice;
GRANT UPDATE (status, finished_at, error) ON backoffice.tenant_moves TO thapsus_backoffice;
