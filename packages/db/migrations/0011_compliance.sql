-- Phase 5: compliance centre content. Every table is tenant-scoped with forced RLS and a tenant-leading
-- index. Statutory values (follow-up periods, deadlines, retention, thresholds) are NOT stored here:
-- they come from the jurisdiction packs at the time of each calculation and the rule source is kept
-- alongside the computed dates. Immigration documents, share codes and document numbers live only in
-- the vault (category 'immigration'); EEO-1 self-identification and the sex used for pay reporting
-- live only in the vault (categories 'eeo' and 'diversity').

-- ---- UK right-to-work checks -------------------------------------------------------------------
CREATE TABLE app.rtw_checks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'GB',
  check_method text NOT NULL,
  list_type text NOT NULL,
  checked_on date NOT NULL,
  checked_by uuid,
  permission_expires_on date,
  pvn_date date,
  excuse text NOT NULL CHECK (excuse IN ('continuous', 'time_limited')),
  excuse_ends_on date,
  follow_up_due_on date,
  evidence_vault_id uuid,
  details_vault_id uuid,
  superseded_by uuid,
  rule_source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX rtw_checks_employee ON app.rtw_checks (tenant_id, employee_id, checked_on);
CREATE INDEX rtw_checks_follow_up ON app.rtw_checks (tenant_id, follow_up_due_on) WHERE superseded_by IS NULL AND follow_up_due_on IS NOT NULL;
SELECT app.enable_tenant_rls('app.rtw_checks');

-- ---- US Form I-9 ------------------------------------------------------------------------------
CREATE TABLE app.i9_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  first_day_of_employment date NOT NULL,
  section1_completed_on date,
  section2_completed_on date,
  section2_due_on date NOT NULL,
  work_authorization_expires_on date,
  reverification_due_on date,
  supplement_b_completed_on date,
  evidence_vault_id uuid,
  rule_source jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, first_day_of_employment),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX i9_records_reverification ON app.i9_records (tenant_id, reverification_due_on) WHERE reverification_due_on IS NOT NULL;
SELECT app.enable_tenant_rls('app.i9_records');
CREATE TRIGGER i9_records_touch BEFORE UPDATE ON app.i9_records FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---- Compliance matrix: requirements per role / location / entity and employee records ----------
CREATE TABLE app.compliance_requirements (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('licence', 'certification', 'background_check', 'training', 'other')),
  name text NOT NULL,
  description text,
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  validity_months int CHECK (validity_months IS NULL OR validity_months > 0),
  reminder_days int[] NOT NULL DEFAULT '{}',
  evidence_required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX compliance_requirements_active ON app.compliance_requirements (tenant_id, active);
SELECT app.enable_tenant_rls('app.compliance_requirements');
CREATE TRIGGER compliance_requirements_touch BEFORE UPDATE ON app.compliance_requirements FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.compliance_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  issued_on date NOT NULL,
  expires_on date,
  reference text,
  evidence_document_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  notes text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (expires_on IS NULL OR expires_on >= issued_on),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES app.compliance_requirements (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, evidence_document_id) REFERENCES app.documents (tenant_id, id)
);
CREATE INDEX compliance_records_employee ON app.compliance_records (tenant_id, employee_id, requirement_id);
CREATE INDEX compliance_records_expiry ON app.compliance_records (tenant_id, expires_on) WHERE status = 'active' AND expires_on IS NOT NULL;
SELECT app.enable_tenant_rls('app.compliance_records');

-- ---- US exemption duties-test attestations (effective-dated) -------------------------------------
CREATE TABLE app.flsa_attestations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  exemption text NOT NULL,
  duties_attested text[] NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  attested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX flsa_attestations_emp ON app.flsa_attestations (tenant_id, employee_id, valid_from);
SELECT app.enable_tenant_rls('app.flsa_attestations');

-- ---- EEO-1 job category per job title (tenant configuration; no personal data) --------------------
CREATE TABLE app.eeo_job_categories (
  tenant_id uuid NOT NULL,
  job_title text NOT NULL,
  category text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_title)
);
SELECT app.enable_tenant_rls('app.eeo_job_categories');

-- ---- Pay-reporting inputs (UK gender pay gap, EU pay transparency) imported from payroll ----------
CREATE TABLE app.pay_report_inputs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_kind text NOT NULL CHECK (report_kind IN ('uk_gpg', 'eu_pay_transparency')),
  snapshot_date date NOT NULL,
  employee_id uuid NOT NULL,
  currency char(3) NOT NULL,
  ordinary_pay_minor bigint NOT NULL DEFAULT 0 CHECK (ordinary_pay_minor >= 0),
  bonus_in_period_minor bigint NOT NULL DEFAULT 0 CHECK (bonus_in_period_minor >= 0),
  pay_period_days numeric(6, 2),
  weekly_hours numeric(5, 2),
  bonus_12_months_minor bigint NOT NULL DEFAULT 0 CHECK (bonus_12_months_minor >= 0),
  full_pay boolean NOT NULL DEFAULT true,
  annual_basic_minor bigint,
  annual_variable_minor bigint,
  annual_hours numeric(7, 2),
  worker_category text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, report_kind, snapshot_date, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.pay_report_inputs');

-- ---- Law-changes feed: read / acknowledged state per tenant user ---------------------------------
CREATE TABLE app.law_change_reads (
  tenant_id uuid NOT NULL,
  law_change_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  PRIMARY KEY (tenant_id, law_change_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.law_change_reads');
-- Grants come from the schema default privileges (0002_identity.sql).
