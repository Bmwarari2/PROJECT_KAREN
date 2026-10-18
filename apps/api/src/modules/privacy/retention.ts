import { REGIONS } from '@thapsus/core';
import { compareDates } from '@thapsus/core/time';
import { periodAtLeast, retentionDecision, retentionRules, RETENTION_CATEGORIES, type RetentionAnchor, type RetentionCategory, type RuleBook, type RuleRef } from '@thapsus/rules';
import type { Tx } from '@thapsus/db';
import type { Vault, VaultActor } from '../vault/service';
import { applyErasure, homeRegion, resolveSubject } from './dsr';

/**
 * Retention engine. For each data category the statutory minimum (packs, by the employee's
 * jurisdiction) and the tenant's own policy combine into an earliest deletion date per record; records
 * past it are deleted or anonymised, except where a legal hold applies. Each run writes a deletion log
 * row per category and jurisdiction: counts, cutoff and rule versions only — never personal data.
 */
interface Source {
  table: string;
  /** SQL for the record's date (the statutory clock), with t = the table and e = app.employees. */
  date: string;
  employee: string | null;
  where?: string;
  /** Extra cleanup after deletion, given the RETURNING rows. */
  returning?: string;
}

export const RETENTION_SOURCES: Record<RetentionCategory, Source[]> = {
  time_records: [
    { table: 'app.clock_events', date: `(t.occurred_at AT TIME ZONE 'UTC')::date`, employee: 'employee_id' },
    { table: 'app.timesheets', date: 't.week_start', employee: 'employee_id' },
    { table: 'app.shifts', date: 't.shift_date', employee: 'employee_id' },
  ],
  leave_records: [
    { table: 'app.leave_requests', date: 't.end_date', employee: 'employee_id' },
    { table: 'app.leave_adjustments', date: 't.effective_date', employee: 'employee_id' },
  ],
  sickness_records: [{ table: 'app.sickness_records', date: 'coalesce(t.end_date, t.start_date)', employee: 'employee_id', returning: 'fit_note_vault_id, reason_vault_id, rtw_vault_id' }],
  payroll_records: [{ table: 'app.employee_pay', date: 't.valid_to', employee: 'employee_id', where: 't.valid_to IS NOT NULL' }],
  immigration_records: [
    { table: 'app.documents', date: 'e.start_date', employee: 'employee_id', where: `t.category = 'immigration'`, returning: 'file_key' },
    { table: 'vault.records', date: 'e.start_date', employee: 'subject_id', where: `t.category = 'immigration'`, returning: 'file_key' },
  ],
  personnel_records: [{ table: 'app.employees', date: 'e.end_date', employee: 'id', where: `t.end_date IS NOT NULL AND t.employee_number NOT LIKE 'erased-%'` }],
  notifications: [{ table: 'app.notifications', date: `(t.created_at AT TIME ZONE 'UTC')::date`, employee: null }],
};

export interface TenantPolicy {
  category: RetentionCategory;
  jurisdiction: string;
  period: string | null;
  anchor: RetentionAnchor;
  action: 'delete' | 'anonymise';
  enabled: boolean;
}

export async function tenantPolicies(tx: Tx): Promise<TenantPolicy[]> {
  return tx.query<TenantPolicy>(`SELECT category, jurisdiction, period, anchor, action, enabled FROM app.retention_policies ORDER BY category, jurisdiction`);
}

const policyFor = (policies: TenantPolicy[], category: string, jurisdiction: string) =>
  policies.find((p) => p.category === category && p.jurisdiction === jurisdiction) ?? policies.find((p) => p.category === category && p.jurisdiction === '*');

/** Rejects a tenant period shorter than a statutory minimum the packs hold for that category. */
export function validatePolicy(book: RuleBook, p: { category: RetentionCategory; jurisdiction: string; period: string | null; anchor: RetentionAnchor }, jurisdictions: string[], today: string): string[] {
  if (!p.period) return [];
  const problems: string[] = [];
  for (const j of p.jurisdiction === '*' ? jurisdictions : [p.jurisdiction]) {
    for (const r of retentionRules(book, j, p.category, today)) {
      if (!r.value.statutoryMinimum) continue;
      const comparable = r.value.from === p.anchor || (r.value.from !== 'employment_end' && p.anchor === 'record_date');
      if (!comparable || !periodAtLeast(p.period, r.value.period) || (r.value.afterEmploymentEnds && !periodAtLeast(p.period, r.value.afterEmploymentEnds))) {
        problems.push(`${j}:${r.key}:${r.value.period}`);
      }
    }
  }
  return problems;
}

