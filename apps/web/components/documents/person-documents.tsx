'use client';
import * as React from 'react';
import { FilePlus2, FileText, Paperclip, ShieldCheck } from 'lucide-react';
import { Badge, Button, buttonVariants, EmptyState, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { newDocumentHref } from '@thapsus/core/documents';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';
import { AttachDialog } from './attach-dialog';
import { kindLabel } from './labels';

interface Doc {
  id: string;
  title: string;
  category: string;
  createdAt: string;
  attachmentType: string | null;
  visibility: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  expiryStatus: string | null;
  sensitive: boolean;
}

/**
 * A person's documents on their profile (ADR-0165): what HR attached and everything else filed for them, each
 * opening in the viewer, with an "Attach document" action for people who manage their documents.
 */
export function PersonDocuments({
  employeeId,
  name,
  canAttach,
}: {
  employeeId: string;
  name: string;
  canAttach: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const docs = useApi<Doc[]>(`/v1/documents?employeeId=${employeeId}`);
  const [open, setOpen] = React.useState(false);
  const date = (v: string) => formatDate(v.slice(0, 10), locale);
  const attach = canAttach ? (
    <span className="flex flex-wrap gap-2">
      {/* prepare a document from a template and send it for signature (16.11) */}
      <IntentLink
        href={newDocumentHref({ employeeId })}
        className={buttonVariants({ variant: 'secondary' }) + ' min-h-11 no-underline'}
      >
        <FilePlus2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('docSend.newFromTemplate')}
      </IntentLink>
      <Button className="min-h-11" onClick={() => setOpen(true)}>
        <Paperclip aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('docAttach.attach')}
      </Button>
    </span>
  ) : null;
  const subtitle = (d: Doc) =>
    [
      // the type, unless the title already is the type (right-to-work evidence keeps a generic title)
      kindLabel(t, d) === d.title ? null : kindLabel(t, d),
      d.expiresOn
        ? t(d.expiryStatus === 'expired' ? 'docView.expired' : 'docView.expiresOnShort', {
            date: date(d.expiresOn),
          })
        : d.issuedOn
          ? t('docView.issuedOnShort', { date: date(d.issuedOn) })
          : t('docView.addedOn', { date: date(d.createdAt) }),
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <>
      {!docs.data ? (
        <Skeleton className="h-40 w-full" />
      ) : docs.data.length ? (
        <ListSection title={t('docAttach.listTitle')} action={attach} headingLevel={3} id="person-documents">
          {docs.data.map((d) => (
            <ListItem
              key={d.id}
              href={`/app/documents/${d.id}`}
              linkAs={IntentLink}
              leading={d.sensitive ? <ShieldCheck /> : <FileText />}
              title={<span className="wrap-anywhere">{d.title}</span>}
              subtitle={subtitle(d)}
              meta={
                d.expiryStatus || d.visibility ? (
                  <span className="flex flex-wrap gap-1">
                    {d.expiryStatus === 'expired' ? (
                      <Badge tone="danger">{t('docView.expiredShort')}</Badge>
                    ) : d.expiryStatus === 'expiring' ? (
                      <Badge tone="warning">{t('docView.expiringShort')}</Badge>
                    ) : null}
                    {d.visibility ? (
                      <Badge>
                        {d.visibility === 'hr' ? t('docAttach.visibilityHr') : t('docAttach.sharedShort')}
                      </Badge>
                    ) : null}
                  </span>
                ) : undefined
              }
            />
          ))}
        </ListSection>
      ) : (
        <EmptyState
          level={3}
          icon={<FileText aria-hidden />}
          title={t('documents.empty')}
          action={attach ?? undefined}
        />
      )}
      {canAttach ? (
        <AttachDialog
          employeeId={employeeId}
          employeeName={name}
          open={open}
          onOpenChange={setOpen}
          onAttached={() => docs.reload()}
        />
      ) : null}
    </>
  );
}
