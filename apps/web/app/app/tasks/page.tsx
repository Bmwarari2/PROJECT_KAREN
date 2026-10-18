'use client';
import * as React from 'react';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { Badge, Button, EmptyState, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';

interface Task {
  id: string;
  title: string;
  source: string;
  dueOn: string | null;
  subjectName: string | null;
  status: string;
}

export default function TasksPage() {
  const t = useT();
  const locale = useLocale();
  const { data, reload } = useApi<Task[]>('/v1/tasks');
  const today = new Date().toISOString().slice(0, 10);
  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-title-2">{t('tasks.title')}</h1>
      {data.length === 0 ? (
        <EmptyState icon={<ListChecks aria-hidden />} title={t('tasks.empty')} />
      ) : (
        <Table>
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
            {data.map((task) => (
              <TR key={task.id}>
                <TD>
                  <span className="font-semibold">{task.title}</span> <Badge className="ml-2">{t(`tasks.source.${task.source}`)}</Badge>
                </TD>
                <TD>{task.subjectName ?? '—'}</TD>
                <TD>{task.dueOn ? <span className={task.dueOn < today ? 'font-semibold text-danger' : ''}>{formatDate(task.dueOn, locale)}</span> : '—'}</TD>
                <TD className="text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await api(`/v1/tasks/${task.id}/complete`, { method: 'POST' });
                      reload();
                    }}
                  >
                    <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('tasks.complete')}
                  </Button>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
