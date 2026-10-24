'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Activity,
  BadgePercent,
  Building2,
  CalendarClock,
  ExternalLink,
  LifeBuoy,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { BarList, DonutChart, KpiTile, Skeleton, TabNav, foldOther, type ChartDatum } from '@thapsus/ui';
import { dateTimeFormat, formatDateTime, formatMoney, numberFormat, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { Panel } from '@/components/dashboard/parts';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { ChartWithTable, DashboardSection } from '../charts';
import { PageTitle, useStaff } from '../ui';

/** Counts the API returns per key (plan, status, region); `key` null means "none yet". */
interface Count {
  key: string | null;
  count: number;
}
interface Week {
  weekStart: string;
  count: number;
}
interface CellMetrics {
  cell: string;
  generatedAt: string;
  snapshot: { oldest: string | null; newest: string | null; missing: number };
  companies: {
    total: number;
    new7d: number;
    new30d: number;
    byStatus: Count[];
    byPlan: Count[];
    byBillingStatus: Count[];
  };
  signups: Week[];
  trials: {
    active: number;
    endingSoon: number;
    endingSoonDays: number;
    ended: number;
    converted: number;
    conversionBasisPoints: number | null;
  };
  churn: { cancelled: number; cancelled30d: number; closing: number };
  usage: {
    activeUsers7d: number;
    activeUsers30d: number;
    users: number;
    usersWithMfa: number;
    employees: number;
  };
  revenue: Array<{ currency: string; mrrMinor: number; arrMinor: number }>;
  support: { openTickets: number; slaAtRisk: number; slaBreached: number };
  contracts: { active: number; renewalsDue: number };
  incidents: { active: number };
}
interface GlobalMetrics {
  thisCell: string;
  regions: Array<{
    region: string;
    total: number;
    new7d: number;
    new30d: number;
    signups: Week[];
    byPlan: Count[];
    byStatus: Count[];
    appUrl: string;
  }>;
}

const REGIONS = ['uk', 'eu', 'us'] as const;
/** Billing statuses in a fixed order, so a status keeps its series colour from one visit to the next. */
const BILLING_ORDER = ['trialing', 'active', 'past_due', 'trial_expired', 'incomplete', 'canceled', null];

/** Formatters shared by the two views. */
function useFormat() {
  const t = useT();
  const locale = useLocale() as Locale;
  return React.useMemo(() => {
    const date = (opts: Intl.DateTimeFormatOptions) => (d: string) =>
      dateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
    return {
      t,
      locale,
      n: (v: number) => numberFormat(locale).format(v),
      pct: (bp: number) =>
        numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000),
      weekShort: date({ day: 'numeric', month: 'short' }),
      weekLong: date({ day: 'numeric', month: 'long', year: 'numeric' }),
      planLabel: (k: string | null) =>
        k === null
          ? t('backoffice.metrics.plan.none')
          : k === 'trial'
            ? t('backoffice.metrics.plan.trial')
            : t(`pricing.plans.${k}.name`),
      regionShort: (r: string) => t(`backoffice.metrics.regionShort.${r}`),
    };
  }, [t, locale]);
}

/**
 * The founder's console home (ADR-0175): how Thapsus-HR is doing, by region. This cell's region shows its
 * own figures (registry, usage snapshot, support queue, contracts, status page); "All regions" and the
 * other regions show only what the global directory holds (region, plan, status, sign-up date), with a
 * link to that region's own back office for the rest. Nothing here is personal data.
 */
