'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, AlertTriangle, Cpu, Database, Gauge, Hourglass, Server, Timer } from 'lucide-react';
import { KpiTile, ListItem, ListSection, Skeleton, TabNav } from '@thapsus/ui';
import { dateTimeFormat, formatDateTime, numberFormat, type Locale } from '@thapsus/core/i18n';
import { Panel } from '@/components/dashboard/parts';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { ChartWithTable, DashboardSection } from '../charts';
import { PageTitle } from '../ui';

interface Point {
  start: string;
  requests: number;
  errors5xx: number;
  p50Ms: number | null;
  p95Ms: number | null;
}
interface Performance {
  cell: string;
  window: '24h' | '7d';
  bucket: 'hour' | 'day';
  totals: {
    requests: number;
    errors5xx: number;
    errorRateBasisPoints: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  series: Point[];
  routes: Array<{
    group: string;
    requests: number;
    errors5xx: number;
    errors4xx: number;
    p50Ms: number | null;
    p95Ms: number | null;
  }>;
  queues: Array<{
    dbKey: string;
    at: string;
    outboxPending: number;
    jobsQueued: number;
    jobsDue: number;
    jobsOldestDueSeconds: number | null;
    jobsRunning: number;
    jobsFailed1h: number;
    jobsFailed24h: number;
    databaseBytes: number;
  }>;
  queueSeries: Array<{ start: string; jobsDue: number }>;
  worker: { beatAt: string | null };
  incidents: Array<{
    id: string;
    kind: string;
    impact: string;
    title: string;
    status: string;
    startedAt: string;
    resolvedAt: string | null;
  }>;
}

function useFormat() {
  const t = useT();
  const locale = useLocale() as Locale;
  const n = (v: number) => numberFormat(locale).format(v);
  const unit = (v: number, u: string) =>
    numberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: 1 }).format(
      v,
    );
  const ms = (v: number | null) => (v === null ? '—' : unit(v, 'millisecond'));
  const age = (s: number | null) =>
    s === null
      ? '—'
      : s < 120
        ? unit(s, 'second')
        : s < 7200
          ? unit(s / 60, 'minute')
          : unit(s / 3600, 'hour');
  const bytes = (b: number) => (b >= 1e9 ? unit(b / 1e9, 'gigabyte') : unit(b / 1e6, 'megabyte'));
  const pct = (bp: number) =>
    numberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bp / 10000);

  return { t, locale, n, unit, ms, age, bytes, pct };
}

/**
 * Platform performance for this cell (ADR-0176): request volume, server errors and response times by route
 * group, the background queues and database size, the worker heartbeat and the status-page incidents. Every
 * chart has its table; times are in UTC because the figures are the platform's, not a person's.
 */
export default function PerformancePage() {
  const { t } = useFormat();
  const params = useSearchParams();
  const range = params.get('window') === '7d' ? '7d' : '24h';
  const p = useApi<Performance>(`/v1/backoffice/performance?window=${range}`);

  const tabs = (['24h', '7d'] as const).map((w) => ({
    href: `/backoffice/performance?window=${w}`,
    label: t(`backoffice.performance.window.${w}`),
    active: w === range,
  }));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageTitle title={t('backoffice.performance.title')} lead={t('backoffice.performance.lead')} />
        <TabNav
          tabs={tabs}
          label={t('backoffice.performance.windowLabel')}
          renderLink={(tab, className, children) => (
            <Link
              href={tab.href}
              className={className}
              aria-current={tab.active ? 'page' : undefined}
              scroll={false}
            >
              {children}
            </Link>
          )}
        />
      </div>
      {!p.data ? <Skeleton className="h-64 w-full" /> : <Body p={p.data} />}
    </div>
  );
}

