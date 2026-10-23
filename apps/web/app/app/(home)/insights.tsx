'use client';
import * as React from 'react';
import { IntentLink as Link } from '@/components/intent-link';
import { CalendarCheck, ChevronDown, UserPlus, Users, UserRoundPlus } from 'lucide-react';
import {
  BarList,
  ColumnChart,
  DonutChart,
  KpiTile,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  cn,
  focusRing,
  foldOther,
  type ChartDatum,
} from '@thapsus/ui';
import { dateTimeFormat, numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { RESTRICTED, outOn, type LeaveCalendar, type PeopleInsights } from '@/lib/dashboard-data';
import { Panel } from '@/components/dashboard/parts';
import { WhosOut } from '@/components/dashboard/whos-out';

/** Employment types in a fixed order, so a type keeps its series colour from one visit to the next. */
const TYPE_ORDER = ['full_time', 'part_time', 'casual', 'contractor', 'intern'];
/** Bars in the department list before the rest fold into "Other" (one series, one colour). */
const DEPARTMENT_BARS = 8;

const monthDate = (m: string) => new Date(`${m}T00:00:00Z`);

/**
 * Team or company insights on Home: headline numbers, joiners by month, employment types, headcount
 * by department and who is out. Each widget appears only when the viewer's permissions let the API
 * answer it; a refused or failed request hides the widget instead of showing it broken.
 */
function InsightsImpl({
  insights,
  insightsFailed,
  showInsights,
  calendar,
  showCalendar,
  today,
}: {
  insights: PeopleInsights | undefined;
  insightsFailed: boolean;
  showInsights: boolean;
  calendar: LeaveCalendar | undefined;
  showCalendar: boolean;
  today: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const n = (v: number) => numberFormat(locale).format(v);
  const charts = showInsights && !insightsFailed;

  const outToday = calendar && today ? outOn(calendar.entries, today, true).length : 0;
  const outWeek = calendar
    ? new Set(calendar.entries.filter((e) => e.status === 'approved').map((e) => e.employeeId)).size
    : 0;
  const joinersTotal = insights?.joiners.reduce((s, m) => s + m.value, 0) ?? 0;
  const thisMonth = insights?.joiners[insights.joiners.length - 1]?.value ?? 0;

  const kpis: React.ReactNode[] = [];
  if (charts) {
    if (!insights) for (let i = 0; i < 3; i++) kpis.push(<Skeleton key={`k${i}`} className="h-32 w-full" />);
    else
      kpis.push(
        <KpiTile
          key="headcount"
          label={t('dashboard.org.headcount')}
          value={n(insights.status.active)}
          hint={t('dashboard.org.headcountHint')}
          icon={<Users aria-hidden />}
          href="/app/people"
          linkAs={Link}
        />,
        <KpiTile
          key="joiners"
          label={t('dashboard.org.joiners')}
          value={n(thisMonth)}
          hint={t('dashboard.org.joinersHint', { n: n(joinersTotal) })}
          icon={<UserPlus aria-hidden />}
        />,
        <KpiTile
          key="prestart"
          label={t('dashboard.org.preStart')}
          value={n(insights.status.pre_start)}
          hint={t('dashboard.org.preStartHint')}
          icon={<UserRoundPlus aria-hidden />}
          href="/app/people?status=pre_start"
          linkAs={Link}
        />,
      );
  }
  if (showCalendar)
    kpis.push(
      calendar ? (
        <KpiTile
          key="out"
          label={t('dashboard.org.outToday')}
          value={n(outToday)}
          hint={t('dashboard.org.outTodayHint', { n: n(outWeek) })}
          icon={<CalendarCheck aria-hidden />}
          href="/app/time"
          linkAs={Link}
        />
      ) : (
        <Skeleton key="out" className="h-32 w-full" />
      ),
    );

  const short = (m: string) =>
    dateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(monthDate(m));
  const long = (m: string) =>
    dateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate(m));
  const joinersChart = (months: PeopleInsights['joiners']) => (
    <ColumnChart
      label={t('dashboard.org.joinersChartLabel', {
        from: long(months[0]!.month),
        to: long(months[months.length - 1]!.month),
      })}
      categories={months.map((m) => short(m.month))}
      series={[
        { key: 'joiners', label: t('dashboard.org.joinersSeries'), values: months.map((m) => m.value) },
      ]}
      format={n}
      integer
      height={160}
    />
  );

  const typeLabel = (k: string | null) =>
    k === null
      ? t('dashboard.org.notSet')
      : k === RESTRICTED
        ? t('dashboard.org.restricted')
        : t(`reports.enum.employmentType.${k}`);
  const types: ChartDatum[] = (insights?.byType ?? []).map((d) => ({
    label: typeLabel(d.key),
    value: d.value,
  }));
  const typeKey = new Map((insights?.byType ?? []).map((d) => [typeLabel(d.key), d.key]));
  const rank = (label: string) => {
    const k = typeKey.get(label);
    const i = k ? TYPE_ORDER.indexOf(k) : -1;
    return i >= 0 ? i : TYPE_ORDER.length;
  };
  const typeSlices = foldOther(types, t('dashboard.org.other')).sort((a, b) => rank(a.label) - rank(b.label));
  const activeTotal = insights?.status.active ?? 0;
  const typesReadable = (insights?.byType ?? []).some((d) => d.key !== RESTRICTED);

  const departments = foldOther(
    (insights?.byDepartment ?? []).map((d) => ({
      label:
        d.key === null
          ? t('dashboard.org.noDepartment')
          : d.key === RESTRICTED
            ? t('dashboard.org.restricted')
            : d.key,
      value: d.value,
    })),
    t('dashboard.org.other'),
    DEPARTMENT_BARS,
  );

  return (
    <div className="flex flex-col gap-4">
      {kpis.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{kpis}</div> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {charts ? (
          <Panel
            level={3}
            title={t('dashboard.org.joinersChart')}
            description={
              insights
                ? t('dashboard.org.joinersChartHint', { n: n(joinersTotal), count: joinersTotal })
                : undefined
            }
            className="lg:col-span-2"
            data-testid="joiners-chart"
          >
            {!insights ? (
              <Skeleton className="h-48 w-full" />
            ) : joinersTotal === 0 ? (
              <p className="text-callout text-text-secondary">{t('dashboard.org.noJoiners')}</p>
            ) : (
              <>
                {/* six months on phones, where twelve labels would not fit; twelve from the small breakpoint */}
                <div className="sm:hidden">{joinersChart(insights.joiners.slice(-6))}</div>
                <div className="hidden sm:block">{joinersChart(insights.joiners)}</div>
                <details className="group">
                  <summary
                    className={cn(
                      'inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-callout font-semibold text-accent [&::-webkit-details-marker]:hidden',
                      focusRing,
                    )}
                  >
                    <ChevronDown
                      aria-hidden
                      className="h-4 w-4 stroke-[1.5] transition-transform duration-[var(--duration-fast)] group-open:rotate-180"
                    />
                    {t('dashboard.org.showTable')}
                  </summary>
                  <div className="mt-3">
                    <Table dense scrollLabel={t('dashboard.org.joinersChart')}>
                      <THead>
                        <tr>
                          <TH>{t('dashboard.org.month')}</TH>
                          <TH className="text-right">{t('dashboard.org.joinersSeries')}</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {insights.joiners.map((m) => (
                          <TR key={m.month}>
                            <TD>{long(m.month)}</TD>
                            <TD className="text-right">{n(m.value)}</TD>
                          </TR>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </details>
              </>
            )}
          </Panel>
        ) : null}
        {charts && (!insights || typesReadable) ? (
          <Panel
            level={3}
            title={t('dashboard.org.byType')}
            description={t('dashboard.org.typeHint')}
            data-testid="type-chart"
          >
            {!insights ? (
              <Skeleton className="h-36 w-full" />
            ) : activeTotal === 0 ? (
              <p className="text-callout text-text-secondary">{t('dashboard.org.noPeople')}</p>
            ) : (
              <DonutChart
                items={typeSlices}
                label={t('dashboard.org.byType')}
                centerValue={n(activeTotal)}
                centerLabel={t('dashboard.org.people', { count: activeTotal })}
                format={n}
              />
            )}
          </Panel>
        ) : null}
        {charts ? (
          <Panel level={3} title={t('dashboard.org.byDepartment')} data-testid="department-chart">
            {!insights ? (
              <Skeleton className="h-40 w-full" />
            ) : departments.length === 0 ? (
              <p className="text-callout text-text-secondary">{t('dashboard.org.noPeople')}</p>
            ) : (
              <BarList items={departments} label={t('dashboard.org.byDepartment')} format={n} />
            )}
          </Panel>
        ) : null}
        {showCalendar && today ? (
          <WhosOut
            calendar={calendar}
            today={today}
            level={3}
            className={charts ? 'lg:col-span-2' : 'lg:col-span-3'}
            link={{ href: '/app/time', label: t('dashboard.out.open') }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Re-renders only when its own props change (the page around it re-renders as each request lands). */
export const Insights = React.memo(InsightsImpl);
