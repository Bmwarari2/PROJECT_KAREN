'use client';
import * as React from 'react';
import {
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  ListChecks,
  MessageSquare,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, ListItem, Skeleton } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ExportLinks } from '@/components/export-links';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
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
const SOURCE_ICON: Record<string, LucideIcon> = {
  approval: ClipboardCheck,
  document: FileSignature,
  compliance: BadgeCheck,
  workflow: ListChecks,
  automation: Zap,
  hr_request: MessageSquare,
};

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
        {/* a grouped list (ADR-0180): each row opens what the task is about */}
        <ul role="list" aria-label={t('tasks.list.title')} data-testid="task-list">
          {shown.map((task) => {
            const Icon = SOURCE_ICON[task.source] ?? ListChecks;
            return (
              <ListItem
                key={task.id}
                href={task.href}
                linkAs={IntentLink}
                leading={<Icon aria-hidden />}
                title={task.title}
                subtitle={
                  <>
                    {/* a task about the viewer does not repeat their own name */}
                    {task.subjectName && task.subjectEmployeeId !== session?.employeeId ? (
                      <>
                        {/* above the row's link, so the name opens the person's profile */}
                        <PersonLink
                          id={task.subjectEmployeeId}
                          name={task.subjectName}
                          className="relative z-10"
                          plainClassName="text-text"
                        />
                        {' · '}
                      </>
                    ) : null}
                    {t(`tasks.source.${task.source}`)}
                  </>
                }
                meta={
                  task.dueOn ? (
                    <span className={overdue(task) ? 'font-semibold text-danger' : undefined}>
                      {t('actionable.task.due', { date: formatDate(task.dueOn, locale) })}
                    </span>
                  ) : undefined
                }
                actions={
                  CLOSED_BY_ACTION.has(task.source) ? undefined : (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="min-h-11 sm:min-h-8"
                      aria-label={t('actionable.task.completeNamed', { title: task.title })}
                      onClick={async () => {
                        await api(`/v1/tasks/${task.id}/complete`, { method: 'POST' });
                        reload();
                      }}
                    >
                      <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      {t('tasks.complete')}
                    </Button>
                  )
                }
              />
            );
          })}
        </ul>
      </ListCard>
    </div>
  );
}
