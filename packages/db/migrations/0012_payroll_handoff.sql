-- Phase 6 (expand only): payroll handoff — sealed integration credentials, payroll connectors with
-- field mapping, pay periods with immutable input snapshots, reproducible exports, a delivery log, and
-- payslip / year-end document batches for employee self-service.

-- ---- Integration credentials ------------------------------------------------------------------------
-- One sealed envelope per integration (OAuth tokens, client secrets, SFTP passwords or keys). The value
-- is encrypted with a per-record data key wrapped by the cell's regional KMS key; the database only ever
-- holds ciphertext. `fields` names what is stored (for "configured" status) and never holds values.
CREATE TABLE app.integration_credentials (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type IN ('payroll_connector', 'it_connection')),
  owner_id uuid NOT NULL,
  envelope jsonb NOT NULL CHECK (envelope ? 'ct' AND envelope ? 'wdek' AND envelope ? 'iv' AND envelope ? 'tag'),
  fields text[] NOT NULL DEFAULT '{}',
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_type, owner_id)
);
SELECT app.enable_tenant_rls('app.integration_credentials');
CREATE TRIGGER integration_credentials_touch BEFORE UPDATE ON app.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- Reporting replicas never read integration secrets (even sealed).
REVOKE ALL ON app.integration_credentials FROM thapsus_reporting;

-- ---- Payroll connectors -------------------------------------------------------------------------------
CREATE TABLE app.payroll_connectors (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('csv', 'excel', 'xero_uk', 'adp', 'workday', 'ukg', 'gusto', 'datev')),
  entity_id uuid,
  -- Thapsus field → target column per section, with transforms (date formats, code maps, money)
  mapping jsonb NOT NULL,
  -- {method: download | sftp | api, sftp?: {host, port, username, directory, hostKeySha256}}
  delivery jsonb NOT NULL DEFAULT '{"method": "download"}'::jsonb,
  -- connector-specific, non-secret settings (e.g. Xero tenant id, payroll calendar, earnings rates)
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.payroll_connectors');
CREATE TRIGGER payroll_connectors_touch BEFORE UPDATE ON app.payroll_connectors FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- OAuth authorisation requests (state is stored hashed; single use, short-lived).
CREATE TABLE app.integration_oauth_states (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  state_hash bytea NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('payroll_connector', 'it_connection')),
  owner_id uuid NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id, state_hash)
);
SELECT app.enable_tenant_rls('app.integration_oauth_states');

-- ---- Pay periods and immutable input snapshots ------------------------------------------------------------
CREATE TABLE app.pay_periods (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'four_weekly', 'semi_monthly', 'monthly')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  pay_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  snapshot_id uuid,
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK ((status = 'closed') = (snapshot_id IS NOT NULL)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id),
  -- one period per date per legal entity (NULL entity = the whole company)
  EXCLUDE USING gist (tenant_id WITH =, (coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX pay_periods_dates ON app.pay_periods (tenant_id, start_date DESC);
SELECT app.enable_tenant_rls('app.pay_periods');

-- Canonical payroll inputs captured when a period closes. Exports of a closed period are rendered from
-- this snapshot only, so re-exporting yields byte-identical files. Snapshots are append-only.
CREATE TABLE app.pay_period_snapshots (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  inputs jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, period_id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES app.pay_periods (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.pay_period_snapshots');
ALTER TABLE app.pay_periods ADD CONSTRAINT pay_periods_snapshot_fk FOREIGN KEY (tenant_id, snapshot_id) REFERENCES app.pay_period_snapshots (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION app.pay_period_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app.pay_period_snapshots is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER pay_period_snapshots_immutable BEFORE UPDATE ON app.pay_period_snapshots FOR EACH ROW EXECUTE FUNCTION app.pay_period_snapshot_immutable();
-- A closed period cannot be reopened or have its dates changed (corrections go into the next period).
CREATE OR REPLACE FUNCTION app.pay_period_closed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' AND (NEW.status <> 'closed' OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date
      OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.entity_id IS DISTINCT FROM OLD.entity_id) THEN
    RAISE EXCEPTION 'closed pay periods cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_periods_closed_guard BEFORE UPDATE ON app.pay_periods FOR EACH ROW EXECUTE FUNCTION app.pay_period_closed_guard();

-- ---- Exports and the delivery log -----------------------------------------------------------------------------
CREATE TABLE app.payroll_exports (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  snapshot_id uuid, -- NULL: a preview of an open period rendered from live data
  file_key text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  inputs_sha256 text NOT NULL,
  config_sha256 text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES app.pay_periods (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connector_id) REFERENCES app.payroll_connectors (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES app.pay_period_snapshots (tenant_id, id)
);
CREATE INDEX payroll_exports_period ON app.payroll_exports (tenant_id, period_id, created_at DESC);
SELECT app.enable_tenant_rls('app.payroll_exports');

CREATE TABLE app.payroll_deliveries (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  period_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('download', 'sftp', 'api')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  -- where the file or records went (host and path, or provider and organisation id); never personal data
  destination text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  job_id uuid,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, export_id) REFERENCES app.payroll_exports (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX payroll_deliveries_recent ON app.payroll_deliveries (tenant_id, created_at DESC);
CREATE INDEX payroll_deliveries_period ON app.payroll_deliveries (tenant_id, period_id, created_at DESC);
SELECT app.enable_tenant_rls('app.payroll_deliveries');

-- ---- Payslips and year-end documents ------------------------------------------------------------------------------
-- Restricted documents: visible only to the employee they belong to and to payroll roles (payslips.*).
-- They live outside app.documents so general document listings and managers never see them.
CREATE TABLE app.payslip_batches (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('payslip', 'year_end')),
  doc_type text NOT NULL CHECK (doc_type IN ('payslip', 'p60', 'p11d', 'w2', 'form_1099', 'annual_statement', 'other')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  pay_date date,
  tax_year text CHECK (length(tax_year) <= 20),
  match_by text NOT NULL DEFAULT 'employee_number' CHECK (match_by IN ('employee_number', 'pattern')),
  pattern text CHECK (length(pattern) <= 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded')),
  file_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX payslip_batches_recent ON app.payslip_batches (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('app.payslip_batches');

CREATE TABLE app.payslips (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  employee_id uuid,
  file_name text NOT NULL CHECK (length(file_name) <= 255),
  file_key text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/pdf',
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  match_status text NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'manual')),
  match_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded')),
  published_at timestamptz,
  first_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES app.payslip_batches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  CHECK (status <> 'published' OR employee_id IS NOT NULL)
);
CREATE INDEX payslips_batch ON app.payslips (tenant_id, batch_id);
CREATE INDEX payslips_employee ON app.payslips (tenant_id, employee_id, status, published_at DESC);
SELECT app.enable_tenant_rls('app.payslips');
-- Payslips are personal financial documents; reporting replicas do not need them.
REVOKE ALL ON app.payslips FROM thapsus_reporting;
