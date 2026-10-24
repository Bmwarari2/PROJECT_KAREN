'use client';
import * as React from 'react';
import { Button, Skeleton } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { FormError, ROLE_KEYS, selectClass, SettingsCard, useAction, useRoleName } from '../kit';
import { useCan } from '../../shell';

interface Routing {
  itFallbackRole: string;
  itAdmins: number;
}

/**
 * Settings → Workflows: where device and access tasks go (ADR-0189). They are the IT admins'; while no
 * one holds that role they go to the fallback role chosen here (the company owner by default).
 */
export function TaskRoutingCard() {
  const t = useT();
  const can = useCan();
  const roleName = useRoleName();
  const action = useAction();
  const routing = useApi<Routing>('/v1/settings/task-routing');
  const [role, setRole] = React.useState('');
  React.useEffect(() => {
    if (routing.data) setRole(routing.data.itFallbackRole);
  }, [routing.data]);
  const canManage = can('settings.workflows.manage');
  const choices = ROLE_KEYS.filter((k) => k !== 'it_admin');
  const r = routing.data;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      async () => {
        routing.setData(
          await api<Routing>('/v1/settings/task-routing', {
            method: 'PUT',
            json: { itFallbackRole: role },
            capability: 'settings.workflows.manage',
          }),
        );
      },
      t('visibility.routing.saved', { role: roleName(role) }),
    );
  }

  return (
    <SettingsCard
      id="task-routing"
      title={t('visibility.routing.title')}
      description={t('visibility.routing.body')}
    >
      {!r ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          <p className="text-callout" data-testid="task-routing-status">
            {r.itAdmins
              ? t('visibility.routing.itAdmins', { count: r.itAdmins })
              : t('visibility.routing.noItAdmin')}
          </p>
          {canManage ? (
            <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="it-fallback-role" className="text-footnote font-semibold text-text-secondary">
                  {t('visibility.routing.fallbackLabel')}
                </label>
                <select
                  id="it-fallback-role"
                  className={selectClass}
                  value={role}
                  aria-describedby="it-fallback-hint"
                  onChange={(e) => setRole(e.target.value)}
                >
                  {role && !choices.includes(role) ? <option value={role}>{role}</option> : null}
                  {choices.map((k) => (
                    <option key={k} value={k}>
                      {roleName(k)}
                    </option>
                  ))}
                </select>
                <p id="it-fallback-hint" className="text-footnote text-text-secondary">
                  {t('visibility.routing.fallbackHint')}
                </p>
              </div>
              <Button type="submit" variant="secondary" loading={action.busy} className="sm:mb-6">
                {t('visibility.routing.save')}
              </Button>
            </form>
          ) : (
            <p className="text-callout text-text-secondary">
              {t('visibility.routing.fallbackIs', { role: roleName(r.itFallbackRole) })}
            </p>
          )}
          <FormError message={action.error} />
        </>
      )}
    </SettingsCard>
  );
}
