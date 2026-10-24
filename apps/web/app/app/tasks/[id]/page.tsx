'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ListChecks } from 'lucide-react';
import { Badge, Card, EmptyState, Skeleton } from '@thapsus/ui';
import { formatDate, formatDateTime } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/zone';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList, type DetailItem } from '@/components/detail-list';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { PageTitle, useSession } from '../../shell';
import { TaskWork } from './task-work';
import type { TaskDetail } from './types';

const statusTone = { open: 'warning', done: 'success', cancelled: 'neutral' } as const;

/**
 * One task (ADR-0160, ADR-0191 to ADR-0193): what it asks and why, a main button that opens the work with
 * the person already chosen, the live status of the record it is linked to, where it comes from, and
 * Mark as done as an audited fallback with a note. Text comes from the API in the reader's locale.
 */
export default function TaskPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const zone = viewerZone(session?.timeZone);
  // the API says whether it is overdue in the viewer's zone, so the page needs no time library (ADR-0186)
  const { data, error, reload } = useApi<TaskDetail>(
    `/v1/tasks/${id}?locale=${locale}&zone=${encodeURIComponent(zone)}`,
  );
  const crumbs = [{ label: t('tasks.title'), href: '/app/tasks' }];

  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.task.title') }]} />
        <EmptyState
          icon={<ListChecks aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const overdue = data.overdue;
  const roleName = (r: string) => (t(`roles.${r}`) === `roles.${r}` ? r : t(`roles.${r}`));

  const facts: DetailItem[] = [
    {
      key: 'due',
      label: t('tasks.col.due'),
      value: data.dueOn ? (
        <span className={overdue ? 'font-semibold text-danger' : undefined}>
          {formatDate(data.dueOn, locale)}
          {overdue ? ` · ${t('tasks.list.overdue')}` : ''}
        </span>
      ) : (
        t('actionable.task.noDue')
      ),
    },
    {
      key: 'person',
      label: t('tasks.col.person'),
      value: data.subject ? <PersonLink id={data.subject.id} name={data.subject.name} /> : '—',
    },
    {
      key: 'assignee',
      label: t('actionable.task.assignee'),
      value: data.assigneeName ?? (data.assigneeRole ? roleName(data.assigneeRole) : '—'),
    },
    {
      key: 'source',
      label: t('actionable.task.source'),
      value: data.origin.href ? (
        <IntentLink href={data.origin.href} data-testid="task-origin">
          {data.origin.label}
        </IntentLink>
      ) : (
        <span data-testid="task-origin">{data.origin.label}</span>
      ),
    },
    {
      key: 'created',
      label: t('actionable.task.created'),
      value: formatDateTime(data.createdAt, locale, zone),
    },
    ...(data.completedAt
      ? [
          {
            key: 'completed',
            label: t('actionable.task.completedOn'),
            value: data.completedByName
              ? t('actionable.task.completedBy', {
                  date: formatDateTime(data.completedAt, locale, zone),
                  name: data.completedByName,
                })
              : formatDateTime(data.completedAt, locale, zone),
          },
        ]
      : []),
    ...(data.status === 'done' && data.completedVia
      ? [
          {
            key: 'how',
            label: t('taskActions.page.how'),
            value: t(`taskActions.page.via.${data.completedVia}`),
          },
        ]
      : []),
    ...(data.completionNote
      ? [
          {
            key: 'note',
            label: t('taskActions.page.noteFact'),
            value: <span className="whitespace-pre-line">{data.completionNote}</span>,
          },
        ]
      : []),
  ];

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="task-detail">
      <Breadcrumbs items={[...crumbs, { label: data.title }]} />
      <Card className="flex flex-col gap-5">
        <div className="flex min-w-0 flex-col gap-2">
          <PageTitle className="text-title-2 break-words">{data.title}</PageTitle>
          <div className="flex flex-wrap gap-2">
            <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? 'neutral'}>
              {t(`actionable.task.status.${data.status}`)}
            </Badge>
          </div>
        </div>
        <p className="whitespace-pre-line text-body text-text-secondary" data-testid="task-description">
          {data.description ?? t('actionable.task.noDescription')}
        </p>
        <TaskWork data={data} onChanged={reload} />
        <DetailList items={facts} />
      </Card>
    </div>
  );
}
