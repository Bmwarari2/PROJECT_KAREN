'use client';
import * as React from 'react';
import Link from 'next/link';
import { BarChart3, CalendarClock, ClipboardList, Clock, Database, FileClock, Lock, Scale, Users, Wallet } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Skeleton, Table, TD, TH, THead, TR, Tabs, TabsContent, TabsList, TabsTrigger, useToast } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';
import { downloadRun, problemText } from './ui';

export interface Catalogue {
  ready: Array<{ id: string; category: string; titleKey: string; descriptionKey: string; jurisdictions: string[]; applicable: boolean; sensitivity: string; params: { properties?: Record<string, unknown>; required?: string[] } }>;
  datasets: Array<{ key: string; labelKey: string; time: 'asOf' | 'period'; sensitivity: string; fields: Array<{ key: string; labelKey: string; type: string; sensitivity: string; enumValues?: string[]; groupable: boolean; aggregatable: boolean; vault: boolean }> }>;
  formats: string[];
  canSchedule: boolean;
  canExportData: boolean;
}
interface Saved {
  id: string;
  name: string;
  kind: 'ready' | 'builder';
  reportId: string | null;
  shared: boolean;
  mine: boolean;
  updatedAt: string;
}
interface Run {
  id: string;
  title: string;
  format: string;
  status: string;
  progressPercent: number;
  rowCount: number | null;
  scheduled: boolean;
  createdAt: string;
  expiresAt: string | null;
}

const ICONS: Record<string, React.ReactNode> = {
  people: <Users aria-hidden />,
  absence: <ClipboardList aria-hidden />,
  time: <Clock aria-hidden />,
  pay: <Wallet aria-hidden />,
  compliance: <Scale aria-hidden />,
};
const runTone = { succeeded: 'success', failed: 'danger', expired: 'neutral', queued: 'neutral', running: 'accent' } as const;

export default function ReportsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<Saved[]>('/v1/reports/saved');
  const runs = useApi<Run[]>('/v1/reports/runs');

  if (catalogue.error) return <EmptyState icon={<Lock aria-hidden />} title={t('reports.noAccess')} body={t('reports.noAccessBody')} />;
  if (!catalogue.data) return <Skeleton className="h-96 w-full" />;
  const ready = [...catalogue.data.ready].sort((a, b) => Number(b.applicable) - Number(a.applicable));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('reports.title')}</h1>
        <Button asChild size="sm">
          <Link href="/app/reports/builder" className="no-underline">
            <BarChart3 aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.builder.open')}
          </Link>
        </Button>
        {catalogue.data.canSchedule ? (
          <Button asChild size="sm" variant="secondary">
            <Link href="/app/reports/schedules" className="no-underline">
              <CalendarClock aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('reports.schedules.title')}
            </Link>
          </Button>
        ) : null}
        {catalogue.data.canExportData ? (
          <Button asChild size="sm" variant="secondary">
            <Link href="/app/reports/exports" className="no-underline">
              <Database aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('reports.exports.title')}
            </Link>
          </Button>
        ) : null}
      </div>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('reports.intro')}</p>
      <Tabs defaultValue="ready">
        <TabsList>
          <TabsTrigger value="ready">{t('reports.tab.ready')}</TabsTrigger>
          <TabsTrigger value="saved">{t('reports.tab.saved')}</TabsTrigger>
          <TabsTrigger value="runs">{t('reports.tab.runs')}</TabsTrigger>
        </TabsList>
        <TabsContent value="ready" className="pt-5">
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {ready.map((r) => (
              <li key={r.id}>
                <Card className="flex h-full flex-col gap-2">
                  <div className="flex items-center gap-2 text-accent [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.5]">
                    {ICONS[r.category]}
                    <CardTitle>
                      <Link href={`/app/reports/ready/${r.id}`} className="text-text no-underline hover:underline">
                        {t(r.titleKey)}
                      </Link>
                    </CardTitle>
                  </div>
                  <p className="text-callout text-text-secondary">{t(r.descriptionKey)}</p>
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {r.jurisdictions.filter((j) => j !== '*').map((j) => (
                      <Badge key={j}>{t(`reports.jurisdiction.${j}`)}</Badge>
                    ))}
                    {r.sensitivity === 'special' ? <Badge tone="warning">{t('reports.sensitiveBadge')}</Badge> : null}
                    {!r.applicable ? <Badge>{t('reports.notApplicable')}</Badge> : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="saved" className="pt-5">
          {saved.data?.length ? (
            <Table>
              <caption className="sr-only">{t('reports.tab.saved')}</caption>
              <THead>
                <tr>
                  <TH>{t('reports.saved.name')}</TH>
                  <TH>{t('reports.saved.kind')}</TH>
                  <TH>{t('reports.saved.sharing')}</TH>
                </tr>
              </THead>
              <tbody>
                {saved.data.map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <Link href={s.kind === 'ready' ? `/app/reports/ready/${s.reportId}?saved=${s.id}` : `/app/reports/builder?saved=${s.id}`}>{s.name}</Link>
                    </TD>
                    <TD>{s.kind === 'ready' ? t(catalogue.data!.ready.find((r) => r.id === s.reportId)?.titleKey ?? 'reports.builder.title') : t('reports.builder.title')}</TD>
                    <TD>{s.shared ? t('reports.saved.shared') : t('reports.saved.private')}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState icon={<FileClock aria-hidden />} title={t('reports.saved.empty')} body={t('reports.saved.emptyBody')} />
          )}
        </TabsContent>
        <TabsContent value="runs" className="pt-5">
          {runs.data?.length ? (
            <Table>
              <caption className="sr-only">{t('reports.tab.runs')}</caption>
              <THead>
                <tr>
                  <TH>{t('reports.runs.report')}</TH>
                  <TH>{t('reports.runs.requested')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH className="text-right">{t('reports.runs.rows')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {runs.data.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link href={`/app/reports/runs/${r.id}`}>{r.title}</Link>
                      <span className="ml-2 text-footnote uppercase text-text-secondary">{r.format}</span>
                    </TD>
                    <TD className="whitespace-nowrap">{formatDateTime(r.createdAt, locale, zone)}</TD>
                    <TD>
                      <Badge tone={runTone[r.status as keyof typeof runTone] ?? 'neutral'}>{t(`reports.runStatus.${r.status}`)}</Badge>
                      {r.scheduled ? <span className="ml-2 text-footnote text-text-secondary">{t('reports.runs.scheduled')}</span> : null}
                    </TD>
                    <TD className="text-right">{r.rowCount ?? '—'}</TD>
                    <TD className="text-right">
                      {r.status === 'succeeded' && r.format !== 'json' ? (
                        <Button size="sm" variant="ghost" onClick={() => downloadRun(r.id).catch((err) => toast({ title: problemText(t, err), tone: 'danger' }))} aria-label={t('reports.runs.downloadNamed', { name: r.title })}>
                          {t('reports.runs.download')}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState icon={<FileClock aria-hidden />} title={t('reports.runs.empty')} body={t('reports.runs.emptyBody')} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
