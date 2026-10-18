-- Validates the foreign keys added NOT VALID in 0007c. Runs in its own transaction and only takes a
-- SHARE UPDATE EXCLUSIVE lock, so reads and writes continue while existing rows are checked.
ALTER TABLE app.employee_jobs VALIDATE CONSTRAINT employee_jobs_position_fk;
ALTER TABLE app.employee_jobs VALIDATE CONSTRAINT employee_jobs_grade_fk;
ALTER TABLE app.employee_jobs VALIDATE CONSTRAINT employee_jobs_cost_centre_fk;
ALTER TABLE app.positions VALIDATE CONSTRAINT positions_entity_fk;
ALTER TABLE app.positions VALIDATE CONSTRAINT positions_location_fk;
