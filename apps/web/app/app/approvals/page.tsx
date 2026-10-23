'use client';
import * as React from 'react';
import Link from 'next/link';
import { Inbox, UserRoundCheck } from 'lucide-react';
import {
  Button,
  buttonVariants,
  EmptyState,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDate, numberFormat } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ExportLinks } from '@/components/export-links';
import {
  ListCard,
  ListFilter,
  ListNoMatches,
  ListSearch,
  matches,
  PageIntro,
  type AppliedFilter,
} from '@/components/module-page';

/** Fields shown first, in this order; others follow. */
const DETAIL_ORDER = [
  'leaveType',
  'startDate',
  'endDate',
  'amountDays',
  'date',
  'weekStart',
  'effectiveDate',
];
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
  const [query, setQuery] = React.useState('');
  const [type, setType] = React.useState('');

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

  // Search and the request-type filter narrow the rows already loaded; bulk actions use only the
  // selected rows that are still shown.
  const rows = data ?? [];
  const types = [...new Set(rows.map((a) => a.policy))].sort((a, b) => a.localeCompare(b, locale));
  const shown = rows.filter(
    (a) => (!type || a.policy === type) && matches(query, a.policy, a.subjectName, details(a.payload)),
  );
  const picked = shown.filter((a) => selected.has(a.id)).map((a) => a.id);
  const filtered = !!type || !!query.trim();
  const clearAll = () => {
    setQuery('');
    setType('');
  };
  const applied: AppliedFilter[] = type
    ? [{ key: 'type', label: t('approvals.list.typeChip', { type }), clear: () => setType('') }]
    : [];

  async function bulk(decision: 'approve' | 'reject') {
    setBusy(true);
    const r = await api<{ succeeded: string[]; failed: unknown[] }>('/v1/approvals/bulk', {
      method: 'POST',
      json: { ids: picked, decision },
    });
    toast({
      title: t('approvals.bulkResult', { ok: r.succeeded.length, failed: r.failed.length }),
      tone: r.failed.length ? 'danger' : 'success',
    });
    setSelected(new Set());
    setBusy(false);
    reload();
  }

  const toggle = (id: string) =>
    setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <div className="flex flex-col gap-5">
      <PageIntro
        title={t('approvals.title')}
        titleIsTab
        lead={t('approvals.lead')}
        actions={
          <>
            <Link
              href="/app/settings/delegations"
              className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} no-underline`}
            >
              <UserRoundCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('admin.delegations.link')}
            </Link>
            <ExportLinks list="approvals" params={{ view: 'mine' }} />
          </>
        }
      />
      <ListCard
        title={t('approvals.list.title')}
        count={
          data
            ? filtered
              ? t('approvals.list.countFiltered', { shown: shown.length, count: rows.length })
              : t('approvals.list.count', { count: rows.length })
            : undefined
        }
        search={
          rows.length ? (
            <ListSearch value={query} onChange={setQuery} label={t('approvals.list.search')} />
          ) : undefined
        }
        filters={
          types.length > 1 || type ? (
            <ListFilter
              value={type}
              onChange={setType}
              label={t('approvals.list.type')}
              anyLabel={t('approvals.list.anyType')}
              options={types.map((p) => ({ value: p, label: p }))}
            />
          ) : undefined
        }
        actions={
          rows.length ? (
            <>
              <Button size="sm" disabled={!picked.length} loading={busy} onClick={() => bulk('approve')}>
                {t('approvals.approveSelected')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!picked.length || busy}
                onClick={() => bulk('reject')}
              >
                {t('approvals.rejectSelected')}
              </Button>
            </>
          ) : undefined
        }
        applied={applied}
        empty={
          !data ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState level={3} icon={<Inbox aria-hidden />} title={t('approvals.empty')} />
          ) : shown.length === 0 ? (
            <ListNoMatches onClear={clearAll} />
          ) : undefined
        }
      >
        <Table scrollLabel={t('approvals.list.title')}>
          <THead>
            <tr>
              <TH className="w-10">
                <input
                  type="checkbox"
                  aria-label={t('approvals.selectAll')}
                  checked={shown.length > 0 && picked.length === shown.length}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(shown.map((d) => d.id)) : new Set())
                  }
                />
              </TH>
              <TH>{t('approvals.col.request')}</TH>
              <TH>{t('approvals.col.person')}</TH>
              <TH>{t('approvals.col.details')}</TH>
              <TH>{t('approvals.col.requested')}</TH>
            </tr>
          </THead>
          <tbody>
            {shown.map((a) => (
              <TR key={a.id}>
                <TD>
                  <input
                    type="checkbox"
                    aria-label={t('approvals.select', { name: a.subjectName ?? a.policy })}
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />
                </TD>
                <TD className="font-semibold">{a.policy}</TD>
                <TD>{a.subjectName ?? '—'}</TD>
                <TD className="text-footnote text-text-secondary">{details(a.payload)}</TD>
                <TD>{formatDate(a.requestedAt.slice(0, 10), locale)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </ListCard>
    </div>
  );
}
