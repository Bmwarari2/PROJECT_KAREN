-- Phase 16 part B: "Asked by" names the person who asked (ADR-0193). Expand only: two columns and a
-- backfill. Nothing is dropped or renamed; requested_by (the asker's sign-in) keeps its meaning. Safe to re-run.

ALTER TABLE app.approval_requests
  -- the person who asked, also when they have no sign-in (a request recorded on their behalf)
  ADD COLUMN IF NOT EXISTS requested_by_employee_id uuid,
  -- who made the request: a person, or an automation rule; "The system" is shown only for automations
  ADD COLUMN IF NOT EXISTS requested_via text NOT NULL DEFAULT 'person' CHECK (requested_via IN ('person', 'automation'));
ALTER TABLE app.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_requested_by_employee_fk;
ALTER TABLE app.approval_requests ADD CONSTRAINT approval_requests_requested_by_employee_fk
  FOREIGN KEY (tenant_id, requested_by_employee_id) REFERENCES app.employees (tenant_id, id)
  ON DELETE SET NULL (requested_by_employee_id);

-- As in 0018 and 0021, FORCE RLS is lifted only inside this transaction so the owner can see every
-- tenant's rows; the application role never owns the table.
ALTER TABLE app.approval_requests NO FORCE ROW LEVEL SECURITY;
-- the asker's employee record, from their sign-in
UPDATE app.approval_requests r SET requested_by_employee_id = u.employee_id
  FROM app.users u
 WHERE u.tenant_id = r.tenant_id AND u.id = r.requested_by AND r.requested_by_employee_id IS NULL
   AND u.employee_id IS NOT NULL;
-- requests people make about themselves (time off, shifts, timesheets, their own details) were asked by
-- the person they are about, also when the request was stored without a sign-in
UPDATE app.approval_requests SET requested_by_employee_id = subject_employee_id
 WHERE requested_by IS NULL AND requested_by_employee_id IS NULL AND subject_employee_id IS NOT NULL
   AND subject IN ('leave.request', 'shift.claim', 'shift.swap', 'timesheet', 'employee.self_change');
ALTER TABLE app.approval_requests FORCE ROW LEVEL SECURITY;
