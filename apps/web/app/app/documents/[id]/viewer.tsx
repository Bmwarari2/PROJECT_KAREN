'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, CircleCheck, Download, FileSignature, FileText, ShieldCheck } from 'lucide-react';
import { Badge, buttonVariants, EmptyState, Skeleton } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';
import { PdfViewerPlaceholder } from '@/components/documents/pdf-toolbar';
import { byteSize, kindLabel } from '@/components/documents/labels';
import type { Countersign, Signature } from '@/components/documents/sign-panel';
import type { Signing } from '@/components/documents/signing-status';
import { newDocumentHref } from '@thapsus/core/documents';
import { PageTitle, useSession } from '../../shell';

// PDF.js loads only here, only for PDFs, and only in the browser (ADR-0168).
const PdfViewer = dynamic(() => import('@/components/documents/pdf-viewer'), {
  ssr: false,
  loading: () => <PdfViewerPlaceholder />,
});
// Signing (the panels, the signature pad, step-up and the timeline) loads only for documents being signed: they
// are server-rendered with the page when shown, and documents that are not in signing never load them (ADR-0197).
const SignPanel = dynamic(() => import('@/components/documents/sign-panel').then((m) => m.SignPanel));
const CountersignPanel = dynamic(() =>
  import('@/components/documents/sign-panel').then((m) => m.CountersignPanel),
);
const SigningStatus = dynamic(() =>
  import('@/components/documents/signing-status').then((m) => m.SigningStatus),
);

interface Doc {
  id: string;
  title: string;
  category: string;
  employeeId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: string | null;
  expiresOn: string | null;
  createdAt: string;
  attachmentType: string | null;
  visibility: string | null;
  issuedOn: string | null;
  note: string | null;
  sensitive: boolean;
  expiryStatus: string | null;
}
export interface DocView {
  document: Doc;
  employeeName: string | null;
  viewable: boolean;
  canManage: boolean;
  evidence: { evidenceType: string; fileName: string; note: string | null; issuedOn: string | null } | null;
  signature: Signature | null;
  countersign: Countersign | null;
  signedCopyOf: { documentId: string; signerName: string | null; signedAt: string | null } | null;
  /** where the document is in its signing, for its details panel (16.12) */
  signing?: Signing | null;
  /** HR may send this PDF for signature */
  canSendForSignature?: boolean;
}

/**
 * The document viewer (ADR-0168): any document someone may read opens here, on desktop and on phones. PDFs are
 * drawn by PDF.js with selectable text, images are shown as they are, other files show their details. Download
 * is always there. When the document waits for the viewer's signature (or countersignature) the panel beside it
 * (under it on phones) takes them through review, confirm, sign and done.
 */
