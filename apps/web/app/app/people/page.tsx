'use client';
import * as React from 'react';
import Link from 'next/link';
import { Search, UserPlus, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Skeleton, Table, TD, TH, THead, TR, buttonVariants } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useDebounced } from '@/lib/use-api';
import { useSession } from '../shell';
import { ExportLinks } from '@/components/export-links';

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

const statusTone = { active: 'success', pre_start: 'accent', leaver: 'neutral' } as const;

export default function PeoplePage() {
  const t = useT();
  const session = useSession();
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState('active');
  const query = useDebounced(q);
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const canCreate = session?.permissions.some((p) => p === '*' || p === 'employees.*' || p === 'employees.create');

  const load = React.useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ limit: '50', status });
      if (query) params.set('q', query);
      if (after) params.set('cursor', after);
      const page = await api<{ data: Row[]; nextCursor: string | null }>(`/v1/employees?${params}`);
      setRows((prev) => (after && prev ? [...prev, ...page.data] : page.data));
      setCursor(page.nextCursor);
    },
    [query, status],
  );
  React.useEffect(() => {
    setRows(null);
    void load(null).catch(() => setRows([]));
  }, [load]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('people.title')}</h1>
        <ExportLinks list="employees" params={{ status, q: query || undefined }} />
        {canCreate ? (
          <Link href="/app/people/new" className={buttonVariants({ size: 'sm' }) + ' no-underline'}>
            <UserPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('people.add')}
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="relative min-w-[240px] flex-1">
          <span className="sr-only">{t('common.search')}</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 stroke-[1.5] text-text-secondary" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('people.searchPlaceholder')} className="pl-9" type="search" />
        </label>
        <label className="flex items-center gap-2 text-callout">
          <span className="text-text-secondary">{t('common.status')}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout">
            {(['active', 'pre_start', 'leaver', 'all'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`people.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows === null ? (
        <Skeleton className="h-96 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Users aria-hidden />} title={t('people.empty')} />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('people.col.name')}</TH>
                <TH className="hidden md:table-cell">{t('people.col.number')}</TH>
                <TH>{t('people.col.title')}</TH>
                <TH className="hidden lg:table-cell">{t('people.col.department')}</TH>
                <TH className="hidden lg:table-cell">{t('people.col.location')}</TH>
                <TH>{t('common.status')}</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link href={`/app/people/${r.id}`} className="font-semibold text-text no-underline hover:text-accent">
                      {r.displayName}
                    </Link>
                  </TD>
                  <TD className="hidden text-text-secondary md:table-cell">{r.employeeNumber}</TD>
                  <TD>{r.jobTitle}</TD>
                  <TD className="hidden lg:table-cell">{r.department}</TD>
                  <TD className="hidden lg:table-cell">{r.location}</TD>
                  <TD>{r.status ? <Badge tone={statusTone[r.status as keyof typeof statusTone] ?? 'neutral'}>{t(`people.status.${r.status}`)}</Badge> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          {cursor ? (
            <Button
              variant="secondary"
              className="self-center"
              loading={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await load(cursor).finally(() => setLoadingMore(false));
              }}
            >
              {t('common.loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
