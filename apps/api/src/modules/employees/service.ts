import type { Tx } from '@thapsus/db';
import { emitEvent } from '@thapsus/db';
import {
  actionMatches,
  fieldAccess,
  type Principal,
  type RoleGrant,
  type Target,
} from '@thapsus/core/permissions';
import { ApiError } from '../../http/errors';
import { FIELDS, REQUIRED, SECTION_TABLE, permKeyFor, sectionsOf, type Section } from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Scope ---------------------------------------------------------------------------------

/** Target attributes used by scope checks: entity, country, department, location and manager chain. */
export async function loadTarget(tx: Tx, employeeId: string): Promise<Target & { employeeId: string }> {
  const row = await tx.maybe<{
    entity_id: string | null;
    country: string | null;
    department_id: string | null;
    location_id: string | null;
    chain: string[] | null;
  }>(
    `WITH RECURSIVE up AS (
       SELECT id, manager_id, 0 AS depth FROM app.employees WHERE id = $1
       UNION ALL
       SELECT e.id, e.manager_id, up.depth + 1 FROM app.employees e JOIN up ON e.id = up.manager_id WHERE up.depth < 50
     )
     SELECT e.entity_id, e.country, e.department_id, e.location_id,
            (SELECT array_agg(manager_id) FROM up WHERE manager_id IS NOT NULL) AS chain
       FROM app.employees e WHERE e.id = $1`,
    [employeeId],
  );
  if (!row) throw new ApiError('notFound');
  // matrix / dotted managers also count as "team" for read actions
  const extra = await tx.query<{ manager_id: string }>(
    `SELECT manager_id FROM app.reporting_lines WHERE employee_id = $1 AND kind <> 'solid' AND valid_from <= current_date AND (valid_to IS NULL OR valid_to > current_date)`,
    [employeeId],
  );
  return {
    employeeId,
    entityId: row.entity_id,
    country: row.country,
    departmentId: row.department_id,
    locationId: row.location_id,
    managerChain: [...(row.chain ?? []), ...extra.map((e) => e.manager_id)],
  };
}

/**
 * SQL predicate (on alias `e`) for the rows one grant's scope covers; 'true' for scope "all" and
 * 'false' when the scope can match nothing (e.g. "self" without a linked employee).
 */
export function grantScopeSql(p: Principal, g: RoleGrant, add: (v: unknown) => string): string {
  const vals = g.scope.values ?? [];
  switch (g.scope.type) {
    case 'all':
      return 'true';
    case 'entity':
      return `e.entity_id = ANY(${add(vals)}::uuid[])`;
    case 'country':
      return `e.country = ANY(${add(vals)}::text[])`;
    case 'department':
      return `e.department_id = ANY(${add(vals)}::uuid[])`;
    case 'location':
      return `e.location_id = ANY(${add(vals)}::uuid[])`;
    case 'self':
      return p.employeeId ? `e.id = ${add(p.employeeId)}::uuid` : 'false';
    case 'own_team': {
      const roots = [p.employeeId, ...(p.delegatedFromEmployeeIds ?? [])].filter(Boolean);
      if (!roots.length) return 'false';
      return `(e.id IN (WITH RECURSIVE down AS (
              SELECT id, 0 AS d FROM app.employees WHERE manager_id = ANY(${add(roots)}::uuid[])
              UNION ALL SELECT x.id, down.d + 1 FROM app.employees x JOIN down ON x.manager_id = down.id WHERE down.d < 50
            ) SELECT id FROM down)
            OR e.id IN (SELECT employee_id FROM app.reporting_lines WHERE manager_id = ANY(${add(roots)}::uuid[]) AND kind <> 'solid'
                          AND valid_from <= current_date AND (valid_to IS NULL OR valid_to > current_date)))`;
    }
    default:
      return 'false';
  }
}

/**
 * SQL predicate (on alias `e`) selecting the employees a principal may act on for `action`.
 * Deny by default: returns 'false' when no grant applies.
 */
export function scopePredicate(p: Principal, action: string, params: unknown[]): string {
  const ors: string[] = [];
  const firstParam = params.length;
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (const g of p.grants) {
    if (!g.permissions.some((perm) => actionMatches(perm, action))) continue;
    if (g.scope.type === 'all') {
      // Drop parameters added for narrower grants: unused placeholders make the query fail.
      params.length = firstParam;
      return 'true';
    }
    const sql = grantScopeSql(p, g, add);
    if (sql !== 'false') ors.push(sql);
  }
  return ors.length ? `(${ors.join(' OR ')})` : 'false';
}

