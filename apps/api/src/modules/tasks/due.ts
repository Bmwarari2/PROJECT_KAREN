import type { Tx } from '@thapsus/db';
import { addBusinessDays, addDays, businessDayTest, dateParts } from '@thapsus/core/time';
import type { DueRule } from '@thapsus/core/task-actions';
import type { RuleBook } from '@thapsus/rules';
import { i9Deadlines, type I9CompletionRule } from '../compliance/engine';
import { complianceSettings, EMPLOYEE_FROM, jurisdictionOf } from '../compliance/service';

/**
 * Task due dates (ADR-0193): a due rule counts calendar or business days from the workflow's own date or
 * from one of the person's own dates (start, leaving date, probation end). Business days are the
 * workspace's business weekdays (compliance settings) without the public holidays of the person's
 * jurisdiction from the packs. A pack deadline (Form I-9 Section 2) is the pack's own rule, worked out as
 * the compliance module works out the Form I-9 record, so the task is due on the record's date.
 * Golden tests: apps/api/test/task-due.test.ts.
 */
export interface DuePerson {
  startDate: string | null;
  endDate: string | null;
  probationEndDate: string | null;
  country: string | null;
  regionCode: string | null;
}

export interface DueContext {
  person: DuePerson | null;
  /** The workflow's own date (start date, leaving date or transfer date). */
  anchorDate: string | null;
  book: RuleBook;
  /** ISO weekdays the workspace does business on (compliance settings, default Monday to Friday). */
  businessWeekdays: number[];
}

/** The date a rule counts from, or null when the person has no such date. */
function anchorOf(rule: DueRule, ctx: DueContext): string | null {
  switch (rule.anchor) {
    case 'anchor':
      return ctx.anchorDate;
    case 'start':
      return ctx.person?.startDate ?? null;
    case 'end':
      return ctx.person?.endDate ?? null;
    case 'probation_end':
      return ctx.person?.probationEndDate ?? null;
  }
}

/** Public holidays of the person's jurisdiction from the packs, for the years around a date. */
function closedDates(ctx: DueContext, around: string): string[] {
  const p = ctx.person;
  if (!p?.country) return [];
  const { year } = dateParts(around);
  const region = p.regionCode && p.regionCode.startsWith(`${p.country}-`) ? p.regionCode : undefined;
  const out: string[] = [];
  for (const y of [year - 1, year, year + 1, year + 2]) out.push(...ctx.book.daysOff(p.country, y, region));
  return out;
}

/** The due date a rule gives (pure; the caller loads the person and the workspace calendar). */
export function dueDateFor(rule: DueRule, ctx: DueContext): string | null {
  if (rule.packDeadline === 'i9_section2') {
    const p = ctx.person;
    const firstDay = p?.startDate;
    const jurisdiction = p ? jurisdictionOf({ country: p.country, region_code: p.regionCode }) : null;
    if (!firstDay || !jurisdiction) return null;
    const r = ctx.book.tryResolve<I9CompletionRule>(jurisdiction, 'i9.completion_deadlines', firstDay);
    if (!r) return null;
    return i9Deadlines(r.value, {
      firstDay,
      lastDay: p.endDate,
      businessWeekdays: ctx.businessWeekdays,
    }).section2DueOn;
  }
  const from = anchorOf(rule, ctx);
  if (!from) return null;
  if (!rule.businessDays) return addDays(from, rule.offsetDays);
  return addBusinessDays(
    from,
    rule.offsetDays,
    businessDayTest(ctx.businessWeekdays, closedDates(ctx, from)),
  );
}

/** The person's dates and jurisdiction (the contract in force on `at`, else their latest). */
export async function loadDuePerson(
  tx: Tx,
  employeeId: string,
  at: string | null,
): Promise<DuePerson | null> {
  const row = await tx.maybe<{
    start_date: string | null;
    end_date: string | null;
    probation_end_date: string | null;
    country: string | null;
    region_code: string | null;
  }>(
    `SELECT e.start_date::text AS start_date, e.end_date::text AS end_date,
            coalesce(e.country, fl.country, le.country) AS country, coalesce(e.region_code, fl.region_code, le.region_code) AS region_code,
            (SELECT c.probation_end_date::text FROM app.employee_contracts c WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id
               ORDER BY (c.valid_from <= coalesce($2::date, current_date) AND (c.valid_to IS NULL OR c.valid_to > coalesce($2::date, current_date))) DESC,
                        c.valid_from DESC LIMIT 1) AS probation_end_date
       FROM ${EMPLOYEE_FROM} WHERE e.id = $1`,
    [employeeId, at],
  );
  if (!row) return null;
  return {
    startDate: row.start_date,
    endDate: row.end_date,
    probationEndDate: row.probation_end_date,
    country: row.country,
    regionCode: row.region_code,
  };
}

/** Works out a due date for a person in the caller's transaction. */
export async function resolveDueDate(
  tx: Tx,
  rule: DueRule,
  c: { employeeId: string | null; anchorDate: string | null; book: RuleBook },
): Promise<string | null> {
  const person = c.employeeId ? await loadDuePerson(tx, c.employeeId, c.anchorDate) : null;
  const { businessWeekdays } = await complianceSettings(tx);
  return dueDateFor(rule, { person, anchorDate: c.anchorDate, book: c.book, businessWeekdays });
}

/** A due rule stored on a task, with the workflow date it was counted from. */
export type StoredDueRule = DueRule & { anchorDate: string | null };

/**
 * Due dates follow the person's own dates: when their start, leaving or probation end date changes, open
 * tasks whose rule counts from one of them (or from a pack deadline) are worked out again. Returns the
 * number of tasks whose due date changed.
 */
export async function refreshTaskDueDates(tx: Tx, employeeId: string, book: RuleBook): Promise<number> {
  const tasks = await tx.query<{ id: string; due_on: string | null; due_rule: StoredDueRule }>(
    `SELECT id, due_on::text AS due_on, due_rule FROM app.tasks
      WHERE subject_employee_id = $1 AND status = 'open' AND due_rule IS NOT NULL
        AND (due_rule->>'anchor' <> 'anchor' OR due_rule ? 'packDeadline')`,
    [employeeId],
  );
  if (!tasks.length) return 0;
  const { businessWeekdays } = await complianceSettings(tx);
  let changed = 0;
  for (const k of tasks) {
    const person = await loadDuePerson(tx, employeeId, k.due_rule.anchorDate);
    const due = dueDateFor(k.due_rule, {
      person,
      anchorDate: k.due_rule.anchorDate,
      book,
      businessWeekdays,
    });
    if (due === k.due_on) continue;
    await tx.exec('UPDATE app.tasks SET due_on = $2 WHERE id = $1', [k.id, due]);
    changed++;
  }
  return changed;
}
