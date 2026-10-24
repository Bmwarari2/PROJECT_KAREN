'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { EmptyState, Skeleton } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useCan } from '../../../shell';
import { RoleEditor } from '../role-editor';
import type { Role } from '../shared';

export default function NewRolePage() {
  const t = useT();
  const can = useCan();
  const copy = useSearchParams().get('copy');
  const source = useApi<Role>(copy ? `/v1/roles/${encodeURIComponent(copy)}` : null);
  if (!can('settings.roles.manage')) return <EmptyState level={1} title={t('errors.forbidden')} />;
  if (copy && !source.data && !source.error) return <Skeleton className="h-96 w-full" />;
  return <RoleEditor copyFrom={source.data} canManage />;
}
