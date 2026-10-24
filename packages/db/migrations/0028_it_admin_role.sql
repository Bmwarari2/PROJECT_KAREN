-- Phase 16 part A (ADR-0189): a built-in IT admin role, and HR admins keep a read-only view of the
-- asset register. Built-in roles of existing tenants follow packages/core/src/roles.ts (new tenants are
-- seeded from it). Custom roles (built_in = false) are never touched, whatever their key: a workspace
-- whose own custom role already uses the key `it_admin` keeps it. Expand only: nothing is dropped.
-- As in 0018 and 0021, FORCE RLS is lifted only inside this transaction so the owner can see every
-- tenant's rows; the application role never owns the table.
ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY;

-- HR admins and country or entity HR admins: the asset register becomes read-only.
UPDATE app.roles SET permissions = array_replace(permissions, 'assets.*', 'assets.read')
 WHERE built_in AND key IN ('hr_admin', 'entity_hr_admin') AND 'assets.*' = ANY (permissions);

-- IT admin: devices, IT accounts and SCIM only; directory and employment-date fields, never pay,
-- contracts or sensitive records, for every tenant that has the built-in roles (app.roles is readable
-- here, app.tenants is not). apps/api/test/it-admin.int.test.ts compares this row with the code.
INSERT INTO app.roles (tenant_id, key, name, built_in, is_admin, permissions, field_access)
SELECT t.tenant_id, 'it_admin', 'IT admin', true, true,
       ARRAY['employees.read', 'assets.*', 'integrations.*', 'scim.manage', 'workflows.tasks', 'support.ticket',
             'self.read', 'self.update_contact', 'leave.request', 'time.clock', 'rota.view_own',
             'rota.swap_request', 'rota.availability', 'documents.read_own', 'documents.sign',
             'payslips.read_own', 'assets.read_own', 'assets.acknowledge', 'help.read', 'ai.ask'],
       '{"employee.*":"none","employee.id":"read","employee.displayName":"read","employee.preferredName":"read","employee.employeeNumber":"read","employee.status":"read","employee.startDate":"read","employee.endDate":"read","employee.workEmail":"read","employee.workPhone":"read","employee.photoUrl":"read","employee.manager":"read","employee.jobTitle":"read","employee.department":"read","employee.location":"read","employee.entity":"read"}'::jsonb
  FROM (SELECT DISTINCT tenant_id FROM app.roles WHERE built_in AND key = 'owner') t
ON CONFLICT (tenant_id, key) DO NOTHING;

ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
