import type { Tx } from '@thapsus/db';
import type { Principal } from '@thapsus/core/permissions';
import { FieldGate, paramAdder, rowScope } from '../access';
import type { EmployeeFact, JobFact } from '../calc/people';
import type { GroupBy } from '../types';

/** Field permission that governs each grouping dimension (as in the employee field model). */
export const DIMENSION_PERM: Record<Exclude<GroupBy, 'none'>, string> = {
  entity: 'entity',
  department: 'department',
  location: 'location',
  country: 'location',
};

export interface ScopedEmployee {
  id: string;
  employee_number: string;
  display_name: string;
  start_date: string;
  end_date: string | null;
  leaver_type: 'voluntary' | 'involuntary' | 'other' | null;
  entity_id: string | null;
  country: string | null;
  department_id: string | null;
  location_id: string | null;
}

/** Employees in the caller's scope for `action` whose employment overlaps [from, to]. */
export async function scopedEmployees(
  tx: Tx,
  p: Principal,
  action: string,
  from: string,
  to: string,
): Promise<ScopedEmployee[]> {
  const params: unknown[] = [];
  const add = paramAdder(params);
  const scope = rowScope(p, action, params);
  return tx.query<ScopedEmployee>(
    `SELECT e.id, e.employee_number, e.display_name, e.start_date, e.end_date, e.leaver_type, e.entity_id, e.country, e.department_id, e.location_id
       FROM app.employees e
      WHERE ${scope} AND e.start_date <= ${add(to)}::date AND (e.end_date IS NULL OR e.end_date >= ${add(from)}::date)
      ORDER BY e.id`,
    params,
  );
}

/** Job records overlapping [from, to] for the scoped employees (one query, keyed by employee). */
export async function jobsFor(
  tx: Tx,
  p: Principal,
  action: string,
  from: string,
  to: string,
): Promise<Map<string, JobFact[]>> {
  const params: unknown[] = [];
  const add = paramAdder(params);
  const scope = rowScope(p, action, params);
  const rows = await tx.query<{
    employee_id: string;
    valid_from: string;
    valid_to: string | null;
    entity_id: string | null;
    department_id: string | null;
    location_id: string | null;
    country: string | null;
    fte: string;
  }>(
    `SELECT j.employee_id, j.valid_from, j.valid_to, j.entity_id, j.department_id, j.location_id, coalesce(l.country, le.country) AS country, j.fte
       FROM app.employee_jobs j
       JOIN app.employees e ON e.tenant_id = j.tenant_id AND e.id = j.employee_id
       LEFT JOIN app.locations l ON l.tenant_id = j.tenant_id AND l.id = j.location_id
       LEFT JOIN app.legal_entities le ON le.tenant_id = j.tenant_id AND le.id = j.entity_id
      WHERE ${scope} AND j.valid_from <= ${add(to)}::date AND (j.valid_to IS NULL OR j.valid_to > ${add(from)}::date)
      ORDER BY j.employee_id, j.valid_from`,
    params,
  );
  const out = new Map<string, JobFact[]>();
  for (const r of rows) {
    const list = out.get(r.employee_id) ?? [];
    list.push({
      validFrom: r.valid_from,
      validTo: r.valid_to,
      entityId: r.entity_id,
      departmentId: r.department_id,
      locationId: r.location_id,
      country: r.country?.trim() ?? null,
      fte: r.fte,
    });
    out.set(r.employee_id, list);
  }
  return out;
}

/** Employee facts for headcount / turnover, with the grouping dimension masked where it is not readable. */
export async function employeeFacts(
  tx: Tx,
  p: Principal,
  from: string,
  to: string,
  groupBy: GroupBy,
): Promise<{ facts: EmployeeFact[]; restricted: number }> {
  // one connection per transaction: queries run one after another
  const emps = await scopedEmployees(tx, p, 'employees.read', from, to);
  const jobs = await jobsFor(tx, p, 'employees.read', from, to);
  const gate = await FieldGate.create(tx, p);
  let restricted = 0;
  const facts = emps.map((e) => {
    const readable = groupBy === 'none' || gate.readable(DIMENSION_PERM[groupBy], gate.target(e));
    if (!readable) restricted++;
    return {
      id: e.id,
      startDate: e.start_date,
      endDate: e.end_date,
      leaverType: e.leaver_type,
      jobs: jobs.get(e.id) ?? [],
      groupReadable: readable,
    };
  });
  return { facts, restricted };
}

/** Display names for group keys (entities, departments, locations); countries stay ISO codes. */
export async function groupNames(tx: Tx, groupBy: GroupBy): Promise<Map<string, string>> {
  const table = {
    entity: 'app.legal_entities',
    department: 'app.departments',
    location: 'app.locations',
  } as Record<string, string>;
  if (!table[groupBy]) return new Map();
  const rows = await tx.query<{ id: string; name: string }>(`SELECT id, name FROM ${table[groupBy]}`);
  return new Map(rows.map((r) => [r.id, r.name]));
}