export interface EmployeeListFilter {
  q?: string;
  status?: string;
  entityId?: string;
  departmentId?: string;
  locationId?: string;
  managerId?: string;
  country?: string;
  /** Current employment type (applied only for callers who may read it for everyone, see below). */
  employmentType?: string;
  /** Start date range, inclusive (the home dashboard's joiners per month). */
  startFrom?: string;
  startTo?: string;
}

/** WHERE clauses (alias `e`) shared by the people list and its export: scope for `action`, then filters. */
export function employeeListWhere(
  p: Principal,
  action: string,
  f: EmployeeListFilter,
  params: unknown[],
): string[] {
  const where: string[] = [scopePredicate(p, action, params)];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  if (!f.status || f.status !== 'all') where.push(`e.status = ${add(f.status ?? 'active')}`);
  if (f.entityId) where.push(`e.entity_id = ${add(f.entityId)}`);
  if (f.departmentId) where.push(`e.department_id = ${add(f.departmentId)}`);
  if (f.locationId) where.push(`e.location_id = ${add(f.locationId)}`);
  if (f.managerId) where.push(`e.manager_id = ${add(f.managerId)}`);
  if (f.country) where.push(`e.country = ${add(f.country)}`);
  if (f.startFrom) where.push(`e.start_date >= ${add(f.startFrom)}::date`);
  if (f.startTo) where.push(`e.start_date <= ${add(f.startTo)}::date`);
  // Employment type is a field some roles may not read (managers): filtering by it would reveal it, so
  // the filter is honoured only for a caller who may read it on everyone (an all-scope grant).
  if (f.employmentType && fieldAccess(p, 'employee', 'employmentType') !== 'none')
    where.push(
      `EXISTS (SELECT 1 FROM app.employee_jobs j WHERE j.tenant_id = e.tenant_id AND j.employee_id = e.id
                 AND j.valid_from <= current_date AND (j.valid_to IS NULL OR j.valid_to > current_date)
                 AND j.employment_type = ${add(f.employmentType)})`,
    );
  if (f.q) {
    const term = f.q.trim();
    // Full-text (words, number, email, title), substring, and trigram word similarity so a misspelt
    // name still matches (`<%` uses the gin_trgm_ops index on display_name).
    const t = add(term);
    where.push(
      `(e.search @@ plainto_tsquery('simple', ${t}) OR e.display_name ILIKE ${add(`%${term.replace(/[%_\\]/g, '\\$&')}%`)} OR e.employee_number = ${t} OR ${t} <% e.display_name)`,
    );
  }
  return where;
}

/**
 * SQL array (alias `e`) of the person's managers for field-level checks on list rows: the whole solid
 * line up plus current dotted/matrix managers — the same chain loadTarget builds for one person — so
 * lists, exports and profiles agree. Only team-scoped grants need it; otherwise the direct manager.
 */
export function managerChainSql(p: Principal): string {
  if (!p.grants.some((g) => g.scope.type === 'own_team')) return `ARRAY[e.manager_id]`;
  return `ARRAY(WITH RECURSIVE up AS (
              SELECT m.id, m.manager_id, 1 AS d FROM app.employees m WHERE m.id = e.manager_id
              UNION ALL SELECT x.id, x.manager_id, up.d + 1 FROM app.employees x JOIN up ON x.id = up.manager_id WHERE up.d < 50)
            SELECT id FROM up
            UNION SELECT r.manager_id FROM app.reporting_lines r WHERE r.employee_id = e.id AND r.kind <> 'solid'
              AND r.valid_from <= current_date AND (r.valid_to IS NULL OR r.valid_to > current_date))`;
}

/** Field-level target for a list row selected with managerChainSql AS chain. */
export function rowTarget(r: {
  id: string;
  entity_id: string | null;
  country: string | null;
  department_id: string | null;
  location_id: string | null;
  chain: Array<string | null> | null;
}): Target & { employeeId: string } {
  return {
    employeeId: r.id,
    entityId: r.entity_id,
    country: r.country,
    departmentId: r.department_id,
    locationId: r.location_id,
    managerChain: (r.chain ?? []).filter((m): m is string => !!m),
  };
}

// ---- Reading -------------------------------------------------------------------------------

