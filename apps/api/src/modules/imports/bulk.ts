import type { Tx } from '@thapsus/db';
import { FIELDS, REQUIRED, SECTION_TABLE, type FieldDef } from '../employees/model';

/**
 * Set-based paths of the import job, so a 200,000-row file is a few statements per chunk instead of
 * a dozen per row. Anything they cannot handle safely is left to the per-row path, which applies the
 * same rules one record at a time and reports precise row errors.
 */
type Values = Record<string, unknown>;
type SectionName = keyof typeof SECTION_TABLE;
const SECTIONS = Object.keys(SECTION_TABLE) as SectionName[];

/** SQL array type for a field's column (as used by unnest). */
function sqlType(def: FieldDef): string {
  if (def.column === 'amount_minor') return 'bigint';
  if (def.column === 'notice_period_days') return 'int';
  return { text: 'text', date: 'date', uuid: 'uuid', number: 'numeric', json: 'jsonb', enum: 'text' }[def.type];
}

/** A new employee can be created in bulk when every section it touches has its required fields. */
export function bulkCreatable(v: Values): boolean {
  if (!v.startDate) return false;
  for (const s of SECTIONS) {
    const present = Object.keys(v).some((k) => FIELDS[k]?.section === s);
    if (present && REQUIRED[s].some((f) => v[f] === undefined || v[f] === null)) return false;
  }
  return true;
}

/**
 * Inserts new employees and their first effective-dated section records (from their start date).
 * Returns employee number → id. Throws on any constraint violation (the caller falls back per row).
 */
export async function bulkCreateEmployees(tx: Tx, rows: Values[], actor: string | null): Promise<Map<string, string>> {
  const inserted = await tx.query<{ id: string; employee_number: string }>(
    `INSERT INTO app.employees (tenant_id, employee_number, start_date, end_date, work_email, display_name)
     SELECT app.current_tenant(), u.* FROM unnest($1::text[], $2::date[], $3::date[], $4::text[], $5::text[]) AS u
     RETURNING id, employee_number`,
    [
      rows.map((v) => String(v.employeeNumber)),
      rows.map((v) => v.startDate),
      rows.map((v) => v.endDate ?? null),
      rows.map((v) => v.workEmail ?? null),
      rows.map((v) => `${v.preferredName ?? v.legalFirstName ?? ''} ${v.legalLastName ?? ''}`.trim()),
    ],
  );
  const ids = new Map(inserted.map((r) => [r.employee_number, r.id]));
  for (const s of SECTIONS) {
    // rows are grouped by the set of fields they carry, so absent columns keep their defaults
    const groups = new Map<string, Values[]>();
    for (const v of rows) {
      const fields = Object.keys(v).filter((k) => FIELDS[k]?.section === s).sort();
      if (!fields.length) continue;
      const key = fields.join(',');
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(v);
    }
    for (const [key, group] of groups) {
      const fields = key.split(',');
      const defs = fields.map((f) => FIELDS[f]!);
      const params: unknown[] = [group.map((v) => ids.get(String(v.employeeNumber))), group.map((v) => v.startDate)];
      for (const [i, def] of defs.entries()) params.push(group.map((v) => (def.type === 'json' && v[fields[i]!] !== null ? JSON.stringify(v[fields[i]!]) : v[fields[i]!])));
      const arrays = ['$1::uuid[]', '$2::date[]', ...defs.map((d, i) => `$${i + 3}::${sqlType(d)}[]`)].join(', ');
      params.push(actor);
      await tx.exec(
        `INSERT INTO ${SECTION_TABLE[s]} (tenant_id, created_by, employee_id, valid_from, ${defs.map((d) => d.column).join(', ')})
         SELECT app.current_tenant(), $${params.length}::uuid, u.* FROM unnest(${arrays}) AS u`,
        params,
      );
    }
  }
  return ids;
}

/** Section field values in force on `date` for many employees at once (field name → value). */
export async function currentSectionValues(tx: Tx, ids: string[], date: string): Promise<Map<string, Values>> {
  const out = new Map<string, Values>(ids.map((id) => [id, {}]));
  for (const s of SECTIONS) {
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT * FROM ${SECTION_TABLE[s]} WHERE employee_id = ANY($1::uuid[]) AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
      [ids, date],
    );
    for (const r of rows) {
      const target = out.get(String(r.employee_id))!;
      for (const [k, def] of Object.entries(FIELDS)) if (def.section === s) target[k] = r[def.column] ?? null;
    }
  }
  return out;
}

