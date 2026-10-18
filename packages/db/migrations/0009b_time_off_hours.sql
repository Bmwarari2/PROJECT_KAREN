-- Phase 3 follow-up: hours actually worked (per-hour-worked accrual, FMLA hours, US paid sick leave)
-- and FMLA leave-year methods validated against the US jurisdiction pack instead of a fixed list.

-- Hours worked recorded per period (manual entry, import or payroll feed). Timesheets, where the
-- time-tracking module is installed, take precedence (see ADR-0030).
CREATE TABLE app.worked_hours (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL, -- exclusive
  minutes integer NOT NULL CHECK (minutes >= 0 AND minutes <= 576000),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'payroll')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, daterange(period_start, period_end, '[)') WITH &&)
);
CREATE INDEX worked_hours_emp ON app.worked_hours (tenant_id, employee_id, period_start);
SELECT app.enable_tenant_rls('app.worked_hours');

-- The pack (family_leave.fmla.leaveYearMethods) is the source of the allowed methods; the database only
-- checks the format. Legacy 'rolling_backward' rows are read as 'rolling_backward_from_leave_date'.
ALTER TABLE app.fmla_cases DROP CONSTRAINT IF EXISTS fmla_cases_leave_year_method_check;
ALTER TABLE app.fmla_cases ADD CONSTRAINT fmla_cases_leave_year_method_format CHECK (leave_year_method ~ '^[a-z][a-z0-9_]{2,60}$');
CREATE INDEX fmla_cases_emp ON app.fmla_cases (tenant_id, employee_id);

CREATE INDEX leave_requests_fmla ON app.leave_requests (tenant_id, fmla_case_id) WHERE fmla_case_id IS NOT NULL;

-- Hourly requests (a part day given in hours: hourly leave, intermittent FMLA).
ALTER TABLE app.leave_requests ADD COLUMN explicit_hours boolean NOT NULL DEFAULT false;
