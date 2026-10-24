'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { ListItem, ListSection, Skeleton, TabNav } from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle } from '../../ui';
import { SecurityNav, SeverityBadge } from '../nav';

export interface IncidentRow {
  id: string;
  reference: string;
  ruleId: string;
  area: string;
  severity: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  detectionCount: number;
  eventCount: number;
  tenantCount: number;
  ipNet: string | null;
  assignedTo: { id: string; displayName: string } | null;
}

/** Incidents (ADR-0177): open ones first, worst first; each row opens the incident. */
export default function IncidentsPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const params = useSearchParams();
  const all = params.get('status') === 'all';
  const list = useApi<IncidentRow[]>(`/v1/backoffice/security/incidents${all ? '?status=all' : ''}`);
  const tabs = [
    { href: '/backoffice/security/incidents', label: t('backoffice.security.incidents.open'), active: !all },
    {
      href: '/backoffice/security/incidents?status=all',
      label: t('backoffice.security.incidents.all'),
      active: all,
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageTitle title={t('backoffice.security.title')} lead={t('backoffice.security.lead')} />
        <SecurityNav />
      </div>
      <TabNav
        tabs={tabs}
        label={t('backoffice.security.incidents.filterLabel')}
        renderLink={(tab, className, children) => (
          <Link
            href={tab.href}
            className={className}
            aria-current={tab.active ? 'page' : undefined}
            scroll={false}
          >
            {children}
          </Link>
        )}
      />
      {!list.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <ListSection id="incidents" title={t('backoffice.security.incidents.title')}>
          {list.data.length ? (
            list.data.map((i) => (
              <ListItem
                key={i.id}
                href={`/backoffice/security/incidents/${i.id}`}
                linkAs={Link}
                leading={<ShieldAlert aria-hidden />}
                title={`${i.reference} · ${t(`backoffice.security.rules.${i.ruleId}.name`)}`}
                subtitle={
                  <>
                    <span className="block">
                      {t('backoffice.security.incidents.line', {
                        area: t(`backoffice.security.area.${i.area}`),
                        status: t(`backoffice.security.status.${i.status}`),
                      })}
                    </span>
                    <span className="block">
                      {[
                        t('backoffice.security.incidents.detections', { count: i.detectionCount }),
                        t('backoffice.security.incidents.events', { count: i.eventCount }),
                        i.tenantCount
                          ? t('backoffice.security.incidents.workspaces', { count: i.tenantCount })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </>
                }
                meta={
                  <>
                    <span className="block">
                      {t('backoffice.security.incidents.lastSeen', {
                        at: formatDateTime(i.lastSeenAt, locale, 'UTC'),
                      })}
                    </span>
                    <span className="block">
                      {i.assignedTo
                        ? t('backoffice.security.incidents.assigned', { name: i.assignedTo.displayName })
                        : t('backoffice.security.incidents.unassigned')}
                    </span>
                  </>
                }
                accessory={<SeverityBadge severity={i.severity} />}
              />
            ))
          ) : (
            <ListItem
              title={
                all ? t('backoffice.security.incidents.none') : t('backoffice.security.incidents.noneOpen')
              }
            />
          )}
        </ListSection>
      )}
    </div>
  );
}
