'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Building2, Globe2 } from 'lucide-react';
import { Badge, Input, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDate, type Locale } from '@thapsus/core/i18n';
import { instantToDate } from '@thapsus/core/time';
import { useApi, useDebounced } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass, useStaff } from '../ui';

interface CellTenant {
  tenantId: string;
  slug: string;
  region: string;
  status: string;
  createdAt: string;
  planId: string | null;
  billingStatus: string | null;
  usage: { headcount: number; activeUsers: number; storageBytes: number; computedAt: string } | null;
  contractReference: string | null;
  trialEndsAt: string | null;
  lastActivityAt: string | null;
  activeUsers7d: number | null;
  breachedTickets: number;
  health: { level: 'good' | 'watch' | 'risk' | 'unknown'; reasons: string[] };
}
interface DirectoryRow {
  tenantId: string;
  slug: string;
  region: string;
  status: string;
  planRef: string | null;
  createdAt: string | null;
  detailUrl: string;
}

const REGIONS = ['uk', 'eu', 'us'] as const;
const PLANS = ['core', 'plus', 'enterprise'] as const;
const HEALTH_TONE = { good: 'success', watch: 'warning', risk: 'danger', unknown: 'neutral' } as const;
const LIMIT = 500;

/**
 * Companies (ADR-0175): every customer, searchable and filtered by region, plan, status, trial and health.
 * This cell's region lists usage totals and a health signal from the snapshot; other regions list what the
 * global directory holds, and their rows open that region's own back office. Filters live in the URL, so the
 * overview's tiles link straight to a filtered list.
 */
