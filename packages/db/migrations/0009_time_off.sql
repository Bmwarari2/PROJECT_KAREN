-- Phase 3: time off and absence.

CREATE TABLE app.leave_types (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name jsonb NOT NULL,
  category text NOT NULL CHECK (category IN ('annual', 'sickness', 'unpaid', 'family', 'toil', 'fmla', 'other')),
  paid boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  deducts_balance boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.leave_types');

CREATE TABLE app.leave_policies (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  leave_type_id uuid NOT NULL,
  entity_id uuid,
  country char(2),
  config jsonb NOT NULL,
  effective_from date NOT NULL DEFAULT '2000-01-01',
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES app.leave_types (tenant_id, id)
);
CREATE INDEX leave_policies_type ON app.leave_policies (tenant_id, leave_type_id);
SELECT app.enable_tenant_rls('app.leave_policies');

CREATE TABLE app.leave_policy_assignments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, policy_id) REFERENCES app.leave_policies (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, leave_type_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX leave_policy_assignments_emp ON app.leave_policy_assignments (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.leave_policy_assignments');

CREATE TABLE app.company_calendars (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  entity_id uuid,
  location_id uuid,
  days jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{date, name}]
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.company_calendars');

CREATE TABLE app.leave_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  start_half text CHECK (start_half IN ('am', 'pm')),
  end_half text CHECK (end_half IN ('am', 'pm')),
  amount_days numeric(8, 4) NOT NULL,
  amount_hours numeric(8, 2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approval_request_id uuid,
  fmla_case_id uuid,
  note text,
  requested_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES app.leave_types (tenant_id, id)
);
CREATE INDEX leave_requests_emp ON app.leave_requests (tenant_id, employee_id, start_date);
CREATE INDEX leave_requests_range ON app.leave_requests (tenant_id, start_date, end_date) WHERE status IN ('pending', 'approved');
SELECT app.enable_tenant_rls('app.leave_requests');

CREATE TABLE app.leave_adjustments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  amount numeric(8, 4) NOT NULL,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'toil', 'carry_over', 'correction')),
  effective_date date NOT NULL,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX leave_adjustments_emp ON app.leave_adjustments (tenant_id, employee_id, leave_type_id);
SELECT app.enable_tenant_rls('app.leave_adjustments');

-- Sickness: dates and status here; reasons, fit notes and return-to-work answers live in the vault.
CREATE TABLE app.sickness_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date,
  leave_request_id uuid,
  fit_note_required boolean NOT NULL DEFAULT false,
  fit_note_vault_id uuid,
  reason_vault_id uuid,
  rtw_status text NOT NULL DEFAULT 'not_required' CHECK (rtw_status IN ('not_required', 'due', 'completed')),
  rtw_vault_id uuid,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sickness_records_emp ON app.sickness_records (tenant_id, employee_id, start_date);
SELECT app.enable_tenant_rls('app.sickness_records');

CREATE TABLE app.fmla_cases (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('own_health', 'family_care', 'birth_bonding', 'placement', 'military_exigency', 'military_caregiver')),
  leave_year_method text NOT NULL CHECK (leave_year_method IN ('calendar_year', 'fixed_12_month_period', 'forward_from_first_leave_date', 'rolling_backward')),
  start_date date NOT NULL,
  intermittent boolean NOT NULL DEFAULT false,
  entitlement_hours numeric(8, 2) NOT NULL,
  eligibility jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.fmla_cases');

CREATE TABLE app.cover_rules (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  department_id uuid,
  location_id uuid,
  min_present int NOT NULL CHECK (min_present >= 0),
  enforcement text NOT NULL DEFAULT 'warn' CHECK (enforcement IN ('warn', 'block')),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.cover_rules');

CREATE TABLE app.absence_triggers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  bradford_threshold int,
  spells_threshold int,
  window_days int NOT NULL DEFAULT 365,
  notify_role text NOT NULL DEFAULT 'hr_admin',
  notify_manager boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.absence_triggers');

CREATE TABLE app.ics_tokens (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('me', 'team')),
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.ics_tokens');
