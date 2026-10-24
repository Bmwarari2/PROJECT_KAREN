import { formatDate, formatMoney, t, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core';
import { instantToDate } from '@thapsus/core/time';
import {
  addressInWords,
  entitlementInWords,
  hoursInWords,
  MERGE_FIELDS,
  noticeInWords,
  patternInWords,
  rateInWords,
  type WeekPattern,
} from '@thapsus/core/documents';
import type { Tx } from '@thapsus/db';
import { averageDayHours, dailyHours, type LeavePolicy, type WorkPattern } from '../leave/engine';
import { leaveContext, policyFor } from '../leave/service';

/**
 * The values of every merge field for one person (16.10), from data Thapsus-HR already holds, as of `asOf` (a
 * civil date; today in UTC by default). A field the data does not support for this person is an empty string,
 * which the send flow reports as a missing value. Words come from the message catalogues in the template's
 * locale; dates and money are formatted for it.
 */
export async function mergeValuesFor(
  tx: Tx,
  employeeId: string,
  locale: Locale,
  asOf: string = instantToDate(new Date().toISOString(), 'UTC'),
): Promise<Record<string, string>> {
  const tr = (key: string, vars?: Record<string, string | number>) => t(locale, key, vars);
  const e = await tx.one<
    Record<string, string | null> & {
      work_pattern: WeekPattern | null;
      address: Record<string, unknown> | null;
    }
  >(
    `SELECT e.display_name, e.employee_number, e.job_title, e.start_date, e.work_email, p.legal_first_name, p.legal_last_name,
            d.name AS department, l.name AS location, le.name AS entity, le.address, le.registration_number,
            pay.amount_minor, pay.currency, pay.frequency, t.name AS company,
            j.employment_type, j.weekly_hours, j.work_pattern, j.fte, coalesce(j.entity_id, e.entity_id) AS entity_id,
            c.contract_type, c.notice_period_days, c.probation_end_date,
            m.display_name AS manager_name, m.job_title AS manager_title
       FROM app.employees e
       JOIN app.tenants t ON t.tenant_id = e.tenant_id
       LEFT JOIN app.employee_personal p ON p.tenant_id = e.tenant_id AND p.employee_id = e.id AND p.valid_from <= $2 AND (p.valid_to IS NULL OR p.valid_to > $2)
       LEFT JOIN app.employee_pay pay ON pay.tenant_id = e.tenant_id AND pay.employee_id = e.id AND pay.valid_from <= $2 AND (pay.valid_to IS NULL OR pay.valid_to > $2)
       LEFT JOIN app.employee_jobs j ON j.tenant_id = e.tenant_id AND j.employee_id = e.id AND j.valid_from <= greatest($2::date, e.start_date) AND (j.valid_to IS NULL OR j.valid_to > greatest($2::date, e.start_date))
       LEFT JOIN app.employee_contracts c ON c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.valid_from <= greatest($2::date, e.start_date) AND (c.valid_to IS NULL OR c.valid_to > greatest($2::date, e.start_date))
       LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = e.location_id
       LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = coalesce(j.entity_id, e.entity_id)
       LEFT JOIN app.employees m ON m.tenant_id = e.tenant_id AND m.id = e.manager_id
      WHERE e.id = $1`,
    [employeeId, asOf],
  );
  const date = (v: string | null | undefined) =>
    v ? formatDate(String(v).slice(0, 10), locale, 'long') : '';
  const salary =
    e.amount_minor && e.currency ? formatMoney(money(BigInt(e.amount_minor), e.currency), locale) : '';
  const values: Record<string, string> = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, '']));
  Object.assign(values, {
    'employee.displayName': e.display_name ?? '',
    'employee.firstName': e.legal_first_name ?? '',
    'employee.lastName': e.legal_last_name ?? '',
    'employee.employeeNumber': e.employee_number ?? '',
    'employee.jobTitle': e.job_title ?? '',
    'employee.department': e.department ?? '',
    'employee.location': e.location ?? '',
    'employee.workEmail': e.work_email ?? '',
    'employee.startDate': date(e.start_date),
    'employee.salary': salary,
    'employee.payFrequency': e.frequency ? tr(`reports.enum.payFrequency.${e.frequency}`) : '',
    'employee.employmentType': e.employment_type
      ? tr(`reports.enum.employmentType.${e.employment_type}`)
      : '',
    'employee.weeklyHours': e.weekly_hours ? hoursInWords(Number(e.weekly_hours), locale, tr) : '',
    'employee.workPattern': e.work_pattern ? patternInWords(e.work_pattern, locale, tr) : '',
    'contract.type': e.contract_type ? tr(`reports.enum.contractType.${e.contract_type}`) : '',
    'contract.noticePeriod':
      e.notice_period_days != null && Number(e.notice_period_days) > 0
        ? noticeInWords(Number(e.notice_period_days), locale)
        : '',
    'contract.probationEndDate': date(e.probation_end_date),
    'pay.rate': salary && e.frequency ? rateInWords(salary, e.frequency, tr) : '',
    'manager.name': e.manager_name ?? '',
    'manager.jobTitle': e.manager_title ?? '',
    'entity.name': e.entity ?? '',
    'entity.address': addressInWords(e.address),
    'entity.registrationNumber': e.registration_number ?? '',
    'company.name': e.company ?? '',
    today: date(asOf),
  });
  // the next pay date and how often payroll runs, from the pay calendar of the person's entity (or the company's)
  const period = await tx.maybe<{ frequency: string; pay_date: string }>(
    `SELECT frequency, pay_date FROM app.pay_periods WHERE (entity_id = $1 OR entity_id IS NULL) AND pay_date >= $2
      ORDER BY (entity_id IS NOT NULL) DESC, pay_date LIMIT 1`,
    [e.entity_id, asOf],
  );
  if (period) {
    values['pay.schedule'] = tr(`docFields.value.schedule.${period.frequency}`);
    values['pay.nextPayDate'] = date(period.pay_date);
  }
  // holiday entitlement from the annual leave policy that applies to the person (assigned, or the default)
  const annual = await tx.maybe<{ id: string }>(
    `SELECT id FROM app.leave_types WHERE category = 'annual' AND active ORDER BY key = 'annual' DESC, key LIMIT 1`,
  );
  if (annual) {
    const ctx = await leaveContext(tx, employeeId, asOf);
    const policy = (await policyFor(tx, ctx, annual.id, asOf))?.config as LeavePolicy | undefined;
    if (policy) {
      const fte = policy.proRata ? ctx.fte : 1;
      const pattern: WorkPattern = ctx.pattern ?? dailyHours(37.5 * fte);
      values['leave.annualEntitlement'] =
        policy.accrual.method === 'per_hour_worked'
          ? entitlementInWords({ kind: 'percent', amount: policy.accrual.percent }, locale, tr)
          : entitlementInWords(
              policy.unit === 'hours'
                ? {
                    kind: 'hours',
                    amount: Math.round(policy.accrual.days * fte * averageDayHours(pattern) * 100) / 100,
                  }
                : { kind: 'days', amount: Math.round(policy.accrual.days * fte * 100) / 100 },
              locale,
              tr,
            );
      values['leave.yearStart'] = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }).format(new Date(`2024-${policy.yearStart}T00:00:00Z`));
    }
  }
  return values;
}