export default function TenantsPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const staff = useStaff();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const cell = staff?.cell ?? 'uk';
  const get = (k: string, d = '') => params.get(k) ?? d;
  const region = get('region', cell);
  const local = region === cell;
  const [q, setQ] = React.useState(get('q'));
  const dq = useDebounced(q);

  const set = React.useCallback(
    (k: string, v: string) => {
      const next = new URLSearchParams(params.toString());
      if (v) next.set(k, v);
      else next.delete(k);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );
  React.useEffect(() => {
    // only the debounced search writes to the URL
    if (dq !== (params.get('q') ?? '')) set('q', dq);
  }, [dq, params, set]);

  const query = (keys: string[]) => {
    const u = new URLSearchParams();
    for (const k of keys) if (get(k)) u.set(k, get(k));
    return u.toString();
  };
  const cellList = useApi<CellTenant[]>(
    local ? `/v1/backoffice/tenants?${query(['q', 'plan', 'status', 'trial', 'health', 'sort'])}` : null,
  );
  const dirStatus = get('status') === 'cancelled' ? 'closing' : get('status');
  const dirList = useApi<DirectoryRow[]>(
    local
      ? null
      : `/v1/backoffice/tenants/all-regions?${new URLSearchParams({
          ...(get('q') ? { q: get('q') } : {}),
          ...(region !== 'all' ? { region } : {}),
          ...(get('plan') ? { plan: get('plan') } : {}),
          ...(dirStatus ? { status: dirStatus } : {}),
        }).toString()}`,
  );

  const date = (iso: string) => formatDate(instantToDate(iso, 'UTC'), locale, 'medium');
  const regionShort = (r: string) => t(`backoffice.metrics.regionShort.${r}`);
  const planName = (k: string | null) =>
    !k
      ? t('backoffice.tenants.planNone')
      : k === 'trial'
        ? t('backoffice.tenants.planTrial')
        : t(`pricing.plans.${k}.name`);
  const rows = local ? cellList.data : dirList.data;
  const filter = (
    id: string,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange = (v: string) => set(id, v),
  ) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`bo-${id}`} className="text-footnote font-semibold text-text-secondary">
        {label}
      </label>
      <select
        id={`bo-${id}`}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={t('backoffice.tenants.title')} lead={t('backoffice.tenants.lead')} />
      <section aria-label={t('backoffice.tenants.filters')} className="flex flex-col gap-3">
        <div className="max-w-md">
          <label htmlFor="tenant-q" className="sr-only">
            {t('backoffice.tenants.search')}
          </label>
          <Input
            id="tenant-q"
            type="search"
            placeholder={t('backoffice.tenants.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {filter(
            'region',
            t('backoffice.tenants.filterRegion'),
            region,
            [
              ['all', t('backoffice.tenants.allRegionsOption')],
              ...REGIONS.map((r): [string, string] => [
                r,
                r === cell
                  ? t('backoffice.tenants.thisRegionOption', { region: regionShort(r) })
                  : regionShort(r),
              ]),
            ],
            (v) => set('region', v === cell ? '' : v),
          )}
          {filter('plan', t('backoffice.tenants.filterPlan'), get('plan'), [
            ['', t('backoffice.tenants.any')],
            ...PLANS.map((p): [string, string] => [p, t(`pricing.plans.${p}.name`)]),
            ...(local ? [] : [['trial', t('backoffice.tenants.planTrial')] as [string, string]]),
            ['none', t('backoffice.tenants.planNone')],
          ])}
          {filter('status', t('backoffice.tenants.filterStatus'), get('status'), [
            ['', t('backoffice.tenants.statusAll')],
            ...(['active', 'suspended', 'closing'] as const).map((s): [string, string] => [
              s,
              t(`backoffice.tenants.regionStatus.${s}`),
            ]),
            ['cancelled', t('backoffice.tenants.statusCancelled')],
          ])}
          {local
            ? filter('trial', t('backoffice.tenants.filterTrial'), get('trial'), [
                ['', t('backoffice.tenants.any')],
                ['active', t('backoffice.tenants.trialActive')],
                ['ending', t('backoffice.tenants.trialEnding')],
                ['ended', t('backoffice.tenants.trialEnded')],
              ])
            : null}
          {local
            ? filter('health', t('backoffice.tenants.filterHealth'), get('health'), [
                ['', t('backoffice.tenants.any')],
                ...(['risk', 'watch', 'good', 'unknown'] as const).map((h): [string, string] => [
                  h,
                  t(`backoffice.tenants.health.level.${h}`),
                ]),
              ])
            : null}
          {local
            ? filter('sort', t('backoffice.tenants.sortBy'), get('sort', 'slug'), [
                ['slug', t('backoffice.tenants.sort.slug')],
                ['created', t('backoffice.tenants.sort.created')],
                ['activity', t('backoffice.tenants.sort.activity')],
                ['health', t('backoffice.tenants.sort.health')],
              ])
            : null}
        </div>
      </section>

      {!rows ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg bg-surface-raised p-5 text-callout text-text-secondary shadow-sm">
          {t('backoffice.tenants.none')}
        </p>
      ) : (
        <ListSection
          id="companies"
          title={t('backoffice.tenants.count', { count: rows.length })}
          footer={rows.length >= LIMIT ? t('backoffice.tenants.limitNote') : undefined}
        >
          {local
            ? (rows as CellTenant[]).map((r) => (
                <ListItem
                  key={r.tenantId}
                  href={`/backoffice/tenants/${r.tenantId}`}
                  linkAs={Link}
                  leading={<Building2 aria-hidden />}
                  title={r.slug}
                  subtitle={
                    <>
                      <span>
                        {[
                          planName(r.planId),
                          r.billingStatus ? t(`billing.status.${r.billingStatus}`) : null,
                          r.status !== 'active' ? t(`backoffice.tenants.regionStatus.${r.status}`) : null,
                          t('backoffice.tenants.created', { date: date(r.createdAt) }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {r.health.reasons.length ? (
                        <span className="block">
                          {r.health.reasons
                            .map((x) => t(`backoffice.tenants.health.reason.${x}`))
                            .join(' · ')}
                        </span>
                      ) : null}
                    </>
                  }
                  meta={
                    r.usage ? (
                      <>
                        <span className="block">
                          {t('backoffice.tenants.employees', { count: r.usage.headcount })} ·{' '}
                          {t('backoffice.tenants.activeThisWeek', { count: r.activeUsers7d ?? 0 })}
                        </span>
                        <span className="block">
                          {r.lastActivityAt
                            ? t('backoffice.tenants.lastActive', { date: date(r.lastActivityAt) })
                            : t('backoffice.tenants.neverActive')}
                        </span>
                      </>
                    ) : (
                      t('backoffice.tenants.noSnapshot')
                    )
                  }
                  accessory={
                    <Badge tone={HEALTH_TONE[r.health.level]}>
                      <span className="sr-only">
                        {t('backoffice.tenants.health.label', {
                          level: t(`backoffice.tenants.health.level.${r.health.level}`),
                        })}
                      </span>
                      <span aria-hidden>{t(`backoffice.tenants.health.level.${r.health.level}`)}</span>
                    </Badge>
                  }
                />
              ))
            : (rows as DirectoryRow[]).map((r) => {
                const here = r.region === cell;
                return (
                  <ListItem
                    key={r.tenantId}
                    href={r.detailUrl}
                    linkAs={here ? Link : undefined}
                    leading={here ? <Building2 aria-hidden /> : <Globe2 aria-hidden />}
                    title={r.slug}
                    subtitle={[
                      regionShort(r.region),
                      planName(r.planRef),
                      r.status !== 'active' ? t(`backoffice.tenants.regionStatus.${r.status}`) : null,
                      r.createdAt ? t('backoffice.tenants.created', { date: date(r.createdAt) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    meta={
                      here ? undefined : t('backoffice.tenants.elsewhere', { region: regionShort(r.region) })
                    }
                  />
                );
              })}
        </ListSection>
      )}
    </div>
  );
}
