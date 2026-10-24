-- Staging feedback, round 14a. Expand only: nullable columns, a wider check and additive role keys;
-- nothing is dropped or renamed. Safe to re-run.

-- Notifications name what they are about (ADR-0160): a target type and the target's id, from which the
-- API builds the page to open (packages/core/src/links.ts). Older notifications keep working through
-- their stored link or the list page for their kind.
ALTER TABLE app.notifications
  ADD COLUMN IF NOT EXISTS target_type text CHECK (target_type IS NULL OR target_type ~ '^[a-z_]{1,40}$'),
  ADD COLUMN IF NOT EXISTS target_id uuid;

-- "Contact HR" (ADR-0163): an employee's question to their HR team is a task in the HR admins' queue,
-- about the person who asked (subject_employee_id). The source list gains one value.
ALTER TABLE app.tasks DROP CONSTRAINT IF EXISTS tasks_source_check;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_source_check
  CHECK (source IN ('workflow', 'approval', 'automation', 'document', 'manual', 'compliance', 'hr_request'));
CREATE INDEX IF NOT EXISTS tasks_hr_requests ON app.tasks (tenant_id, subject_employee_id, created_at DESC)
  WHERE source = 'hr_request';

-- Built-in roles of existing tenants follow packages/core/src/roles.ts (ADR-0163): admin roles contact
-- Thapsus-HR support, employees and managers contact their own HR team instead. Custom roles
-- (built_in = false) are never touched. As in 0018, FORCE RLS is lifted only inside this transaction so
-- the owner can see every tenant's rows; the application role never owns the table.
ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY;
UPDATE app.roles SET permissions = array_remove(permissions, 'support.ticket')
 WHERE built_in AND key IN ('manager', 'employee') AND 'support.ticket' = ANY (permissions);
UPDATE app.roles SET permissions = permissions || ARRAY['hr.contact']
 WHERE built_in AND key IN ('manager', 'employee') AND NOT ('hr.contact' = ANY (permissions));
UPDATE app.roles SET permissions = permissions || ARRAY['support.ticket']
 WHERE built_in AND key IN ('entity_hr_admin', 'payroll_admin') AND NOT ('support.ticket' = ANY (permissions))
   AND NOT ('support.*' = ANY (permissions));
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
