'use client';
import * as React from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { Badge, Button, EmptyState, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { ListCard, ListSearch, PageIntro, useInModule } from '@/components/module-page';
import { roleName, type Role, type UserSummary } from '../roles/shared';

export default function UsersPage() {
  const t = useT();
  const inModule = useInModule();
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
  if (error) return <EmptyState level={inModule ? 2 : 1} title={t('errors.forbidden')} />;
  return (
    <div className="flex flex-col gap-5">
      <PageIntro
        title={t('access.users.title')}
        titleIsTab
        lead={t('access.users.intro')}
        actions={
          <Link href="/app/settings/roles" className="text-callout">
            {t('app.settings.rolesLink')}
          </Link>
        }
      />
      {/* the search runs on the server (the list is paged), so it covers everyone, not only the rows loaded */}
      <ListCard
        title={t('access.users.title')}
        count={
          rows
            ? cursor
              ? t('access.users.list.countMore', { count: rows.length })
              : t('access.users.list.count', { count: rows.length })
            : undefined
        }
        search={<ListSearch value={q} onChange={setQ} label={t('access.users.search')} />}
        empty={
          !rows ? (
            <Skeleton className="h-64 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState level={3} icon={<Users aria-hidden />} title={t('access.users.empty')} />
          ) : undefined
        }
      >
        <Table scrollLabel={t('access.users.title')}>
          <THead>
            <tr>
              <TH>{t('access.users.colName')}</TH>
              <TH className="hidden md:table-cell">{t('access.users.colEmail')}</TH>
              <TH>{t('access.users.colRoles')}</TH>
              <TH className="hidden sm:table-cell">{t('access.users.colMfa')}</TH>
            </tr>
          </THead>
          <tbody>
            {(rows ?? []).map((u) => (
              <TR key={u.id}>
                <TD>
                  <Link href={`/app/settings/users/${u.id}`} className="font-semibold">
                    {u.displayName}
                  </Link>
                  {u.status !== 'active' ? (
                    <p className="text-footnote text-text-secondary">
                      {t(`access.users.status.${u.status}`)}
                    </p>
                  ) : null}
                </TD>
                <TD className="hidden break-all text-text-secondary md:table-cell">{u.email}</TD>
                <TD>
                  <span className="flex flex-wrap gap-2">
                    {u.roles.map((k) => (
                      <Badge key={k}>{names.get(k) ?? k}</Badge>
                    ))}
                  </span>
                </TD>
                <TD className="hidden sm:table-cell">
                  {u.hasMfa ? (
                    <Badge tone="success">{t('access.users.mfaOn')}</Badge>
                  ) : (
                    <span className="text-text-secondary">{t('access.users.mfaOff')}</span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
        {cursor ? (
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
      </ListCard>
    </div>
  );
}
