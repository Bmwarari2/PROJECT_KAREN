'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus, ShieldCheck } from 'lucide-react';
import { Badge, EmptyState, Skeleton, Table, TD, TH, THead, TR, buttonVariants } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { hasPermission, useSession } from '../../shell';
import { roleName, type Role } from './shared';

export default function RolesPage() {
  const t = useT();
  const session = useSession();
  const { data, error } = useApi<Role[]>('/v1/roles');
  const canManage = hasPermission(session, 'roles.manage');

  if (error)
    return <EmptyState level={1} title={error.status === 403 ? t('errors.forbidden') : t('common.error')} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('access.roles.title')}</h1>
        <Link href="/app/settings/users" className="text-callout">
          {t('app.settings.usersLink')}
        </Link>
        {canManage ? (
          <Link href="/app/settings/roles/new" className={buttonVariants({ size: 'sm' }) + ' no-underline'}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('access.roles.new')}
          </Link>
        ) : null}
      </div>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('access.roles.intro')}</p>
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.length === 0 ? (
        <EmptyState icon={<ShieldCheck aria-hidden />} title={t('access.roles.empty')} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>{t('access.roles.colName')}</TH>
              <TH>{t('access.roles.colType')}</TH>
              <TH>{t('access.roles.colPermissions')}</TH>
              <TH className="text-right">{t('access.roles.colHolders')}</TH>
            </tr>
          </THead>
          <tbody>
            {data.map((r) => (
              <TR key={r.id}>
                <TD>
                  <Link href={`/app/settings/roles/${r.id}`} className="font-semibold">
                    {roleName(t, r)}
                  </Link>
                  {r.description ? (
                    <p className="text-footnote text-text-secondary">{r.description}</p>
                  ) : null}
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-2">
                    <Badge tone={r.builtIn ? 'neutral' : 'accent'}>
                      {r.builtIn ? t('access.roles.builtIn') : t('access.roles.custom')}
                    </Badge>
                    {r.isAdmin ? <Badge tone="warning">{t('access.roles.admin')}</Badge> : null}
                  </span>
                </TD>
                <TD className="text-text-secondary">
                  {r.permissions.includes('*')
                    ? t('access.roles.allPermissions')
                    : t('access.roles.permissionCount', { count: r.permissions.length })}
                </TD>
                <TD className="text-right tabular-nums">{r.assignmentCount}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