export interface RunLine {
  category: RetentionCategory;
  jurisdiction: string;
  action: 'delete' | 'anonymise' | 'retain';
  rows: number;
  files: number;
  cutoff: string | null;
  rules: RuleRef[];
  policy: { period: string | null; anchor: string } | null;
}

const JURISDICTION_SQL = `CASE WHEN e.country = 'US' AND e.region_code ~ '^US-[A-Z]{2}$' THEN e.region_code WHEN e.country IS NOT NULL THEN trim(e.country) ELSE $2 END`;

/**
 * Runs (or with dryRun, only measures) retention for the given categories. Without `force`, a category
 * is processed only when the tenant enabled its policy (automatic deletion is opt-in per category).
 */
export async function runRetention(
  tx: Tx,
  o: { book: RuleBook; today: string; dryRun: boolean; categories?: RetentionCategory[]; force?: boolean; vault: Vault; actor: VaultActor; deleteFiles: (keys: string[]) => void },
): Promise<RunLine[]> {
  const policies = await tenantPolicies(tx);
  const home = REGIONS[await homeRegion(tx)].jurisdiction;
  const homeJurisdiction = home === 'UK' ? 'GB' : home;
  const lines: RunLine[] = [];
  for (const category of o.categories ?? [...RETENTION_CATEGORIES]) {
    for (const src of RETENTION_SOURCES[category]) {
      const join = src.employee ? `JOIN app.employees e ON e.tenant_id = t.tenant_id AND e.id = t.${src.employee}` : `LEFT JOIN app.employees e ON false`;
      const hold = src.employee
        ? `AND NOT EXISTS (SELECT 1 FROM app.legal_holds h WHERE h.tenant_id = t.tenant_id AND h.released_at IS NULL AND (h.employee_id IS NULL OR h.employee_id = e.id) AND (h.category IS NULL OR h.category = $1))`
        : `AND NOT EXISTS (SELECT 1 FROM app.legal_holds h WHERE h.tenant_id = t.tenant_id AND h.released_at IS NULL AND h.employee_id IS NULL AND (h.category IS NULL OR h.category = $1))`;
      const base = `FROM ${src.table} t ${join} WHERE ${src.date} IS NOT NULL ${src.where ? `AND ${src.where}` : ''} ${hold}`;
      const groups = await tx.query<{ j: string; d: string; ee: string | null; n: number }>(
        `SELECT ${JURISDICTION_SQL} AS j, ${src.date} AS d, e.end_date AS ee, count(*)::int AS n ${base} GROUP BY 1, 2, 3`,
        [category, homeJurisdiction],
      );
      const byJ = new Map<string, { deletable: Array<{ d: string; ee: string | null }>; rows: number; cutoff: string | null; rules: RuleRef[]; policy: TenantPolicy | undefined }>();
      for (const g of groups) {
        let acc = byJ.get(g.j);
        if (!acc) {
          acc = { deletable: [], rows: 0, cutoff: null, rules: [], policy: policyFor(policies, category, g.j) };
          byJ.set(g.j, acc);
        }
        const rules = retentionRules(o.book, g.j, category, o.today);
        acc.rules = rules.map((r) => r.rule);
        const p = acc.policy;
        const tenant = p?.period ? { period: p.period, from: p.anchor } : null;
        if (!rules.length && !tenant) continue; // nothing says this may be deleted
        const decision = retentionDecision(rules, { recordDate: g.d, employmentEnd: g.ee }, tenant);
        if (decision.deletableFrom && compareDates(decision.deletableFrom, o.today) <= 0) {
          acc.deletable.push({ d: g.d, ee: g.ee });
          acc.rows += g.n;
          if (!acc.cutoff || compareDates(g.d, acc.cutoff) > 0) acc.cutoff = g.d;
        }
      }
      for (const [jurisdiction, acc] of byJ) {
        const enabled = !!acc.policy?.enabled || !!o.force;
        const action = category === 'personnel_records' ? 'anonymise' : (acc.policy?.action ?? 'delete');
        let rows = acc.rows;
        let files = 0;
        if (!o.dryRun && enabled && acc.deletable.length) {
          const match = `EXISTS (SELECT 1 FROM unnest($3::date[], $4::date[]) AS g(d, ee) WHERE g.d = ${src.date} AND g.ee IS NOT DISTINCT FROM e.end_date) AND ${JURISDICTION_SQL} = $5`;
          const params = [category, homeJurisdiction, acc.deletable.map((x) => x.d), acc.deletable.map((x) => x.ee), jurisdiction];
          if (category === 'personnel_records') {
            const ids = await tx.query<{ id: string }>(`SELECT t.id ${base} AND ${match}`, params);
            rows = 0;
            for (const { id } of ids) {
              const subject = await resolveSubject(tx, { employeeId: id });
              const r = await applyErasure(tx, { vault: o.vault, actor: o.actor, book: o.book, subject, today: o.today, requestId: `retention:${o.today}`, onlyCategories: ['personnel_records', 'contact', 'account', 'notifications'] });
              if (r.plan.erase.includes('personnel_records')) rows++;
              o.deleteFiles(r.fileKeys);
              files += r.fileKeys.length;
            }
          } else {
            const using = src.employee ? `USING app.employees e WHERE e.tenant_id = t.tenant_id AND e.id = t.${src.employee} AND` : `WHERE`;
            const where = `${src.date} IS NOT NULL ${src.where ? `AND ${src.where}` : ''} ${hold} AND ${src.employee ? match : `${src.date} = ANY($2::date[])`}`;
            const returning = src.returning ? src.returning.split(',').map((c) => `t.${c.trim()}`).join(', ') : 't.id';
            const deleted = await tx.query<Record<string, string | null>>(`DELETE FROM ${src.table} t ${using} ${where} RETURNING ${returning}`, src.employee ? params : [category, acc.deletable.map((x) => x.d)]);
            rows = deleted.length;
            const fileKeys = deleted.flatMap((r) => (r.file_key ? [r.file_key] : []));
            const vaultIds = deleted.flatMap((r) => [r.fit_note_vault_id, r.reason_vault_id, r.rtw_vault_id].filter((x): x is string => !!x));
            if (vaultIds.length) {
              const v = await tx.query<{ file_key: string | null }>(`DELETE FROM vault.records WHERE id = ANY($1::uuid[]) RETURNING file_key`, [vaultIds]);
              fileKeys.push(...v.flatMap((r) => (r.file_key ? [r.file_key] : [])));
            }
            o.deleteFiles(fileKeys);
            files = fileKeys.length;
          }
        }
        lines.push({
          category,
          jurisdiction,
          action: enabled || o.dryRun ? action : 'retain',
          rows: enabled || o.dryRun ? rows : 0,
          files,
          cutoff: acc.cutoff,
          rules: acc.rules,
          policy: acc.policy ? { period: acc.policy.period, anchor: acc.policy.anchor } : null,
        });
      }
    }
  }
  return lines;
}

/** Writes the deletion log (one row per category, jurisdiction and source table, counts only). */
export async function logRun(tx: Tx, lines: RunLine[], o: { trigger: 'schedule' | 'manual' | 'dsr'; dryRun: boolean; jobId?: string | null }) {
  for (const l of lines) {
    await tx.exec(
      `INSERT INTO app.retention_runs (tenant_id, job_id, trigger, dry_run, category, jurisdiction, action, rows_affected, files_deleted, cutoff, rule_versions, tenant_policy)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [o.jobId ?? null, o.trigger, o.dryRun, l.category, l.jurisdiction, l.action, l.rows, l.files, l.cutoff, JSON.stringify(l.rules.map((r) => ({ key: r.key, jurisdiction: r.jurisdiction, effectiveFrom: r.effectiveFrom, packVersion: r.packVersion, sourceUrl: r.source.url }))), l.policy ? JSON.stringify(l.policy) : null],
    );
  }
}
