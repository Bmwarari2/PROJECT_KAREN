'use client';
import * as React from 'react';
import { Badge, Card, Skeleton, useToast } from '@thapsus/ui';
import { FEATURE_FLAGS, type FeatureKey } from '@thapsus/core/features';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { errorText, PageHeader } from '@/components/platform';
import { useExperience, useSession } from '../../shell';

interface Flag {
  key: FeatureKey;
  enabled: boolean;
  default: boolean;
  overridden: boolean;
  managedBy: 'tenant' | 'staff';
}

export default function FeaturesPage() {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const { reload } = useExperience();
  const flags = useApi<Flag[]>('/v1/settings/features');
  const canManage = !!session?.permissions.some(
    (p) => p === '*' || p === 'settings.manage' || p === 'settings.*',
  );

  async function toggle(f: Flag, enabled: boolean) {
    try {
      const next = await api<Flag[]>(`/v1/settings/features/${f.key}`, {
        method: 'PUT',
        json: { enabled: enabled === f.default ? null : enabled },
      });
      flags.setData(next);
      reload();
      toast({
        title: t(enabled ? 'platform.features.turnedOn' : 'platform.features.turnedOff', {
          name: t(FEATURE_FLAGS[f.key].labelKey),
        }),
        tone: 'success',
      });
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.features.title')} lead={t('platform.features.lead')} />
      <Card>
        {!flags.data ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {flags.data.map((f) => {
              const def = FEATURE_FLAGS[f.key];
              const id = `flag-${f.key}`;
              const locked = f.managedBy === 'staff' || !canManage;
              return (
                <li key={f.key} className="flex items-start gap-4 py-4">
                  <div className="mr-auto">
                    <label htmlFor={id} className="text-callout font-semibold">
                      {t(def.labelKey)}
                    </label>
                    <p
                      id={`${id}-desc`}
                      className="mt-1 max-w-[var(--prose-width)] text-footnote text-text-secondary"
                    >
                      {t(def.descriptionKey)}
                    </p>
                    {f.managedBy === 'staff' ? (
                      <Badge tone="neutral" className="mt-2">
                        {t('platform.features.staffManaged')}
                      </Badge>
                    ) : null}
                  </div>
                  <input
                    id={id}
                    type="checkbox"
                    role="switch"
                    aria-describedby={`${id}-desc`}
                    aria-checked={f.enabled}
                    checked={f.enabled}
                    disabled={locked}
                    onChange={(e) => toggle(f, e.target.checked)}
                    className="mt-1 h-6 w-6 accent-[var(--color-accent)]"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