const asOfRow = (table: string) =>
  `SELECT * FROM ${table} WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) LIMIT 1`;

export interface EmployeeView {
  id: string;
  [k: string]: unknown;
}

/** Full employee record as of a date (null-safe), BEFORE field-level filtering. */
export async function employeeAsOf(tx: Tx, id: string, asOf: string): Promise<EmployeeView> {
  const e = await tx.maybe<Record<string, unknown>>(`SELECT e.* FROM app.employees e WHERE e.id = $1`, [id]);
  if (!e) throw new ApiError('notFound');
  // Sequential on purpose: one transaction = one connection (concurrent queries on a client are deprecated in pg).
  const personal = await tx.maybe(asOfRow('app.employee_personal'), [id, asOf]);
  // Names of the job's reference data come from the record in force on the as-of date, not today's.
  const job = await tx.maybe<Record<string, unknown>>(
    `SELECT j.*, d.name AS department_name, l.name AS location_name, le.name AS entity_name, coalesce(l.country, le.country) AS as_of_country,
            p.title AS position_title, g.name AS grade_name, cc.name AS cost_centre_name
       FROM app.employee_jobs j
       LEFT JOIN app.departments d ON d.tenant_id = j.tenant_id AND d.id = j.department_id
       LEFT JOIN app.locations l ON l.tenant_id = j.tenant_id AND l.id = j.location_id
       LEFT JOIN app.legal_entities le ON le.tenant_id = j.tenant_id AND le.id = j.entity_id
       LEFT JOIN app.positions p ON p.tenant_id = j.tenant_id AND p.id = j.position_id
       LEFT JOIN app.grades g ON g.tenant_id = j.tenant_id AND g.id = j.grade_id
       LEFT JOIN app.cost_centres cc ON cc.tenant_id = j.tenant_id AND cc.id = j.cost_centre_id
      WHERE j.employee_id = $1 AND j.valid_from <= $2 AND (j.valid_to IS NULL OR j.valid_to > $2) LIMIT 1`,
    [id, asOf],
  );
  const pay = await tx.maybe(asOfRow('app.employee_pay'), [id, asOf]);
  const contract = await tx.maybe(asOfRow('app.employee_contracts'), [id, asOf]);
  const manager = await tx.maybe<{ manager_id: string; display_name: string }>(
    `SELECT r.manager_id, m.display_name FROM app.reporting_lines r JOIN app.employees m ON m.tenant_id = r.tenant_id AND m.id = r.manager_id
      WHERE r.employee_id = $1 AND r.kind = 'solid' AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to > $2)`,
    [id, asOf],
  );
  const view: EmployeeView = {
    id,
    employeeNumber: e.employee_number,
    status:
      e.end_date && (e.end_date as string) < asOf
        ? 'leaver'
        : (e.start_date as string) > asOf
          ? 'pre_start'
          : 'active',
    startDate: e.start_date,
    endDate: e.end_date,
    workEmail: e.work_email,
    workPhone: e.work_phone,
    displayName: personal
      ? `${(personal.preferred_name as string) || personal.legal_first_name} ${personal.legal_last_name}`
      : e.display_name,
    managerId: manager?.manager_id ?? null,
    manager: manager ? { id: manager.manager_id, displayName: manager.display_name } : null,
    department: job?.department_name ?? null,
    location: job?.location_name ?? null,
    entity: job?.entity_name ?? null,
    country: job ? (job.as_of_country ?? null) : e.country,
    position: job?.position_title ?? null,
    grade: job?.grade_name ?? null,
    costCentre: job?.cost_centre_name ?? null,
  };
  const sectionRows: Record<string, Record<string, unknown> | undefined> = { personal, job, pay, contract };
  for (const [field, def] of Object.entries(FIELDS)) {
    if (def.section === 'core') continue;
    view[field] = sectionRows[def.section]?.[def.column] ?? null;
  }
  const custom = await tx.query<{ key: string; value: unknown }>(
    `SELECT d.key, v.value FROM app.custom_field_values v JOIN app.custom_field_definitions d ON d.tenant_id = v.tenant_id AND d.id = v.field_id
      WHERE v.record_id = $1 AND d.entity_type = 'employee' AND NOT d.archived AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to > $2)`,
    [id, asOf],
  );
  view.custom = Object.fromEntries(custom.map((c) => [c.key, c.value]));
  return view;
}

