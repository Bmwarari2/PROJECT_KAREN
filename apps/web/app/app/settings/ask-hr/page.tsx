'use client';
import * as React from 'react';
import { Bot, FolderPlus, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, Select, Skeleton, Table, TD, TH, THead, TR, Textarea, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime, formatNumber } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageHeader } from '@/components/platform';
import { useSession } from '../../shell';

interface Settings {
  enabled: boolean;
  available: boolean;
  entitled: boolean;
  customerEnabled: boolean;
  region: string;
  awsRegion: string;
  model: { name: string; id: string; provider: string } | null;
  verifiedOn: string;
  canManageFlag: boolean;
  canManageSources: boolean;
  policyFolderIds: string[];
  policyDocumentIds: string[];
  folders: Array<{ id: string; name: string; visibility: string }>;
  candidateDocuments: Array<{ id: string; title: string; folderId: string | null }>;
  documents: Array<{ id: string; title: string; status: string; chunks: number; sanitisedChunks: number; indexedAt: string | null }>;
  stats: { questions: number; answered: number; refused: number; noAnswer: number; helpful: number; notHelpful: number };
}

export default function AskHrSettingsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const settings = useApi<Settings>('/v1/ai/settings');
  const [folders, setFolders] = React.useState<string[]>([]);
  const [docs, setDocs] = React.useState<string[]>([]);
  const [newFolder, setNewFolder] = React.useState('');
  const [policy, setPolicy] = React.useState({ title: '', body: '', folderId: '' });
  const [busy, setBusy] = React.useState<string | null>(null);
  const s = settings.data;

  React.useEffect(() => {
    if (!s) return;
    setFolders(s.policyFolderIds);
    setDocs(s.policyDocumentIds);
    setPolicy((p) => ({ ...p, folderId: p.folderId && s.policyFolderIds.includes(p.folderId) ? p.folderId : (s.policyFolderIds[0] ?? '') }));
  }, [s]);

  const fail = (err: unknown) => {
    const detail = err instanceof ApiProblem ? (err.body.detail as string | undefined) : undefined;
    const key = `askHr.errors.${detail}`;
    toast({ title: detail && t(key) !== key ? t(key) : err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
  };
  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const put = (json: Record<string, unknown>) =>
    run('save', async () => {
      settings.setData(await api<Settings>('/v1/ai/settings', { method: 'PUT', json }));
      toast({ title: t('askHr.settings.saved'), tone: 'success' });
    });

  if (settings.error) return <EmptyState level={1} icon={<Bot aria-hidden />} title={settings.error.title} />;
  if (!s) return <Skeleton className="h-96 w-full" />;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const canToggle = s.available && s.entitled && s.canManageFlag;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('askHr.settings.title')} lead={t('askHr.settings.body')} />

      <Card className="flex flex-col gap-3">
        <CardTitle>{t('askHr.settings.status')}</CardTitle>
        <p className="text-callout" data-testid="ai-region">
          {s.available && s.model ? t('askHr.settings.regionAvailable', { awsRegion: s.awsRegion, model: s.model.name }) : t('askHr.settings.regionUnavailable', { awsRegion: s.awsRegion })}
        </p>
        <p className="text-footnote text-text-secondary">{t('askHr.settings.verified', { date: formatDate(s.verifiedOn, locale) })}</p>
        {s.available && !s.entitled ? <p className="text-callout text-text-secondary">{t('askHr.settings.notEntitled')}</p> : null}
        <div className="flex items-center gap-3">
          <input
            id="ai-enabled"
            type="checkbox"
            role="switch"
            aria-checked={s.enabled}
            aria-describedby={!s.canManageFlag ? 'ai-enabled-hint' : undefined}
            checked={s.enabled}
            disabled={!canToggle || busy === 'save'}
            onChange={(e) => put({ enabled: e.target.checked })}
            className="h-6 w-6 accent-[var(--color-accent)]"
          />
          <label htmlFor="ai-enabled" className="text-callout font-semibold">
            {t('askHr.settings.switchLabel')}
          </label>
          <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? t('askHr.settings.on') : t('askHr.settings.off')}</Badge>
        </div>
        {!s.canManageFlag ? (
          <p id="ai-enabled-hint" className="text-footnote text-text-secondary">
            {t('askHr.settings.ownerOnly')}
          </p>
        ) : null}
      </Card>

      {s.canManageSources ? (
        <Card className="flex flex-col gap-4">
          <CardTitle>{t('askHr.settings.folders')}</CardTitle>
          <p className="text-callout text-text-secondary">{t('askHr.settings.foldersHint')}</p>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('askHr.settings.folders')}</legend>
            {s.folders.map((f) => (
              <label key={f.id} className="flex items-center gap-3 text-callout">
                <input type="checkbox" checked={folders.includes(f.id)} disabled={f.visibility !== 'everyone'} onChange={(e) => setFolders(toggle(folders, f.id, e.target.checked))} className="h-5 w-5 accent-[var(--color-accent)]" />
                <span>{f.name}</span>
                {f.visibility !== 'everyone' ? <Badge tone="neutral">{t('askHr.settings.notEveryone')}</Badge> : null}
              </label>
            ))}
          </fieldset>
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void run('folder', async () => {
                const { id } = await api<{ id: string }>('/v1/document-folders', { method: 'POST', json: { name: newFolder.trim(), visibility: 'everyone' } });
                setNewFolder('');
                settings.setData(await api<Settings>('/v1/ai/settings', { method: 'PUT', json: { policyFolderIds: [...folders, id], policyDocumentIds: docs } }));
              });
            }}
          >
            <Field id="ai-new-folder" label={t('askHr.settings.newFolder')} className="flex-1">
              {(p) => <Input {...p} required maxLength={120} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />}
            </Field>
            <Button type="submit" variant="secondary" loading={busy === 'folder'}>
              <FolderPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('askHr.settings.createFolder')}
            </Button>
          </form>
          {s.candidateDocuments.some((d) => !d.folderId || !folders.includes(d.folderId)) ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-callout font-semibold">{t('askHr.settings.documents')}</legend>
              <p className="text-footnote text-text-secondary">{t('askHr.settings.documentsHint')}</p>
              {s.candidateDocuments
                .filter((d) => !d.folderId || !folders.includes(d.folderId))
                .map((d) => (
                  <label key={d.id} className="flex items-center gap-3 text-callout">
                    <input type="checkbox" checked={docs.includes(d.id)} onChange={(e) => setDocs(toggle(docs, d.id, e.target.checked))} className="h-5 w-5 accent-[var(--color-accent)]" />
                    <span>{d.title}</span>
                  </label>
                ))}
            </fieldset>
          ) : null}
          <div>
            <Button onClick={() => put({ policyFolderIds: folders, policyDocumentIds: docs })} loading={busy === 'save'}>
              {t('askHr.settings.saveSources')}
            </Button>
          </div>
        </Card>
      ) : null}

      {s.canManageSources && s.policyFolderIds.length ? (
        <Card>
          <CardTitle>{t('askHr.settings.addText')}</CardTitle>
          <p className="mt-2 text-callout text-text-secondary">{t('askHr.settings.addTextHint')}</p>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run('policy', async () => {
                await api('/v1/ai/policy-documents', { method: 'POST', json: policy });
                setPolicy((p) => ({ ...p, title: '', body: '' }));
                toast({ title: t('askHr.settings.saved'), tone: 'success' });
                settings.reload();
              });
            }}
          >
            <Field id="ai-policy-title" label={t('askHr.settings.policyTitle')}>
              {(p) => <Input {...p} required maxLength={200} value={policy.title} onChange={(e) => setPolicy({ ...policy, title: e.target.value })} />}
            </Field>
            {s.policyFolderIds.length > 1 ? (
              <Field id="ai-policy-folder" label={t('askHr.settings.policyFolder')}>
                {(p) => (
                  <Select
                    id={p.id}
                    aria-describedby={p['aria-describedby']}
                    value={policy.folderId}
                    onValueChange={(v) => setPolicy({ ...policy, folderId: v })}
                    options={s.folders.filter((f) => s.policyFolderIds.includes(f.id)).map((f) => ({ value: f.id, label: f.name }))}
                  />
                )}
              </Field>
            ) : null}
            <Field id="ai-policy-body" label={t('askHr.settings.policyBody')}>
              {(p) => <Textarea {...p} required rows={8} maxLength={200_000} value={policy.body} onChange={(e) => setPolicy({ ...policy, body: e.target.value })} />}
            </Field>
            <div>
              <Button type="submit" loading={busy === 'policy'} disabled={!policy.folderId}>
                {t('askHr.settings.addPolicy')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="mr-auto">{t('askHr.settings.indexed')}</CardTitle>
          {s.canManageSources ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'reindex'}
              onClick={() =>
                run('reindex', async () => {
                  await api('/v1/ai/reindex', { method: 'POST' });
                  toast({ title: t('askHr.settings.reindexStarted'), tone: 'success' });
                })
              }
            >
              <RefreshCw aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('askHr.settings.reindex')}
            </Button>
          ) : null}
        </div>
        <div className="mt-4">
          {s.documents.length === 0 ? (
            <EmptyState icon={<Bot aria-hidden />} title={t('askHr.settings.noDocuments')} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>{t('askHr.settings.document')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>{t('askHr.settings.chunks')}</TH>
                  <TH>{t('askHr.settings.indexedAt')}</TH>
                </tr>
              </THead>
              <tbody>
                {s.documents.map((d) => (
                  <TR key={d.id}>
                    <TD>{d.title}</TD>
                    <TD>
                      <Badge tone={d.status === 'indexed' ? 'success' : d.status === 'pending' ? 'neutral' : 'warning'}>{t(`askHr.settings.state.${d.status}`)}</Badge>
                      {d.sanitisedChunks ? <span className="ml-2 text-footnote text-text-secondary">{t('askHr.settings.sanitised')}</span> : null}
                    </TD>
                    <TD>{formatNumber(d.chunks, locale)}</TD>
                    <TD>{d.indexedAt ? formatDateTime(d.indexedAt, locale, session?.timeZone ?? 'UTC') : '—'}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>{t('askHr.settings.stats')}</CardTitle>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {(
            [
              ['statQuestions', s.stats.questions],
              ['statAnswered', s.stats.answered],
              ['statRefused', s.stats.refused],
              ['statNoAnswer', s.stats.noAnswer],
              ['statHelpful', s.stats.helpful],
              ['statNotHelpful', s.stats.notHelpful],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-footnote text-text-secondary">{t(`askHr.settings.${k}`)}</dt>
              <dd className="text-title-3">{formatNumber(v, locale)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
