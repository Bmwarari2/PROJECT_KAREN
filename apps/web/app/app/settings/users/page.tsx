'use client';
import * as React from 'react';
import Link from 'next/link';
import { Search, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { roleName, type Role, type UserSummary } from '../roles/shared';

export default function UsersPage() {
  const t = useT();
  const [q, setQ] = React.useState('');
  const query = useDebounced(q);
  const roles = useApi<Role[]>('/v1/roles');
  const [rows, setRows] = React.useState<UserSummary[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const load = React.useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ limit: '50' });
      if (query) params.set('q', query);
      if (after) params.set('cursor', after);
      const page = await api<{ data: UserSummary[]; nextCursor: string | null }>(`/v1/users?${params}`);
      setRows((prev) => (after && prev ? [...prev, ...page.data] : page.data));
      setCursor(page.nextCursor);
    },
    [query],
  );
  React.useEffect(() => {
    setRows(null);
    void load(null).catch(() => (setRows([]), setError(true)));
  }, [load]);

  const names = new Map((roles.data ?? []).map((r) => [r.key, roleName(t, r)]));
  if (error) return <EmptyState level={1} title={t('errors.forbidden')} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('access.users.title')}</h1>
        <Link href="/app/settings/roles" className="text-callout">
          {t('app.settings.rolesLink')}
        </Link>
      </div>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('access.users.intro')}</p>
      <div className="relative max-w-md">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 stroke-[1.5] text-text-secondary" />
        <Input type="search" aria-label={t('access.users.search')} placeholder={t('access.users.search')} value={q} onChange={(e) => setQ(e.target.value)} className="h-10 pl-9" />
      </div>
      {!rows ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Users aria-hidden />} title={t('access.users.empty')} />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('access.users.colName')}</TH>
                <TH className="hidden md:table-cell">{t('access.users.colEmail')}</TH>
                <TH>{t('access.users.colRoles')}</TH>
                <TH className="hidden sm:table-cell">{t('access.users.colMfa')}</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <Link href={`/app/settings/users/${u.id}`} className="font-semibold">
                      {u.displayName}
                    </Link>
                    {u.status !== 'active' ? <p className="text-footnote text-text-secondary">{t(`access.users.status.${u.status}`)}</p> : null}
                  </TD>
                  <TD className="hidden break-all text-text-secondary md:table-cell">{u.email}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-2">
                      {u.roles.map((k) => (
                        <Badge key={k}>{names.get(k) ?? k}</Badge>
                      ))}
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell">{u.hasMfa ? <Badge tone="success">{t('access.users.mfaOn')}</Badge> : <span className="text-text-secondary">{t('access.users.mfaOff')}</span>}</TD>
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
