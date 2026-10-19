import { compareDates } from '@thapsus/core/time';
import { can, type Principal } from '@thapsus/core/permissions';
import { writeAudit, type Tx } from '@thapsus/db';
import type { RuleBook } from '@thapsus/rules';
import { ApiError } from '../../http/errors';
import { scopePredicate } from '../employees/service';
import type { Vault, VaultActor } from '../vault/service';
import {
  eeo1Aggregate,
  eeo1SnapshotWindow,
  genderPayGap,
  gpgDates,
  gpgHourlyRate,
  payTransparency,
  RATE_SCALE,
  type Eeo1Rule,
  type GpgEmployee,
  type GpgRule,
  type PayFrequency,
  type PayTransparencyRule,
  type PtWorker,
  type Sex,
} from './engine';
import { complianceSettings, EMPLOYEE_COLUMNS, EMPLOYEE_FROM, targetOf, type EmployeeRow } from './service';

/**
 * Statutory reporting datasets (UK gender pay gap, EEO-1 Component 1, EU pay transparency), shared by the
 * compliance centre endpoints and the ready-made reports (apps/api/src/modules/reports). Sex for pay
 * reporting and EEO-1 self-identification are decrypted from the vault through the Vault service (every
 * decrypt audited; 403 when the caller lacks vault.read:<category> for a subject) and only aggregates —
 * with small-cell suppression for EEO-1 — leave this module. Runs on the WRITER: vault reads write audit.
 */
export interface ComplianceReportCtx {
  tx: Tx;
  book: RuleBook;
  principal: Principal;
  tenantId: string;
  actor: VaultActor;
  vault: Vault;
}

