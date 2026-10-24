'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { FileSignature, FileText } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';
import { ExportLinks } from '@/components/export-links';
import {
  ListCard,
  ListFilter,
  ListNoMatches,
  ListSearch,
  matches,
  PageIntro,
} from '@/components/module-page';
import { EntityLink } from '@/components/person-link';

interface SigReq {
  id: string;
  documentId: string;
  title: string;
  status: string;
  requestedAt: string;
}
interface Doc {
  id: string;
  title: string;
  createdAt: string;
  category: string;
}

export default function DocumentsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const params = useSearchParams();
  const sigs = useApi<SigReq[]>('/v1/signature-requests');
  const docs = useApi<Doc[]>(
    session?.employeeId ? `/v1/documents?employeeId=${session.employeeId}` : '/v1/documents',
  );
  const [signing, setSigning] = React.useState<SigReq | null>(null);
  const [name, setName] = React.useState('');
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('');

  React.useEffect(() => {
    const id = params.get('sign');
    if (id && sigs.data) setSigning(sigs.data.find((s) => s.id === id && s.status === 'pending') ?? null);
  }, [params, sigs.data]);

  const open = async (documentId: string) =>
    window.open(
      (await api<{ url: string }>(`/v1/documents/${documentId}/download`)).url,
      '_blank',
      'noopener',
    );

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (!signing) return;
    setBusy(true);
    try {
      await api(`/v1/signature-requests/${signing.id}/sign`, {
        method: 'POST',
        json: { consent: true, typedName: name },
      });
      toast({ title: t('documents.signed'), tone: 'success' });
      setSigning(null);
      sigs.reload();
      docs.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const pending = (sigs.data ?? []).filter((s) => s.status === 'pending');
  // The documents are filtered on the page: the API returns every one the viewer may see.
  const rows = docs.data ?? [];
  const categories = [...new Set(rows.map((d) => d.category))].sort((a, b) => a.localeCompare(b, locale));
  const shown = rows.filter((d) => (!category || d.category === category) && matches(query, d.title));
  const filtered = !!category || !!query.trim();
  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('documents.title')}
        titleIsTab
        actions={<ExportLinks list="documents" params={{ employeeId: session?.employeeId ?? undefined }} />}
      />
      {pending.length ? (
        <Card>
          <CardTitle>{t('documents.toSign')}</CardTitle>
          <ul className="mt-3 flex flex-col gap-2">
            {pending.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                <FileSignature aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                <span className="min-w-0 flex-1 text-callout">
                  <EntityLink href={`/app/documents/${s.documentId}?sign=${s.id}`}>{s.title}</EntityLink>
                </span>
                <Button size="sm" variant="secondary" onClick={() => open(s.documentId)}>
                  {t('documents.read')}
                </Button>
                <Button size="sm" onClick={() => setSigning(s)}>
                  {t('documents.sign')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
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
              options={categories.map((c) => ({ value: c, label: c }))}
            />
          ) : undefined
        }
        applied={
          category
            ? [
                {
                  key: 'category',
                  label: t('documents.list.categoryChip', { category }),
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
                  <span className="flex items-center gap-3">
                    <FileText aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-accent" />
                    {/* the document's own page (the in-app viewer, ADR-0161) */}
                    <EntityLink href={`/app/documents/${d.id}`} className="text-callout">
                      {d.title}
                    </EntityLink>
                  </span>
                </TD>
                <TD>
                  <Badge>{d.category}</Badge>
                </TD>
                <TD className="text-footnote text-text-secondary">
                  {formatDate(d.createdAt.slice(0, 10), locale)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </ListCard>
      <Dialog open={!!signing} onOpenChange={(o) => !o && setSigning(null)}>
        {signing ? (
          <DialogContent
            title={t('documents.signTitle', { title: signing.title })}
            description={t('documents.signBody')}
            closeLabel={t('common.close')}
          >
            <form onSubmit={sign} className="flex flex-col gap-4">
              <Field id="typedName" label={t('documents.typedName')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    minLength={2}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                )}
              </Field>
              <label className="flex items-start gap-3 text-callout">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <span>{t('documents.consent')}</span>
              </label>
              <Button type="submit" disabled={!consent} loading={busy}>
                {t('documents.signNow')}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
