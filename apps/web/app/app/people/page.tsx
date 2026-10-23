'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ListFilter,
  Lock,
  Network,
  Search,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FilterChip,
  Input,
  KpiTile,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Table,
  TableToolbar,
  TD,
  TH,
  THead,
  TR,
  buttonVariants,
  cn,
  focusRing,
} from '@thapsus/ui';
import { today as todayIn } from '@thapsus/core/time';
import { formatDate, numberFormat } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { useStatusCounts } from '@/lib/dashboard-data';
import { Avatar } from '@/components/dashboard/parts';
import { ExportLinks } from '@/components/export-links';
import { ModuleFrameContext, hasPermission, useSession } from '../shell';

interface Row {
  id: string;
  employeeNumber?: string;
  displayName?: string;
  jobTitle?: string | null;
  department?: string | null;
  location?: string | null;
  status?: string;
  startDate?: string;
}
interface Ref {
  id: string;
  name: string;
}

const STATUSES = ['active', 'pre_start', 'leaver', 'all'] as const;
type Status = (typeof STATUSES)[number];
const REFS = [
  {
    param: 'departmentId',
    label: 'people.field.department',
    any: 'people.dir.anyDepartment',
    path: 'departments',
  },
  { param: 'locationId', label: 'people.field.location', any: 'people.dir.anyLocation', path: 'locations' },
  { param: 'entityId', label: 'people.field.entity', any: 'people.dir.anyEntity', path: 'legal-entities' },
] as const;
type RefParam = (typeof REFS)[number]['param'];
const statusTone = { active: 'success', pre_start: 'accent', leaver: 'neutral' } as const;

type SortKey = 'name' | 'title' | 'department' | 'location' | 'startDate' | 'status';
const sortValue: Record<SortKey, (r: Row) => string> = {
  name: (r) => r.displayName ?? '',
  title: (r) => r.jobTitle ?? '',
  department: (r) => r.department ?? '',
  location: (r) => r.location ?? '',
  startDate: (r) => r.startDate ?? '',
  status: (r) => r.status ?? '',
};

/** The directory's filters live in the address (shareable; the KPI tiles set the status). */
function readFilters(params: URLSearchParams) {
  const s = params.get('status');
  return {
    status: (STATUSES as readonly string[]).includes(s ?? '') ? (s as Status) : 'active',
    q: params.get('q') ?? '',
    departmentId: params.get('departmentId') ?? '',
    locationId: params.get('locationId') ?? '',
    entityId: params.get('entityId') ?? '',
  };
}
type Filters = ReturnType<typeof readFilters>;

