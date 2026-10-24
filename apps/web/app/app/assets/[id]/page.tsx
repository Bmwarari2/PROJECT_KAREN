'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, Laptop } from 'lucide-react';
import {
  Badge,
  buttonVariants,
  Card,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
} from '@thapsus/ui';
import { formatDate, formatMoney } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle } from '../../shell';

interface AssetDetail {
  id: string;
  assetTag: string;
  type: string;
  name: string;
  serialNumber: string | null;
  costMinor: number | null;
  currency: string | null;
  purchasedOn: string | null;
  status: string;
  notes: string | null;
  holder: {
    assignmentId: string;
    employeeId: string;
    employeeName: string;
    acknowledgedAt: string | null;
  } | null;
  assignments: Array<{
    id: string;
    employeeId: string;
    employeeName: string | null;
    status: string;
    assignedOn: string;
    acknowledgedAt: string | null;
    returnedOn: string | null;
    conditionIn: string | null;
  }>;
}

const statusTone = {
  in_stock: 'success',
  assigned: 'accent',
  in_repair: 'warning',
  retired: 'neutral',
  lost: 'danger',
} as const;

/** One asset (ADR-0161): what it is, who holds it, and everyone it was issued to. */
export default function AssetPage() {
  const t = useT();
  const locale = useLocale();
  const sec = useSectionLevel();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<AssetDetail>(`/v1/assets/${id}`);
  const crumbs = [{ label: t('assets.title'), href: '/app/assets' }];
  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.asset.title') }]} />
        <EmptyState icon={<Laptop aria-hidden />} title={t('errors.notFound')} />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const d = (v: string | null) => (v ? formatDate(v, locale) : '—');
  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="asset-detail">
      <Breadcrumbs items={[...crumbs, { label: data.name }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">{data.name}</PageTitle>
            <p className="font-mono text-footnote text-text-secondary">{data.assetTag}</p>
            <div>
              <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? 'neutral'}>
                {t(`assets.status.${data.status}`)}
              </Badge>
            </div>
          </div>
          {data.holder ? (
            <IntentLink
              href={`/app/assets?return=${data.holder.assignmentId}`}
              className={`${buttonVariants({ variant: 'secondary', size: 'md' })} no-underline`}
            >
              {t('assets.recordReturn')}
              <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
            </IntentLink>
          ) : null}
        </div>
        <DetailList
          items={[
            { key: 'type', label: t('assets.type'), value: t(`assets.types.${data.type}`) },
            { key: 'serial', label: t('assets.serialNumber'), value: data.serialNumber ?? '—' },
            {
              key: 'cost',
              label: t('assets.cost'),
              value:
                data.costMinor !== null && data.currency
                  ? formatMoney(money(BigInt(data.costMinor), data.currency), locale)
                  : '—',
            },
            { key: 'purchased', label: t('actionable.asset.purchasedOn'), value: d(data.purchasedOn) },
            {
              key: 'holder',
              label: t('assets.holder'),
              value: data.holder ? (
                <span>
                  <PersonLink id={data.holder.employeeId} name={data.holder.employeeName} />
                  <span className="block text-footnote text-text-secondary">
                    {data.holder.acknowledgedAt ? t('assets.signedFor') : t('assets.awaitingSignOff')}
                  </span>
                </span>
              ) : (
                '—'
              ),
            },
            ...(data.notes ? [{ key: 'notes', label: t('actionable.asset.notes'), value: data.notes }] : []),
          ]}
        />
      </Card>
      <Card className="flex flex-col gap-3 p-0">
        <div className="px-5 pt-5">
          <CardTitle as={sec.heading}>{t('actionable.asset.history')}</CardTitle>
        </div>
        {data.assignments.length ? (
          <div className="[&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
            <Table dense scrollLabel={t('actionable.asset.history')}>
              <THead>
                <tr>
                  <TH>{t('assets.employee')}</TH>
                  <TH>{t('assets.issuedOn')}</TH>
                  <TH>{t('actionable.asset.returnedOn')}</TH>
                </tr>
              </THead>
              <tbody>
                {data.assignments.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <PersonLink id={a.employeeId} name={a.employeeName} />
                    </TD>
                    <TD>{d(a.assignedOn)}</TD>
                    <TD>
                      {a.returnedOn
                        ? d(a.returnedOn)
                        : a.status === 'active'
                          ? t('actionable.asset.stillIssued')
                          : '—'}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="px-5 pb-5 text-callout text-text-secondary">{t('actionable.asset.noHistory')}</p>
        )}
      </Card>
    </div>
  );
}
