'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { BadgeCheck, ExternalLink, FileText, Lock } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, Skeleton } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { personHref } from '@thapsus/core/links';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { PersonLink } from '@/components/person-link';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle } from '../../../shell';
import { SourceLink } from '../../ui';

interface Check {
  id: string;
  employeeId: string;
  employeeName: string;
  checkMethod: string;
  listType: string;
  checkedOn: string;
  checkedByName: string | null;
  excuse: string;
  permissionExpiresOn: string | null;
  pvnDate: string | null;
  followUpDueOn: string | null;
  excuseEndsOn: string | null;
  current: boolean;
  detailsRestricted: boolean;
  details: { documentType: string | null; documentReference: string | null; shareCode: string | null } | null;
  evidence: { fileName: string; url: string } | null;
  ruleSource: { url?: string; title?: string; verifiedOn?: string } | null;
}

/**
 * One right-to-work check (ADR-0161): how and when it was done, the statutory excuse it gives and its
 * follow-up date from the GB pack, and, for people with vault access to immigration data, the
 * document details and the evidence (each view is audited).
 */
export default function RightToWorkCheckPage() {
  const t = useT();
  const locale = useLocale();
  const sec = useSectionLevel();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<Check>(`/v1/compliance/right-to-work/checks/${id}`);
  const crumbs = [{ label: t('compliance.rtw.title'), href: '/app/compliance/right-to-work' }];
  const d = (v: string | null) => (v ? formatDate(v, locale) : '—');

  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.rtw.check') }]} />
        <EmptyState
          icon={<BadgeCheck aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const source =
    data.ruleSource?.url && data.ruleSource.title
      ? { url: data.ruleSource.url, title: data.ruleSource.title }
      : null;

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="rtw-check">
      <Breadcrumbs
        items={[
          ...crumbs,
          { label: data.employeeName, href: personHref(data.employeeId, 'compliance') },
          { label: t('actionable.rtw.checkOn', { date: d(data.checkedOn) }) },
        ]}
      />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">
              {t('actionable.rtw.checkOn', { date: d(data.checkedOn) })}
            </PageTitle>
            <div className="flex flex-wrap gap-2">
              <Badge tone={data.current ? 'success' : 'neutral'}>
                {t(data.current ? 'actionable.common.current' : 'actionable.common.superseded')}
              </Badge>
              <Badge>{t(`actionable.rtw.excuse.${data.excuse}`)}</Badge>
            </div>
          </div>
        </div>
        <DetailList
          items={[
            {
              key: 'person',
              label: t('actionable.common.person'),
              value: <PersonLink id={data.employeeId} name={data.employeeName} tab="compliance" />,
            },
            {
              key: 'method',
              label: t('compliance.rtw.method'),
              value: t(`compliance.rtw.methodName.${data.checkMethod}`),
            },
            {
              key: 'list',
              label: t('compliance.rtw.listType'),
              value: t(`compliance.rtw.list.${data.listType}`),
            },
            {
              key: 'by',
              label: t('actionable.rtw.checkedBy'),
              value: data.checkedByName ?? '—',
            },
            ...(data.permissionExpiresOn
              ? [
                  {
                    key: 'expires',
                    label: t('compliance.rtw.permissionExpiresOn'),
                    value: d(data.permissionExpiresOn),
                  },
                ]
              : []),
            ...(data.pvnDate
              ? [{ key: 'pvn', label: t('compliance.rtw.pvnDate'), value: d(data.pvnDate) }]
              : []),
            ...(data.excuseEndsOn
              ? [{ key: 'excuseEnds', label: t('actionable.rtw.excuseEnds'), value: d(data.excuseEndsOn) }]
              : []),
            { key: 'followUp', label: t('compliance.rtw.followUp'), value: d(data.followUpDueOn) },
          ]}
        />
        {source ? <SourceLink source={source} verifiedOn={data.ruleSource?.verifiedOn ?? null} /> : null}
      </Card>
      <Card className="flex flex-col gap-3">
        <CardTitle as={sec.heading}>{t('actionable.rtw.evidence')}</CardTitle>
        {data.detailsRestricted ? (
          <p className="flex items-start gap-2 text-callout text-text-secondary">
            <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
            {t('actionable.rtw.restricted')}
          </p>
        ) : !data.details && !data.evidence ? (
          <p className="text-callout text-text-secondary">{t('actionable.rtw.noEvidence')}</p>
        ) : (
          <>
            {data.details ? (
              <DetailList
                items={[
                  {
                    key: 'docType',
                    label: t('compliance.rtw.documentType'),
                    value: data.details.documentType
                      ? t(`compliance.rtw.document.${data.details.documentType}`)
                      : '—',
                  },
                  {
                    key: 'ref',
                    label: t('compliance.rtw.documentReference'),
                    value: data.details.documentReference ?? '—',
                  },
                  ...(data.details.shareCode
                    ? [{ key: 'share', label: t('compliance.rtw.shareCode'), value: data.details.shareCode }]
                    : []),
                ]}
              />
            ) : null}
            {data.evidence ? (
              <p className="text-callout">
                <a
                  href={data.evidence.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-6 items-center gap-2 font-semibold text-accent underline underline-offset-2"
                >
                  <FileText aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {data.evidence.fileName}
                  <ExternalLink aria-hidden className="h-3.5 w-3.5 stroke-[1.5]" />
                  <span className="sr-only">{t('compliance.opensNewTab')}</span>
                </a>
              </p>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
