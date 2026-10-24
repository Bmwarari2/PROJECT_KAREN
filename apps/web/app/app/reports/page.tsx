'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  BarChart3,
  ClipboardList,
  Clock,
  Download,
  FileClock,
  Scale,
  Search,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardTitle,
  ListItem,
  ListSection,
  cn,
  EmptyState,
  Input,
  Skeleton,
  Table,
  TableToolbar,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDate, formatDateTime, type Locale } from '@thapsus/core/i18n';
import { instantToDate } from '@thapsus/core/time';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { hasPermission, PageTitle, useSession } from '../shell';
import { downloadRun, NoReportsAccess, problemText, runTone, selectClass } from './ui';

export interface Catalogue {
  ready: Array<{
    id: string;
    category: string;
    titleKey: string;
    descriptionKey: string;
    jurisdictions: string[];
    applicable: boolean;
    sensitivity: string;
    params: { properties?: Record<string, unknown>; required?: string[] };
  }>;
  datasets: Array<{
    key: string;
    labelKey: string;
    time: 'asOf' | 'period';
    sensitivity: string;
    fields: Array<{
      key: string;
      labelKey: string;
      type: string;
      sensitivity: string;
      enumValues?: string[];
      groupable: boolean;
      aggregatable: boolean;
      vault: boolean;
    }>;
  }>;
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

/** Categories of ready-made reports, in catalogue order. */
const CATEGORIES = ['people', 'absence', 'time', 'pay', 'compliance'] as const;
const ICONS: Record<string, React.ReactNode> = {
  people: <Users aria-hidden />,
  absence: <ClipboardList aria-hidden />,
  time: <Clock aria-hidden />,
  pay: <Wallet aria-hidden />,
  compliance: <Scale aria-hidden />,
};
const RECENT_RUNS = 6;
const norm = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * The reports catalogue: ready-made reports grouped by category with search and a category filter,
 * the viewer's saved and shared reports as a table, and their recent exports. Everything listed is
 * already limited by the API to what the viewer may run.
 */
export default function ReportsPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<Saved[]>('/v1/reports/saved');
  const runs = useApi<Run[]>('/v1/reports/runs');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [savedQuery, setSavedQuery] = React.useState('');
  const [savedFilter, setSavedFilter] = React.useState<'all' | 'mine' | 'others'>('all');