function Body({ p }: { p: Performance }) {
  const { t, locale, n, ms, age, bytes, pct } = useFormat();
  const hourly = p.bucket === 'hour';
  const short = (iso: string) =>
    dateTimeFormat(
      locale,
      hourly
        ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
        : { weekday: 'short', day: 'numeric', timeZone: 'UTC' },
    ).format(new Date(iso));
  const long = (iso: string) =>
    dateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(hourly ? { timeStyle: 'short' } : {}),
      timeZone: 'UTC',
    }).format(new Date(iso));
  const span = {
    unit: t(`backoffice.performance.unit.${p.bucket}`),
    from: long(p.series[0]!.start),
    to: long(p.series[p.series.length - 1]!.start),
  };
  const chart = (
    key: string,
    title: string,
    labelKey: string,
    values: number[],
    format: (v: number) => string,
    integer = true,
  ) => (
    <Panel level={2} title={title} data-testid={`${key}-chart`}>
      <ChartWithTable
        label={t(labelKey, span)}
        categories={p.series.map((s) => short(s.start))}
        tableCategories={p.series.map((s) => long(s.start))}
        series={[{ key, label: t(`backoffice.performance.series.${key}`), values }]}
        format={format}
        integer={integer}
        showTable={t('backoffice.performance.showTable')}
        categoryHeading={t(`backoffice.performance.slot.${p.bucket}`)}
        phoneColumns={hourly ? 8 : 7}
      />
    </Panel>
  );
  const due = p.queues.reduce((s, q) => s + q.jobsDue, 0);
  const oldest = p.queues.reduce<number | null>(
    (m, q) => (q.jobsOldestDueSeconds === null ? m : Math.max(m ?? 0, q.jobsOldestDueSeconds)),
    null,
  );
  const size = p.queues.reduce((s, q) => s + q.databaseBytes, 0);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label={t('backoffice.performance.requests')}
          value={n(p.totals.requests)}
          hint={t('backoffice.performance.requestsHint')}
          icon={<Activity aria-hidden />}
        />
        <KpiTile
          label={t('backoffice.performance.errors')}
          value={n(p.totals.errors5xx)}
          hint={
            p.totals.errorRateBasisPoints === null
              ? t('backoffice.performance.errorsNone')
              : t('backoffice.performance.errorsHint', { rate: pct(p.totals.errorRateBasisPoints) })
          }
          icon={<AlertTriangle aria-hidden />}
        />
        <KpiTile
          label={t('backoffice.performance.p95')}
          value={ms(p.totals.p95Ms)}
          hint={t('backoffice.performance.p95Hint', { p50: ms(p.totals.p50Ms) })}
          icon={<Timer aria-hidden />}
        />
        <KpiTile
          label={t('backoffice.performance.oldestJob')}
          value={
            p.queues.length ? (oldest === null ? t('backoffice.performance.noneDue') : age(oldest)) : '—'
          }
          hint={
            p.queues.length
              ? t('backoffice.performance.oldestJobHint', { count: due })
              : t('backoffice.performance.noQueueSample')
          }
          icon={<Hourglass aria-hidden />}
        />
        <KpiTile
          label={t('backoffice.performance.databaseSize')}
          value={p.queues.length ? bytes(size) : '—'}
          hint={
            p.queues.length
              ? t('backoffice.performance.databaseSizeHint', { count: p.queues.length })
              : t('backoffice.performance.noQueueSample')
          }
          icon={<Database aria-hidden />}
        />
        <KpiTile
          label={t('backoffice.performance.worker')}
          value={p.worker.beatAt ? short(p.worker.beatAt) : '—'}
          hint={
            p.worker.beatAt
              ? t('backoffice.performance.workerBeat', { at: formatDateTime(p.worker.beatAt, locale, 'UTC') })
              : t('backoffice.performance.workerNone')
          }
          icon={<Cpu aria-hidden />}
        />
      </div>

      {p.totals.requests === 0 ? (
        <p className="rounded-lg bg-surface-raised p-5 text-callout text-text-secondary shadow-sm">
          {t('backoffice.performance.noTraffic')}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {chart(
            'requests',
            t('backoffice.performance.requestsChart'),
            'backoffice.performance.requestsChartLabel',
            p.series.map((s) => s.requests),
            n,
          )}
          {chart(
            'errors',
            t('backoffice.performance.errorsChart'),
            'backoffice.performance.errorsChartLabel',
            p.series.map((s) => s.errors5xx),
            n,
          )}
          {chart(
            'p95',
            t('backoffice.performance.latencyChart'),
            'backoffice.performance.latencyChartLabel',
            p.series.map((s) => s.p95Ms ?? 0),
            (v) => ms(v),
          )}
          {chart(
            'jobs',
            t('backoffice.performance.queueChart'),
            'backoffice.performance.queueChartLabel',
            p.queueSeries.map((s) => s.jobsDue),
            n,
          )}
        </div>
      )}

      {p.routes.length ? (
        <ListSection
          id="routes"
          title={t('backoffice.performance.routes')}
          footer={t('backoffice.performance.routesHint')}
        >
          {p.routes.map((r) => (
            <ListItem
              key={r.group}
              leading={<Server aria-hidden />}
              title={r.group}
              subtitle={[
                t('backoffice.performance.routeRequests', { count: r.requests }),
                r.errors5xx ? t('backoffice.performance.routeErrors', { count: r.errors5xx }) : null,
                r.errors4xx ? t('backoffice.performance.routeClientErrors', { count: r.errors4xx }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              meta={
                r.p50Ms === null
                  ? t('backoffice.performance.noLatency')
                  : t('backoffice.performance.routeLatency', { p50: ms(r.p50Ms), p95: ms(r.p95Ms) })
              }
            />
          ))}
        </ListSection>
      ) : null}

      <DashboardSection
        id="queues"
        title={t('backoffice.performance.queues')}
        footer={t('backoffice.performance.queuesHint')}
      >
        {p.queues.length ? (
          <ListSection>
            {p.queues.map((q) => (
              <ListItem
                key={q.dbKey}
                leading={<Gauge aria-hidden />}
                title={t('backoffice.performance.database', { key: q.dbKey })}
                subtitle={
                  <>
                    <span className="block">
                      {t('backoffice.performance.queueLine', {
                        outbox: n(q.outboxPending),
                        queued: n(q.jobsQueued),
                        due: n(q.jobsDue),
                        running: n(q.jobsRunning),
                      })}
                    </span>
                    <span className="block">
                      {t('backoffice.performance.failedLine', {
                        hour: n(q.jobsFailed1h),
                        day: n(q.jobsFailed24h),
                      })}
                    </span>
                  </>
                }
                meta={
                  <>
                    <span className="block">{bytes(q.databaseBytes)}</span>
                    <span className="block">
                      {q.jobsOldestDueSeconds === null
                        ? t('backoffice.performance.noneDue')
                        : t('backoffice.performance.oldestLine', { age: age(q.jobsOldestDueSeconds) })}
                    </span>
                  </>
                }
              />
            ))}
          </ListSection>
        ) : (
          <p className="rounded-lg bg-surface-raised p-5 text-callout text-text-secondary shadow-sm">
            {t('backoffice.performance.noQueueSample')}
          </p>
        )}
      </DashboardSection>

      <ListSection
        id="incidents"
        title={t('backoffice.performance.incidents')}
        description={t('backoffice.performance.incidentsHint')}
        action={
          <Link href="/backoffice/status" className="text-callout font-semibold">
            {t('backoffice.performance.manage')}
          </Link>
        }
      >
        {p.incidents.length ? (
          p.incidents.map((i) => (
            <ListItem
              key={i.id}
              leading={<AlertTriangle aria-hidden />}
              title={i.title}
              subtitle={t('backoffice.performance.incidentLine', {
                status: t(`statusPage.postStatus.${i.status}`),
                at: formatDateTime(i.startedAt, locale, 'UTC'),
              })}
              meta={
                i.resolvedAt
                  ? t('backoffice.performance.resolved', { at: formatDateTime(i.resolvedAt, locale, 'UTC') })
                  : t(`backoffice.performance.impact.${i.impact}`)
              }
            />
          ))
        ) : (
          <ListItem title={t('backoffice.performance.noIncidents')} />
        )}
      </ListSection>
    </>
  );
}