export function DocumentViewer({ id, initial }: { id: string; initial?: DocView }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const justSigned = useSearchParams().get('signed') === '1';
  const { data, error, reload } = useApi<DocView>(`/v1/documents/${id}`, initial);
  const [pages, setPages] = React.useState(0);
  const [seen, setSeen] = React.useState<Set<number>>(new Set());

  // An older link may name the signature request rather than the document: open the document instead.
  React.useEffect(() => {
    if (error?.status !== 404 || !session?.employeeId) return;
    api<Array<{ id: string; documentId: string }>>('/v1/signature-requests')
      .then((list) => {
        const sr = list.find((s) => s.id === id);
        if (sr) router.replace(`/app/documents/${sr.documentId}`);
      })
      .catch(() => undefined);
  }, [error, id, router, session?.employeeId]);

  if (error)
    return (
      <EmptyState
        level={2}
        icon={<FileText aria-hidden />}
        title={t('docView.notFound')}
        action={
          <IntentLink
            href="/app/documents"
            className={buttonVariants({ variant: 'secondary' }) + ' no-underline'}
          >
            {t('docView.back')}
          </IntentLink>
        }
      />
    );
  if (!data) return <Skeleton className="h-[70vh] w-full" />;

  const d = data.document;
  const content = `/v1/documents/${d.id}/content`;
  const download = (
    <a
      href={`${content}?download=true`}
      download
      className={buttonVariants({ variant: 'secondary' }) + ' min-h-11 no-underline'}
      aria-label={t('docView.downloadNamed', { title: d.title })}
    >
      <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
      {t('docView.download')}
    </a>
  );
  const date = (v: string | null) => (v ? formatDate(v.slice(0, 10), locale, 'long') : '');
  const pending = data.signature?.status === 'pending' ? data.signature : null;
  const details: Array<[string, React.ReactNode]> = [
    [t('docView.type'), kindLabel(t, d)],
    ...(data.evidence
      ? [
          [t('docView.evidenceType'), t(`docAttach.evidence.${data.evidence.evidenceType}`)] as [
            string,
            string,
          ],
        ]
      : []),
    ...(data.employeeName && d.employeeId !== session?.employeeId
      ? [[t('docView.person'), data.employeeName] as [string, string]]
      : []),
    ...((data.evidence?.issuedOn ?? d.issuedOn)
      ? [[t('docView.issuedOn'), date(data.evidence?.issuedOn ?? d.issuedOn)] as [string, string]]
      : []),
    ...(d.expiresOn ? [[t('docView.expiresOn'), date(d.expiresOn)] as [string, string]] : []),
    ...(d.visibility
      ? [
          [
            t('docView.visibility'),
            d.visibility === 'hr'
              ? t('docAttach.visibilityHr')
              : t('docAttach.visibilityEmployee', { name: data.employeeName ?? '' }),
          ] as [string, string],
        ]
      : []),
    [
      t('docView.file'),
      `${data.evidence?.fileName ?? d.fileName}${d.sizeBytes ? ` · ${byteSize(Number(d.sizeBytes), locale)}` : ''}`,
    ],
    [t('docView.added'), date(d.createdAt)],
    ...((data.evidence?.note ?? d.note)
      ? [[t('docView.note'), data.evidence?.note ?? d.note] as [string, string]]
      : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <IntentLink
        href="/app/documents"
        className="inline-flex min-h-11 items-center gap-1 self-start text-callout text-accent no-underline hover:underline"
      >
        <ChevronLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('docView.back')}
      </IntentLink>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <PageTitle className="text-title-2 wrap-anywhere">{d.title}</PageTitle>
          <p className="text-callout text-text-secondary">
            {kindLabel(t, d)} · {t('docView.addedOn', { date: date(d.createdAt) })}
          </p>
          <div className="flex flex-wrap gap-2">
            {d.expiryStatus === 'expired' ? (
              <Badge tone="danger">{t('docView.expired', { date: date(d.expiresOn) })}</Badge>
            ) : d.expiryStatus === 'expiring' ? (
              <Badge tone="warning">{t('docView.expiring', { date: date(d.expiresOn) })}</Badge>
            ) : null}
            {d.sensitive ? (
              <Badge>
                <ShieldCheck aria-hidden className="h-3.5 w-3.5 stroke-[1.5]" />
                {t('docView.vault')}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {data.canSendForSignature && d.employeeId ? (
            <IntentLink
              href={newDocumentHref({ employeeId: d.employeeId, documentId: d.id })}
              className={buttonVariants({ variant: 'secondary' }) + ' min-h-11 no-underline'}
            >
              <FileSignature aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('docSend.sendForSignature')}
            </IntentLink>
          ) : null}
          {download}
        </div>
      </div>

      {data.signedCopyOf ? (
        <p
          className="flex items-start gap-2 rounded-lg bg-surface-raised p-4 text-callout shadow-sm"
          role="status"
        >
          <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-success" />
          <span>
            {justSigned ? `${t('docView.justSigned')} ` : ''}
            {t('docView.signedCopy', {
              name: data.signedCopyOf.signerName ?? '',
              date: date(data.signedCopyOf.signedAt),
            })}{' '}
            <IntentLink href={`/app/documents/${data.signedCopyOf.documentId}`} className="text-accent">
              {t('docView.openOriginal')}
            </IntentLink>
          </span>
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start">
        <section aria-label={t('docView.documentRegion')} className="min-w-0">
          {d.contentType === 'application/pdf' ? (
            <PdfViewer
              src={content}
              title={d.title}
              fallback={download}
              onPages={setPages}
              onPage={(p) => setSeen((s) => (s.has(p) ? s : new Set(s).add(p)))}
            />
          ) : data.viewable ? (
            // a private, audited file (not an optimisable static asset), so a plain img
            <img
              src={content}
              alt={t('docView.imageAlt', { title: d.title })}
              className="mx-auto h-auto max-w-full rounded-lg shadow-md"
            />
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-raised p-5 shadow-sm">
              <p className="text-callout text-text-secondary">{t('docView.notViewable')}</p>
              {download}
            </div>
          )}
        </section>
        <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-[calc(var(--topbar-height)_+_var(--space-6))]">
          {data.countersign ? (
            <CountersignPanel
              request={data.countersign}
              onDone={(r) => {
                if (r.status === 'completed' && r.signedDocumentId && data.canManage)
                  router.push(`/app/documents/${r.signedDocumentId}`);
                else reload();
              }}
            />
          ) : pending || data.signature ? (
            <SignPanel
              request={pending ?? data.signature!}
              pages={pages}
              seen={seen.size}
              onSigned={(r) => {
                // the signed copy opens in the viewer, ready to download; otherwise the panel's last step says
                // that it now waits for the company
                if (r.status === 'completed' && r.signedDocumentId)
                  router.push(`/app/documents/${r.signedDocumentId}?signed=1`);
              }}
            />
          ) : null}
          {data.signing ? (
            <SigningStatus signing={data.signing} canManage={data.canManage} onChanged={reload} />
          ) : null}
          <section aria-labelledby="doc-details" className="flex flex-col gap-2">
            <h2 id="doc-details" className="px-1 text-title-3">
              {t('docView.details')}
            </h2>
            <dl className="flex flex-col rounded-lg bg-surface-raised shadow-sm">
              {details.map(([k, v], i) => (
                <div
                  key={k}
                  className={`flex flex-col gap-0.5 px-4 py-3 ${i ? 'border-t border-border' : ''}`}
                >
                  <dt className="text-footnote text-text-secondary">{k}</dt>
                  <dd className="text-callout text-text wrap-anywhere">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
