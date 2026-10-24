'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { Lock, Wallet } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate, formatDateTime, numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { PersonLink } from '@/components/person-link';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle, useSession } from '../../../shell';

type Keyed = { employeeId: string; employeeNumber: string };
interface Inputs {
  period: { id?: string; name?: string; startDate?: string; endDate?: string; payDate?: string | null };
  employees: Array<Keyed & { displayName: string }>;
  hours: Keyed[];
  absences: Keyed[];
  sickPay: Keyed[];
  payChanges: Keyed[];
  starters: Keyed[];
  leavers: Keyed[];
}
interface Period {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  status: 'open' | 'closed';
}
interface ExportRow {
  id: string;
  periodId: string;
  fileName: string;
  createdAt: string;
}

const SECTIONS = ['hours', 'absences', 'sickPay', 'payChanges', 'starters', 'leavers'] as const;

/**
 * One pay period (ADR-0161): its dates and status, who is in it with what changed for each person
 * (hours, absences, sick pay, pay changes, starters and leavers), and its exports. The inputs view is
 * audited as sensitive by the API (it includes absence dates).
 */
export default function PayPeriodPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const sec = useSectionLevel();
  const zone = viewerZone(session?.timeZone);
  const n = (v: number) => numberFormat(locale).format(v);
  const { id } = useParams<{ id: string }>();
  const periods = useApi<Period[]>('/v1/payroll/periods');
  const inputs = useApi<Inputs>(`/v1/payroll/periods/${id}/inputs`);
  const exports = useApi<ExportRow[]>('/v1/payroll/exports');
  const crumbs = [{ label: t('payroll.title'), href: '/app/payroll' }];
  const period = periods.data?.find((p) => p.id === id);
  if (inputs.error || (periods.data && !period))
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('payroll.period') }]} />
        <EmptyState
          icon={<Wallet aria-hidden />}
          title={inputs.error?.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!period || !inputs.data) return <Skeleton className="h-64 w-full" />;
  const data = inputs.data;
  const count = (k: (typeof SECTIONS)[number], employeeId: string) =>
    data[k].filter((r) => r.employeeId === employeeId).length;
  const mine = (exports.data ?? []).filter((x) => x.periodId === id);
  return (
    <div className="flex flex-col gap-4" data-testid="pay-period">
      <Breadcrumbs items={[...crumbs, { label: period.name }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <PageTitle className="text-title-2 break-words">{period.name}</PageTitle>
          <div>
            <Badge tone={period.status === 'closed' ? 'accent' : 'neutral'}>
              {period.status === 'closed' ? <Lock aria-hidden className="h-3 w-3" /> : null}
              {t(`payroll.status.${period.status}`)}
            </Badge>
          </div>
        </div>
        <DetailList
          items={[
            {
              key: 'dates',
              label: t('payroll.dates'),
              value: `${formatDate(period.startDate, locale)} – ${formatDate(period.endDate, locale)}`,
            },
            {
              key: 'pay',
              label: t('actionable.payroll.payDate'),
              value: period.payDate ? formatDate(period.payDate, locale) : '—',
            },
            ...SECTIONS.map((k) => ({
              key: k,
              label: t(`actionable.payroll.section.${k}`),
              value: n(data[k].length),
            })),
          ]}
        />
      </Card>
      <Card className="flex flex-col gap-3 p-0">
        <div className="px-5 pt-5">
          <CardTitle as={sec.heading}>
            {t('actionable.payroll.people', { count: data.employees.length, n: n(data.employees.length) })}
          </CardTitle>
        </div>
        {data.employees.length ? (
          <div className="[&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
            <Table dense scrollLabel={t('actionable.payroll.peopleLabel')}>
              <THead>
                <tr>
                  <TH>{t('actionable.common.person')}</TH>
                  <TH>{t('actionable.payroll.number')}</TH>
                  {SECTIONS.map((k) => (
                    <TH key={k} className="text-right">
                      {t(`actionable.payroll.section.${k}`)}
                    </TH>
                  ))}
                </tr>
              </THead>
              <tbody>
                {data.employees.map((e) => (
                  <TR key={e.employeeId}>
                    <TD>
                      <PersonLink id={e.employeeId} name={e.displayName} />
                    </TD>
                    <TD className="font-mono text-footnote">{e.employeeNumber}</TD>
                    {SECTIONS.map((k) => (
                      <TD key={k} className="text-right">
                        {n(count(k, e.employeeId))}
                      </TD>
                    ))}
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="px-5 pb-5 text-callout text-text-secondary">{t('actionable.payroll.nobody')}</p>
        )}
      </Card>
      <Card className="flex flex-col gap-3">
        <CardTitle as={sec.heading}>{t('payroll.exports')}</CardTitle>
        {mine.length ? (
          <ul className="flex flex-col gap-2">
            {mine.map((x) => (
              <li key={x.id} className="flex flex-col gap-0.5 rounded-md border border-border p-3">
                <span className="break-words font-semibold">{x.fileName}</span>
                <span className="text-footnote text-text-secondary">
                  {formatDateTime(x.createdAt, locale, zone)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-callout text-text-secondary">{t('payroll.noExports')}</p>
        )}
      </Card>
    </div>
  );
}
