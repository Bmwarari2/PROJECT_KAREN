'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus, ShieldCheck } from 'lucide-react';
import {
  Badge,
  buttonVariants,
  Card,
  cn,
  EmptyState,
  Skeleton,
  Table,
  TableToolbar,
  TD,
  TH,
  THead,
  TR,
} from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { hasPermission, ModuleFrameContext, PageTitle, useSession } from '../../shell';
import { RolesNav } from './nav';
import { roleName, type Role } from './shared';
import { selectClass } from '../kit';

export default function RolesPage() {
  const t = useT();
  const session = useSession();
  const inModule = React.useContext(ModuleFrameContext);
  const { data, error } = useApi<Role[]>('/v1/roles');
  const canManage = hasPermission(session, 'roles.manage');
  const [type, setType] = React.useState<'all' | 'builtIn' | 'custom'>('all');

  if (error)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        title={error.status === 403 ? t('errors.forbidden') : t('common.error')}
      />
    );
  const rows = (data ?? []).filter((r) => type === 'all' || (type === 'builtIn' ? r.builtIn : !r.builtIn));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <PageTitle>{t('access.roles.title')}</PageTitle>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
            {t('access.roles.intro')}
          </p>
        </div>
        {canManage ? (
          <Link href="/app/settings/roles/new" className={cn(buttonVariants({ size: 'sm' }), 'no-underline')}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('access.roles.new')}
          </Link>
        ) : null}
      </div>
      <RolesNav />
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.length === 0 ? (
        <EmptyState icon={<ShieldCheck aria-hidden />} title={t('access.roles.empty')} />
      ) : (
        <Card className="overflow-hidden p-0">
          <TableToolbar
            title={t('access.compare.allRoles')}
            count={t('access.compare.roleCount', { count: rows.length })}
            filters={
              <select
                aria-label={t('access.compare.typeFilter')}
                className={cn(selectClass, 'w-auto')}
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
              >
                <option value="all">{t('access.compare.typeAll')}</option>
                <option value="builtIn">{t('access.roles.builtIn')}</option>
                <option value="custom">{t('access.roles.custom')}</option>
              </select>
            }
            actions={
              <Link href="/app/settings/users" className="text-callout">
                {t('app.settings.usersLink')}
              </Link>
            }
          />
          <Table scrollLabel={t('access.compare.allRoles')}>
            <caption className="sr-only">{t('access.compare.allRoles')}</caption>
            <THead>
              <tr>
                <TH>{t('access.roles.colName')}</TH>
                <TH>{t('access.roles.colType')}</TH>
                <TH>{t('access.roles.colPermissions')}</TH>
                <TH className="text-right">{t('access.roles.colHolders')}</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
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
        </Card>
      )}
    </div>
  );
}
