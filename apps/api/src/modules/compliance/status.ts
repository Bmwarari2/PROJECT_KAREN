import { addDays, compareDates, daysBetween } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import type { RuleBook } from '@thapsus/rules';
import {
  i9RetainUntil,
  matrixStatus,
  requirementApplies,
  rtwRetainUntil,
  unfairDismissalQualifyingDate,
  type MatrixStatus,
  type RequirementScope,
} from './engine';
import { jurisdictionOf, type ComplianceSettings, type EmployeeRow } from './service';

/**
 * Status calculations shared by the list endpoints, the dashboard and the daily reminder job, so all
 * three always agree. Dates come from stored records; rules are resolved from the packs on `asOf`.
 */
export type RtwStatus = 'missing' | 'valid' | 'follow_up_due' | 'expired' | 'retention';
export interface RtwStatusRow {
  employee: EmployeeRow;
  status: RtwStatus;
  check: {
    id: string;
    check_method: string;
    list_type: string;
    checked_on: string;
    follow_up_due_on: string | null;
    excuse_ends_on: string | null;
    evidence_vault_id: string | null;
  } | null;
  retainUntil: string | null;
}

export async function rtwStatuses(
  tx: Tx,
  book: RuleBook,
  emps: EmployeeRow[],
  asOf: string,
  settings: ComplianceSettings,
): Promise<RtwStatusRow[]> {
  const checks = emps.length
    ? await tx.query<NonNullable<RtwStatusRow['check']> & { employee_id: string }>(
        `SELECT id, employee_id, check_method, list_type, checked_on::text, follow_up_due_on::text, excuse_ends_on::text, evidence_vault_id FROM app.rtw_checks WHERE superseded_by IS NULL AND employee_id = ANY($1::uuid[])`,
        [emps.map((e) => e.id)],
      )
    : [];
  const byEmp = new Map(checks.map((c) => [c.employee_id, c]));
  const window = Math.max(0, ...settings.rtwReminderDays);
  const out: RtwStatusRow[] = [];
  for (const e of emps) {
    if (compareDates(e.start_date, addDays(asOf, window)) > 0) continue; // not starting soon enough to need a check yet
    const c = byEmp.get(e.id) ?? null;
    const retention = book.tryResolve<{ retainAfterEmploymentEnds: string }>(
      jurisdictionOf(e) ?? 'GB',
      'right_to_work.retention',
      asOf,
    );
    const retainUntil = c && retention ? rtwRetainUntil(retention.value, e.end_date) : null;
    const left = e.end_date !== null && compareDates(e.end_date, asOf) < 0;
    if (left && (!c || (retainUntil && compareDates(retainUntil, asOf) < 0))) continue; // leavers past retention drop off
    let status: RtwStatus = 'missing';
    if (left) status = 'retention';
    else if (c) {
      const due = c.follow_up_due_on;
      if (!due) status = 'valid';
      else if (compareDates(due, asOf) < 0) status = 'expired';
      else status = compareDates(due, addDays(asOf, window)) <= 0 ? 'follow_up_due' : 'valid';
    }
    out.push({ employee: e, status, check: c, retainUntil });
  }
  return out;
}

export type I9Status =
  | 'missing'
  | 'section1_due'
  | 'section2_due'
  | 'section2_overdue'
  | 'complete'
  | 'reverification_due'
  | 'reverification_overdue';
export interface I9StatusRow {
  employee: EmployeeRow;
  status: I9Status;
  record: {
    id: string;
    first_day_of_employment: string;
    section1_completed_on: string | null;
    section2_completed_on: string | null;
    section2_due_on: string;
    reverification_due_on: string | null;
    supplement_b_completed_on: string | null;
  } | null;
  retainUntil: string | null;
  retainAtLeastUntil: string | null;
}

export async function i9Statuses(
  tx: Tx,
  book: RuleBook,
  emps: EmployeeRow[],
  asOf: string,
  settings: ComplianceSettings,
): Promise<I9StatusRow[]> {
  const retention = book.tryResolve<Parameters<typeof i9RetainUntil>[0]>('US', 'i9.retention', asOf);
  const recs = emps.length
    ? await tx.query<NonNullable<I9StatusRow['record']> & { employee_id: string }>(
        `SELECT DISTINCT ON (employee_id) id, employee_id, first_day_of_employment::text, section1_completed_on::text, section2_completed_on::text, section2_due_on::text, reverification_due_on::text, supplement_b_completed_on::text
           FROM app.i9_records WHERE employee_id = ANY($1::uuid[]) ORDER BY employee_id, first_day_of_employment DESC`,
        [emps.map((e) => e.id)],
      )
    : [];
  const byEmp = new Map(recs.map((r) => [r.employee_id, r]));
  const window = Math.max(0, ...settings.i9ReminderDays);
  const out: I9StatusRow[] = [];
  for (const e of emps) {
    const r = byEmp.get(e.id) ?? null;
    const ret = retention
      ? i9RetainUntil(retention.value, {
          hireDate: r?.first_day_of_employment ?? e.start_date,
          terminationDate: e.end_date,
        })
      : { retainUntil: null, atLeastUntil: null };
    if (
      e.end_date &&
      compareDates(e.end_date, asOf) < 0 &&
      (!r || (ret.retainUntil && compareDates(ret.retainUntil, asOf) < 0))
    )
      continue;
    let status: I9Status = 'missing';
    if (r) {
      if (!r.section1_completed_on) status = 'section1_due';
      else if (!r.section2_completed_on)
        status = compareDates(r.section2_due_on, asOf) < 0 ? 'section2_overdue' : 'section2_due';
      else if (r.reverification_due_on && !r.supplement_b_completed_on)
        status =
          compareDates(r.reverification_due_on, asOf) < 0
            ? 'reverification_overdue'
            : compareDates(r.reverification_due_on, addDays(asOf, window)) <= 0
              ? 'reverification_due'
              : 'complete';
      else status = 'complete';
    }
    out.push({
      employee: e,
      status,
      record: r,
      retainUntil: ret.retainUntil,
      retainAtLeastUntil: ret.atLeastUntil,
    });
  }
  return out;
}

