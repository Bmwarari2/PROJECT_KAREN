'use client';
import * as React from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Badge, Button, EmptyState, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, slaTone } from '../ui';

interface QueueItem {
  ticketId: string;
  tenantId: string;
  slug: string | null;
  reference: string;
  priority: string;
  status: string;
  category: string;
  planId: string;
  lastAuthor: string;
  lastActivityAt: string;
  sla: { firstResponse: { dueAt: string; state: string }; resolution: { dueAt: string; state: string }; flag: string };
}

/** The cell's support queue: routing metadata only; opening a ticket is audited (ADR-0101). */
export default function SupportQueue() {
  const t = useT();
  const locale = useLocale() as Locale;
  const [all, setAll] = React.useState(false);
  const q = useApi<QueueItem[]>(`/v1/backoffice/support/queue?status=${all ? 'all' : 'open'}`);
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={t('backoffice.support.title')} lead={t('backoffice.support.lead')}>
        <Button size="sm" variant="secondary" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? t('backoffice.support.openOnly') : t('backoffice.support.showAll')}
        </Button>
      </PageTitle>
      {q.data && !q.data.length ? (
        <EmptyState icon={<Inbox aria-hidden />} title={t('backoffice.support.empty')} />
      ) : (
        <Table>
          <caption className="sr-only">{t('backoffice.support.title')}</caption>
          <THead>
            <tr>
              <TH>{t('support.reference')}</TH>
              <TH>{t('backoffice.tenants.workspace')}</TH>
              <TH>{t('support.priority')}</TH>
              <TH>{t('common.status')}</TH>
              <TH>{t('support.sla')}</TH>
              <TH>{t('support.firstResponseDue')}</TH>
              <TH>{t('support.resolutionDue')}</TH>
              <TH>{t('backoffice.support.waitingOn')}</TH>
            </tr>
          </THead>
          <tbody>
            {(q.data ?? []).map((i) => (
              <TR key={i.ticketId}>
                <TD>
                  <Link href={`/backoffice/support/${i.tenantId}/${i.ticketId}`}>{i.reference}</Link>
                </TD>
                <TD>{i.slug ?? i.tenantId}</TD>
                <TD>{t(`support.priorities.${i.priority}`)}</TD>
                <TD>{t(`support.statuses.${i.status}`)}</TD>
                <TD>
                  <Badge tone={slaTone(i.sla.flag)}>{t(`support.slaStates.${i.sla.flag}`)}</Badge>
                </TD>
                <TD className="text-footnote">{when(i.sla.firstResponse.dueAt)}</TD>
                <TD className="text-footnote">{when(i.sla.resolution.dueAt)}</TD>
                <TD>{i.lastAuthor === 'user' ? t('backoffice.support.us') : t('backoffice.support.customer')}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