/** Removes fields the principal may not read (identically enforced for API and UI). */
export function filterFields(
  p: Principal,
  view: EmployeeView,
  target: Target,
  extraAlways: string[] = [],
): EmployeeView {
  const out: EmployeeView = { id: view.id };
  for (const [k, v] of Object.entries(view)) {
    if (k === 'id' || extraAlways.includes(k)) {
      out[k] = v;
      continue;
    }
    if (k === 'custom' && v && typeof v === 'object') {
      const allowed: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v))
        if (fieldAccess(p, 'employee', `custom.${ck}`, target) !== 'none') allowed[ck] = cv;
      if (Object.keys(allowed).length) out.custom = allowed;
      continue;
    }
    if (fieldAccess(p, 'employee', permKeyFor(k), target) !== 'none') out[k] = v;
  }
  return out;
}

export async function history(tx: Tx, id: string) {
  const out: Record<string, unknown[]> = {};
  for (const [section, table] of Object.entries(SECTION_TABLE)) {
    out[section] = await tx.query(`SELECT * FROM ${table} WHERE employee_id = $1 ORDER BY valid_from`, [id]);
  }
  out.reporting = await tx.query(
    `SELECT r.*, m.display_name AS manager_name FROM app.reporting_lines r JOIN app.employees m ON m.tenant_id = r.tenant_id AND m.id = r.manager_id WHERE r.employee_id = $1 ORDER BY valid_from`,
    [id],
  );
  out.emergencyContacts = await tx.query(
    `SELECT id, name, relationship, phone, email, priority, CASE WHEN valid_from = '-infinity' THEN NULL ELSE valid_from END AS valid_from, valid_to
       FROM app.emergency_contacts WHERE employee_id = $1 ORDER BY valid_from, priority`,
    [id],
  );
  return out;
}

// ---- Emergency contacts (effective-dated list; each priority slot holds one contact at a time) --------

export interface ContactInput {
  name: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  priority?: number;
}

const CONTACT_COLUMNS = `id, name, relationship, phone, email, priority,
  CASE WHEN valid_from = '-infinity' THEN NULL ELSE valid_from END AS "validFrom", valid_to AS "validTo"`;

export async function contactsAsOf(tx: Tx, employeeId: string, date: string) {
  return tx.query(
    `SELECT ${CONTACT_COLUMNS} FROM app.emergency_contacts
      WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY priority`,
    [employeeId, date],
  );
}

/**
 * Replaces the contact list in force from `date`: contacts covering `date` are closed on it (or
 * replaced when they start on it), the new list runs until the next future-dated list, if any.
 */