export type ReqRow = {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  applies_to: RequirementScope;
  validity_months: number | null;
  reminder_days: number[];
  evidence_required: boolean;
  active: boolean;
};
export interface MatrixCell {
  employee: EmployeeRow;
  requirement: ReqRow;
  status: MatrixStatus;
  record: {
    id: string;
    issued_on: string;
    expires_on: string | null;
    evidence_document_id: string | null;
  } | null;
  expiresOn: string | null;
  daysLeft: number | null;
  reminderDays: number[];
}
/** Effective reminder offsets: the requirement's own, else the tenant default. */
export const reminderDaysFor = (r: { reminder_days: number[] }, defaults: number[]) =>
  r.reminder_days.length ? r.reminder_days : defaults;

export async function matrixCells(
  tx: Tx,
  emps: EmployeeRow[],
  reqs: ReqRow[],
  asOf: string,
  settings: ComplianceSettings,
): Promise<MatrixCell[]> {
  if (!emps.length || !reqs.length) return [];
  const recs = await tx.query<
    NonNullable<MatrixCell['record']> & { employee_id: string; requirement_id: string }
  >(
    `SELECT DISTINCT ON (employee_id, requirement_id) id, employee_id, requirement_id, issued_on::text, expires_on::text, evidence_document_id FROM app.compliance_records
      WHERE status = 'active' AND employee_id = ANY($1::uuid[]) ORDER BY employee_id, requirement_id, issued_on DESC, created_at DESC`,
    [emps.map((e) => e.id)],
  );
  const recOf = new Map(recs.map((r) => [`${r.employee_id}|${r.requirement_id}`, r]));
  const out: MatrixCell[] = [];
  for (const e of emps) {
    for (const r of reqs) {
      if (
        !requirementApplies(r.applies_to, {
          jobTitle: e.job_title,
          locationId: e.location_id,
          entityId: e.entity_id,
          departmentId: e.department_id,
          country: e.country,
        })
      )
        continue;
      const rec = recOf.get(`${e.id}|${r.id}`) ?? null;
      const reminderDays = reminderDaysFor(r, settings.matrixReminderDays);
      const s = matrixStatus(
        { validityMonths: r.validity_months, reminderDays },
        rec ? { issuedOn: rec.issued_on, expiresOn: rec.expires_on } : null,
        asOf,
      );
      out.push({
        employee: e,
        requirement: r,
        status: s.status,
        record: rec,
        expiresOn: s.expiresOn,
        daysLeft: s.daysLeft,
        reminderDays,
      });
    }
  }
  return out;
}

export interface ServiceAlert {
  kind: 'probation_ending' | 'unfair_dismissal_qualifying_period';
  employee: EmployeeRow;
  dueOn: string;
  daysLeft: number;
  qualifyingPeriod?: string;
  source?: { url: string; title: string };
}

/** Probation end dates (from contracts) and the date unfair dismissal protection starts (effective-dated pack rule), within the reminder window. */
export async function serviceAlerts(
  tx: Tx,
  book: RuleBook,
  emps: EmployeeRow[],
  asOf: string,
  settings: ComplianceSettings,
  withinDays?: number,
): Promise<ServiceAlert[]> {
  const out: ServiceAlert[] = [];
  const probWindow = withinDays ?? Math.max(0, ...settings.probationReminderDays);
  const svcWindow = withinDays ?? Math.max(0, ...settings.serviceReminderDays);
  const contracts = emps.length
    ? new Map(
        (
          await tx.query<{ employee_id: string; probation_end_date: string | null }>(
            `SELECT employee_id, probation_end_date::text FROM app.employee_contracts WHERE employee_id = ANY($1::uuid[]) AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
            [emps.map((e) => e.id), asOf],
          )
        ).map((c) => [c.employee_id, c.probation_end_date]),
      )
    : new Map<string, string | null>();
  const days = (d: string) => daysBetween(asOf, d);
  for (const e of emps) {
    if (e.end_date && compareDates(e.end_date, asOf) < 0) continue;
    const prob = contracts.get(e.id);
    if (prob && compareDates(prob, asOf) >= 0 && compareDates(prob, addDays(asOf, probWindow)) <= 0)
      out.push({ kind: 'probation_ending', employee: e, dueOn: prob, daysLeft: days(prob) });
    const jur = jurisdictionOf(e);
    if (!jur) continue;
    const q = unfairDismissalQualifyingDate(book, jur, e.start_date);
    if (q && compareDates(q.date, asOf) >= 0 && compareDates(q.date, addDays(asOf, svcWindow)) <= 0)
      out.push({
        kind: 'unfair_dismissal_qualifying_period',
        employee: e,
        dueOn: q.date,
        daysLeft: days(q.date),
        qualifyingPeriod: q.qualifyingPeriod,
        source: q.source,
      });
  }
  return out.sort((a, b) => compareDates(a.dueOn, b.dueOn));
}
