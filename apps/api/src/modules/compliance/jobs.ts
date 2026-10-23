import type { FastifyInstance } from 'fastify';
import { enqueueJob, getPool, writeAudit, type Tx } from '@thapsus/db';
import { compareDates, daysBetween, instantToDate } from '@thapsus/core/time';
import type { RuleBook } from '@thapsus/rules';
import type { Deps } from '../../deps';
import { periodic, registerJob } from '../../jobs/registry';
import { createTask, notify, userForEmployee } from '../../lib/notify';
import { ruleBook } from '../rules/routes';
import { reminderOffsetToday, relevantJurisdictions } from './engine';
import {
  complianceRecipients,
  complianceSettings,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_FROM,
  tenantJurisdictionCodes,
  tenantLocale,
  text,
  type EmployeeRow,
} from './service';
import { i9Statuses, matrixCells, rtwStatuses, serviceAlerts, type ReqRow } from './status';

/**
 * Daily compliance reminders, idempotent per (tenant, date): every notification and task carries a
 * dedupe key naming the record and the reminder offset, so re-running a day (or a retried job) sends
 * nothing twice. Offsets are tenant settings; due dates come from records computed from the packs.
 */
export async function runComplianceDaily(deps: Deps, tx: Tx, date: string) {
  const book: RuleBook = await ruleBook({ deps } as unknown as FastifyInstance);
  const settings = await complianceSettings(tx);
  const locale = await tenantLocale(tx);
  const hr = await complianceRecipients(tx);
  const counts = { rtw: 0, i9: 0, matrix: 0, service: 0, lawChanges: 0, tasks: 0 };
  const emps = await tx.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.end_date IS NULL OR e.end_date >= $1::date - 3650`,
    [date],
  );
  const country = (c: string) => emps.filter((e) => e.country === c);
  const task = async (t: Parameters<typeof createTask>[1]) => {
    if (await createTask(tx, t)) counts.tasks++;
  };

  // ---- UK right to work: follow-up reminders, and a one-off reminder for starters without a check ----
  for (const r of await rtwStatuses(tx, book, country('GB'), date, settings)) {
    const name = r.employee.display_name;
    if (r.check?.follow_up_due_on && r.status !== 'retention') {
      const due = r.check.follow_up_due_on;
      const offset = reminderOffsetToday(due, date, settings.rtwReminderDays);
      if (offset !== null)
        counts.rtw += (
          await notify(tx, {
            userIds: hr,
            kind: 'compliance.rtw_follow_up',
            titleKey: 'notify.rtwFollowUpDue',
            params: { name, date: due, days: offset },
            link: '/app/compliance/right-to-work',
            dedupeKey: `rtwcheck:${r.check.id}:${offset}`,
          })
        ).length;
      if (daysBetween(date, due) <= Math.max(0, ...settings.rtwReminderDays))
        await task({
          source: 'compliance',
          sourceId: r.check.id,
          title: text(locale, 'compliance.task.rtwFollowUp', { name }),
          subjectEmployeeId: r.employee.id,
          assigneeRole: 'hr_admin',
          dueOn: due,
          link: '/app/compliance/right-to-work',
          dedupeKey: `rtwcheck:${r.check.id}:task`,
        });
    }
    if (r.status === 'missing') {
      counts.rtw += (
        await notify(tx, {
          userIds: hr,
          kind: 'compliance.rtw_missing',
          titleKey: 'notify.rtwCheckMissing',
          params: { name, date: r.employee.start_date },
          link: '/app/compliance/right-to-work',
          dedupeKey: `rtw-missing:${r.employee.id}`,
        })
      ).length;
      await task({
        source: 'compliance',
        title: text(locale, 'compliance.task.rtwCheck', { name }),
        subjectEmployeeId: r.employee.id,
        assigneeRole: 'hr_admin',
        dueOn: r.employee.start_date,
        link: '/app/compliance/right-to-work',
        dedupeKey: `rtw-missing:${r.employee.id}`,
      });
    }
  }

  // ---- US Form I-9: Section 2 deadline and reverification -------------------------------------------
  for (const r of await i9Statuses(tx, book, country('US'), date, settings)) {
    const name = r.employee.display_name;
    if (!r.record) continue;
    if (
      (r.status === 'section2_due' || r.status === 'section2_overdue') &&
      compareDates(r.record.section2_due_on, date) <= 0
    ) {
      counts.i9 += (
        await notify(tx, {
          userIds: hr,
          kind: 'compliance.i9_section2',
          titleKey: 'notify.i9Section2Due',
          params: { name, date: r.record.section2_due_on },
          link: '/app/compliance/i9',
          dedupeKey: `i9-s2:${r.record.id}`,
        })
      ).length;
    }
    const due = r.record.reverification_due_on;
    if (due && !r.record.supplement_b_completed_on) {
      const offset = reminderOffsetToday(due, date, settings.i9ReminderDays);
      if (offset !== null)
        counts.i9 += (
          await notify(tx, {
            userIds: hr,
            kind: 'compliance.i9_reverification',
            titleKey: 'notify.i9ReverificationDue',
            params: { name, date: due, days: offset },
            link: '/app/compliance/i9',
            dedupeKey: `i9-rev:${r.record.id}:${due}:${offset}`,
          })
        ).length;
      if (daysBetween(date, due) <= Math.max(0, ...settings.i9ReminderDays))
        await task({
          source: 'compliance',
          sourceId: r.record.id,
          title: text(locale, 'compliance.task.i9Reverify', { name }),
          subjectEmployeeId: r.employee.id,
          assigneeRole: 'hr_admin',
          dueOn: due,
          link: '/app/compliance/i9',
          dedupeKey: `i9-rev:${r.record.id}:${due}:task`,
        });
    }
  }

  // ---- compliance matrix: expiry reminders to HR and the employee; missing items as HR tasks --------
  const reqs = await tx.query<ReqRow>('SELECT * FROM app.compliance_requirements WHERE active');
  const active = emps.filter(
    (e) => e.status !== 'leaver' && (!e.end_date || compareDates(e.end_date, date) >= 0),
  );
  for (const c of await matrixCells(tx, active, reqs, date, settings)) {
    const name = c.employee.display_name;
    if (c.record && c.expiresOn) {
      const offset = reminderOffsetToday(c.expiresOn, date, c.reminderDays);
      if (offset !== null) {
        const own = await userForEmployee(tx, c.employee.id);
        counts.matrix += (
          await notify(tx, {
            userIds: [...new Set([...hr, ...(own ? [own] : [])])],
            kind: 'compliance.expiring',
            titleKey: offset === 0 ? 'notify.complianceExpiresToday' : 'notify.complianceExpiring',
            params: { name, requirement: c.requirement.name, date: c.expiresOn, days: offset },
            link: '/app/compliance/matrix',
            dedupeKey: `matrix:${c.record.id}:${offset}`,
          })
        ).length;
        await task({
          source: 'compliance',
          sourceId: c.record.id,
          title: text(locale, 'compliance.task.renew', { name, requirement: c.requirement.name }),
          subjectEmployeeId: c.employee.id,
          assigneeRole: 'hr_admin',
          dueOn: c.expiresOn,
          link: '/app/compliance/matrix',
          dedupeKey: `matrix:${c.record.id}:task`,
        });
      }
      if (c.status === 'expired' && daysBetween(c.expiresOn, date) === 1)
        counts.matrix += (
          await notify(tx, {
            userIds: hr,
            kind: 'compliance.expired',
            titleKey: 'notify.complianceExpired',
            params: { name, requirement: c.requirement.name, date: c.expiresOn },
            link: '/app/compliance/matrix',
            dedupeKey: `matrix:${c.record.id}:expired`,
          })
        ).length;
    }
    if (c.status === 'missing')
      await task({
        source: 'compliance',
        sourceId: c.requirement.id,
        title: text(locale, 'compliance.task.missing', { name, requirement: c.requirement.name }),
        subjectEmployeeId: c.employee.id,
        assigneeRole: 'hr_admin',
        link: '/app/compliance/matrix',
        dedupeKey: `matrix-missing:${c.requirement.id}:${c.employee.id}`,
      });
  }

  // ---- probation end and unfair dismissal qualifying period (effective-dated pack rule) ---------------
  for (const a of await serviceAlerts(tx, book, active, date, settings)) {
    const offsets =
      a.kind === 'probation_ending' ? settings.probationReminderDays : settings.serviceReminderDays;
    const offset = reminderOffsetToday(a.dueOn, date, offsets);
    if (offset === null) continue;
    const manager = await userForEmployee(tx, a.employee.manager_id);
    const users = [...new Set([...hr, ...(manager ? [manager] : [])])];
    const key = a.kind === 'probation_ending' ? 'probation' : 'qualifying';
    counts.service += (
      await notify(tx, {
        userIds: users,
        kind: `compliance.${a.kind}`,
        titleKey: a.kind === 'probation_ending' ? 'notify.probationEnding' : 'notify.qualifyingPeriodReached',
        params: {
          name: a.employee.display_name,
          date: a.dueOn,
          days: offset,
          period: a.qualifyingPeriod ?? '',
        },
        link: '/app/compliance',
        dedupeKey: `${key}:${a.employee.id}:${a.dueOn}:${offset}`,
      })
    ).length;
  }

  // ---- law changes relevant to the tenant's jurisdictions -----------------------------------------
  const codes = await tenantJurisdictionCodes(tx);
  const relevant = relevantJurisdictions(book, codes);
  const pool = getPool(deps.router.config.databases[deps.router.registryKey]!);
  const { rows: entries } = await pool.query<{
    id: string;
    jurisdiction: string;
    title: Record<string, string>;
  }>(
    `SELECT id, jurisdiction, title FROM backoffice.law_changes WHERE status = 'published' AND published_at <= now()`,
  );
  for (const e of entries.filter((x) => relevant.has(x.jurisdiction))) {
    counts.lawChanges += (
      await notify(tx, {
        userIds: hr,
        kind: 'compliance.law_change',
        titleKey: 'notify.lawChangePublished',
        params: { jurisdiction: e.jurisdiction, title: e.title[locale] ?? e.title['en-GB'] ?? '' },
        link: '/app/compliance/law-changes',
        dedupeKey: `lawchange:${e.id}`,
      })
    ).length;
  }

  if (Object.values(counts).some((n) => n > 0))
    await writeAudit(tx, {
      actorType: 'system',
      action: 'compliance.reminders_sent',
      targetType: 'compliance',
      diff: { date, ...counts },
    });
  return { date, ...counts };
}

registerJob('compliance.daily', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx((tx) => runComplianceDaily(ctx.deps, tx, date));
});

periodic.push(async (tx, now) => {
  const date = instantToDate(now.toISOString(), 'UTC');
  await enqueueJob(tx, 'compliance.daily', date, { date });
});
