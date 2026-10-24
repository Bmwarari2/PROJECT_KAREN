'use client';
import { FileWarning, KeyRound, Link2 } from 'lucide-react';
import { ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDate, formatDateTime, type Locale } from '@thapsus/core/i18n';
import { instantToDate } from '@thapsus/core/time';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle } from '../../ui';
import { SecurityNav } from '../nav';

interface Honeytoken {
  id: string;
  kind: 'api_key' | 'endpoint' | 'object_key';
  label: string;
  plantedIn: string;
  createdAt: string;
  retiredAt: string | null;
  touches30d: number;
  lastTouchedAt: string | null;
}
const ICON = { api_key: KeyRound, endpoint: Link2, object_key: FileWarning };

/** The honeytoken registry (ADR-0179): decoys, where they are planted, and when they were last touched. */
export default function HoneytokensPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const list = useApi<Honeytoken[]>('/v1/backoffice/security/honeytokens');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageTitle
          title={t('backoffice.security.honeytokens.title')}
          lead={t('backoffice.security.honeytokens.lead')}
        />
        <SecurityNav />
      </div>
      {!list.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        (['api_key', 'endpoint', 'object_key'] as const).map((kind) => (
          <ListSection
            key={kind}
            id={`honey-${kind}`}
            title={t(`backoffice.security.honeytokens.kind.${kind}`)}
            footer={kind === 'object_key' ? t('backoffice.security.honeytokens.noFakeEmployees') : undefined}
          >
            {list
              .data!.filter((h) => h.kind === kind)
              .map((h) => {
                const Icon = ICON[h.kind];
                return (
                  <ListItem
                    key={h.id}
                    leading={<Icon aria-hidden />}
                    title={h.label}
                    subtitle={t('backoffice.security.honeytokens.planted', {
                      where: h.plantedIn,
                      date: formatDate(instantToDate(h.createdAt, 'UTC'), locale),
                    })}
                    meta={
                      <>
                        <span className="block">
                          {h.retiredAt
                            ? t('backoffice.security.honeytokens.retired')
                            : t('backoffice.security.honeytokens.touches', { count: h.touches30d })}
                        </span>
                        <span className="block">
                          {h.lastTouchedAt
                            ? t('backoffice.security.honeytokens.lastTouched', {
                                at: formatDateTime(h.lastTouchedAt, locale, 'UTC'),
                              })
                            : t('backoffice.security.honeytokens.never')}
                        </span>
                      </>
                    }
                  />
                );
              })}
          </ListSection>
        ))
      )}
    </div>
  );
}
