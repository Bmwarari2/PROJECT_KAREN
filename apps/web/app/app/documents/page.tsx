'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { FileSignature, FileText } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Dialog, DialogContent, EmptyState, Field, Input, Skeleton, useToast } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';
import { ExportLinks } from '@/components/export-links';

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
  const docs = useApi<Doc[]>(session?.employeeId ? `/v1/documents?employeeId=${session.employeeId}` : '/v1/documents');
  const [signing, setSigning] = React.useState<SigReq | null>(null);
  const [name, setName] = React.useState('');
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const id = params.get('sign');
    if (id && sigs.data) setSigning(sigs.data.find((s) => s.id === id && s.status === 'pending') ?? null);
  }, [params, sigs.data]);

  const open = async (documentId: string) => window.open((await api<{ url: string }>(`/v1/documents/${documentId}/download`)).url, '_blank', 'noopener');

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (!signing) return;
    setBusy(true);
    try {
      await api(`/v1/signature-requests/${signing.id}/sign`, { method: 'POST', json: { consent: true, typedName: name } });
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
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('documents.title')}</h1>
        <ExportLinks list="documents" params={{ employeeId: session?.employeeId ?? undefined }} />
      </div>
      {pending.length ? (
        <Card>
          <CardTitle>{t('documents.toSign')}</CardTitle>
          <ul className="mt-3 flex flex-col gap-2">
            {pending.map((s) => (
              <li key={s.id} className="flex items-center gap-3">
                <FileSignature aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                <span className="flex-1 text-callout">{s.title}</span>
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
      {!docs.data ? (
        <Skeleton className="h-40 w-full" />
      ) : docs.data.length === 0 ? (
        <EmptyState icon={<FileText aria-hidden />} title={t('documents.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {docs.data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-md border border-border p-3">
              <FileText aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
              <button type="button" className="text-left text-callout text-accent hover:underline" onClick={() => open(d.id)}>
                {d.title}
              </button>
              <Badge>{d.category}</Badge>
              <span className="ml-auto text-footnote text-text-secondary">{formatDate(d.createdAt.slice(0, 10), locale)}</span>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!signing} onOpenChange={(o) => !o && setSigning(null)}>
        {signing ? (
          <DialogContent title={t('documents.signTitle', { title: signing.title })} description={t('documents.signBody')} closeLabel={t('common.close')}>
            <form onSubmit={sign} className="flex flex-col gap-4">
              <Field id="typedName" label={t('documents.typedName')}>
                {(p) => <Input {...p} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
              </Field>
              <label className="flex items-start gap-3 text-callout">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 accent-[var(--color-accent)]" />
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
