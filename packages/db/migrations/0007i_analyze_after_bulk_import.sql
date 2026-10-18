-- A bulk import adds tens of thousands of rows to one tenant at once. Until autovacuum re-analyzes the
-- tables, the planner still believes that tenant is tiny and picks nested loops that scan the whole
-- table per row (a 20,000-row import timed out in its manager-link step). The import job refreshes the
-- statistics with this function once its rows are written.
--  - Owner rights are needed for ANALYZE; the function takes no arguments and has a fixed table list.
--  - Statistics are not tenant data, and pg_stats hides tables with row-level security from roles it
--    applies to, so this exposes nothing across tenants.
CREATE OR REPLACE FUNCTION app.analyze_core_hr() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  ANALYZE app.employees;
  ANALYZE app.employee_personal;
  ANALYZE app.employee_jobs;
  ANALYZE app.employee_pay;
  ANALYZE app.employee_contracts;
  ANALYZE app.reporting_lines;
END $$;
REVOKE ALL ON FUNCTION app.analyze_core_hr() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.analyze_core_hr() TO thapsus_app;
