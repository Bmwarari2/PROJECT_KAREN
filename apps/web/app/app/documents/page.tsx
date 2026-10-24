'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileClock, FileSignature, FileText, PenLine } from 'lucide-react';
import { Badge, EmptyState, ListItem, ListSection, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { hasPermission, useSession } from '../shell';
import { ExportLinks } from '@/components/export-links';
import { IntentLink } from '@/components/intent-link';
import { categoryLabel, kindLabel } from '@/components/documents/labels';
import {
  ListCard,
  ListFilter,
  ListNoMatches,
  ListSearch,
  matches,
  PageIntro,
} from '@/components/module-page';

interface SigReq {
  id: string;
  documentId: string;
  title: string;
  status: string;
  requestedAt: string;
  signedAt: string | null;
  approvalStatus: string | null;
  returnedReason: string | null;
  completedAt: string | null;
}
interface Doc {
  id: string;
  title: string;
  createdAt: string;
  category: string;
  attachmentType: string | null;
  expiryStatus: string | null;
  expiresOn: string | null;
}
interface Approval {
  id: string;
  subject: string;
  subjectName: string | null;
  requestedAt: string;
  payload: { documentId?: string; documentTitle?: string };
}

/**
 * Documents: what waits for the viewer's signature (or countersignature), then every document they may see.
 * Each one opens in the viewer (ADR-0168); nothing downloads until they ask for it there.
 */
export default function DocumentsPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const params = useSearchParams();
  const sigs = useApi<SigReq[]>('/v1/signature-requests');
  const docs = useApi<Doc[]>(
    session?.employeeId ? `/v1/documents?employeeId=${session.employeeId}` : '/v1/documents',
  );
  const approvals = useApi<Approval[]>(
    hasPermission(session, 'approvals.act') ? '/v1/approvals?view=mine' : null,
  );
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('');

  // links from before the viewer (/app/documents?sign=<request>) open the document in the viewer
  React.useEffect(() => {
    const id = params.get('sign');
    const sr = id && sigs.data?.find((s) => s.id === id);
    if (sr) router.replace(`/app/documents/${sr.documentId}`);
  }, [params, sigs.data, router]);

  const day = (iso: string) => formatDate(iso.slice(0, 10), locale);
  const toSign = (sigs.data ?? []).filter((s) => s.status === 'pending');
  const awaiting = (sigs.data ?? []).filter((s) => s.status === 'signed' && s.approvalStatus === 'pending');
  const toCountersign = (approvals.data ?? []).filter(
    (a) => a.subject === 'document.countersign' && a.payload.documentId,
  );
  // The documents are filtered on the page: the API returns every one the viewer may see.
  const rows = docs.data ?? [];
  const categories = [...new Set(rows.map((d) => d.category))].sort((a, b) =>
    categoryLabel(t, a).localeCompare(categoryLabel(t, b), locale),
  );
  const shown = rows.filter((d) => (!category || d.category === category) && matches(query, d.title));
  const filtered = !!category || !!query.trim();
  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('documents.title')}
        titleIsTab
        actions={<ExportLinks list="documents" params={{ employeeId: session?.employeeId ?? undefined }} />}
      />
      {toSign.length ? (
        <ListSection title={t('documents.toSign')} id="to-sign">
          {toSign.map((s) => (
            <ListItem
              key={s.id}
              href={`/app/documents/${s.documentId}`}
              linkAs={IntentLink}
              leading={<FileSignature />}
              title={<span className="wrap-anywhere">{s.title}</span>}
              subtitle={
                s.approvalStatus === 'returned'
                  ? t('docSign.returnedShort')
                  : t('docSign.requested', { date: day(s.requestedAt) })
              }
              accessory={<Badge tone="accent">{t('docSign.signAction')}</Badge>}
            />
          ))}
        </ListSection>
      ) : null}
      {toCountersign.length ? (
        <ListSection title={t('docSign.toCountersign')} id="to-countersign">
          {toCountersign.map((a) => (
            <ListItem
              key={a.id}
              href={`/app/documents/${a.payload.documentId}`}
              linkAs={IntentLink}
              leading={<PenLine />}
              title={a.payload.documentTitle ?? t('documents.title')}
              subtitle={t('docSign.signedBy', { name: a.subjectName ?? '', date: day(a.requestedAt) })}
              accessory={<Badge tone="accent">{t('docSign.countersignAction')}</Badge>}
            />
          ))}
        </ListSection>
      ) : null}
      {awaiting.length ? (
        <ListSection title={t('docSign.waitingList')} id="awaiting">
          {awaiting.map((s) => (
            <ListItem
              key={s.id}
              href={`/app/documents/${s.documentId}`}
              linkAs={IntentLink}
              leading={<FileClock />}
              title={<span className="wrap-anywhere">{s.title}</span>}
              subtitle={t('docSign.signedOn', { date: day(s.signedAt ?? s.requestedAt) })}
            />
          ))}
        </ListSection>
      ) : null}
      <ListCard
        title={session?.employeeId ? t('documents.list.mine') : t('documents.list.all')}
        count={
          docs.data
            ? filtered
              ? t('documents.list.countFiltered', { shown: shown.length, count: rows.length })
              : t('documents.list.count', { count: rows.length })
            : undefined
        }
        search={
          rows.length ? (
            <ListSearch value={query} onChange={setQuery} label={t('documents.list.search')} />
          ) : undefined
        }
        filters={
          categories.length > 1 || category ? (
            <ListFilter
              value={category}
              onChange={setCategory}
              label={t('documents.list.category')}
              anyLabel={t('documents.list.anyCategory')}
              options={categories.map((c) => ({ value: c, label: categoryLabel(t, c) }))}
            />
          ) : undefined
        }
        applied={
          category
            ? [
                {
                  key: 'category',
                  label: t('documents.list.categoryChip', { category: categoryLabel(t, category) }),
                  clear: () => setCategory(''),
                },
              ]
            : []
        }
        empty={
          !docs.data ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState level={3} icon={<FileText aria-hidden />} title={t('documents.empty')} />
          ) : shown.length === 0 ? (
            <ListNoMatches
              onClear={() => {
                setQuery('');
                setCategory('');
              }}
            />
          ) : undefined
        }
      >
        <Table scrollLabel={session?.employeeId ? t('documents.list.mine') : t('documents.list.all')}>
          <THead>
            <tr>
              <TH>{t('documents.list.colTitle')}</TH>
              <TH>{t('documents.list.category')}</TH>
              <TH>{t('documents.list.colAdded')}</TH>
            </tr>
          </THead>
          <tbody>
            {shown.map((d) => (
              <TR key={d.id}>
                <TD>
                  <span className="flex min-w-0 items-center gap-3">
                    <FileText aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-accent" />
                    <IntentLink
                      href={`/app/documents/${d.id}`}
                      className="min-w-0 break-words text-callout text-accent no-underline hover:underline"
                    >
                      {d.title}
                    </IntentLink>
                  </span>
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    <Badge>{kindLabel(t, d)}</Badge>
                    {d.expiryStatus === 'expired' ? (
                      <Badge tone="danger">{t('docView.expiredShort')}</Badge>
                    ) : d.expiryStatus === 'expiring' ? (
                      <Badge tone="warning">{t('docView.expiringShort')}</Badge>
                    ) : null}
                  </span>
                </TD>
                <TD className="text-footnote text-text-secondary">{day(d.createdAt)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </ListCard>
    </div>
  );
}
