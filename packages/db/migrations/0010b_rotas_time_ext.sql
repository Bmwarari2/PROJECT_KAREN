-- Phase 4 (expand only): columns and tables used by the rota, clock, kiosk and timesheet APIs.

-- Shifts: notes, change tracking and a keyset index (date, start, id) for range listings at 10k+ workers.
ALTER TABLE app.shifts ADD COLUMN notes text CHECK (length(notes) <= 500);
ALTER TABLE app.shifts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX shifts_keyset ON app.shifts (tenant_id, shift_date, starts_at, id);
CREATE INDEX shifts_open ON app.shifts (tenant_id, shift_date) WHERE employee_id IS NULL AND status = 'published';
CREATE TRIGGER shifts_touch BEFORE UPDATE ON app.shifts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Swaps and open-shift claims: optional exchange shift, colleague acceptance, one pending claim per person.
ALTER TABLE app.shift_swaps ADD COLUMN to_shift_id uuid;
ALTER TABLE app.shift_swaps ADD COLUMN note text CHECK (length(note) <= 500);
ALTER TABLE app.shift_swaps ADD COLUMN requested_by uuid;
ALTER TABLE app.shift_swaps ADD COLUMN accepted_at timestamptz;
ALTER TABLE app.shift_swaps ADD COLUMN decided_at timestamptz;
ALTER TABLE app.shift_swaps ADD CONSTRAINT shift_swaps_to_shift_fk FOREIGN KEY (tenant_id, to_shift_id) REFERENCES app.shifts (tenant_id, id) ON DELETE CASCADE;
CREATE UNIQUE INDEX shift_swaps_one_pending ON app.shift_swaps (tenant_id, shift_id, from_employee_id) WHERE status = 'pending';
CREATE INDEX shift_swaps_from ON app.shift_swaps (tenant_id, from_employee_id, status);
CREATE INDEX shift_swaps_to ON app.shift_swaps (tenant_id, to_employee_id, status);

-- Clock events stay append-only: a manager correction is a new event that may supersede an earlier one.
ALTER TABLE app.clock_events ADD COLUMN reason text CHECK (length(reason) <= 500);
ALTER TABLE app.clock_events ADD COLUMN replaces_event_id uuid;
ALTER TABLE app.clock_events ADD COLUMN kiosk_id uuid;
CREATE INDEX clock_events_replaces ON app.clock_events (tenant_id, replaces_event_id) WHERE replaces_event_id IS NOT NULL;

ALTER TABLE app.kiosks ADD COLUMN created_by uuid;
ALTER TABLE app.kiosks ADD COLUMN last_used_at timestamptz;

-- Timesheets keep the snapshot that was approved, so payroll exports of a closed week are reproducible.
ALTER TABLE app.timesheets ADD COLUMN worked_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE app.timesheets ADD COLUMN days jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app.timesheets ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app.timesheets ADD COLUMN time_recording_required boolean NOT NULL DEFAULT false;
ALTER TABLE app.timesheets ADD COLUMN submitted_by uuid;
ALTER TABLE app.timesheets ADD COLUMN reopened_at timestamptz;

CREATE TABLE app.timesheet_exports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  row_count integer NOT NULL,
  checksum text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX timesheet_exports_week ON app.timesheet_exports (tenant_id, week_start, created_at);
SELECT app.enable_tenant_rls('app.timesheet_exports');

-- 48-hour opt-out: the date the worker gave notice to end it (the opt-out runs until the notice expires).
ALTER TABLE app.working_time_opt_outs ADD COLUMN notice_given_on date;
ALTER TABLE app.working_time_opt_outs ADD COLUMN ended_by uuid;

CREATE INDEX availability_emp_day ON app.availability (tenant_id, employee_id, weekday, on_date);