/** Same value as stored? Numbers compare numerically (30 = 30.00), JSON structurally, the rest as text. */
export function sameValue(field: string, stored: unknown, incoming: unknown): boolean {
  const def = FIELDS[field];
  if (stored === null || stored === undefined) return incoming === null || incoming === undefined || incoming === '';
  if (def?.type === 'number') return Number(stored) === Number(incoming);
  if (def?.type === 'json') return JSON.stringify(stored) === (typeof incoming === 'string' ? incoming : JSON.stringify(incoming));
  return String(stored) === String(incoming);
}

/**
 * Solid reporting lines for people who have none yet (typically just created by this import), in bulk.
 * Links that would form a cycle among themselves, or whose person already has a line, are returned
 * for the per-row path (which rejects cycles with an error and splits existing lines correctly).
 */
export async function bulkLinkManagers(tx: Tx, links: Array<{ employeeId: string; managerId: string; date: string }>, actor: string | null) {
  const withLines = new Set(
    (await tx.query<{ employee_id: string }>(`SELECT DISTINCT employee_id FROM app.reporting_lines WHERE employee_id = ANY($1::uuid[]) AND kind = 'solid'`, [links.map((l) => l.employeeId)])).map((r) => r.employee_id),
  );
  const candidates = links.filter((l) => !withLines.has(l.employeeId) && l.employeeId !== l.managerId);
  const next = new Map(candidates.map((l) => [l.employeeId, l.managerId]));
  // walk each manager chain through the new links; a chain that returns to a visited node is a cycle
  const cyclic = new Set<string>();
  const state = new Map<string, 'walking' | 'done'>();
  for (const start of next.keys()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur && next.has(cur) && state.get(cur) !== 'done') {
      if (state.get(cur) === 'walking') {
        for (const p of path.slice(path.indexOf(cur))) cyclic.add(p);
        break;
      }
      state.set(cur, 'walking');
      path.push(cur);
      cur = next.get(cur);
    }
    for (const p of path) state.set(p, 'done');
  }
  let bulk = candidates.filter((l) => !cyclic.has(l.employeeId));
  if (bulk.length) {
    await tx.exec('SAVEPOINT links');
    const args = [bulk.map((l) => l.employeeId), bulk.map((l) => l.managerId), bulk.map((l) => l.date)];
    await tx.exec(
      `INSERT INTO app.reporting_lines (tenant_id, employee_id, manager_id, kind, valid_from, created_by)
       SELECT app.current_tenant(), u.e, u.m, 'solid', u.d, $4::uuid FROM unnest($1::uuid[], $2::uuid[], $3::date[]) AS u(e, m, d)`,
      [...args, actor],
    );
    // keep the current manager (what cycle checks walk) up to date as lines are written
    await tx.exec(`UPDATE app.employees e SET manager_id = u.m FROM unnest($1::uuid[], $2::uuid[], $3::date[]) AS u(e, m, d) WHERE e.id = u.e AND u.d <= current_date`, args);
    // a chain through people who already had managers can still close a loop: check, and if so undo
    const loops = await tx.query(
      `WITH RECURSIVE up AS (
         SELECT e.id AS start, e.manager_id AS cur, 1 AS d FROM app.employees e WHERE e.id = ANY($1::uuid[])
         UNION ALL SELECT up.start, x.manager_id, up.d + 1 FROM up JOIN app.employees x ON x.id = up.cur WHERE up.d < 100 AND up.cur <> up.start
       ) SELECT 1 FROM up WHERE cur = start LIMIT 1`,
      [args[0]],
    );
    if (loops.length) {
      await tx.exec('ROLLBACK TO SAVEPOINT links');
      bulk = [];
    } else await tx.exec('RELEASE SAVEPOINT links');
  }
  const linked = new Set(bulk.map((l) => l.employeeId));
  return { linked: bulk.length, rest: links.filter((l) => !linked.has(l.employeeId)) };
}
