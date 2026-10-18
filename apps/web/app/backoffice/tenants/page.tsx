'use client';
import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Input, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatNumber, type Locale } from '@thapsus/core/i18n';
import { useApi, useDebounced } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle } from '../ui';

interface CellTenant {
  tenantId: string;
  slug: string;
  region: string;
  status: string;
  planId: string | null;
  billingStatus: string | null;
  usage: { headcount: number; activeUsers: number; storageBytes: number; computedAt: string } | null;
  contractReference: string | null;
}
interface DirectoryRow {
  tenantId: string;
  slug: string;
  region: string;
  status: string;
  planRef: string | null;
}

export default function TenantsPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const [view, setView] = React.useState<'cell' | 'all'>('cell');
  const [q, setQ] = React.useState('');
  const dq = useDebounced(q);
  const cell = useApi<CellTenant[]>(view === 'cell' ? `/v1/backoffice/tenants?q=${encodeURIComponent(dq)}` : null);
  const all = useApi<DirectoryRow[]>(view === 'all' ? '/v1/backoffice/tenants/all-regions' : null);
  const mb = (b: number) => formatNumber(b / 1_048_576, locale, { maximumFractionDigits: 1 });
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={t('backoffice.tenants.title')} lead={view === 'cell' ? t('backoffice.tenants.cellLead') : t('backoffice.tenants.allLead')}>
        <div role="group" aria-label={t('backoffice.tenants.viewLabel')} className="flex gap-2">
          <Button size="sm" variant={view === 'cell' ? 'primary' : 'secondary'} aria-pressed={view === 'cell'} onClick={() => setView('cell')}>
            {t('backoffice.tenants.thisCell')}
          </Button>
          <Button size="sm" variant={view === 'all' ? 'primary' : 'secondary'} aria-pressed={view === 'all'} onClick={() => setView('all')}>
            {t('backoffice.tenants.allRegions')}
          </Button>
        </div>
      </PageTitle>
      {view === 'cell' ? (
        <>
          <div className="max-w-sm">
            <label htmlFor="tenant-q" className="sr-only">
              {t('backoffice.tenants.search')}
            </label>
            <Input id="tenant-q" type="search" placeholder={t('backoffice.tenants.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Table>
            <caption className="sr-only">{t('backoffice.tenants.thisCell')}</caption>
            <THead>
              <tr>
                <TH>{t('backoffice.tenants.workspace')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>{t('backoffice.tenants.plan')}</TH>
                <TH>{t('backoffice.tenants.headcount')}</TH>
                <TH>{t('backoffice.tenants.activeUsers')}</TH>
                <TH>{t('backoffice.tenants.storage')}</TH>
                <TH>{t('backoffice.tenants.contract')}</TH>
              </tr>
            </THead>
            <tbody>
              {(cell.data ?? []).map((r) => (
                <TR key={r.tenantId}>
                  <TD>
                    <Link href={`/backoffice/tenants/${r.tenantId}`}>{r.slug}</Link>
                  </TD>
                  <TD>
                    <Badge>{r.status}</Badge>
                  </TD>
                  <TD>{r.planId ? `${t(`pricing.plans.${r.planId}.name`)}${r.billingStatus ? ` · ${t(`billing.status.${r.billingStatus}`)}` : ''}` : '—'}</TD>
                  <TD>{r.usage ? formatNumber(r.usage.headcount, locale) : '—'}</TD>
                  <TD>{r.usage ? formatNumber(r.usage.activeUsers, locale) : '—'}</TD>
                  <TD>{r.usage ? t('backoffice.tenants.mb', { value: mb(r.usage.storageBytes) }) : '—'}</TD>
                  <TD>{r.contractReference ?? '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </>
      ) : (
        <Table>
          <caption className="sr-only">{t('backoffice.tenants.allRegions')}</caption>
          <THead>
            <tr>
              <TH>{t('backoffice.tenants.workspace')}</TH>
              <TH>{t('backoffice.tenants.region')}</TH>
              <TH>{t('common.status')}</TH>
              <TH>{t('backoffice.tenants.plan')}</TH>
            </tr>
          </THead>
          <tbody>
            {(all.data ?? []).map((r) => (
              <TR key={r.tenantId}>
                <TD>{r.slug}</TD>
                <TD>{t(`regions.${r.region}`)}</TD>
                <TD>{r.status}</TD>
                <TD>{r.planRef ?? '—'}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
