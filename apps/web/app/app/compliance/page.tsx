'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlarmClock, BadgeCheck, CalendarHeart, FileWarning, Landmark, Scale, ShieldCheck, Timer } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, Skeleton } from '@thapsus/ui';
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';

interface Dashboard {
  asOf: string;
  rightToWork: { total: number; missing: number; valid: number; followUpDue: number; expired: number; retention: number };
  i9: { total: number; missing: number; incomplete: number; overdue: number; reverificationDue: number; complete: number };
  matrix: { compliant: number; expiring: number; expired: number; missing: number };
  alerts: Array<{ kind: string; employeeId: string; employeeName: string; dueOn: string; daysLeft: number; qualifyingPeriod: string | null }>;
  reporting: {
    genderPayGap: { headcount: number; threshold: number; required: boolean; snapshotDate: string; deadline: string } | null;
    eeo1: { usEmployees: number; threshold: number; required: boolean; window: { from: string; to: string } } | null;
    payTransparency: Array<{ entityId: string; entityName: string; country: string; status: string; workers: number; reportingRequired: boolean; firstReportBy: string | null }>;
  };
  lawChanges: { relevant: number; unacknowledged: number };
}

interface Coverage {
  us: { paidSickLeave: Array<{ jurisdiction: string; employees: number; answeredBy: string | null; modelled: boolean; source: { url: string; title: string } | null }>; fmla: { usEmployees: number; coveredEmployer: boolean; minEmployees: number; openCases: number } | null };
  eu: Array<{ country: string; employees: number; rules: Array<{ key: string; modelled: boolean; answeredBy: string | null }>; publicHolidays: number }>;
}
interface Flsa {
  employeeId: string;
  status: string;
  overtimeEligible: boolean;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' | 'danger' }) {
  const locale = useLocale();
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-text';
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-footnote text-text-secondary">{label}</dt>
      <dd className={`text-title-3 tabular-nums ${color}`}>{formatNumber(value, locale)}</dd>
    </div>
  );
}

