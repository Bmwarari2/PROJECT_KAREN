-- Positions, grades and cost centres are reference tables; effective-dated job records now point at
-- them with foreign keys (added NOT VALID so existing rows are not scanned under a strong lock; they
-- are validated in 0007d in a separate transaction). Expand only.

-- References written by earlier releases were not checked. A dangling id has no meaning, so it is
-- cleared before validation. As in 0007b, FORCE RLS is lifted only inside this transaction so the
-- owner can see the rows; the application role is unaffected.
ALTER TABLE app.employee_jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.positions NO FORCE ROW LEVEL SECURITY;
UPDATE app.employee_jobs j SET position_id = NULL
 WHERE position_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.positions p WHERE p.tenant_id = j.tenant_id AND p.id = j.position_id);
UPDATE app.employee_jobs j SET grade_id = NULL
 WHERE grade_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.grades g WHERE g.tenant_id = j.tenant_id AND g.id = j.grade_id);
UPDATE app.employee_jobs j SET cost_centre_id = NULL
 WHERE cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.cost_centres c WHERE c.tenant_id = j.tenant_id AND c.id = j.cost_centre_id);
UPDATE app.positions p SET entity_id = NULL
 WHERE entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.legal_entities e WHERE e.tenant_id = p.tenant_id AND e.id = p.entity_id);
UPDATE app.positions p SET location_id = NULL
 WHERE location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.locations l WHERE l.tenant_id = p.tenant_id AND l.id = p.location_id);
ALTER TABLE app.employee_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.positions FORCE ROW LEVEL SECURITY;

ALTER TABLE app.employee_jobs
  ADD CONSTRAINT employee_jobs_position_fk FOREIGN KEY (tenant_id, position_id) REFERENCES app.positions (tenant_id, id) NOT VALID,
  ADD CONSTRAINT employee_jobs_grade_fk FOREIGN KEY (tenant_id, grade_id) REFERENCES app.grades (tenant_id, id) NOT VALID,
  ADD CONSTRAINT employee_jobs_cost_centre_fk FOREIGN KEY (tenant_id, cost_centre_id) REFERENCES app.cost_centres (tenant_id, id) NOT VALID;
ALTER TABLE app.positions
  ADD CONSTRAINT positions_entity_fk FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id) NOT VALID,
  ADD CONSTRAINT positions_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id) NOT VALID;

-- Lookups by reference (position headcount, cost-centre reporting) stay index-backed at 200,000 people.
CREATE INDEX employee_jobs_position ON app.employee_jobs (tenant_id, position_id) WHERE position_id IS NOT NULL;
CREATE INDEX employee_jobs_cost_centre ON app.employee_jobs (tenant_id, cost_centre_id) WHERE cost_centre_id IS NOT NULL;
CREATE INDEX employee_jobs_grade ON app.employee_jobs (tenant_id, grade_id) WHERE grade_id IS NOT NULL;
