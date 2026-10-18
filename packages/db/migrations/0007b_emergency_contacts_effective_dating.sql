-- Emergency contacts become effective-dated like the other core HR sections (expand only: new
-- defaulted columns and constraints; nothing is dropped). A contact "slot" (priority 1, 2, …) is held
-- by at most one contact on any date, so the list in force on a date is well defined.
ALTER TABLE app.emergency_contacts
  ADD COLUMN valid_from date NOT NULL DEFAULT '-infinity',
  ADD COLUMN valid_to date,
  ADD COLUMN created_by uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.emergency_contacts ADD CONSTRAINT emergency_contacts_period CHECK (valid_to IS NULL OR valid_to > valid_from);

-- Earlier releases accepted duplicate priorities. Renumber them per employee so the exclusion
-- constraint can be added. The migrator owns the table and RLS is forced, so it would see no rows;
-- FORCE is lifted only inside this transaction (which holds an exclusive lock) and restored below.
-- The application role is never the owner, so its policy applies throughout.
ALTER TABLE app.emergency_contacts NO FORCE ROW LEVEL SECURITY;
WITH ranked AS (
  SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id, employee_id ORDER BY priority, id)::int AS rn
    FROM app.emergency_contacts
)
UPDATE app.emergency_contacts c SET priority = r.rn FROM ranked r
 WHERE c.tenant_id = r.tenant_id AND c.id = r.id AND c.priority <> r.rn;
ALTER TABLE app.emergency_contacts FORCE ROW LEVEL SECURITY;

ALTER TABLE app.emergency_contacts ADD CONSTRAINT emergency_contacts_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, priority WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
CREATE INDEX emergency_contacts_emp_from ON app.emergency_contacts (tenant_id, employee_id, valid_from);
