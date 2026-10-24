'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { EmptyState, Skeleton } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useCan } from '../../../shell';
import { RoleEditor } from '../role-editor';
import type { Role } from '../shared';

export default function RolePage() {
  const t = useT();
  const can = useCan();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<Role>(`/v1/roles/${id}`);
  if (error)
    return (
      <EmptyState level={1} title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')} />
    );
  if (!data) return <Skeleton className="h-96 w-full" />;
  // keyed by version so a reload after saving re-seeds the form
  return <RoleEditor key={data.updatedAt} role={data} canManage={can('settings.roles.manage')} />;
}
