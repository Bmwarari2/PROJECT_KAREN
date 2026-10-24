'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, CheckCircle2, ListChecks } from 'lucide-react';
import { Badge, Button, buttonVariants, Card, EmptyState, Skeleton, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime } from '@thapsus/core/i18n';
import { compareDates, today as todayIn } from '@thapsus/core/time';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList, type DetailItem } from '@/components/detail-list';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { PageTitle, useSession } from '../../shell';

interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  source: string;
  status: string;
  dueOn: string | null;
  createdAt: string;
  completedAt: string | null;
  completedByName: string | null;
  subject: { id: string; name: string } | null;
  assigneeRole: string | null;
  assigneeName: string | null;
  workflow: { id: string; kind: string; name: string } | null;
  href: string;
  canComplete: boolean;
}

const statusTone = { open: 'warning', done: 'success', cancelled: 'neutral' } as const;

/**
 * One task (ADR-0160): what it asks, when it is due, who it is about and where to do it. Tasks whose
 * work happens on another page (a request, a document, an onboarding step) link there; the rest are
 * marked done here.
 */
export default function TaskPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<TaskDetail>(`/v1/tasks/${id}`);
  const [busy, setBusy] = React.useState(false);
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
  const today = todayIn(viewerZone(session?.timeZone));
  const overdue = data.status === 'open' && !!data.dueOn && compareDates(data.dueOn, today) < 0;
  const elsewhere = data.href !== `/app/tasks/${data.id}`;
  const roleName = (r: string) => (t(`roles.${r}`) === `roles.${r}` ? r : t(`roles.${r}`));
  const zone = viewerZone(session?.timeZone);

  async function complete() {
    setBusy(true);
    try {
      await api(`/v1/tasks/${id}/complete`, { method: 'POST' });
      toast({ title: t('actionable.task.completed'), tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

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
    { key: 'source', label: t('actionable.task.source'), value: t(`tasks.source.${data.source}`) },
    ...(data.workflow
      ? [{ key: 'workflow', label: t('actionable.task.workflow'), value: data.workflow.name }]
      : []),
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
  ];

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="task-detail">
      <Breadcrumbs items={[...crumbs, { label: data.title }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">{data.title}</PageTitle>
            <div className="flex flex-wrap gap-2">
              <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? 'neutral'}>
                {t(`actionable.task.status.${data.status}`)}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {elsewhere ? (
              <IntentLink
                href={data.href}
                className={`${buttonVariants({ variant: data.canComplete ? 'secondary' : 'primary', size: 'md' })} no-underline`}
              >
                {t(`actionable.task.go.${data.source}`)}
                <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </IntentLink>
            ) : null}
            {data.canComplete ? (
              <Button loading={busy} onClick={complete}>
                <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('actionable.task.markDone')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="whitespace-pre-line text-body text-text-secondary">
          {data.description ?? t('actionable.task.noDescription')}
        </p>
        <DetailList items={facts} />
      </Card>
    </div>
  );
}
