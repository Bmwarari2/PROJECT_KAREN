-- Phase 8: privacy and trust (expand only). Every tenant table: tenant_id-leading keys, forced RLS.

-- ---- Data subject requests ------------------------------------------------------------------------
CREATE TABLE app.dsr_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('access', 'correction', 'deletion')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'rejected', 'cancelled')),
  subject_employee_id uuid,
  subject_user_id uuid,
  requester_relationship text NOT NULL DEFAULT 'self' CHECK (requester_relationship IN ('self', 'authorised_agent', 'parent_or_guardian', 'other')),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'portal', 'letter', 'phone', 'in_person', 'other')),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  received_on date NOT NULL,
  information_received_on date,
  paused_days integer NOT NULL DEFAULT 0 CHECK (paused_days >= 0 AND paused_days <= 366),
  -- NULL when no law sets a deadline for this jurisdiction (the tenant's own target applies instead).
  due_on date,
  extended boolean NOT NULL DEFAULT false,
  extended_due_on date,
  extension_reason text CHECK (length(extension_reason) <= 1000),
  rule jsonb,
  identity_verified_at timestamptz,
  identity_method text CHECK (identity_method IN ('signed_in_account', 'known_contact_details', 'document_check', 'agent_authorisation', 'other')),
  -- A note on HOW identity was verified. Never copies of identity documents or their numbers.
  identity_note text CHECK (length(identity_note) <= 1000),
  details text CHECK (length(details) <= 4000),
  correction jsonb,
  outcome jsonb,
  rejection_reason text CHECK (length(rejection_reason) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_employee_id) REFERENCES app.employees (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES app.users (tenant_id, id),
  CHECK (subject_employee_id IS NOT NULL OR subject_user_id IS NOT NULL)
);
CREATE INDEX dsr_requests_queue ON app.dsr_requests (tenant_id, status, due_on);
CREATE INDEX dsr_requests_subject ON app.dsr_requests (tenant_id, subject_employee_id);
CREATE TRIGGER dsr_requests_touch BEFORE UPDATE ON app.dsr_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('app.dsr_requests');

-- ---- Legal holds: suspend erasure and retention for a person (or everyone) and a category (or all) ----
CREATE TABLE app.legal_holds (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid,
  category text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  reference text CHECK (length(reference) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id)
);
CREATE INDEX legal_holds_active ON app.legal_holds (tenant_id, employee_id) WHERE released_at IS NULL;
SELECT app.enable_tenant_rls('app.legal_holds');

-- ---- Retention: tenant policies over the pack rules, and the deletion log (counts only) ----------------
CREATE TABLE app.retention_policies (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('time_records', 'leave_records', 'sickness_records', 'payroll_records', 'immigration_records', 'personnel_records', 'notifications')),
  jurisdiction text NOT NULL DEFAULT '*' CHECK (jurisdiction = '*' OR jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  period text CHECK (period ~ '^P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?$' AND period <> 'P'),
  anchor text NOT NULL DEFAULT 'record_date' CHECK (anchor IN ('record_date', 'employment_end')),
  action text NOT NULL DEFAULT 'delete' CHECK (action IN ('delete', 'anonymise')),
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, category, jurisdiction)
);
SELECT app.enable_tenant_rls('app.retention_policies');

-- What was deleted, when, under which rule version: categories and counts only, never personal data.
CREATE TABLE app.retention_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'dsr')),
  dry_run boolean NOT NULL,
  category text NOT NULL,
  jurisdiction text NOT NULL,
  action text NOT NULL CHECK (action IN ('delete', 'anonymise', 'retain')),
  rows_affected integer NOT NULL DEFAULT 0,
  files_deleted integer NOT NULL DEFAULT 0,
  cutoff date,
  rule_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  tenant_policy jsonb,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX retention_runs_at ON app.retention_runs (tenant_id, run_at DESC);
SELECT app.enable_tenant_rls('app.retention_runs');

