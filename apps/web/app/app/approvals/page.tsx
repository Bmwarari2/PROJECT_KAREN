'use client';
import * as React from 'react';
import Link from 'next/link';
import { Inbox, UserRoundCheck } from 'lucide-react';
import { Button, buttonVariants, EmptyState, Skeleton, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { formatDate, numberFormat } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ExportLinks } from '@/components/export-links';

/** Fields shown first, in this order; others follow. */
const DETAIL_ORDER = ['leaveType', 'startDate', 'endDate', 'amountDays', 'date', 'weekStart', 'effectiveDate'];
const order = (k: string) => (DETAIL_ORDER.includes(k) ? DETAIL_ORDER.indexOf(k) : DETAIL_ORDER.length);

interface Approval {
  id: string;
  policy: string;
  subjectName: string | null;
  requestedAt: string;
  payload: Record<string, unknown>;
}

export default function ApprovalsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { data, reload } = useApi<Approval[]>('/v1/approvals?view=mine');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  async function bulk(decision: 'approve' | 'reject') {
    setBusy(true);
    const r = await api<{ succeeded: string[]; failed: unknown[] }>('/v1/approvals/bulk', { method: 'POST', json: { ids: [...selected], decision } });
    toast({ title: t('approvals.bulkResult', { ok: r.succeeded.length, failed: r.failed.length }), tone: r.failed.length ? 'danger' : 'success' });
    setSelected(new Set());
    setBusy(false);
    reload();
  }

  // Request details in words: known fields with their labels, dates formatted, internal ids left out.
  const known = (key: string) => (t(key) === key ? null : t(key));
  const details = (payload: Record<string, unknown>) =>
    Object.entries(payload)
      .filter(([k]) => k !== 'reason' && !k.startsWith('__') && !/Id$/.test(k))
      .map(([k, v]) => [k, known(`admin.approvals.field.${k}`) ?? known(`people.field.${k}`), v] as const)
      .filter(([, label]) => label)
      .sort(([a], [b]) => order(a) - order(b))
      .map(([k, label, v]) => {
        const value =
          k === 'leaveType' && typeof v === 'string'
            ? (known(`timeOff.kind.${v}`) ?? v)
            : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
              ? formatDate(v, locale)
              : Array.isArray(v)
                ? numberFormat(locale).format(v.length)
                : typeof v === 'number'
                  ? numberFormat(locale).format(v)
                  : String(v);
        return `${label}: ${value}`;
      })
      .join(', ');

  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('approvals.title')}</h1>
        <Link href="/app/settings/delegations" className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} no-underline`}>
          <UserRoundCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.delegations.link')}
        </Link>
        <ExportLinks list="approvals" params={{ view: 'mine' }} />
        <Button size="sm" disabled={!selected.size} loading={busy} onClick={() => bulk('approve')}>
          {t('approvals.approveSelected')}
        </Button>
        <Button size="sm" variant="secondary" disabled={!selected.size || busy} onClick={() => bulk('reject')}>
          {t('approvals.rejectSelected')}
        </Button>
      </div>
      {/* the heading renders before the list arrives, in the same element as the loaded page */}
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.length === 0 ? (
        <EmptyState icon={<Inbox aria-hidden />} title={t('approvals.empty')} />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH className="w-10">
                <input type="checkbox" aria-label={t('approvals.selectAll')} checked={selected.size === data.length} onChange={(e) => setSelected(e.target.checked ? new Set(data.map((d) => d.id)) : new Set())} />
              </TH>
              <TH>{t('approvals.col.request')}</TH>
              <TH>{t('approvals.col.person')}</TH>
              <TH>{t('approvals.col.details')}</TH>
              <TH>{t('approvals.col.requested')}</TH>
            </tr>
          </THead>
          <tbody>
            {data.map((a) => (
              <TR key={a.id}>
                <TD>
                  <input type="checkbox" aria-label={t('approvals.select', { name: a.subjectName ?? a.policy })} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                </TD>
                <TD className="font-semibold">{a.policy}</TD>
                <TD>{a.subjectName ?? '—'}</TD>
                <TD className="text-footnote text-text-secondary">
                  {details(a.payload)}
                </TD>
                <TD>{formatDate(a.requestedAt.slice(0, 10), locale)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
