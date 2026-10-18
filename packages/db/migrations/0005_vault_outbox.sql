-- Sensitive-data vault: separate schema, field-level envelope encryption (per-region KMS key wraps a
-- per-record data key). The database only ever holds ciphertext.

CREATE TABLE vault.records (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_type text NOT NULL DEFAULT 'employee',
  subject_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('health', 'sickness', 'disability', 'diversity', 'eeo', 'immigration')),
  field text NOT NULL,
  envelope jsonb NOT NULL CHECK (envelope ? 'ct' AND envelope ? 'wdek' AND envelope ? 'iv' AND envelope ? 'tag'),
  file_key text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX vault_records_subject ON vault.records (tenant_id, subject_id, category);
SELECT app.enable_tenant_rls('vault.records');
CREATE TRIGGER vault_records_touch BEFORE UPDATE ON vault.records FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON vault.records TO thapsus_app;
-- Reporting replicas never read the vault.
REVOKE ALL ON vault.records FROM thapsus_reporting;

-- Transactional outbox: domain events written in the same transaction as the change.
CREATE TABLE app.outbox (
  tenant_id uuid NOT NULL,
  id bigserial NOT NULL,
  topic text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_unpublished ON app.outbox (tenant_id, id) WHERE published_at IS NULL;
SELECT app.enable_tenant_rls('app.outbox');

-- Idempotent background jobs: one row per idempotency key; progress for long-running jobs.
CREATE TABLE app.jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  progress_done bigint NOT NULL DEFAULT 0,
  progress_total bigint,
  attempts int NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE INDEX jobs_runnable ON app.jobs (tenant_id, run_after) WHERE status = 'queued';
SELECT app.enable_tenant_rls('app.jobs');

-- Registry-level work queue so the worker can find tenants with pending work without scanning tenant data.
CREATE TABLE registry.work_signals (
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  signalled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON registry.work_signals TO thapsus_app;