export async function employeesIn(c: Pick<ComplianceReportCtx, 'tx' | 'principal'>, action: string, where: string, args: unknown[] = []) {
  const params = [...args];
  const scope = scopePredicate(c.principal, action, params);
  return c.tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${where} AND ${scope} ORDER BY e.display_name, e.id`, params);
}

/** Reads one vault field per employee; the reader must hold vault.read:<category> for every subject (403 otherwise). */
export async function vaultField(c: ComplianceReportCtx, emps: EmployeeRow[], category: 'diversity' | 'eeo', field: string) {
  const out = new Map<string, Record<string, string>>();
  for (const e of emps) {
    const fields = await c.vault.read(c.tx, c.actor, c.tenantId, targetOf(e), category);
    const f = fields.find((x) => x.field === field);
    if (f) out.set(e.id, JSON.parse(f.value) as Record<string, string>);
  }
  return out;
}

const audit = (c: ComplianceReportCtx, action: string, diff: Record<string, unknown>) =>
  writeAudit(c.tx, { actorType: c.actor.actorType, actorId: c.actor.principal.userId, action, targetType: 'compliance', diff, ip: c.actor.ip, requestId: c.actor.requestId, sensitive: true });

// ---- EEO-1 Component 1 -------------------------------------------------------------------------------
export async function eeo1Report(c: ComplianceReportCtx, q: { year: number; snapshotDate?: string; exact?: boolean }) {
  const rule = c.book.tryResolve<Eeo1Rule>('US', 'reporting.eeo1', `${q.year}-12-31`);
  if (!rule) throw new ApiError('unprocessable', 'No EEO-1 rule for that year');
  const window = eeo1SnapshotWindow(rule.value, q.year);
  const snapshot = q.snapshotDate ?? window.to;
  if (compareDates(snapshot, window.from) < 0 || compareDates(snapshot, window.to) > 0) throw new ApiError('unprocessable', 'The snapshot date must fall in the workforce snapshot window', window);
  const settings = await complianceSettings(c.tx);
  const emps = await employeesIn(c, 'compliance.reports', `coalesce(e.country, fl.country, le.country) = 'US' AND e.start_date <= $1 AND (e.end_date IS NULL OR e.end_date >= $1)`, [snapshot]);
  const jobs = new Map((await c.tx.query<{ job_title: string; category: string }>('SELECT job_title, category FROM app.eeo_job_categories')).map((m) => [m.job_title, m.category]));
  const selfId = await vaultField(c, emps, 'eeo', 'self_identification');
  const result = eeo1Aggregate(rule.value, emps.map((e) => ({ jobCategory: e.job_title ? (jobs.get(e.job_title) ?? null) : null, raceEthnicity: selfId.get(e.id)?.raceEthnicity ?? null, sex: selfId.get(e.id)?.sex ?? null })), { k: settings.smallCellThreshold, exact: q.exact === true && can(c.principal, 'compliance.reports_exact') });
  await audit(c, 'compliance.eeo1_report_viewed', { year: q.year, snapshot, employees: emps.length, exact: result.suppressionThreshold === null });
  return { year: q.year, snapshotDate: snapshot, window, ...result, rule: rule.value, source: rule.source, verifiedOn: rule.verifiedOn };
}

// ---- UK gender pay gap --------------------------------------------------------------------------------
export async function genderPayGapReport(c: ComplianceReportCtx, q: { year: number; sector?: 'privateAndVoluntary' | 'publicAuthority'; entityId?: string }) {
  const settings = await complianceSettings(c.tx);
  const sector = q.sector ?? settings.gpgSector;
  const probe = c.book.tryResolve<GpgRule & Parameters<typeof gpgDates>[0]>('GB', 'reporting.gender_pay_gap', `${q.year}-12-31`);
  if (!probe) throw new ApiError('unprocessable', 'No gender pay gap rule for that year');
  const { snapshotDate, deadline } = gpgDates(probe.value, q.year, sector);
  const rule = c.book.resolve<GpgRule & Parameters<typeof gpgDates>[0]>('GB', 'reporting.gender_pay_gap', snapshotDate);
  const territory = (rule.value as { territory?: string[] }).territory ?? [];
  const args: unknown[] = [snapshotDate];
  let where = `coalesce(e.country, fl.country, le.country) = 'GB' AND e.start_date <= $1 AND (e.end_date IS NULL OR e.end_date >= $1)`;
  if (q.entityId) {
    args.push(q.entityId);
    where += ` AND coalesce(e.entity_id, fj.entity_id) = $2`;
  }
  const emps = (await employeesIn(c, 'compliance.reports', where, args)).filter((e) => !e.region_code || territory.length === 0 || territory.includes(e.region_code) || !e.region_code.startsWith('GB-'));
  const inputs = new Map((await c.tx.query<{ employee_id: string; ordinary_pay_minor: string; bonus_in_period_minor: string; pay_period_days: string | null; weekly_hours: string | null; bonus_12_months_minor: string; full_pay: boolean }>(`SELECT * FROM app.pay_report_inputs WHERE report_kind = 'uk_gpg' AND snapshot_date = $1`, [snapshotDate])).map((r) => [r.employee_id, r]));
  const pay = new Map((await c.tx.query<{ employee_id: string; amount_minor: string; frequency: PayFrequency }>(`SELECT employee_id, amount_minor, frequency FROM app.employee_pay WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [snapshotDate])).map((r) => [r.employee_id, r]));
  const hours = new Map((await c.tx.query<{ employee_id: string; weekly_hours: string | null }>(`SELECT employee_id, weekly_hours FROM app.employee_jobs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [snapshotDate])).map((r) => [r.employee_id, r.weekly_hours]));
  const sexes = await vaultField(c, emps, 'diversity', 'pay_reporting');
  const dataSource = inputs.size ? ('pay_report_inputs' as const) : ('employee_pay' as const);
  const rows: GpgEmployee[] = [];
  for (const e of emps) {
    const s = sexes.get(e.id)?.sex;
    const sex: Sex | null = s === 'male' || s === 'female' ? s : null;
    const inp = inputs.get(e.id);
    if (inp) {
      const wh = Number(inp.weekly_hours ?? hours.get(e.id) ?? 0);
      const rate = wh > 0 ? gpgHourlyRate(rule.value, { ordinaryPayMinor: Number(inp.ordinary_pay_minor), bonusInPeriodMinor: Number(inp.bonus_in_period_minor), period: inp.pay_period_days ? { days: Number(inp.pay_period_days) } : 'monthly', weeklyHours: wh }) : 0;
      rows.push({ sex, fullPay: inp.full_pay && wh > 0, hourlyRate: rate, bonus12MonthsMinor: Number(inp.bonus_12_months_minor) });
      continue;
    }
    if (dataSource === 'pay_report_inputs') continue; // a loaded dataset is authoritative for the snapshot
    const p = pay.get(e.id);
    const wh = Number(hours.get(e.id) ?? 0);
    if (!p || !(wh > 0)) {
      rows.push({ sex, fullPay: false, hourlyRate: 0, bonus12MonthsMinor: 0 });
      continue;
    }
    const amount = Number(p.amount_minor);
    if (p.frequency === 'daily') {
      // a daily rate has no reg. 6 pay period of its own: load the payroll figures via pay-report inputs
      rows.push({ sex, fullPay: false, hourlyRate: 0, bonus12MonthsMinor: 0 });
      continue;
    }
    const rate = p.frequency === 'hourly' ? amount * RATE_SCALE : gpgHourlyRate(rule.value, { ordinaryPayMinor: amount, period: p.frequency, weeklyHours: wh });
    rows.push({ sex, fullPay: true, hourlyRate: rate, bonus12MonthsMinor: 0 });
  }
  const r = genderPayGap(rule.value, rows);
  await audit(c, 'compliance.gpg_report_viewed', { year: q.year, sector, snapshotDate, employees: emps.length });
  return {
    snapshotDate,
    deadline,
    sector,
    employeeThreshold: rule.value.employeeThreshold,
    headcount: emps.length,
    required: emps.length >= rule.value.employeeThreshold,
    dataSource,
    population: r.population,
    figures: { ...r.rounded, quartiles: r.quartiles.map((x, i) => ({ band: x.band, total: x.total, malePercent: r.rounded.quartiles[i]!.malePercent, femalePercent: r.rounded.quartiles[i]!.femalePercent })) },
    source: rule.source,
    verifiedOn: rule.verifiedOn,
  };
}

// ---- EU pay transparency ------------------------------------------------------------------------------
export async function payTransparencyReport(c: ComplianceReportCtx, q: { year: number; entityId?: string }) {
  const asOf = `${q.year}-12-31`;
  const snapshot = `${q.year - 1}-12-31`; // reports concern the previous calendar year (art. 9(2)-(4))
  const entities = await c.tx.query<{ id: string; name: string; country: string }>(`SELECT id, name, country FROM app.legal_entities ${q.entityId ? 'WHERE id = $1' : ''} ORDER BY name`, q.entityId ? [q.entityId] : []);
  const eu = entities.filter((en) => c.book.pack(en.country)?.parent === 'EU');
  const out = [];
  for (const en of eu) {
    const directive = c.book.tryResolve<PayTransparencyRule>('EU', 'reporting.pay_transparency', asOf);
    const status = c.book.tryResolve<{ status: string; law: string | null; inForceFrom: string | null }>(en.country, 'reporting.pay_transparency', asOf);
    if (!directive || !status || status.jurisdiction === 'EU') continue;
    const emps = await employeesIn(c, 'compliance.reports', `coalesce(e.entity_id, fj.entity_id) = $1 AND e.start_date <= $2 AND (e.end_date IS NULL OR e.end_date >= $2)`, [en.id, snapshot]);
    const inputs = new Map((await c.tx.query<{ employee_id: string; annual_basic_minor: string | null; annual_variable_minor: string | null; annual_hours: string | null; worker_category: string | null }>(`SELECT * FROM app.pay_report_inputs WHERE report_kind = 'eu_pay_transparency' AND snapshot_date = $1`, [snapshot])).map((r) => [r.employee_id, r]));
    const sexes = await vaultField(c, emps, 'diversity', 'pay_reporting');
    const workers: PtWorker[] = emps.map((e) => {
      const s = sexes.get(e.id)?.sex;
      const i = inputs.get(e.id);
      return { sex: s === 'male' || s === 'female' ? s : null, annualBasicMinor: Number(i?.annual_basic_minor ?? 0), annualVariableMinor: Number(i?.annual_variable_minor ?? 0), annualHours: i?.annual_hours ? Number(i.annual_hours) : null, category: i?.worker_category ?? null };
    });
    const ind = payTransparency(directive.value, workers, q.year);
    out.push({ entityId: en.id, entityName: en.name, country: en.country, transposition: { ...status.value, source: status.source, verifiedOn: status.verifiedOn }, directive: { source: directive.source, verifiedOn: directive.verifiedOn }, indicators: ind });
  }
  await audit(c, 'compliance.pay_transparency_viewed', { year: q.year, entities: out.length });
  return out;
}
