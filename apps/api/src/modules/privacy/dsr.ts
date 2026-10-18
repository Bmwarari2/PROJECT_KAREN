import { REGIONS, type HomeRegion } from '@thapsus/core';
import { t, type Locale } from '@thapsus/core/i18n';
import { compareDates, instantToDate } from '@thapsus/core/time';
import { dsrDeadline, privacyJurisdiction, retentionDecision, retentionRules, RETENTION_CATEGORIES, type DsrKind, type RetentionCategory, type RuleBook, type RuleRef } from '@thapsus/rules';
import { writeAudit, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { loadTarget } from '../employees/service';
import { renderTextPdf, sha256 } from '../documents/pdf';
import { Vault, type VaultActor } from '../vault/service';
import { SECRET_COLUMN, SUBJECT_TABLES, type TableRule } from './subject-map';

export interface DsrRow {
  id: string;
  kind: DsrKind;
  status: string;
  subject_employee_id: string | null;
  subject_user_id: string | null;
  jurisdiction: string;
  received_on: string;
  information_received_on: string | null;
  paused_days: number;
  due_on: string | null;
  extended: boolean;
  extended_due_on: string | null;
  extension_reason: string | null;
  rule: RuleRef | null;
  identity_verified_at: string | null;
  identity_method: string | null;
  identity_note: string | null;
  requester_relationship: string;
  channel: string;
  details: string | null;
  correction: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  rejection_reason: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Subject {
  employeeId: string | null;
  userId: string | null;
  displayName: string | null;
  startDate: string | null;
  endDate: string | null;
  jurisdiction: string;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export async function homeRegion(tx: Tx): Promise<HomeRegion> {
  return (await tx.one<{ home_region: HomeRegion }>('SELECT home_region FROM app.tenants WHERE tenant_id = app.current_tenant()')).home_region;
}

/** Finds the person (employee and/or user account) and the jurisdiction whose privacy law applies. */
export async function resolveSubject(tx: Tx, ref: { employeeId?: string | null; userId?: string | null }): Promise<Subject> {
  let employeeId = ref.employeeId ?? null;
  let userId = ref.userId ?? null;
  if (employeeId && !userId) userId = (await tx.maybe<{ id: string }>('SELECT id FROM app.users WHERE employee_id = $1 ORDER BY created_at LIMIT 1', [employeeId]))?.id ?? null;
  if (userId && !employeeId) {
    const u = await tx.maybe<{ employee_id: string | null }>('SELECT employee_id FROM app.users WHERE id = $1', [userId]);
    if (!u) throw new ApiError('notFound');
    employeeId = u.employee_id;
  }
  const e = employeeId
    ? await tx.maybe<{ display_name: string | null; start_date: string; end_date: string | null; country: string | null; region_code: string | null; le_country: string | null; le_region: string | null }>(
        `SELECT e.display_name, e.start_date, e.end_date, e.country, e.region_code, le.country AS le_country, le.region_code AS le_region
           FROM app.employees e LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.entity_id WHERE e.id = $1`,
        [employeeId],
      )
    : undefined;
  if (employeeId && !e) throw new ApiError('notFound');
  const regime = REGIONS[await homeRegion(tx)].jurisdiction;
  const displayName = e?.display_name ?? (userId ? (await tx.maybe<{ display_name: string }>('SELECT display_name FROM app.users WHERE id = $1', [userId]))?.display_name ?? null : null);
  return {
    employeeId,
    userId,
    displayName,
    startDate: e?.start_date ?? null,
    endDate: e?.end_date ?? null,
    jurisdiction: privacyJurisdiction(e?.country ?? e?.le_country, e?.region_code ?? e?.le_region, regime),
  };
}

/** Deadline columns for a request under the law in force on its receipt date (null when no law applies). */
export function deadlineColumns(book: RuleBook, r: Pick<DsrRow, 'jurisdiction' | 'kind' | 'received_on' | 'information_received_on' | 'paused_days' | 'extended'>) {
  const d = dsrDeadline(book, r.jurisdiction, r.kind, { receivedOn: r.received_on, informationReceivedOn: r.information_received_on, pausedDays: r.paused_days });
  if (!d || !d.applies) return { due_on: null, extended_due_on: null, rule: d?.rule ?? null, extensionAllowed: false, extensionNoticeBy: null as string | null };
  return { due_on: d.dueOn, extended_due_on: d.extendedDueOn, rule: d.rule, extensionAllowed: !!d.extendedDueOn, extensionNoticeBy: d.extensionNoticeBy };
}

export const effectiveDue = (r: Pick<DsrRow, 'due_on' | 'extended' | 'extended_due_on'>) => (r.extended && r.extended_due_on ? r.extended_due_on : r.due_on);

// ---- Access export ---------------------------------------------------------------------------------------
export interface ExportResult {
  json: Buffer;
  pdf: Uint8Array;
  summary: { tables: Record<string, number>; sensitiveValues: number; withheldCategories: string[]; activity: number; auditEvents: number };
}

function idsFor(rule: TableRule, s: Subject): Array<{ column: string; id: string }> {
  return rule.subject.flatMap((l) => {
    const id = l.kind === 'employee' ? s.employeeId : s.userId;
    return id ? [{ column: l.column, id }] : [];
  });
}

/**
 * Builds the machine-readable access export: every row in every tenant table that identifies the
 * person (credentials omitted), decrypted vault values (each decrypt audited), counts of records the
 * person created about others, and the person's audit trail metadata.
 */
export async function buildAccessExport(tx: Tx, o: { vault: Vault; actor: VaultActor; tenantId: string; request: DsrRow; locale: Locale; now: Date }): Promise<ExportResult> {
  const s = await resolveSubject(tx, { employeeId: o.request.subject_employee_id, userId: o.request.subject_user_id });
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const activity: Array<{ table: string; column: string; count: number }> = [];
  const excluded: Record<string, string> = {};
  for (const [table, rule] of Object.entries(SUBJECT_TABLES)) {
    if (table === 'vault.records' || table === 'audit.events') continue;
    const links = idsFor(rule, s);
    if (links.length) {
      const where = links.map((l, i) => `${q(l.column)} = $${i + 1}`).join(' OR ');
      const rows = await tx.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where} ORDER BY 1, 2`, links.map((l) => l.id));
      const omit = new Set([...(rule.omit ?? []), 'tenant_id', 'search']);
      tables[table] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.has(k) && !SECRET_COLUMN.test(k))));
    } else if (!rule.subject.length && 'keep' in rule.erase) excluded[table] = rule.erase.keep;
    for (const column of rule.actor ?? []) {
      const id = column === 'manager_id' ? s.employeeId : s.userId;
      if (!id) continue;
      const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${q(column)} = $1`, [id]);
      if (n.n) activity.push({ table, column, count: n.n });
    }
  }
  const sensitive = s.employeeId ? await o.vault.exportSubject(tx, o.actor, o.tenantId, await loadTarget(tx, s.employeeId), { purpose: 'dsr_access_export', requestId: o.request.id }) : { values: [], withheld: [] };
  const actions = s.userId ? await tx.query(`SELECT at, action, target_type AS "targetType", ip, user_agent AS "userAgent" FROM audit.events WHERE actor_id = $1 ORDER BY id LIMIT 20000`, [s.userId]) : [];
  const about = s.employeeId ? await tx.query(`SELECT at, action, actor_type AS "actorType" FROM audit.events WHERE target_id = $1 ORDER BY id LIMIT 20000`, [s.employeeId]) : [];
  const generatedAt = o.now.toISOString();
  const doc = {
    format: 'thapsus-hr.subject-access-export',
    formatVersion: 1,
    generatedAt,
    request: { id: o.request.id, kind: o.request.kind, receivedOn: o.request.received_on, jurisdiction: o.request.jurisdiction, rule: o.request.rule },
    subject: { employeeId: s.employeeId, userId: s.userId },
    tables,
    sensitive,
    activity,
    auditTrail: { actionsByYou: actions, actionsAboutYou: about },
    coverage: { tables: Object.keys(tables), excluded, note: 'Credentials and encryption material are never exported.' },
  };
  const json = Buffer.from(JSON.stringify(doc, null, 2));
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  const L = (k: string, v?: Record<string, string | number>) => t(o.locale, `privacy.exportPdf.${k}`, v);
  const lines = [
    L('intro', { name: s.displayName ?? '—' }),
    '',
    `${L('reference')}: ${o.request.id}`,
    `${L('received')}: ${o.request.received_on}`,
    `${L('generated')}: ${generatedAt}`,
    `${L('jurisdiction')}: ${o.request.jurisdiction}`,
    '',
    L('categoriesHeading'),
    ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `- ${L(`table.${k.replace('.', '_')}`)}: ${n}`),
    '',
    L('sensitiveHeading'),
    sensitive.values.length ? [...new Set(sensitive.values.map((v) => v.category))].map((c) => `- ${L(`vault.${c}`)}: ${sensitive.values.filter((v) => v.category === c).length}`).join('\n') : L('none'),
    ...(sensitive.withheld.length ? ['', L('withheld', { categories: sensitive.withheld.join(', ') })] : []),
    '',
    `${L('activity')}: ${activity.reduce((a, b) => a + b.count, 0)}`,
    `${L('audit')}: ${actions.length + about.length}`,
    '',
    L('machineReadable', { sha256: sha256(json) }),
  ];
  const pdf = await renderTextPdf(L('title'), lines.join('\n'));
  return { json, pdf, summary: { tables: counts, sensitiveValues: sensitive.values.length, withheldCategories: sensitive.withheld, activity: activity.length, auditEvents: actions.length + about.length } };
}