-- ---- Company data export and account closure ---------------------------------------------------------
CREATE TABLE app.company_exports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  requested_by uuid,
  job_id uuid,
  file_key text,
  size_bytes bigint,
  sha256 text,
  manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX company_exports_recent ON app.company_exports (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('app.company_exports');

CREATE TABLE app.account_closures (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'purging', 'completed')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  grace_days integer NOT NULL CHECK (grace_days >= 0),
  purge_after timestamptz NOT NULL,
  reason text CHECK (length(reason) <= 1000),
  cancelled_by uuid,
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX account_closures_one_open ON app.account_closures (tenant_id) WHERE status IN ('scheduled', 'purging');
SELECT app.enable_tenant_rls('app.account_closures');

-- ---- Legal: DPA acceptance, sub-processor change subscriptions, privacy notice templates --------------
CREATE TABLE app.dpa_acceptances (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dpa_version text NOT NULL,
  template text NOT NULL CHECK (template IN ('uk', 'eu', 'us')),
  accepted_by uuid NOT NULL,
  accepted_by_name text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  document_sha256 text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dpa_version),
  FOREIGN KEY (tenant_id, accepted_by) REFERENCES app.users (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.dpa_acceptances');

CREATE TABLE app.subprocessor_subscriptions (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.subprocessor_subscriptions');

CREATE TABLE app.privacy_notices (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template text NOT NULL CHECK (template IN ('uk', 'eu', 'us')),
  template_version text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 200000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, template)
);
SELECT app.enable_tenant_rls('app.privacy_notices');

-- ---- Incident and breach log (the customer's own, as controller) --------------------------------------
CREATE TABLE app.incidents (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'processor')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description text CHECK (length(description) <= 10000),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contained', 'closed')),
  personal_data_breach boolean NOT NULL DEFAULT false,
  risk_level text CHECK (risk_level IN ('unlikely', 'risk', 'high_risk')),
  occurred_at timestamptz,
  aware_at timestamptz NOT NULL,
  contained_at timestamptz,
  closed_at timestamptz,
  affected jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_categories text[] NOT NULL DEFAULT '{}',
  deadlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX incidents_open ON app.incidents (tenant_id, status, aware_at);
CREATE TRIGGER incidents_touch BEFORE UPDATE ON app.incidents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT app.enable_tenant_rls('app.incidents');

-- ---- Thapsus-side breach register (processor duties towards controllers). No personal data. ----------
CREATE TABLE backoffice.breach_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cell text NOT NULL CHECK (cell IN ('uk', 'eu', 'us')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  summary text NOT NULL CHECK (length(summary) <= 10000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contained', 'closed')),
  aware_at timestamptz NOT NULL,
  affected_tenant_ids uuid[] NOT NULL DEFAULT '{}',
  data_categories text[] NOT NULL DEFAULT '{}',
  controllers_notify_by timestamptz NOT NULL,
  controllers_notified_at timestamptz,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX breach_register_open ON backoffice.breach_register (status, controllers_notify_by);
GRANT SELECT, INSERT, UPDATE ON backoffice.breach_register TO thapsus_backoffice;

-- ---- Deletion certificates (regional registry: counts and timestamps only, no personal data) -----------
CREATE TABLE registry.deletion_certificates (
  tenant_id uuid PRIMARY KEY,
  issued_at timestamptz NOT NULL DEFAULT now(),
  certificate jsonb NOT NULL,
  certificate_sha256 text NOT NULL
);
GRANT SELECT, INSERT ON registry.deletion_certificates TO thapsus_app;
GRANT SELECT ON registry.deletion_certificates TO thapsus_backoffice;

-- ---- Verified deletion of a closed tenant's audit trail ----------------------------------------------------
-- audit.events stays append-only for every role. The single exception is the purge of a tenant whose
-- registry status is 'closing' and whose closure is purging, performed by audit.purge_closed_tenant().
CREATE OR REPLACE FUNCTION audit.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('audit.sealing', true) = 'on' AND OLD.hash IS NULL
     AND NEW.tenant_id = OLD.tenant_id AND NEW.id = OLD.id AND NEW.at = OLD.at
     AND NEW.action = OLD.action AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
     AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
     AND NEW.diff IS NOT DISTINCT FROM OLD.diff
     AND NEW.ip IS NOT DISTINCT FROM OLD.ip
     AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND NEW.sensitive = OLD.sensitive THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('audit.purging', true) = OLD.tenant_id::text
     AND EXISTS (SELECT 1 FROM registry.tenants t WHERE t.tenant_id = OLD.tenant_id AND t.status = 'closing') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit.events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION audit.purge_closed_tenant() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit, app AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_rows bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.tenants WHERE tenant_id = v_tenant AND status = 'closing')
     OR NOT EXISTS (SELECT 1 FROM app.account_closures WHERE tenant_id = v_tenant AND status = 'purging') THEN
    RAISE EXCEPTION 'tenant % is not being closed', v_tenant USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('audit.purging', v_tenant::text, true);
  DELETE FROM audit.events WHERE tenant_id = v_tenant;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  DELETE FROM audit.chain_heads WHERE tenant_id = v_tenant;
  PERFORM set_config('audit.purging', '', true);
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION audit.purge_closed_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.purge_closed_tenant() TO thapsus_app;