/** Replaces the query string without a navigation; Next.js keeps useSearchParams in step. */
function writeFilters(f: Filters) {
  const q = new URLSearchParams();
  if (f.status !== 'active') q.set('status', f.status);
  if (f.q) q.set('q', f.q);
  for (const r of REFS) if (f[r.param]) q.set(r.param, f[r.param]);
  const s = q.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}`);
}

/** A KPI tile link that applies its status filter in place (other filters stay). */
function StatusLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const status = new URL(href, window.location.href).searchParams.get('status') ?? 'active';
        writeFilters({
          ...readFilters(new URLSearchParams(window.location.search)),
          status: status as Status,
        });
      }}
    >
      {children}
    </a>
  );
}

export default function PeoplePage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession()!;
  const params = useSearchParams();
  const paramKey = params.toString();
  const filters = React.useMemo(() => readFilters(new URLSearchParams(paramKey)), [paramKey]);
  const n = (v: number) => numberFormat(locale).format(v);

  const [q, setQ] = React.useState(filters.q);
  const query = useDebounced(q);
  React.useEffect(() => {
    if (query !== filters.q) writeFilters({ ...filters, q: query });
    // only a newly typed query is written here; the other filters are written where they change
  }, [query]);

  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const canCreate = hasPermission(session, 'employees.create');
  // the rail hides the directory without this permission; opened directly, the page says why
  const canRead = hasPermission(session, 'employees.read');
  // without the directory tab the page may sit outside the People header, so it brings its own h1
  const inModule = React.useContext(ModuleFrameContext);

  const load = React.useCallback(
    async (after: string | null) => {
      const p = new URLSearchParams({ limit: '50', status: filters.status });
      if (filters.q) p.set('q', filters.q);
      for (const r of REFS) if (filters[r.param]) p.set(r.param, filters[r.param]);
      if (after) p.set('cursor', after);
      const page = await api<{ data: Row[]; nextCursor: string | null }>(`/v1/employees?${p}`);
      setRows((prev) => (after && prev ? [...prev, ...page.data] : page.data));
      setCursor(page.nextCursor);
    },
    [filters],
  );
  React.useEffect(() => {
    if (!canRead) return;
    setRows(null);
    void load(null).catch(() => setRows([]));
  }, [load, canRead]);

  // headline counts by status, where the viewer may run reports (the API scopes them)
  // dates come from the browser's clock after hydration (the server's clock never shows through)
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const zone = mounted ? viewerZone(session.timeZone) : null;
  const canReport = hasPermission(session, 'reports.run') || hasPermission(session, 'reports.read_team');
  const counts = useStatusCounts(zone ? todayIn(zone) : null, canReport && canRead);

  // filter choices (reference data everyone signed in may read), loaded once a filter needs them
  const [filterOpen, setFilterOpen] = React.useState(false);
  const needRefs = filterOpen || REFS.some((r) => !!filters[r.param]);
  const departments = useApi<Ref[]>(needRefs ? '/v1/org/departments' : null);
  const locations = useApi<Ref[]>(needRefs ? '/v1/org/locations' : null);
  const entities = useApi<Ref[]>(needRefs ? '/v1/org/legal-entities' : null);
  const refData: Record<RefParam, Ref[] | undefined> = {
    departmentId: departments.data,
    locationId: locations.data,
    entityId: entities.data,
  };
  const set = (next: Partial<Filters>) => writeFilters({ ...filters, ...next });

  const chips: Array<{ key: string; field: string; value: string; remove: () => void }> = [];
  if (filters.status !== 'all')
    chips.push({
      key: 'status',
      field: t('common.status'),
      value: t(`people.status.${filters.status}`),
      remove: () => set({ status: 'all' }),
    });
  for (const r of REFS)
    if (filters[r.param])
      chips.push({
        key: r.param,
        field: t(r.label),
        value: refData[r.param]?.find((x) => x.id === filters[r.param])?.name ?? '…',
        remove: () => set({ [r.param]: '' } as Partial<Filters>),
      });
  const activeFilters = chips.length;

  // Sorting is on the rows already loaded, so it is offered once the whole result is on screen;
  // until then the list keeps the API's order (by name).
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const sortable = !!rows && cursor === null && rows.length > 1;
  const shown = React.useMemo(() => {
    if (!rows || !sortable || (sort.key === 'name' && sort.dir === 'asc')) return rows;
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * collator.compare(sortValue[sort.key](a), sortValue[sort.key](b)));
  }, [rows, sortable, sort, locale]);
  const effectiveSort = sortable ? sort : { key: 'name' as const, dir: 'asc' as const };
  const head = (key: SortKey, label: string, className?: string) => {
    const active = effectiveSort.key === key;
    const Icon = !active ? ArrowUpDown : effectiveSort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <TH
        className={className}
        aria-sort={active ? (effectiveSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        {sortable ? (
          <button
            type="button"
            onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
            className={cn(
              '-mx-1 inline-flex min-h-8 items-center gap-1 rounded-sm px-1 hover:text-text',
              focusRing,
            )}
          >
            {label}
            <Icon aria-hidden className={cn('h-3.5 w-3.5 stroke-[1.5]', !active && 'opacity-60')} />
          </button>
        ) : (
          label
        )}
      </TH>
    );
  };

  const KPIS = [
    ['active', 'people.dir.kpiActiveHint'],
    ['pre_start', 'people.dir.kpiPreStartHint'],
    ['leaver', 'people.dir.kpiLeaverHint'],
  ] as const;
  const kpis = KPIS.map(([status, hint]) =>
    counts.data ? (
      <KpiTile
        key={status}
        label={t(`people.status.${status}`)}
        value={n(counts.data[status])}
        hint={t(hint)}
        href={`/app/people?status=${status}`}
        linkAs={StatusLink}
      />
    ) : (
      <Skeleton key={status} className="h-28 w-full" />
    ),
  );

  if (!canRead)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<Lock aria-hidden />}
        title={t('people.dir.noAccessTitle')}
        body={t('people.dir.noAccessBody', { permission: t('access.perm.employees.read') })}
        action={
          <Link
            href="/app/org-chart"
            className={cn(buttonVariants({ variant: 'secondary' }), 'no-underline')}
          >
            <Network aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('people.dir.openOrgChart')}
          </Link>
        }
      />
    );

  return (
    <div className="flex flex-col gap-5">
      {canReport && !counts.failed ? (
        <>
          <div className="hidden gap-3 sm:grid sm:grid-cols-3" data-testid="people-kpis">
            {kpis}
          </div>
          {/* phones: the same counts as one compact row, so the list starts on the first screen */}
          {counts.data ? (
            <ul className="flex flex-wrap gap-2 sm:hidden">
              {KPIS.map(([status]) => (
                <li key={status}>
                  <StatusLink
                    href={`/app/people?status=${status}`}
                    className={cn(
                      'inline-flex min-h-10 items-center gap-2 rounded-pill border border-border bg-surface-raised px-4 text-callout text-text no-underline',
                      focusRing,
                    )}
                  >
                    <span className="font-semibold tabular-nums">{n(counts.data![status])}</span>
                    {t(`people.status.${status}`)}
                  </StatusLink>
                </li>
              ))}
            </ul>
          ) : (
            <Skeleton className="h-10 w-full sm:hidden" />
          )}
        </>
      ) : null}
      <div className="rounded-lg border border-border bg-surface-raised pb-1">
        <TableToolbar
          title={t('people.dir.title')}
          count={
            rows
              ? t(cursor ? 'people.dir.showingMore' : 'people.dir.showing', {
                  n: n(rows.length),
                  count: rows.length,
                })
              : undefined
          }
          search={
            <label className="relative w-full sm:w-72">
              <span className="sr-only">{t('common.search')}</span>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 stroke-[1.5] text-text-secondary"
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('people.searchPlaceholder')}
                className="pl-9"
                type="search"
              />
            </label>
          }
          filters={
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button variant="secondary" size="sm">
                  <ListFilter aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('people.dir.addFilter')}
                  {activeFilters ? (
                    <>
                      <span
                        aria-hidden
                        className="rounded-full bg-accent-subtle px-1.5 text-footnote tabular-nums text-text"
                      >
                        {n(activeFilters)}
                      </span>
                      <span className="sr-only">{t('people.dir.applied', { n: n(activeFilters) })}</span>
                    </>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" aria-label={t('people.dir.filters')}>
                <div className="flex flex-col gap-3">
                  <p className="text-callout font-semibold">{t('people.dir.filters')}</p>
                  <Field id="filter-status" label={t('common.status')}>
                    {(p) => (
                      <select
                        {...p}
                        value={filters.status}
                        onChange={(e) => set({ status: e.target.value as Status })}
                        className="h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`people.status.${s}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  {REFS.map((r) => (
                    <Field key={r.param} id={`filter-${r.param}`} label={t(r.label)}>
                      {(p) => (
                        <select
                          {...p}
                          value={filters[r.param]}
                          onChange={(e) => set({ [r.param]: e.target.value } as Partial<Filters>)}
                          className="h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text"
                        >
                          <option value="">{t(r.any)}</option>
                          {(refData[r.param] ?? []).map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  ))}
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!activeFilters}
                      onClick={() => set({ status: 'all', departmentId: '', locationId: '', entityId: '' })}
                    >
                      {t('people.dir.clearFilters')}
                    </Button>
                    <PopoverClose asChild>
                      <Button size="sm">{t('people.dir.done')}</Button>
                    </PopoverClose>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          }
          actions={
            <>
              <ExportLinks
                list="employees"
                params={{
                  status: filters.status,
                  q: filters.q || undefined,
                  departmentId: filters.departmentId || undefined,
                  locationId: filters.locationId || undefined,
                  entityId: filters.entityId || undefined,
                }}
              />
              {canCreate ? (
                <Link href="/app/people/new" className={buttonVariants({ size: 'sm' }) + ' no-underline'}>
                  <UserPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('people.add')}
                </Link>
              ) : null}
            </>
          }
        />
        {chips.length ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3"
            data-testid="filter-chips"
          >
            {chips.map((c) => (
              <FilterChip
                key={c.key}
                label={t('people.dir.chip', { field: c.field, value: c.value })}
                removeLabel={t('people.dir.removeFilter', { field: c.field, value: c.value })}
                onRemove={c.remove}
              />
            ))}
            {chips.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set({ status: 'all', departmentId: '', locationId: '', entityId: '' })}
              >
                {t('people.dir.clearFilters')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {shown === null ? (
          <div className="p-4">
            <Skeleton className="h-96 w-full" />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <EmptyState
              level={3}
              icon={<Users aria-hidden />}
              title={t('people.empty')}
              body={activeFilters || filters.q ? t('people.dir.emptyBody') : undefined}
            />
          </div>
        ) : (
          <div className="[&>div]:rounded-none [&>div]:border-0">
            <Table scrollLabel={t('people.dir.tableLabel')}>
              <THead>
                <tr>
                  {head('name', t('people.col.name'))}
                  {head('title', t('people.col.title'), 'hidden sm:table-cell')}
                  {head('department', t('people.col.department'), 'hidden md:table-cell')}
                  {head('location', t('people.col.location'), 'hidden lg:table-cell')}
                  {head('startDate', t('people.field.startDate'), 'hidden xl:table-cell')}
                  {head('status', t('common.status'))}
                </tr>
              </THead>
              <tbody>
                {shown.map((r) => (
                  <TR key={r.id}>
                    <TD className="py-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="hidden sm:inline-flex">
                          <Avatar name={r.displayName ?? ''} size="sm" />
                        </span>
                        <div className="flex min-w-0 flex-col">
                          <Link
                            href={`/app/people/${r.id}`}
                            className="font-semibold text-text no-underline hover:text-accent hover:underline"
                          >
                            {r.displayName}
                          </Link>
                          {/* phones show the job title here instead of in its own column */}
                          {r.jobTitle ? (
                            <span className="text-footnote text-text-secondary sm:hidden">{r.jobTitle}</span>
                          ) : null}
                          {r.employeeNumber ? (
                            <span className="hidden text-footnote text-text-secondary sm:inline">
                              {r.employeeNumber}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </TD>
                    <TD className="hidden sm:table-cell">{r.jobTitle}</TD>
                    <TD className="hidden md:table-cell">{r.department}</TD>
                    <TD className="hidden lg:table-cell">{r.location}</TD>
                    <TD className="hidden text-text-secondary xl:table-cell">
                      {r.startDate ? formatDate(r.startDate, locale) : null}
                    </TD>
                    <TD>
                      {r.status ? (
                        <Badge tone={statusTone[r.status as keyof typeof statusTone] ?? 'neutral'}>
                          {t(`people.status.${r.status}`)}
                        </Badge>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {cursor && shown?.length ? (
          <div className="flex justify-center border-t border-border p-3">
            <Button
              variant="secondary"
              loading={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await load(cursor).finally(() => setLoadingMore(false));
              }}
            >
              {t('common.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