// ---- Erasure ----------------------------------------------------------------------------------------------
/** Latest record date per retention category for one employee (what a statutory clock runs from). */
const LATEST_RECORD: Partial<Record<RetentionCategory, string>> = {
  time_records: `SELECT max(d) AS d FROM (SELECT max(occurred_at)::date AS d FROM app.clock_events WHERE employee_id = $1 UNION ALL SELECT max(week_start) FROM app.timesheets WHERE employee_id = $1 UNION ALL SELECT max(shift_date) FROM app.shifts WHERE employee_id = $1) x`,
  leave_records: `SELECT max(d) AS d FROM (SELECT max(end_date) AS d FROM app.leave_requests WHERE employee_id = $1 UNION ALL SELECT max(effective_date) FROM app.leave_adjustments WHERE employee_id = $1 UNION ALL SELECT max(start_date) FROM app.fmla_cases WHERE employee_id = $1) x`,
  sickness_records: `SELECT max(coalesce(end_date, start_date)) AS d FROM app.sickness_records WHERE employee_id = $1`,
  payroll_records: `SELECT max(coalesce(valid_to, $2::date)) AS d FROM app.employee_pay WHERE employee_id = $1`,
};

export interface ErasurePlan {
  holds: Array<{ id: string; category: string | null; reason: string }>;
  erase: string[];
  retain: Array<{ category: string; until: string | null; reason: 'legal_hold' | 'statutory_retention'; rules: RuleRef[] }>;
}

