'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { Badge, Card, CardTitle, EmptyState, Skeleton } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle, useSession } from '../../shell';

interface HrRequestDetail {
  id: string;
  subject: string;
  message: string;
  status: 'open' | 'done' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
  completedByName: string | null;
}

const tone = { open: 'warning', done: 'success', cancelled: 'neutral' } as const;

/**
 * One question or request the viewer sent to HR (ADR-0163): what they asked, its status and when HR
 * closed it. HR works on it from the task in their inbox; only the person who asked opens this page.
 */
export default function HrRequestPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const sec = useSectionLevel();
  const zone = viewerZone(session?.timeZone);
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<HrRequestDetail>(`/v1/hr-requests/${id}`);
  const crumbs = [{ label: t('actionable.hr.title'), href: '/app/contact-hr' }];

  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.hr.request') }]} />
        <EmptyState
          icon={<MessageSquare aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const when = (v: string) => formatDateTime(v, locale, zone);

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="hr-request-detail">
      <Breadcrumbs items={[...crumbs, { label: data.subject }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <PageTitle className="text-title-2 break-words">{data.subject}</PageTitle>
          <div>
            <Badge tone={tone[data.status] ?? 'neutral'}>{t(`actionable.hr.status.${data.status}`)}</Badge>
          </div>
        </div>
        <DetailList
          items={[
            { key: 'sent', label: t('actionable.hr.sentLabel'), value: when(data.createdAt) },
            ...(data.completedAt
              ? [
                  {
                    key: 'done',
                    label: t('actionable.hr.doneLabel'),
                    value: data.completedByName
                      ? t('actionable.hr.doneBy', {
                          date: when(data.completedAt),
                          name: data.completedByName,
                        })
                      : when(data.completedAt),
                  },
                ]
              : []),
          ]}
        />
        <p className="text-callout text-text-secondary">
          {data.status === 'open' ? t('actionable.hr.openNote') : t('actionable.hr.doneNote')}
        </p>
      </Card>
      <Card className="flex flex-col gap-2">
        <CardTitle as={sec.heading}>{t('actionable.hr.message')}</CardTitle>
        <p className="whitespace-pre-wrap break-words text-body">{data.message}</p>
      </Card>
    </div>
  );
}
