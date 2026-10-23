'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, FileClock } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Skeleton, useToast } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useSession } from '../../../shell';
import { downloadRun, problemText, RunProgress, useBackgroundRun } from '../../ui';

interface Run {
  id: string;
  title: string;
  format: string;
  status: string;
  progressPercent: number;
  rowCount: number | null;
  bytes: number | null;
  fileName: string | null;
  errorCode: string | null;
  scheduled: boolean;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}
const tone = { succeeded: 'success', failed: 'danger', expired: 'neutral', queued: 'neutral', running: 'accent' } as const;

/** One report run (the link in a scheduled-delivery email lands here, behind sign-in). */
export default function RunPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { id } = useParams<{ id: string }>();
  const bg = useBackgroundRun();
  const poll = bg.poll;
  const [run, setRun] = React.useState<Run | null>(null);
  const [missing, setMissing] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    api<Run>(`/v1/reports/runs/${id}`)
      .then(async (r) => {
        if (!live) return;
        setRun(r);
        if (r.status === 'queued' || r.status === 'running') {
          await poll(id);
          if (live) setRun(await api<Run>(`/v1/reports/runs/${id}`));
        }
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [id, poll]);

  if (missing) return <EmptyState level={1} icon={<FileClock aria-hidden />} title={t('errors.notFound')} />;
  if (!run) return <Skeleton className="h-48 w-full" />;
  const when = (v: string | null) => (v ? formatDateTime(v, locale, zone) : '—');
  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/reports" className="inline-flex w-fit items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('reports.title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{run.title}</h1>
        <Badge tone={tone[run.status as keyof typeof tone] ?? 'neutral'}>{t(`reports.runStatus.${run.status}`)}</Badge>
      </div>
      <Card className="flex flex-col gap-4">
        {run.status === 'queued' || run.status === 'running' ? <RunProgress run={bg.run ?? run} /> : null}
        <dl className="grid gap-x-6 gap-y-2 text-callout sm:grid-cols-2">
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t('reports.runs.format')}</dt>
            <dd className="uppercase">{run.format}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t('reports.runs.rows')}</dt>
            <dd className="tabular-nums">{run.rowCount ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t('reports.runs.requested')}</dt>
            <dd>{when(run.createdAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t('reports.runs.finished')}</dt>
            <dd>{when(run.finishedAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t('reports.runs.expires')}</dt>
            <dd>{when(run.expiresAt)}</dd>
          </div>
          {run.scheduled ? (
            <div className="flex justify-between gap-3">
              <dt className="text-text-secondary">{t('reports.runs.source')}</dt>
              <dd>{t('reports.runs.scheduled')}</dd>
            </div>
          ) : null}
        </dl>
        {run.status === 'failed' && run.errorCode ? <RunProgress run={run} /> : null}
        {run.status === 'expired' ? <p className="text-callout text-text-secondary">{t('reports.runs.expiredBody')}</p> : null}
        {run.status === 'succeeded' && run.format !== 'json' ? (
          <Button className="w-fit" onClick={() => downloadRun(run.id).catch((err) => toast({ title: problemText(t, err), tone: 'danger' }))}>
            <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.runs.downloadNamed', { name: run.fileName ?? run.title })}
          </Button>
        ) : null}
        <p className="text-footnote text-text-secondary">{t('reports.runs.privacy')}</p>
      </Card>
    </div>
  );
}
