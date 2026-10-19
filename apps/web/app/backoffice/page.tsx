'use client';
import Link from 'next/link';
import { Card, Skeleton } from '@thapsus/ui';
import { useApi } from '@/lib/use-api';
import { useT } from '@/lib/i18n-client';
import { PageTitle } from './ui';

interface Overview {
  cell: string;
  awsRegion: string;
  tenants: number;
  openTickets: number;
  slaAtRisk: number;
  slaBreached: number;
  activeContracts: number;
  renewalsDue: number;
  activeIncidents: number;
}

export default function BackofficeHome() {
  const t = useT();
  const o = useApi<Overview>('/v1/backoffice/overview');
  if (!o.data) return <Skeleton className="h-40 w-full" />;
  const tiles: Array<[string, number, string]> = [
    ['tenants', o.data.tenants, '/backoffice/tenants'],
    ['openTickets', o.data.openTickets, '/backoffice/support'],
    ['slaAtRisk', o.data.slaAtRisk, '/backoffice/support'],
    ['slaBreached', o.data.slaBreached, '/backoffice/support'],
    ['activeContracts', o.data.activeContracts, '/backoffice/plans'],
    ['renewalsDue', o.data.renewalsDue, '/backoffice/plans'],
    ['activeIncidents', o.data.activeIncidents, '/backoffice/status'],
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.overview.title')} lead={t('backoffice.overview.lead', { region: t(`regions.${o.data.cell}`), aws: o.data.awsRegion })} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([k, n, href]) => (
          <li key={k}>
            <Card>
              <Link href={href} className="text-footnote font-semibold text-text-secondary no-underline">
                {t(`backoffice.overview.${k}`)}
              </Link>
              <p className="mt-2 text-title-1 tabular-nums">{n}</p>
            </Card>
          </li>
        ))}
      </ul>
      <p className="text-footnote text-text-secondary">{t('backoffice.overview.privacy')}</p>
    </div>
  );
}
