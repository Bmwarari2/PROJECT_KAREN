'use client';
import * as React from 'react';
import { Upload } from 'lucide-react';
import { Button, Card, Table, TD, TH, THead, TR, useToast, PageSection } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { PageIntro } from '@/components/module-page';

interface Uploaded {
  id: string;
  headers: string[];
  rowCount: number;
  suggestedMapping: Record<string, string>;
  targets: string[];
}
interface Preview {
  rows: number;
  valid: number;
  creates: number;
  updates: number;
  errors: Array<{ row: number; column: string; message: string }>;
}

export default function ImportsPage() {
  const t = useT();
  const toast = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [up, setUp] = React.useState<Uploaded | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [job, setJob] = React.useState<{
    id: string;
    status: string;
    done: number;
    total: number | null;
    errorUrl?: string | null;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function upload() {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set('file', file);
    const res = await fetch('/v1/imports', { method: 'POST', body: form });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) return toast({ title: body.title, tone: 'danger' });
    setUp(body);
    setMapping(body.suggestedMapping);
    setPreview(null);
    setJob(null);
  }

  async function runPreview() {
    if (!up) return;
    setBusy(true);
    try {
      setPreview(await api<Preview>(`/v1/imports/${up.id}/preview`, { method: 'POST', json: { mapping } }));
    } catch (e) {
      toast({ title: e instanceof ApiProblem ? e.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    if (!up) return;
    const r = await api<{ jobId: string }>(`/v1/imports/${up.id}/run`, { method: 'POST', json: { dryRun } });
    const poll = async () => {
      const j = await api<{ status: string; progressDone: string; progressTotal: string | null }>(
        `/v1/jobs/${r.jobId}`,
      );
      const imp = await api<{ errorReportUrl: string | null }>(`/v1/imports/${up.id}`);
      setJob({
        id: r.jobId,
        status: j.status,
        done: Number(j.progressDone),
        total: j.progressTotal ? Number(j.progressTotal) : null,
        errorUrl: imp.errorReportUrl,
      });
      if (j.status === 'queued' || j.status === 'running') setTimeout(poll, 1500);
    };
    void poll();
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageIntro title={t('imports.title')} titleIsTab />
      <PageSection headingLevel={2} title={t('imports.step1')} description={t('imports.step1Body')}>
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="min-w-0 max-w-full text-callout">
              <span className="sr-only">{t('imports.file')}</span>
              <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <Button size="sm" onClick={upload} disabled={!file} loading={busy && !up}>
              <Upload aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('imports.upload')}
            </Button>
          </div>
        </Card>
      </PageSection>
      {up ? (
        <PageSection headingLevel={2} title={t('imports.step2', { rows: up.rowCount, count: up.rowCount })}>
          <Card className="flex flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {up.headers.map((h) => (
                <label key={h} className="flex items-center gap-2 text-callout">
                  <span className="w-40 truncate text-text-secondary" title={h}>
                    {h}
                  </span>
                  <select
                    value={mapping[h] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                    className="h-9 flex-1 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
                  >
                    <option value="">{t('imports.ignore')}</option>
                    {up.targets.map((x) => (
                      <option key={x} value={x}>
                        {t(`people.field.${x}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <Button size="sm" className="self-start" onClick={runPreview} loading={busy}>
              {t('imports.preview')}
            </Button>
          </Card>
        </PageSection>
      ) : null}
      {preview ? (
        <PageSection headingLevel={2} title={t('imports.step3')}>
          <Card className="flex flex-col gap-3">
            <p className="text-callout">
              {t('imports.summary', {
                creates: preview.creates,
                updates: preview.updates,
                problems: t('imports.problems', { count: preview.errors.length }),
              })}
            </p>
            {preview.errors.length ? (
              <Table dense>
                <THead>
                  <tr>
                    <TH>{t('imports.row')}</TH>
                    <TH>{t('imports.column')}</TH>
                    <TH>{t('imports.problem')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {preview.errors.slice(0, 50).map((e, i) => (
                    <TR key={i}>
                      <TD>{e.row}</TD>
                      <TD label={t('imports.column')}>{e.column}</TD>
                      <TD className="text-danger" label={t('imports.problem')}>
                        {e.message}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : null}
            <div className="flex gap-3">
              <Button size="sm" variant="secondary" onClick={() => run(true)}>
                {t('imports.dryRun')}
              </Button>
              <Button size="sm" onClick={() => run(false)} disabled={!preview.valid}>
                {t('imports.run')}
              </Button>
            </div>
            {job ? (
              <div role="status" className="flex flex-col gap-2">
                <progress
                  className="h-2 w-full accent-[var(--color-accent)]"
                  value={job.done}
                  max={job.total ?? undefined}
                />
                <p className="text-footnote text-text-secondary">
                  {t('imports.progress', {
                    done: job.done,
                    total: job.total ?? '…',
                    count: job.total ?? '…',
                    status: t(`imports.status.${job.status}`),
                  })}
                </p>
                {job.errorUrl ? (
                  <a href={job.errorUrl} className="text-callout">
                    {t('imports.errorReport')}
                  </a>
                ) : null}
              </div>
            ) : null}
          </Card>
        </PageSection>
      ) : null}
    </div>
  );
}
