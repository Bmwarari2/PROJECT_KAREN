'use client';
import * as React from 'react';
import { Download } from 'lucide-react';
import { Field, Input, Table, TD, TH, THead, TR, buttonVariants } from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { addDays, today } from '@thapsus/core/time';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle } from '../ui';

interface Row {
  id: string;
  at: string;
  staffEmail: string | null;
  action: string;
  subjectTenantId: string | null;
  target: string | null;
  ip: string | null;
}

/** Append-only staff audit trail (super admins), exportable as CSV. */
export default function StaffAudit() {
  const t = useT();
  const locale = useLocale() as Locale;
  const [from, setFrom] = React.useState(() => addDays(today('UTC'), -7));
  const [to, setTo] = React.useState(() => addDays(today('UTC'), 1));
  const qs = `from=${from}T00:00:00Z&to=${to}T00:00:00Z`;
  const rows = useApi<Row[]>(`/v1/backoffice/audit?${qs}`);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={t('backoffice.audit.title')} lead={t('backoffice.audit.lead')}>
        <a
          href={`/v1/backoffice/audit?${qs}&format=csv`}
          className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} no-underline`}
          download
        >
          <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('backoffice.audit.export')}
        </a>
      </PageTitle>
      <div className="flex flex-wrap gap-4">
        <Field id="a-from" label={t('backoffice.audit.from')}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <Field id="a-to" label={t('backoffice.audit.to')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <Table dense scrollLabel={t('backoffice.audit.title')}>
        <caption className="sr-only">{t('backoffice.audit.title')}</caption>
        <THead>
          <tr>
            <TH>{t('backoffice.audit.at')}</TH>
            <TH>{t('backoffice.audit.staff')}</TH>
            <TH>{t('backoffice.audit.action')}</TH>
            <TH>{t('backoffice.audit.customer')}</TH>
            <TH>{t('backoffice.audit.target')}</TH>
          </tr>
        </THead>
        <tbody>
          {(rows.data ?? [])
            .slice(-500)
            .reverse()
            .map((r) => (
              <TR key={r.id}>
                <TD className="text-footnote">{formatDateTime(r.at, locale, 'UTC')}</TD>
                <TD className="text-footnote">{r.staffEmail ?? '—'}</TD>
                <TD>{r.action}</TD>
                <TD className="text-footnote">{r.subjectTenantId ?? '—'}</TD>
                <TD className="text-footnote">{r.target ?? '—'}</TD>
              </TR>
            ))}
        </tbody>
      </Table>
    </div>
  );
}