/** Which categories can be erased now and which must be kept (legal hold or statutory minimum). */
export async function erasurePlan(tx: Tx, book: RuleBook, s: Subject, today: string): Promise<ErasurePlan> {
  const holds = s.employeeId
    ? await tx.query<{ id: string; category: string | null; reason: string }>(`SELECT id, category, reason FROM app.legal_holds WHERE released_at IS NULL AND (employee_id = $1 OR employee_id IS NULL)`, [s.employeeId])
    : [];
  const plan: ErasurePlan = { holds, erase: [], retain: [] };
  const categories = [...new Set(Object.values(SUBJECT_TABLES).map((r) => r.category))];
  for (const category of categories) {
    if (category === 'accountability') continue;
    if (holds.some((h) => h.category === null || h.category === category)) {
      plan.retain.push({ category, until: null, reason: 'legal_hold', rules: [] });
      continue;
    }
    if ((RETENTION_CATEGORIES as readonly string[]).includes(category) && s.employeeId) {
      const rules = retentionRules(book, s.jurisdiction, category as RetentionCategory, today).filter((r) => r.value.statutoryMinimum);
      if (rules.length) {
        const sql = LATEST_RECORD[category as RetentionCategory];
        const latest = sql ? ((await tx.one<{ d: string | null }>(sql, sql.includes('$2') ? [s.employeeId, today] : [s.employeeId])).d ?? null) : null;
        const recordDate = category === 'immigration_records' ? s.startDate ?? today : latest ?? (category === 'personnel_records' ? today : null);
        if (recordDate) {
          const d = retentionDecision(rules, { recordDate, employmentEnd: s.endDate });
          if (d.deletableFrom === null || compareDates(d.deletableFrom, today) > 0) {
            plan.retain.push({ category, until: d.deletableFrom, reason: 'statutory_retention', rules: rules.map((r) => r.rule) });
            continue;
          }
        }
      }
    }
    plan.erase.push(category);
  }
  return plan;
}

export interface ErasureReport {
  plan: ErasurePlan;
  rows: Record<string, number>;
  vault: Record<string, number>;
  fileKeys: string[];
}

/**
 * Applies erasure for the categories the plan allows: deletes or anonymises the person's rows per
 * SUBJECT_TABLES, erases vault values outside retained categories and returns object keys to remove
 * once the transaction commits. Retained categories are left untouched (Art. 17(3)(b), CCPA 1798.105(d)).
 */