export async function replaceContacts(
  tx: Tx,
  employeeId: string,
  date: string,
  contacts: ContactInput[],
  actor: string | null,
) {
  const rows = contacts.map((c, i) => ({ ...c, priority: c.priority ?? i + 1 }));
  const priorities = rows.map((r) => r.priority);
  if (new Set(priorities).size !== priorities.length)
    throw new ApiError('validation', 'Each contact needs a different priority');
  const next = await tx.maybe<{ valid_from: string | null }>(
    `SELECT min(valid_from)::text AS valid_from FROM app.emergency_contacts WHERE employee_id = $1 AND valid_from > $2`,
    [employeeId, date],
  );
  await tx.exec(`DELETE FROM app.emergency_contacts WHERE employee_id = $1 AND valid_from = $2`, [
    employeeId,
    date,
  ]);
  await tx.exec(
    `UPDATE app.emergency_contacts SET valid_to = $2 WHERE employee_id = $1 AND valid_from < $2 AND (valid_to IS NULL OR valid_to > $2)`,
    [employeeId, date],
  );
  for (const c of rows) {
    await tx.exec(
      `INSERT INTO app.emergency_contacts (tenant_id, employee_id, name, relationship, phone, email, priority, valid_from, valid_to, created_by)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        employeeId,
        c.name,
        c.relationship ?? null,
        c.phone ?? null,
        c.email ?? null,
        c.priority,
        date,
        next?.valid_from ?? null,
        actor,
      ],
    );
  }
}

// ---- Writing -------------------------------------------------------------------------------

function toColumns(values: Record<string, unknown>) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(values)) {
    const def = FIELDS[k];
    if (!def) continue;
    if (def.enum && v !== null && !def.enum.includes(String(v)))
      throw new ApiError('validation', `Invalid ${k}`);
    if (def.type === 'uuid' && v !== null && !UUID.test(String(v)))
      throw new ApiError('validation', `Invalid ${k}`);
    cols.push(def.column);
    vals.push(def.type === 'json' && v !== null ? JSON.stringify(v) : v);
  }
  return { cols, vals };
}

/**
 * Applies an effective-dated change to one section. The record covering `date` is split at `date`;
 * the new record inherits unchanged values and runs until the old record's end, so later future-dated
 * records are preserved. A change on the record's own start date is a correction (update in place).
 */
export async function applySectionChange(
  tx: Tx,
  employeeId: string,
  section: Exclude<Section, 'core'>,
  date: string,
  values: Record<string, unknown>,
  actor: string | null,
) {
  const table = SECTION_TABLE[section];
  const current = await tx.maybe<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR UPDATE`,
    [employeeId, date],
  );
  const { cols, vals } = toColumns(values);
  if (!cols.length) return;
  if (current && current.valid_from === date) {
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await tx.exec(`UPDATE ${table} SET ${sets} WHERE id = $1`, [current.id, ...vals]);
    return;
  }
  const next = await tx.maybe<{ valid_from: string }>(
    `SELECT min(valid_from)::text AS valid_from FROM ${table} WHERE employee_id = $1 AND valid_from > $2`,
    [employeeId, date],
  );
  let base: Record<string, unknown> = {};
  let validTo: string | null = next?.valid_from ?? null;
  if (current) {
    validTo = current.valid_to as string | null;
    await tx.exec(`UPDATE ${table} SET valid_to = $2 WHERE id = $1`, [current.id, date]);
    base = Object.fromEntries(
      Object.entries(FIELDS)
        .filter(([, d]) => d.section === section)
        .map(([k, d]) => [
          k,
          d.type === 'json' && current[d.column] !== null ? current[d.column] : current[d.column],
        ]),
    );
  } else {
    const missing = REQUIRED[section].filter((f) => values[f] === undefined || values[f] === null);
    if (missing.length) throw new ApiError('validation', `Missing ${missing.join(', ')}`);
  }
  // Propagate the changed fields into later (future-dated) records that still carried the old value;
  // fields a later record changes explicitly are left alone.
  if (current) {
    for (const [field, value] of Object.entries(values)) {
      const def = FIELDS[field];
      if (!def || def.section !== section) continue;
      const v = def.type === 'json' && value !== null ? JSON.stringify(value) : value;
      const old =
        def.type === 'json' && base[field] !== null && base[field] !== undefined
          ? JSON.stringify(base[field])
          : base[field];
      await tx.exec(
        `UPDATE ${table} SET ${def.column} = $3 WHERE employee_id = $1 AND valid_from > $2 AND ${def.column} IS NOT DISTINCT FROM $4${def.type === 'json' ? '::jsonb' : ''}`,
        [employeeId, date, v, old ?? null],
      );
    }
  }
  const merged = toColumns({ ...base, ...values });
  const placeholders = merged.vals.map((_, i) => `$${i + 5}`).join(', ');
  await tx.exec(
    `INSERT INTO ${table} (tenant_id, employee_id, valid_from, valid_to, created_by${merged.cols.length ? ', ' + merged.cols.join(', ') : ''})
     VALUES (app.current_tenant(), $1, $2, $3, $4${merged.vals.length ? ', ' + placeholders : ''})`,
    [employeeId, date, validTo, actor, ...merged.vals],
  );
}

/** Rejects reporting cycles: the new manager must not be the employee or anywhere below them. */
export async function assertNoCycle(tx: Tx, employeeId: string, managerId: string) {
  if (employeeId === managerId) throw new ApiError('unprocessable', 'An employee cannot manage themselves');
  const cycle = await tx.maybe(
    `WITH RECURSIVE up AS (
       SELECT id, manager_id, 0 AS d FROM app.employees WHERE id = $1
       UNION ALL SELECT e.id, e.manager_id, up.d + 1 FROM app.employees e JOIN up ON e.id = up.manager_id WHERE up.d < 100
     ) SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
    [managerId, employeeId],
  );
  if (cycle) throw new ApiError('unprocessable', 'This would create a reporting cycle');
}

export async function setManager(
  tx: Tx,
  employeeId: string,
  managerId: string | null,
  date: string,
  kind: 'solid' | 'dotted' | 'matrix',
  actor: string | null,
) {
  if (managerId) {
    const exists = await tx.maybe('SELECT 1 FROM app.employees WHERE id = $1', [managerId]);
    if (!exists) throw new ApiError('validation', 'Unknown manager');
    if (kind === 'solid') await assertNoCycle(tx, employeeId, managerId);
  }
  if (kind === 'solid') {
    const cur = await tx.maybe<{ id: string; valid_from: string; valid_to: string | null }>(
      `SELECT id, valid_from::text, valid_to::text FROM app.reporting_lines WHERE employee_id = $1 AND kind = 'solid' AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) FOR UPDATE`,
      [employeeId, date],
    );
    const next = await tx.maybe<{ valid_from: string | null }>(
      `SELECT min(valid_from)::text AS valid_from FROM app.reporting_lines WHERE employee_id = $1 AND kind = 'solid' AND valid_from > $2`,
      [employeeId, date],
    );
    if (cur) {
      if (cur.valid_from === date) await tx.exec('DELETE FROM app.reporting_lines WHERE id = $1', [cur.id]);
      else await tx.exec('UPDATE app.reporting_lines SET valid_to = $2 WHERE id = $1', [cur.id, date]);
    }
    if (managerId) {
      await tx.exec(
        `INSERT INTO app.reporting_lines (tenant_id, employee_id, manager_id, kind, valid_from, valid_to, created_by) VALUES (app.current_tenant(), $1, $2, 'solid', $3, $4, $5)`,
        [employeeId, managerId, date, cur?.valid_to ?? next?.valid_from ?? null, actor],
      );
    }
  } else if (managerId) {
    await tx.exec(
      `INSERT INTO app.reporting_lines (tenant_id, employee_id, manager_id, kind, valid_from, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5)`,
      [employeeId, managerId, kind, date, actor],
    );
  }
}

export async function setCustomFields(
  tx: Tx,
  employeeId: string,
  values: Record<string, unknown>,
  date: string,
  actor: string | null,
) {
  for (const [key, value] of Object.entries(values)) {
    const def = await tx.maybe<{
      id: string;
      field_type: string;
      options: Array<{ value: string }>;
      required: boolean;
      validation: { min?: number; max?: number; pattern?: string };
      effective_dated: boolean;
    }>(
      `SELECT id, field_type, options, required, validation, effective_dated FROM app.custom_field_definitions WHERE entity_type = 'employee' AND key = $1 AND NOT archived`,
      [key],
    );
    if (!def) throw new ApiError('validation', `Unknown custom field ${key}`);
    validateCustomValue(def, value, key);
    if (def.field_type === 'file' && value) {
      // A file field points at an uploaded document about this person (or a company-wide document).
      const doc = await tx.maybe(
        `SELECT 1 FROM app.documents WHERE id = $1 AND status = 'ready' AND (employee_id = $2 OR employee_id IS NULL)`,
        [(value as { documentId: string }).documentId, employeeId],
      );
      if (!doc) throw new ApiError('validation', `Invalid value for ${key}`);
    }
    const from = def.effective_dated ? date : '-infinity';
    await tx.exec(
      `DELETE FROM app.custom_field_values WHERE field_id = $1 AND record_id = $2 AND valid_from = $3::date`,
      [def.id, employeeId, from],
    );
    if (def.effective_dated) {
      await tx.exec(
        `UPDATE app.custom_field_values SET valid_to = $3 WHERE field_id = $1 AND record_id = $2 AND valid_from < $3 AND (valid_to IS NULL OR valid_to > $3)`,
        [def.id, employeeId, date],
      );
    }
    if (value !== null && value !== undefined) {
      await tx.exec(
        `INSERT INTO app.custom_field_values (tenant_id, field_id, record_id, value, valid_from, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4::date, $5)`,
        [def.id, employeeId, JSON.stringify(value), from, actor],
      );
    }
  }
}

export function validateCustomValue(
  def: {
    field_type: string;
    options: Array<{ value: string }>;
    required: boolean;
    validation: { min?: number; max?: number; pattern?: string };
  },
  value: unknown,
  key: string,
) {
  const bad = () => {
    throw new ApiError('validation', `Invalid value for ${key}`);
  };
  if (value === null || value === undefined) return def.required ? bad() : undefined;
  const opts = (def.options ?? []).map((o) => o.value);
  switch (def.field_type) {
    case 'text':
      if (
        typeof value !== 'string' ||
        (def.validation.pattern && !new RegExp(def.validation.pattern).test(value))
      )
        bad();
      break;
    case 'number':
      if (
        typeof value !== 'number' ||
        (def.validation.min !== undefined && value < def.validation.min) ||
        (def.validation.max !== undefined && value > def.validation.max)
      )
        bad();
      break;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') bad();
      break;
    case 'select':
      if (typeof value !== 'string' || !opts.includes(value)) bad();
      break;
    case 'multi_select':
      if (!Array.isArray(value) || value.some((v) => !opts.includes(v))) bad();
      break;
    case 'currency': {
      const m = value as { amountMinor?: unknown; currency?: unknown };
      if (
        typeof m !== 'object' ||
        !Number.isInteger(m.amountMinor) ||
        typeof m.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(m.currency)
      )
        bad();
      break;
    }
    case 'file':
      if (
        typeof value !== 'object' ||
        !UUID.test(String((value as { documentId?: unknown }).documentId ?? ''))
      )
        bad();
      break;
  }
}

/** Every field the caller wants to write must be writable for this target (deny by default). */
export function assertWritable(p: Principal, fields: string[], target: Target) {
  const denied = fields.filter(
    (f) => fieldAccess(p, 'employee', f.startsWith('custom.') ? f : permKeyFor(f), target) !== 'write',
  );
  if (denied.length) throw new ApiError('forbidden', `Not allowed to change: ${denied.join(', ')}`);
}

export interface ChangeInput {
  effectiveDate: string;
  managerId?: string | null;
  custom?: Record<string, unknown>;
  reassignReportsTo?: string;
  reason?: string;
  [field: string]: unknown;
}

/** Applies an employee change (permissions already checked) and returns the before/after diff. */
export async function applyEmployeeChange(
  tx: Tx,
  id: string,
  b: ChangeInput,
  actor: string | null,
  topic = 'employee.changed',
) {
  const fields = Object.keys(b).filter((k) => k in FIELDS);
  const before = await employeeAsOf(tx, id, b.effectiveDate);
  for (const f of fields.filter((x) => FIELDS[x]!.section === 'core'))
    await tx.exec(`UPDATE app.employees SET ${FIELDS[f]!.column} = $2 WHERE id = $1`, [id, b[f]]);
  const sections = sectionsOf(b);
  for (const s of ['personal', 'job', 'pay', 'contract'] as const) {
    if (sections[s]) await applySectionChange(tx, id, s, b.effectiveDate, sections[s]!, actor);
  }
  if (b.managerId !== undefined) await setManager(tx, id, b.managerId, b.effectiveDate, 'solid', actor);
  if (b.custom) await setCustomFields(tx, id, b.custom, b.effectiveDate, actor);
  if (b.reassignReportsTo) {
    const reports = await tx.query<{ id: string }>('SELECT id FROM app.employees WHERE manager_id = $1', [
      id,
    ]);
    for (const r of reports) await setManager(tx, r.id, b.reassignReportsTo, b.effectiveDate, 'solid', actor);
  }
  await refreshCurrent(tx, id);
  const after = await employeeAsOf(tx, id, b.effectiveDate);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of [...fields, 'managerId'])
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      diff[k] = { from: before[k] ?? null, to: after[k] ?? null };
  const customBefore = (before.custom ?? {}) as Record<string, unknown>;
  const customAfter = (after.custom ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(b.custom ?? {})) {
    if (JSON.stringify(customBefore[k]) !== JSON.stringify(customAfter[k]))
      diff[`custom.${k}`] = { from: customBefore[k] ?? null, to: customAfter[k] ?? null };
  }
  await recordChangeEvent(tx, id, topic, { effectiveDate: b.effectiveDate, fields: Object.keys(diff) });
  return diff;
}

export async function refreshCurrent(tx: Tx, employeeId: string | null) {
  await tx.query('SELECT app.refresh_employee_current($1)', [employeeId]);
}

/** Refreshes the current values of many employees (one linear statement; keep batches to a few thousand). */
export async function refreshCurrentMany(tx: Tx, employeeIds: string[]) {
  if (employeeIds.length) await tx.query('SELECT app.refresh_employees_current($1::uuid[])', [employeeIds]);
}

export async function recordChangeEvent(
  tx: Tx,
  employeeId: string,
  topic: string,
  payload: Record<string, unknown>,
) {
  await emitEvent(tx, topic, { employeeId, ...payload }, { type: 'employee', id: employeeId });
}

export { sectionsOf };
