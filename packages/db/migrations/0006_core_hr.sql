-- Core HR and organisation model. Effective-dated tables use half-open [valid_from, valid_to) date
-- ranges (valid_to NULL = open-ended) with exclusion constraints that forbid overlapping periods.
-- employees carries denormalised *current* values for fast lists/search at 200,000 rows; they are
-- refreshed by app.refresh_employee_current() after writes and daily for future-dated changes.

CREATE TABLE app.legal_entities (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country char(2) NOT NULL,
  region_code text,
  registration_number text,
  currency char(3) NOT NULL,
  time_zone text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  employee_count_hint int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.legal_entities');

CREATE TABLE app.locations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  entity_id uuid,
  country char(2) NOT NULL,
  region_code text,
  time_zone text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  geofence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.locations');

CREATE TABLE app.departments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES app.departments (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.departments');

CREATE TABLE app.cost_centres (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  entity_id uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.cost_centres');

CREATE TABLE app.grades (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  currency char(3),
  min_minor bigint,
  max_minor bigint,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT app.enable_tenant_rls('app.grades');

CREATE TABLE app.positions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  department_id uuid,
  grade_id uuid,
  entity_id uuid,
  location_id uuid,
  headcount int NOT NULL DEFAULT 1 CHECK (headcount > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'frozen', 'closed')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.departments (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES app.grades (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.positions');

CREATE TABLE app.employees (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_number text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pre_start', 'active', 'leaver')),
  start_date date NOT NULL,
  end_date date,
  work_email citext,
  work_phone text,
  -- denormalised current values (refreshed from the effective-dated tables)
  display_name text NOT NULL DEFAULT '',
  preferred_name text,
  job_title text,
  department_id uuid,
  location_id uuid,
  entity_id uuid,
  country char(2),
  region_code text,
  manager_id uuid,
  time_zone text,
  search tsvector,
  current_as_of date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_number)
);
SELECT app.enable_tenant_rls('app.employees');
CREATE INDEX employees_list ON app.employees (tenant_id, status, display_name, id);
CREATE INDEX employees_manager ON app.employees (tenant_id, manager_id);
CREATE INDEX employees_department ON app.employees (tenant_id, department_id);
CREATE INDEX employees_entity ON app.employees (tenant_id, entity_id);
CREATE INDEX employees_search ON app.employees USING gin (search);
CREATE INDEX employees_name_trgm ON app.employees USING gin (display_name gin_trgm_ops);
CREATE TRIGGER employees_touch BEFORE UPDATE ON app.employees FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE app.users ADD CONSTRAINT users_employee_fk FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE SET NULL (employee_id);
CREATE INDEX users_employee ON app.users (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

-- Effective-dated personal details
CREATE TABLE app.employee_personal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  legal_first_name text NOT NULL,
  legal_last_name text NOT NULL,
  preferred_name text,
  pronouns text,
  date_of_birth date,
  personal_email citext,
  personal_phone text,
  address jsonb,
  nationality char(2),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX employee_personal_emp ON app.employee_personal (tenant_id, employee_id, valid_from);
SELECT app.enable_tenant_rls('app.employee_personal');

-- Effective-dated job assignment
CREATE TABLE app.employee_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  job_title text NOT NULL,
  position_id uuid,
  department_id uuid,
  location_id uuid,
  entity_id uuid NOT NULL,
  cost_centre_id uuid,
  grade_id uuid,
  employment_type text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time', 'part_time', 'casual', 'contractor', 'intern')),
  fte numeric(5, 4) NOT NULL DEFAULT 1 CHECK (fte > 0 AND fte <= 1.5),
  weekly_hours numeric(5, 2),
  work_pattern jsonb,
  flsa_status text CHECK (flsa_status IN ('exempt', 'non_exempt')),
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.departments (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX employee_jobs_emp ON app.employee_jobs (tenant_id, employee_id, valid_from);
CREATE INDEX employee_jobs_starting ON app.employee_jobs (tenant_id, valid_from);
SELECT app.enable_tenant_rls('app.employee_jobs');

-- Effective-dated pay (integer minor units + ISO 4217)
CREATE TABLE app.employee_pay (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('annual', 'monthly', 'weekly', 'hourly', 'daily')),
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX employee_pay_emp ON app.employee_pay (tenant_id, employee_id, valid_from);
SELECT app.enable_tenant_rls('app.employee_pay');

CREATE TABLE app.employee_contracts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  contract_type text NOT NULL CHECK (contract_type IN ('permanent', 'fixed_term', 'zero_hours', 'temporary', 'contractor', 'apprenticeship')),
  notice_period_days int,
  probation_end_date date,
  document_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX employee_contracts_emp ON app.employee_contracts (tenant_id, employee_id, valid_from);
SELECT app.enable_tenant_rls('app.employee_contracts');

-- Reporting relationships: one solid line at a time; any number of dotted/matrix lines.
CREATE TABLE app.reporting_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  manager_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('solid', 'dotted', 'matrix')),
  valid_from date NOT NULL,
  valid_to date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (employee_id <> manager_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, manager_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (kind = 'solid'),
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, manager_id WITH =, kind WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX reporting_lines_emp ON app.reporting_lines (tenant_id, employee_id, valid_from);
CREATE INDEX reporting_lines_mgr ON app.reporting_lines (tenant_id, manager_id, valid_from);
SELECT app.enable_tenant_rls('app.reporting_lines');

CREATE TABLE app.emergency_contacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  name text NOT NULL,
  relationship text,
  phone text,
  email citext,
  priority int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX emergency_contacts_emp ON app.emergency_contacts (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.emergency_contacts');

-- Custom fields and custom objects
CREATE TABLE app.custom_field_definitions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL DEFAULT 'employee',
  key text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9_]{1,40}$'),
  label jsonb NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'currency', 'file')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_dated boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entity_type, key)
);
SELECT app.enable_tenant_rls('app.custom_field_definitions');

CREATE TABLE app.custom_field_values (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL,
  record_id uuid NOT NULL,
  value jsonb NOT NULL,
  valid_from date NOT NULL DEFAULT '-infinity',
  valid_to date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, field_id) REFERENCES app.custom_field_definitions (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, field_id WITH =, record_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX custom_field_values_record ON app.custom_field_values (tenant_id, record_id);
SELECT app.enable_tenant_rls('app.custom_field_values');

CREATE TABLE app.custom_object_types (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9_]{1,40}$'),
  label jsonb NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.custom_object_types');

CREATE TABLE app.custom_object_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  type_id uuid NOT NULL,
  employee_id uuid,
  data jsonb NOT NULL,
  valid_from date NOT NULL DEFAULT '-infinity',
  valid_to date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id) REFERENCES app.custom_object_types (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX custom_object_records_emp ON app.custom_object_records (tenant_id, type_id, employee_id);
SELECT app.enable_tenant_rls('app.custom_object_records');

-- Refreshes the denormalised current values of one employee (or every employee when NULL) as of a date.
CREATE OR REPLACE FUNCTION app.refresh_employee_current(p_employee uuid, p_as_of date DEFAULT current_date) RETURNS int
  LANGUAGE sql AS $$
  WITH cur AS (
    SELECT e.tenant_id, e.id,
      p.legal_first_name, p.legal_last_name, p.preferred_name,
      j.job_title, j.department_id, j.location_id, j.entity_id,
      l.country AS loc_country, l.region_code AS loc_region, l.time_zone AS loc_tz,
      le.country AS ent_country, le.time_zone AS ent_tz,
      r.manager_id
    FROM app.employees e
    LEFT JOIN LATERAL (SELECT * FROM app.employee_personal x WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id
                         AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT * FROM app.employee_jobs x WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id
                         AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) j ON true
    LEFT JOIN LATERAL (SELECT x.manager_id FROM app.reporting_lines x WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id
                         AND x.kind = 'solid' AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) r ON true
    LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = j.location_id
    LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = j.entity_id
    WHERE p_employee IS NULL OR e.id = p_employee
  )
  UPDATE app.employees e SET
    display_name = coalesce(nullif(trim(coalesce(cur.preferred_name, cur.legal_first_name) || ' ' || cur.legal_last_name), ''), e.display_name),
    preferred_name = cur.preferred_name,
    job_title = cur.job_title,
    department_id = cur.department_id,
    location_id = cur.location_id,
    entity_id = cur.entity_id,
    country = coalesce(cur.loc_country, cur.ent_country),
    region_code = cur.loc_region,
    time_zone = coalesce(cur.loc_tz, cur.ent_tz),
    manager_id = cur.manager_id,
    status = CASE WHEN e.end_date IS NOT NULL AND e.end_date < p_as_of THEN 'leaver'
                  WHEN e.start_date > p_as_of THEN 'pre_start' ELSE 'active' END,
    search = to_tsvector('simple', coalesce(cur.legal_first_name, '') || ' ' || coalesce(cur.legal_last_name, '') || ' ' ||
             coalesce(cur.preferred_name, '') || ' ' || e.employee_number || ' ' || coalesce(e.work_email::text, '') || ' ' || coalesce(cur.job_title, '')),
    current_as_of = p_as_of
  FROM cur WHERE e.tenant_id = cur.tenant_id AND e.id = cur.id;
  SELECT 1;
$$;