  if (catalogue.error) return <NoReportsAccess />;
  const canBuild = hasPermission(session, 'reports.run') && !!catalogue.data?.datasets.length;
  // The heading and intro are the page's largest paint on a phone: they render before the catalogue
  // arrives, in the same elements as the loaded page, so React keeps them (no second paint).
  const header = (
    <div className="flex flex-wrap items-start gap-4">
      <div className="mr-auto min-w-0">
        <PageTitle>{t('reports.ui.catalogueTitle')}</PageTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('reports.intro')}
        </p>
      </div>
      {canBuild ? (
        <Link href="/app/reports/builder" className={cn(buttonVariants({ size: 'sm' }), 'no-underline')}>
          <BarChart3 aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('reports.builder.open')}
        </Link>
      ) : null}
    </div>
  );
  if (!catalogue.data)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Skeleton className="h-96 w-full" />
      </div>
    );
  const cat = catalogue.data;
  const q = norm(query.trim());
  const ready = cat.ready
    .filter((r) => category === 'all' || r.category === category)
    .filter((r) => !q || norm(`${t(r.titleKey)} ${t(r.descriptionKey)}`).includes(q))
    .sort((a, b) => Number(b.applicable) - Number(a.applicable));
  const present = [...new Set(cat.ready.map((r) => r.category))];
  const groups = [...CATEGORIES, ...present]
    .filter((c, i, all) => all.indexOf(c) === i)
    .map((c) => ({ key: c, reports: ready.filter((r) => r.category === c) }))
    .filter((g) => g.reports.length);
  const sq = norm(savedQuery.trim());
  const savedRows = (saved.data ?? [])
    .filter((s) => savedFilter === 'all' || (savedFilter === 'mine' ? s.mine : !s.mine))
    .filter((s) => !sq || norm(s.name).includes(sq));
  const reportName = (s: Saved) =>
    s.kind === 'ready'
      ? t(cat.ready.find((r) => r.id === s.reportId)?.titleKey ?? 'reports.builder.title')
      : t('reports.builder.title');

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="overflow-hidden p-0">
            <TableToolbar
              title={t('reports.ui.readyTitle')}
              count={t('reports.ui.reportCount', { count: ready.length })}
              search={
                <span className="relative block">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 stroke-[1.5] text-text-secondary"
                  />
                  <Input
                    type="search"
                    aria-label={t('reports.ui.searchReports')}
                    placeholder={t('reports.ui.searchReports')}
                    className="h-10 w-full pl-9 sm:w-56"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </span>
              }
              filters={
                <select
                  aria-label={t('reports.ui.category.label')}
                  className={cn(selectClass, 'w-auto')}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="all">{t('reports.ui.category.all')}</option>
                  {CATEGORIES.filter((c) => present.includes(c)).map((c) => (
                    <option key={c} value={c}>
                      {t(`reports.ui.category.${c}`)}
                    </option>
                  ))}
                </select>
              }
            />
          </Card>
          {groups.length ? (
            groups.map((g) => (
              <ListSection
                key={g.key}
                id={`cat-${g.key}`}
                // the categories sit under "Ready-made reports" (h2)
                headingLevel={3}
                title={
                  <span className="flex items-center gap-2">
                    {t(`reports.ui.category.${g.key}`)}
                    <span className="text-callout font-normal text-text-secondary">
                      {t('reports.ui.reportCount', { count: g.reports.length })}
                    </span>
                  </span>
                }
              >
                {g.reports.map((r) => {
                  const badges = [
                    ...r.jurisdictions
                      .filter((j) => j !== '*')
                      .map((j) => <Badge key={j}>{t(`reports.jurisdiction.${j}`)}</Badge>),
                    r.sensitivity === 'special' ? (
                      <Badge key="sensitive" tone="warning">
                        {t('reports.sensitiveBadge')}
                      </Badge>
                    ) : null,
                    !r.applicable ? <Badge key="na">{t('reports.notApplicable')}</Badge> : null,
                  ].filter(Boolean);
                  return (
                    <ListItem
                      key={r.id}
                      href={`/app/reports/ready/${r.id}`}
                      linkAs={Link}
                      leading={ICONS[g.key] ?? <BarChart3 aria-hidden />}
                      title={t(r.titleKey)}
                      subtitle={
                        <span className="flex flex-col gap-1.5">
                          {t(r.descriptionKey)}
                          {badges.length ? <span className="flex flex-wrap gap-1.5">{badges}</span> : null}
                        </span>
                      }
                    />
                  );
                })}
              </ListSection>
            ))
          ) : (
            <p role="status" className="text-callout text-text-secondary">
              {t('reports.ui.noMatches')}
            </p>
          )}

          <Card className="overflow-hidden p-0">
            <TableToolbar
              title={t('reports.ui.savedTitle')}
              count={saved.data ? t('reports.ui.savedCount', { count: savedRows.length }) : undefined}
              search={
                saved.data?.length ? (
                  <Input
                    type="search"
                    aria-label={t('reports.ui.searchSaved')}
                    placeholder={t('reports.ui.searchSaved')}
                    className="h-10 w-full sm:w-56"
                    value={savedQuery}
                    onChange={(e) => setSavedQuery(e.target.value)}
                  />
                ) : undefined
              }
              filters={
                saved.data?.length ? (
                  <select
                    aria-label={t('reports.ui.savedFilter.label')}
                    className={cn(selectClass, 'w-auto')}
                    value={savedFilter}
                    onChange={(e) => setSavedFilter(e.target.value as typeof savedFilter)}
                  >
                    <option value="all">{t('reports.ui.savedFilter.all')}</option>
                    <option value="mine">{t('reports.ui.savedFilter.mine')}</option>
                    <option value="others">{t('reports.ui.savedFilter.others')}</option>
                  </select>
                ) : undefined
              }
            />
            {!saved.data ? (
              <Skeleton className="m-5 h-24" />
            ) : savedRows.length ? (
              <Table scrollLabel={t('reports.ui.savedTitle')} className="[&_td]:align-top">
                <caption className="sr-only">{t('reports.ui.savedTitle')}</caption>
                <THead>
                  <tr>
                    <TH>{t('reports.saved.name')}</TH>
                    <TH>{t('reports.saved.kind')}</TH>
                    <TH>{t('reports.saved.sharing')}</TH>
                    <TH>{t('reports.ui.updated')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {savedRows.map((s) => (
                    <TR key={s.id}>
                      <TD>
                        <Link
                          href={
                            s.kind === 'ready'
                              ? `/app/reports/ready/${s.reportId}?saved=${s.id}`
                              : `/app/reports/builder?saved=${s.id}`
                          }
                          className="font-semibold"
                        >
                          {s.name}
                        </Link>
                      </TD>
                      <TD className="text-text-secondary">{reportName(s)}</TD>
                      <TD>
                        <Badge tone={s.shared ? 'accent' : 'neutral'}>
                          {s.shared ? t('reports.saved.shared') : t('reports.saved.private')}
                        </Badge>
                        {!s.mine ? (
                          <span className="ml-2 text-footnote text-text-secondary">
                            {t('reports.ui.sharedWithYou')}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="whitespace-nowrap text-text-secondary">
                        {formatDate(instantToDate(s.updatedAt, zone), locale)}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : saved.data.length ? (
              <p role="status" className="px-5 py-6 text-callout text-text-secondary">
                {t('reports.ui.noSavedMatches')}
              </p>
            ) : (
              <div className="p-5">
                <EmptyState
                  level={3}
                  icon={<FileClock aria-hidden />}
                  title={t('reports.saved.empty')}
                  body={t('reports.saved.emptyBody')}
                />
              </div>
            )}
          </Card>
        </div>

        <RecentRuns runs={runs.data} locale={locale} zone={zone} />
      </div>
    </div>
  );
}

/** The viewer's latest exports and scheduled deliveries, while their files can be downloaded. */
function RecentRuns({ runs, locale, zone }: { runs: Run[] | undefined; locale: Locale; zone: string }) {
  const t = useT();
  const toast = useToast();
  const shown = (runs ?? []).slice(0, RECENT_RUNS);
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <CardTitle>{t('reports.ui.recentRuns')}</CardTitle>
        <p className="mt-1 text-footnote text-text-secondary">{t('reports.runs.privacy')}</p>
      </div>
      {!runs ? (
        <Skeleton className="h-24" />
      ) : shown.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {shown.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link href={`/app/reports/runs/${r.id}`} className="break-words text-callout font-semibold">
                  {r.title}
                </Link>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-text-secondary">
                  <Badge tone={runTone[r.status as keyof typeof runTone] ?? 'neutral'}>
                    {t(`reports.runStatus.${r.status}`)}
                  </Badge>
                  <span className="uppercase">{r.format}</span>
                  <span>{formatDateTime(r.createdAt, locale, zone)}</span>
                  {r.scheduled ? <span>{t('reports.runs.scheduled')}</span> : null}
                </span>
              </div>
              {r.status === 'succeeded' && r.format !== 'json' ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    downloadRun(r.id).catch((err) => toast({ title: problemText(t, err), tone: 'danger' }))
                  }
                  aria-label={t('reports.runs.downloadNamed', { name: r.title })}
                  title={t('reports.runs.download')}
                >
                  <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-callout font-semibold">{t('reports.runs.empty')}</p>
          <p className="text-footnote text-text-secondary">{t('reports.runs.emptyBody')}</p>
        </div>
      )}
      {runs && runs.length > shown.length ? (
        <p className="text-footnote text-text-secondary">
          {t('reports.ui.latestRuns', { count: shown.length })}
        </p>
      ) : null}
    </Card>
  );
}