export default function ComplianceDashboard() {
  const t = useT();
  const locale = useLocale();
  const d = useApi<Dashboard>('/v1/compliance/dashboard');
  const cov = useApi<Coverage>('/v1/compliance/leave-coverage');
  const flsa = useApi<Flsa[]>('/v1/compliance/flsa');
  const period = (p: string | null) => (p ? t(`compliance.period.${p}`) : '');

  if (d.error) return <EmptyState icon={<ShieldCheck aria-hidden />} title={t('compliance.noAccess')} />;
  if (!d.data) return <Skeleton className="h-96 w-full" />;
  const x = d.data;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title-2">{t('compliance.title')}</h1>
        <p className="text-callout text-text-secondary">{t('compliance.asOf', { date: formatDate(x.asOf, locale) })}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardTitle className="flex items-center gap-2">
            <BadgeCheck aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            <Link href="/app/compliance/right-to-work">{t('compliance.dashboard.rtwTitle')}</Link>
          </CardTitle>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Stat label={t('compliance.status.valid')} value={x.rightToWork.valid} tone="success" />
            <Stat label={t('compliance.status.follow_up_due')} value={x.rightToWork.followUpDue} tone="warning" />
            <Stat label={t('compliance.status.missing')} value={x.rightToWork.missing + x.rightToWork.expired} tone="danger" />
          </dl>
        </Card>
        <Card>
          <CardTitle className="flex items-center gap-2">
            <FileWarning aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            <Link href="/app/compliance/i9">{t('compliance.dashboard.i9Title')}</Link>
          </CardTitle>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Stat label={t('compliance.status.complete')} value={x.i9.complete} tone="success" />
            <Stat label={t('compliance.dashboard.i9Open')} value={x.i9.incomplete + x.i9.reverificationDue} tone="warning" />
            <Stat label={t('compliance.dashboard.i9Overdue')} value={x.i9.overdue + x.i9.missing} tone="danger" />
          </dl>
        </Card>
        <Card>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            <Link href="/app/compliance/matrix">{t('compliance.dashboard.matrixTitle')}</Link>
          </CardTitle>
          <dl className="mt-3 grid grid-cols-4 gap-3">
            <Stat label={t('compliance.status.compliant')} value={x.matrix.compliant} tone="success" />
            <Stat label={t('compliance.status.expiring')} value={x.matrix.expiring} tone="warning" />
            <Stat label={t('compliance.status.expired')} value={x.matrix.expired} tone="danger" />
            <Stat label={t('compliance.status.missing')} value={x.matrix.missing} tone="danger" />
          </dl>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle className="flex items-center gap-2">
            <AlarmClock aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            {t('compliance.dashboard.alertsTitle')}
          </CardTitle>
          {x.alerts.length ? (
            <ul className="mt-3 flex flex-col gap-2">
              {x.alerts.map((a) => (
                <li key={`${a.kind}:${a.employeeId}`} className="flex flex-wrap items-center gap-2 text-callout">
                  <span className="font-semibold">{a.employeeName}</span>
                  <span className="text-text-secondary">{t(`compliance.alert.${a.kind}`, { period: period(a.qualifyingPeriod) })}</span>
                  <Badge tone={a.daysLeft <= 7 ? 'warning' : 'neutral'} className="ml-auto">
                    {formatDate(a.dueOn, locale)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-callout text-text-secondary">{t('compliance.dashboard.noAlerts')}</p>
          )}
        </Card>
        <Card>
          <CardTitle className="flex items-center gap-2">
            <Scale aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            {t('compliance.dashboard.reportingTitle')}
          </CardTitle>
          <ul className="mt-3 flex flex-col gap-3 text-callout">
            {x.reporting.genderPayGap ? (
              <li>
                <Link href="/app/compliance/reports/gender-pay-gap">{t('compliance.dashboard.gpg', { headcount: x.reporting.genderPayGap.headcount, threshold: x.reporting.genderPayGap.threshold, date: formatDate(x.reporting.genderPayGap.snapshotDate, locale) })}</Link>
                <p className="text-footnote text-text-secondary">{x.reporting.genderPayGap.required ? t('compliance.dashboard.reportBy', { date: formatDate(x.reporting.genderPayGap.deadline, locale) }) : t('compliance.dashboard.belowThreshold')}</p>
              </li>
            ) : null}
            {x.reporting.eeo1 ? (
              <li>
                <Link href="/app/compliance/reports/eeo-1">{t('compliance.dashboard.eeo1', { count: x.reporting.eeo1.usEmployees, threshold: x.reporting.eeo1.threshold })}</Link>
                <p className="text-footnote text-text-secondary">{t('compliance.dashboard.eeo1Window', { from: formatDate(x.reporting.eeo1.window.from, locale), to: formatDate(x.reporting.eeo1.window.to, locale) })}</p>
              </li>
            ) : null}
            {x.reporting.payTransparency.map((p) => (
              <li key={p.entityId}>
                <Link href="/app/compliance/reports/pay-transparency">{t('compliance.dashboard.pt', { entity: p.entityName, country: p.country, status: t(`compliance.ptStatus.${p.status}`) })}</Link>
                <p className="text-footnote text-text-secondary">{p.reportingRequired && p.firstReportBy ? t('compliance.dashboard.reportBy', { date: formatDate(p.firstReportBy, locale) }) : t('compliance.dashboard.ptBelow', { workers: p.workers })}</p>
              </li>
            ))}
            {!x.reporting.genderPayGap && !x.reporting.eeo1 && !x.reporting.payTransparency.length ? <li className="text-text-secondary">{t('compliance.dashboard.noReporting')}</li> : null}
          </ul>
        </Card>
      </div>
      {cov.data && (cov.data.us.paidSickLeave.length || cov.data.eu.length) ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardTitle className="flex items-center gap-2">
              <CalendarHeart aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
              {t('compliance.coverage.title')}
            </CardTitle>
            <ul className="mt-3 flex flex-col gap-2 text-callout">
              {cov.data.us.paidSickLeave.map((p) => (
                <li key={p.jurisdiction} className="flex flex-wrap items-center gap-2">
                  <Badge>{p.jurisdiction}</Badge>
                  <span>{p.modelled ? t('compliance.coverage.psl', { answeredBy: p.answeredBy ?? p.jurisdiction }) : t('compliance.coverage.pslNone')}</span>
                  <span className="ml-auto text-footnote text-text-secondary">{t('compliance.coverage.employees', { count: p.employees })}</span>
                </li>
              ))}
              {cov.data.us.fmla ? <li>{cov.data.us.fmla.coveredEmployer ? t('compliance.coverage.fmlaCovered', { cases: cov.data.us.fmla.openCases }) : t('compliance.coverage.fmlaNotCovered', { count: cov.data.us.fmla.usEmployees, min: cov.data.us.fmla.minEmployees })}</li> : null}
              {cov.data.eu.map((c) => (
                <li key={c.country} className="flex flex-wrap items-center gap-2">
                  <Badge>{c.country}</Badge>
                  <span>{t('compliance.coverage.eu', { modelled: c.rules.filter((r) => r.modelled).length, total: c.rules.length, holidays: c.publicHolidays })}</span>
                  <span className="ml-auto text-footnote text-text-secondary">{t('compliance.coverage.employees', { count: c.employees })}</span>
                </li>
              ))}
            </ul>
          </Card>
          {flsa.data?.length ? (
            <Card>
              <CardTitle className="flex items-center gap-2">
                <Timer aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                {t('compliance.flsa.title')}
              </CardTitle>
              <dl className="mt-3 grid grid-cols-3 gap-3">
                <Stat label={t('compliance.status.exempt')} value={flsa.data.filter((f) => f.status === 'exempt').length} tone="success" />
                <Stat label={t('compliance.status.exempt_at_risk')} value={flsa.data.filter((f) => f.status === 'exempt_at_risk').length} tone="warning" />
                <Stat label={t('compliance.flsa.overtimeEligible')} value={flsa.data.filter((f) => f.overtimeEligible).length} />
              </dl>
            </Card>
          ) : null}
        </div>
      ) : null}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <Landmark aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
          <Link href="/app/compliance/law-changes">{t('compliance.dashboard.lawChangesTitle')}</Link>
        </CardTitle>
        <p className="mt-2 text-callout text-text-secondary">{t('compliance.dashboard.lawChanges', { open: x.lawChanges.unacknowledged, total: x.lawChanges.relevant })}</p>
      </Card>
    </div>
  );
}
