-- Tasks keep the reminder lead time chosen on their workflow template, and remember the person
-- (employee) they are for when that person has no sign-in yet, e.g. a new joiner's pre-start tasks
-- created before they are invited. Expand only.
ALTER TABLE app.tasks
  ADD COLUMN reminder_days_before int CHECK (reminder_days_before IS NULL OR reminder_days_before BETWEEN 0 AND 365),
  ADD COLUMN assignee_employee_id uuid;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_assignee_employee_fk
  FOREIGN KEY (tenant_id, assignee_employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE SET NULL (assignee_employee_id);
CREATE INDEX tasks_assignee_employee ON app.tasks (tenant_id, assignee_employee_id, status) WHERE assignee_employee_id IS NOT NULL;
CREATE INDEX tasks_open_due ON app.tasks (tenant_id, due_on) WHERE status = 'open';
