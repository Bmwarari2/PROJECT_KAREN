-- Phase 4: rotas, clocking, timesheets and working-time settings.

CREATE TABLE app.rota_templates (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location_id uuid,
  department_id uuid,
  -- [{weekday 1-7, start 'HH:MM', end 'HH:MM', breakMinutes, role, headcount}]
  slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.rota_templates');

CREATE TABLE app.shifts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid, -- null = open shift
  location_id uuid,
  department_id uuid,
  role text,
  -- local wall-clock times in the shift's zone; instants derived for overlap checks
  shift_date date NOT NULL,
  start_local text NOT NULL CHECK (start_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  end_local text NOT NULL CHECK (end_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  zone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  published_at timestamptz,
  template_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (employee_id IS NOT NULL AND status <> 'cancelled')
);
CREATE INDEX shifts_range ON app.shifts (tenant_id, shift_date);
CREATE INDEX shifts_emp ON app.shifts (tenant_id, employee_id, shift_date);
SELECT app.enable_tenant_rls('app.shifts');

CREATE TABLE app.availability (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  weekday smallint CHECK (weekday BETWEEN 1 AND 7),
  on_date date,
  available boolean NOT NULL,
  from_time text,
  to_time text,
  note text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  CHECK ((weekday IS NULL) <> (on_date IS NULL))
);
CREATE INDEX availability_emp ON app.availability (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.availability');

CREATE TABLE app.shift_swaps (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL,
  from_employee_id uuid NOT NULL,
  to_employee_id uuid,
  kind text NOT NULL CHECK (kind IN ('swap', 'claim_open')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approval_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES app.shifts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shift_swaps_shift ON app.shift_swaps (tenant_id, shift_id);
SELECT app.enable_tenant_rls('app.shift_swaps');

-- Clock events are appended (never edited); corrections are new events. client_event_id makes
-- offline-queue sync idempotent.
CREATE TABLE app.clock_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end')),
  occurred_at timestamptz NOT NULL,
  zone text NOT NULL,
  source text NOT NULL CHECK (source IN ('pwa', 'kiosk', 'manager', 'import')),
  client_event_id text NOT NULL,
  -- geolocation only when the tenant enabled geofencing for the country; coarse (4 dp) and never logged
  lat numeric(8, 4),
  lng numeric(8, 4),
  within_geofence boolean,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, client_event_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX clock_events_emp ON app.clock_events (tenant_id, employee_id, occurred_at);
SELECT app.enable_tenant_rls('app.clock_events');

CREATE TABLE app.kiosks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location_id uuid,
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.kiosks');

CREATE TABLE app.kiosk_pins (
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.kiosk_pins');

CREATE TABLE app.timesheets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  week_start date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'approved', 'rejected')),
  regular_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  double_minutes integer NOT NULL DEFAULT 0,
  scheduled_minutes integer NOT NULL DEFAULT 0,
  violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_request_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  exported_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, week_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX timesheets_week ON app.timesheets (tenant_id, week_start, status);
SELECT app.enable_tenant_rls('app.timesheets');

-- UK 48-hour opt-out records (reg. 5 Working Time Regulations 1998); effective-dated.
CREATE TABLE app.working_time_opt_outs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  signed_document_id uuid,
  notice_days integer NOT NULL DEFAULT 7,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX working_time_opt_outs_emp ON app.working_time_opt_outs (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.working_time_opt_outs');
