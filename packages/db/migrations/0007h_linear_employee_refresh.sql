-- The denormalised "current" columns on app.employees are refreshed with one correlated UPDATE per
-- row instead of UPDATE … FROM a CTE over the same table. The self-join planned as a nested loop with a
-- join filter (quadratic: 20,000 people took 160 s; RLS keeps the planner from using the key on id),
-- so a tenant-wide refresh after a bulk import could never finish within the statement timeout.
-- Same signature and the same values as 0006; expand only.

CREATE OR REPLACE FUNCTION app.refresh_employees_current(p_ids uuid[], p_as_of date DEFAULT current_date) RETURNS int
  LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE app.employees e SET
      (display_name, preferred_name, job_title, department_id, location_id, entity_id, country, region_code, time_zone, manager_id, status, search, current_as_of) = (
        SELECT coalesce(nullif(trim(coalesce(p.preferred_name, p.legal_first_name) || ' ' || p.legal_last_name), ''), e.display_name),
               p.preferred_name, j.job_title, j.department_id, j.location_id, j.entity_id,
               coalesce(l.country, le.country), l.region_code, coalesce(l.time_zone, le.time_zone), r.manager_id,
               CASE WHEN e.end_date IS NOT NULL AND e.end_date < p_as_of THEN 'leaver'
                    WHEN e.start_date > p_as_of THEN 'pre_start' ELSE 'active' END,
               to_tsvector('simple', coalesce(p.legal_first_name, '') || ' ' || coalesce(p.legal_last_name, '') || ' ' ||
                 coalesce(p.preferred_name, '') || ' ' || e.employee_number || ' ' || coalesce(e.work_email::text, '') || ' ' || coalesce(j.job_title, '')),
               p_as_of
          FROM (SELECT 1) one
          LEFT JOIN LATERAL (SELECT x.legal_first_name, x.legal_last_name, x.preferred_name FROM app.employee_personal x
                              WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) p ON true
          LEFT JOIN LATERAL (SELECT x.job_title, x.department_id, x.location_id, x.entity_id FROM app.employee_jobs x
                              WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) j ON true
          LEFT JOIN LATERAL (SELECT x.manager_id FROM app.reporting_lines x
                              WHERE x.tenant_id = e.tenant_id AND x.employee_id = e.id AND x.kind = 'solid' AND x.valid_from <= p_as_of AND (x.valid_to IS NULL OR x.valid_to > p_as_of) LIMIT 1) r ON true
          LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = j.location_id
          LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = j.entity_id)
     WHERE p_ids IS NULL OR e.id = ANY(p_ids)
    RETURNING 1)
  SELECT count(*)::int FROM upd;
$$;

-- One employee, or every employee of the current tenant when NULL (unchanged contract).
CREATE OR REPLACE FUNCTION app.refresh_employee_current(p_employee uuid, p_as_of date DEFAULT current_date) RETURNS int
  LANGUAGE sql AS $$
  SELECT app.refresh_employees_current(CASE WHEN p_employee IS NULL THEN NULL ELSE ARRAY[p_employee] END, p_as_of);
  SELECT 1;
$$;
