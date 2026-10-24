'use client';
import * as React from 'react';
import { ArrowRight, CheckCircle2, ListChecks } from 'lucide-react';
import { Badge, Button, buttonVariants, EmptyState, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ExportLinks } from '@/components/export-links';
import { IntentLink } from '@/components/intent-link';
import { EntityLink, PersonLink } from '@/components/person-link';
import {
  ListCard,
  ListFilter,
  ListNoMatches,
  ListSearch,
  matches,
  PageIntro,
  type AppliedFilter,
} from '@/components/module-page';
import { compareDates, today as todayIn } from '@thapsus/core/time';
import { viewerZone } from '@/lib/week';
import { useSession } from '../shell';

interface Task {
  id: string;
  title: string;
  source: string;
  dueOn: string | null;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  status: string;
  /** What the task is about (ADR-0160): its request, document, onboarding step or its own page. */
  href: string;
}

/** Requests and signatures close their tasks when they are decided or signed, not with "Complete". */
const CLOSED_BY_ACTION = new Set(['approval', 'document']);

export default function TasksPage() {
  const t = useT();
  const locale = useLocale();
  const { data, reload } = useApi<Task[]>('/v1/tasks');
  const [query, setQuery] = React.useState('');
  // the home dashboard opens the list on its overdue tasks: /app/tasks?overdue=1 (ADR-0161)
  const [source, setSource] = React.useState('');
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('overdue') === '1') setOverdueOnly(true);
    if (q.get('source')) setSource(q.get('source')!);
  }, []);
  const session = useSession();
  const today = React.useMemo(() => todayIn(viewerZone(session?.timeZone)), [session?.timeZone]);
  const rows = data ?? [];
  const overdue = (task: Task) => !!task.dueOn && compareDates(task.dueOn, today) < 0;
  // Search and filters narrow the open tasks already loaded.
  const shown = rows.filter(
    (task) =>
      (!source || task.source === source) &&
      (!overdueOnly || overdue(task)) &&
      matches(query, task.title, task.subjectName),
  );
  const sources = [...new Set(rows.map((task) => task.source))];
  const filtered = !!source || overdueOnly || !!query.trim();
  const clearAll = () => {
    setQuery('');
    setSource('');
    setOverdueOnly(false);
  };
  const applied: AppliedFilter[] = [
    ...(source
      ? [
          {
            key: 'source',
            label: t('tasks.list.sourceChip', { source: t(`tasks.source.${source}`) }),
            clear: () => setSource(''),
          },
        ]
      : []),
    ...(overdueOnly
      ? [{ key: 'overdue', label: t('tasks.list.overdue'), clear: () => setOverdueOnly(false) }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageIntro
        title={t('tasks.title')}
        titleIsTab
        lead={t('tasks.lead')}
        actions={<ExportLinks list="tasks" params={{ status: 'open' }} />}
      />
      <ListCard
        title={t('tasks.list.title')}
        count={
          data
            ? filtered
              ? t('tasks.list.countFiltered', { shown: shown.length, count: rows.length })
              : t('tasks.list.count', { count: rows.length })
            : undefined
        }
        search={
          rows.length ? (
            <ListSearch value={query} onChange={setQuery} label={t('tasks.list.search')} />
          ) : undefined
        }
        filters={
          rows.length ? (
            <>
              {sources.length > 1 || source ? (
                <ListFilter
                  value={source}
                  onChange={setSource}
                  label={t('tasks.list.source')}
                  anyLabel={t('tasks.list.anySource')}
                  options={sources.map((s) => ({ value: s, label: t(`tasks.source.${s}`) }))}
                />
              ) : null}
              <label className="inline-flex h-10 items-center gap-2 text-callout">
                <input
                  type="checkbox"
                  checked={overdueOnly}
                  onChange={(e) => setOverdueOnly(e.target.checked)}
                  className="h-5 w-5 accent-[var(--color-accent)]"
                />
                {t('tasks.list.overdueOnly')}
              </label>
            </>
          ) : undefined
        }
        applied={applied}
        empty={
          !data ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState level={3} icon={<ListChecks aria-hidden />} title={t('tasks.empty')} />
          ) : shown.length === 0 ? (
            <ListNoMatches onClear={clearAll} />
          ) : undefined
        }
      >
        <Table scrollLabel={t('tasks.list.title')}>
          <THead>
            <tr>
              <TH>{t('tasks.col.task')}</TH>
              <TH>{t('tasks.col.person')}</TH>
              <TH>{t('tasks.col.due')}</TH>
              <TH>
                <span className="sr-only">{t('common.actions')}</span>
              </TH>
            </tr>
          </THead>
          <tbody>
            {shown.map((task) => (
              <TR key={task.id}>
                <TD>
                  <EntityLink href={task.href}>{task.title}</EntityLink>{' '}
                  <Badge className="ml-2">{t(`tasks.source.${task.source}`)}</Badge>
                </TD>
                <TD>
                  {task.subjectName ? (
                    <PersonLink id={task.subjectEmployeeId} name={task.subjectName} />
                  ) : (
                    '—'
                  )}
                </TD>
                <TD>
                  {task.dueOn ? (
                    <span className={overdue(task) ? 'font-semibold text-danger' : ''}>
                      {formatDate(task.dueOn, locale)}
                    </span>
                  ) : (
                    '—'
                  )}
                </TD>
                <TD className="text-right">
                  {CLOSED_BY_ACTION.has(task.source) ? (
                    <IntentLink
                      href={task.href}
                      className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} no-underline`}
                      aria-label={t('actionable.task.openNamed', { title: task.title })}
                    >
                      {t('actionable.task.open')}
                      <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    </IntentLink>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('actionable.task.completeNamed', { title: task.title })}
                      onClick={async () => {
                        await api(`/v1/tasks/${task.id}/complete`, { method: 'POST' });
                        reload();
                      }}
                    >
                      <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      {t('tasks.complete')}
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </ListCard>
    </div>
  );
}