export default function BackofficeHome() {
  const f = useFormat();
  const { t } = f;
  const staff = useStaff();
  const params = useSearchParams();
  const cell = staff?.cell ?? 'uk';
  const asked = params.get('region');
  const region =
    asked === 'all' || (REGIONS as readonly string[]).includes(asked ?? '') ? (asked as string) : cell;
  const local = region === cell;
  const m = useApi<CellMetrics>(local ? '/v1/backoffice/metrics' : null);
  const g = useApi<GlobalMetrics>(local ? null : '/v1/backoffice/metrics/global');

  const tabs = [
    { key: 'all', label: t('backoffice.metrics.allRegions') },
    ...REGIONS.map((r) => ({ key: r, label: f.regionShort(r) })),
  ].map((x) => ({ href: `/backoffice?region=${x.key}`, label: x.label, active: x.key === region }));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageTitle title={t('backoffice.metrics.title')} lead={t('backoffice.metrics.lead')} />
        <TabNav
          tabs={tabs}
          label={t('backoffice.metrics.regionsLabel')}
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
        {local ? (
          <p className="text-footnote text-text-secondary">
            {t('backoffice.metrics.thisCell', { region: t(`regions.${cell}`) })}
          </p>
        ) : null}
      </div>
      {local ? (
        m.data ? (
          <CellOverview m={m.data} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )
      ) : g.data ? (
        <GlobalOverview g={g.data} region={region} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
      <p className="text-footnote text-text-secondary">{t('backoffice.metrics.privacy')}</p>
    </div>
  );
}

function CellOverview({ m }: { m: CellMetrics }) {
  const { t, locale, n, pct, weekShort, weekLong, planLabel } = useFormat();
  const plans: ChartDatum[] = m.companies.byPlan.map((c) => ({ label: planLabel(c.key), value: c.count }));
  const billing: ChartDatum[] = foldOther(
    [...m.companies.byBillingStatus]
      .sort((a, b) => BILLING_ORDER.indexOf(a.key) - BILLING_ORDER.indexOf(b.key))
      .map((c) => ({
        label: c.key ? t(`billing.status.${c.key}`) : t('backoffice.metrics.billingStatusNone'),
        value: c.count,
      })),
    t('backoffice.metrics.other'),
  );
  const signupTotal = m.signups.reduce((s, w) => s + w.count, 0);
  const snapshotNote = m.snapshot.newest
    ? `${t('backoffice.metrics.snapshot', {
        at: formatDateTime(m.snapshot.oldest ?? m.snapshot.newest, locale, 'UTC'),
      })}${m.snapshot.missing ? ` ${t('backoffice.metrics.snapshotMissing', { count: m.snapshot.missing })}` : ''}`
    : m.snapshot.missing
      ? t('backoffice.metrics.snapshotMissing', { count: m.snapshot.missing })
      : undefined;
  return (
    <>
      <DashboardSection id="companies" title={t('backoffice.metrics.sections.companies')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label={t('backoffice.metrics.companies')}
            value={n(m.companies.total)}
            hint={t('backoffice.metrics.companiesHint', { count: m.companies.new30d })}
            icon={<Building2 aria-hidden />}
            href="/backoffice/tenants"
            linkAs={Link}
          />
          <KpiTile
            label={t('backoffice.metrics.new7d')}
            value={n(m.companies.new7d)}
            hint={t('backoffice.metrics.new7dHint')}
            icon={<UserPlus aria-hidden />}
            href="/backoffice/tenants?sort=created"
            linkAs={Link}
          />
          <KpiTile
            label={t('backoffice.metrics.trialsEnding')}
            value={n(m.trials.endingSoon)}
            hint={t('backoffice.metrics.trialsEndingHint', {
              count: m.trials.endingSoonDays,
              active: n(m.trials.active),
            })}
            icon={<CalendarClock aria-hidden />}
            href="/backoffice/tenants?trial=ending"
            linkAs={Link}
          />
          <KpiTile
            label={t('backoffice.metrics.conversion')}
            value={m.trials.conversionBasisPoints === null ? '—' : pct(m.trials.conversionBasisPoints)}
            hint={
              m.trials.conversionBasisPoints === null
                ? t('backoffice.metrics.conversionNone')
                : t('backoffice.metrics.conversionHint', {
                    converted: n(m.trials.converted),
                    ended: n(m.trials.ended),
                  })
            }
            icon={<BadgePercent aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.cancelled')}
            value={n(m.churn.cancelled)}
            hint={t('backoffice.metrics.cancelledHint', { count: m.churn.cancelled30d })}
            icon={<UserMinus aria-hidden />}
            href="/backoffice/tenants?status=cancelled"
            linkAs={Link}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            level={3}
            title={t('backoffice.metrics.signupsChart')}
            description={t('backoffice.metrics.signupsChartHint')}
            className="lg:col-span-2"
            data-testid="signups-chart"
          >
            {signupTotal === 0 ? (
              <p className="text-callout text-text-secondary">{t('backoffice.metrics.noData')}</p>
            ) : (
              <ChartWithTable
                label={t('backoffice.metrics.signupsChartLabel', {
                  from: weekLong(m.signups[0]!.weekStart),
                  to: weekLong(m.signups[m.signups.length - 1]!.weekStart),
                })}
                categories={m.signups.map((w) => weekShort(w.weekStart))}
                tableCategories={m.signups.map((w) => weekLong(w.weekStart))}
                series={[
                  {
                    key: 'signups',
                    label: t('backoffice.metrics.signupsSeries'),
                    values: m.signups.map((w) => w.count),
                  },
                ]}
                format={n}
                integer
                showTable={t('backoffice.metrics.showTable')}
                categoryHeading={t('backoffice.metrics.week')}
              />
            )}
          </Panel>
          <Panel level={3} title={t('backoffice.metrics.byBillingStatus')} data-testid="billing-chart">
            {billing.length === 0 ? (
              <p className="text-callout text-text-secondary">{t('backoffice.metrics.noData')}</p>
            ) : (
              <DonutChart
                items={billing}
                label={t('backoffice.metrics.byBillingStatus')}
                centerValue={n(m.companies.total - m.snapshot.missing)}
                centerLabel={t('backoffice.metrics.companies')}
                format={n}
              />
            )}
          </Panel>
          <Panel
            level={3}
            title={t('backoffice.metrics.byPlan')}
            description={t('backoffice.metrics.byPlanHint')}
            className="lg:col-span-3"
          >
            {plans.length === 0 ? (
              <p className="text-callout text-text-secondary">{t('backoffice.metrics.noData')}</p>
            ) : (
              <BarList items={plans} label={t('backoffice.metrics.byPlan')} format={n} />
            )}
          </Panel>
        </div>
      </DashboardSection>

      <DashboardSection
        id="revenue"
        title={t('backoffice.metrics.sections.revenue')}
        footer={t('backoffice.metrics.revenueHint')}
      >
        {m.revenue.length === 0 ? (
          <p className="rounded-lg bg-surface-raised p-5 text-callout text-text-secondary shadow-sm">
            {t('backoffice.metrics.noRevenue')}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {m.revenue.map((r) => (
              <KpiTile
                key={r.currency}
                label={t('backoffice.metrics.mrrIn', { currency: r.currency })}
                value={formatMoney(money(r.mrrMinor, r.currency), locale)}
                hint={t('backoffice.metrics.mrrHint', {
                  arr: formatMoney(money(r.arrMinor, r.currency), locale),
                })}
                icon={<Wallet aria-hidden />}
              />
            ))}
          </div>
        )}
      </DashboardSection>

      <DashboardSection id="usage" title={t('backoffice.metrics.sections.usage')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t('backoffice.metrics.activeUsers7d')}
            value={n(m.usage.activeUsers7d)}
            hint={t('backoffice.metrics.activeUsers7dHint')}
            icon={<Users aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.activeUsers30d')}
            value={n(m.usage.activeUsers30d)}
            hint={t('backoffice.metrics.activeUsers30dHint', { count: m.usage.users })}
            icon={<UsersRound aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.employees')}
            value={n(m.usage.employees)}
            hint={t('backoffice.metrics.employeesHint')}
            icon={<Building2 aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.mfaAdoption')}
            value={m.usage.users ? pct(Math.round((m.usage.usersWithMfa * 10000) / m.usage.users)) : '—'}
            hint={t('backoffice.metrics.mfaAdoptionHint', {
              withMfa: n(m.usage.usersWithMfa),
              users: n(m.usage.users),
            })}
            icon={<ShieldCheck aria-hidden />}
          />
        </div>
      </DashboardSection>

      <DashboardSection id="service" title={t('backoffice.metrics.sections.service')} footer={snapshotNote}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label={t('backoffice.metrics.openTickets')}
            value={n(m.support.openTickets)}
            hint={t('backoffice.metrics.openTicketsHint', {
              atRisk: n(m.support.slaAtRisk),
              breached: n(m.support.slaBreached),
            })}
            icon={<LifeBuoy aria-hidden />}
            href="/backoffice/support"
            linkAs={Link}
          />
          <KpiTile
            label={t('backoffice.metrics.incidents')}
            value={n(m.incidents.active)}
            hint={t('backoffice.metrics.incidentsHint')}
            icon={<Activity aria-hidden />}
            href="/backoffice/status"
            linkAs={Link}
          />
          <KpiTile
            label={t('backoffice.metrics.renewals')}
            value={n(m.contracts.renewalsDue)}
            hint={t('backoffice.metrics.renewalsHint', { count: m.contracts.active })}
            icon={<CalendarClock aria-hidden />}
            href="/backoffice/plans"
            linkAs={Link}
          />
        </div>
      </DashboardSection>
    </>
  );
}

function GlobalOverview({ g, region }: { g: GlobalMetrics; region: string }) {
  const { t, n, weekShort, weekLong, planLabel, regionShort } = useFormat();
  const shown = region === 'all' ? g.regions : g.regions.filter((r) => r.region === region);
  const sum = (k: 'total' | 'new7d' | 'new30d') => shown.reduce((s, r) => s + r[k], 0);
  const weeks = g.regions[0]?.signups.map((w) => w.weekStart) ?? [];
  const plans = new Map<string | null, number>();
  for (const r of shown) for (const c of r.byPlan) plans.set(c.key, (plans.get(c.key) ?? 0) + c.count);
  const planItems: ChartDatum[] = [...plans.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: planLabel(k), value: v }));
  const one = region === 'all' ? null : shown[0];
  const signupTotal = shown.reduce((s, r) => s + r.signups.reduce((x, w) => x + w.count, 0), 0);
  return (
    <>
      <DashboardSection
        id="companies"
        title={t('backoffice.metrics.sections.companies')}
        footer={t('backoffice.metrics.globalNote')}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiTile
            label={t('backoffice.metrics.companies')}
            value={n(sum('total'))}
            icon={<Building2 aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.new7d')}
            value={n(sum('new7d'))}
            hint={t('backoffice.metrics.new7dHint')}
            icon={<UserPlus aria-hidden />}
          />
          <KpiTile
            label={t('backoffice.metrics.new30d')}
            value={n(sum('new30d'))}
            icon={<UserPlus aria-hidden />}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            level={3}
            title={
              region === 'all'
                ? t('backoffice.metrics.signupsRegionsChart')
                : t('backoffice.metrics.signupsChart')
            }
            description={t('backoffice.metrics.signupsChartHint')}
            className="lg:col-span-2"
            data-testid="signups-chart"
          >
            {signupTotal === 0 || !weeks.length ? (
              <p className="text-callout text-text-secondary">{t('backoffice.metrics.noData')}</p>
            ) : (
              <ChartWithTable
                label={t('backoffice.metrics.signupsChartLabel', {
                  from: weekLong(weeks[0]!),
                  to: weekLong(weeks[weeks.length - 1]!),
                })}
                categories={weeks.map(weekShort)}
                tableCategories={weeks.map(weekLong)}
                // one series per region in a fixed order (UK, EU, US), so a region keeps its colour
                series={shown.map((r) => ({
                  key: r.region,
                  label: regionShort(r.region),
                  values: r.signups.map((w) => w.count),
                }))}
                stacked={shown.length > 1}
                format={n}
                integer
                showTable={t('backoffice.metrics.showTable')}
                categoryHeading={t('backoffice.metrics.week')}
              />
            )}
          </Panel>
          {region === 'all' ? (
            <Panel level={3} title={t('backoffice.metrics.byRegion')}>
              <BarList
                items={g.regions.map((r) => ({ label: t(`regions.${r.region}`), value: r.total }))}
                label={t('backoffice.metrics.byRegion')}
                format={n}
              />
            </Panel>
          ) : null}
          <Panel
            level={3}
            title={t('backoffice.metrics.byPlan')}
            className={region === 'all' ? 'lg:col-span-3' : undefined}
          >
            {planItems.length === 0 ? (
              <p className="text-callout text-text-secondary">{t('backoffice.metrics.noData')}</p>
            ) : (
              <BarList items={planItems} label={t('backoffice.metrics.byPlan')} format={n} />
            )}
          </Panel>
        </div>
      </DashboardSection>
      {one && one.region !== g.thisCell ? (
        <div className="flex flex-col gap-3 rounded-lg bg-surface-raised p-5 shadow-sm sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-callout">
            {t('backoffice.metrics.elsewhere', { region: t(`regions.${one.region}`) })}
          </p>
          <a
            href={`${one.appUrl}/backoffice`}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 self-start rounded-pill border border-border px-5 text-callout font-semibold text-text no-underline hover:bg-surface sm:h-10 sm:self-auto"
          >
            {t('backoffice.metrics.openRegion', { region: regionShort(one.region) })}
            <ExternalLink aria-hidden className="h-4 w-4 stroke-[1.5]" />
          </a>
        </div>
      ) : null}
    </>
  );
}