export async function applyErasure(tx: Tx, o: { vault: Vault; actor: VaultActor; book: RuleBook; subject: Subject; today: string; requestId: string; onlyCategories?: string[] }): Promise<ErasureReport> {
  const s = o.subject;
  const plan = await erasurePlan(tx, o.book, s, o.today);
  const rows: Record<string, number> = {};
  const fileKeys: string[] = [];
  const erasing = new Set(plan.erase.filter((c) => !o.onlyCategories || o.onlyCategories.includes(c)));
  // Files first: document binaries and signed copies of documents that are being erased.
  if (s.employeeId && erasing.has('personnel_records')) {
    const docs = await tx.query<{ file_key: string | null }>(`SELECT file_key FROM app.documents WHERE employee_id = $1 AND category IS DISTINCT FROM 'immigration'`, [s.employeeId]);
    const signed = await tx.query<{ signed_file_key: string | null }>(`SELECT s.signed_file_key FROM app.signature_requests s WHERE s.signer_employee_id = $1`, [s.employeeId]);
    fileKeys.push(...docs.flatMap((d) => (d.file_key ? [d.file_key] : [])), ...signed.flatMap((d) => (d.signed_file_key ? [d.signed_file_key] : [])));
  }
  // Children before parents: the map is ordered so that user-scoped rows go before the user and the employee.
  const order = Object.entries(SUBJECT_TABLES).sort(([a], [b]) => rank(a) - rank(b));
  for (const [table, rule] of order) {
    if (table === 'vault.records' || 'keep' in rule.erase || !erasing.has(rule.category)) continue;
    const links = idsFor(rule, s);
    if (!links.length) continue;
    let where = links.map((l, i) => `${q(l.column)} = $${i + 1}`).join(' OR ');
    if (table === 'app.documents') where = `(${where}) AND category IS DISTINCT FROM 'immigration'`;
    const params = links.map((l) => l.id);
    if ('delete' in rule.erase) {
      rows[table] = await tx.exec(`DELETE FROM ${table} WHERE ${where}`, params);
    } else {
      const sets = Object.entries(rule.erase.anonymise).map(([col, v]) => {
        if (v === '=erased') return `${q(col)} = 'erased-' || left(id::text, 8)`;
        if (v === '=erased-email') return `${q(col)} = 'erased+' || id::text || '@erased.invalid'`;
        return v === null ? `${q(col)} = NULL` : `${q(col)} = ${tx.client.escapeLiteral(v)}`;
      });
      rows[table] = await tx.exec(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, params);
    }
  }
  // Immigration documents follow their own retention category.
  if (s.employeeId && erasing.has('immigration_records')) {
    const docs = await tx.query<{ file_key: string | null }>(`DELETE FROM app.documents WHERE employee_id = $1 AND category = 'immigration' RETURNING file_key`, [s.employeeId]);
    rows['app.documents'] = (rows['app.documents'] ?? 0) + docs.length;
    fileKeys.push(...docs.flatMap((d) => (d.file_key ? [d.file_key] : [])));
  }
  let vault: Record<string, number> = {};
  if (s.employeeId) {
    const keep = ['health', 'sickness', 'disability', 'diversity', 'eeo', 'immigration'].filter((c) => !erasing.has(vaultCategory(c)));
    const v = await o.vault.eraseSubject(tx, o.actor, s.employeeId, keep, { purpose: 'dsr_erasure', requestId: o.requestId });
    vault = v.byCategory;
    fileKeys.push(...v.fileKeys);
    if (erasing.has('personnel_records')) await tx.query('SELECT app.refresh_employee_current($1)', [s.employeeId]);
  }
  await writeAudit(tx, { actorType: o.actor.actorType, actorId: o.actor.principal.userId, action: 'privacy.erasure_applied', targetType: 'dsr_request', targetId: o.requestId, diff: { erasedCategories: plan.erase, retained: plan.retain.map((r) => ({ category: r.category, reason: r.reason, until: r.until })), rows }, sensitive: true, requestId: o.actor.requestId, ip: o.actor.ip });
  return { plan, rows, vault, fileKeys };
}

/** Vault categories map onto retention categories: sickness/health with sickness records, immigration with immigration records. */
function vaultCategory(c: string): string {
  if (c === 'sickness' || c === 'health') return 'sickness_records';
  if (c === 'immigration') return 'immigration_records';
  return 'personnel_records';
}

/** Deletion order: account artefacts, then other children, then the user, then the employee record itself. */
function rank(table: string): number {
  if (table === 'app.employees') return 3;
  if (table === 'app.users') return 2;
  if (table === 'app.employee_personal') return 1;
  return 0;
}

export function todayUtc(now: Date): string {
  return instantToDate(now.toISOString(), 'UTC');
}
