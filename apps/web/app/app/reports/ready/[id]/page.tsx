'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { ArrowLeft, Play, Save } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  useToast,
} from '@thapsus/ui';
import { today } from '@thapsus/core/time';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import type { ReportResult } from '@/lib/report-format';
import { useSession } from '../../../shell';
import type { Catalogue } from '../../page';
import { ExportBar, problemText, ReportView, RunProgress, selectClass, useBackgroundRun } from '../../ui';

type Prop = {
  type?: string;
  format?: string;
  anyOf?: Array<{ const?: string }>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
};
const RELATIVE = [
  'today',
  'yesterday',
  'previousWeek',
  'previousMonth',
  'monthToDate',
  'yearToDate',
  'previousYear',
];

/** Sensible starting values for a parameter form (the viewer's zone; never sent unless the user runs the report). */
function defaults(props: Record<string, Prop>, zone: string): Record<string, string> {
  const d = today(zone);
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(props)) {
    if (k === 'asOf' || k === 'to') out[k] = d;
    else if (k === 'from') out[k] = `${d.slice(0, 4)}-01-01`;
    else if (k === 'year') out[k] = d.slice(0, 4);
    else if (p.default !== undefined) out[k] = String(p.default);
    else if (p.anyOf?.[0]?.const) out[k] = p.anyOf[0].const;
    else out[k] = '';
  }
  return out;
}

export default function ReadyReportPage() {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { id } = useParams<{ id: string }>();
  const savedId = useSearchParams().get('saved');
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<{ name: string; spec: { params?: Record<string, unknown> } }>(
    savedId ? `/v1/reports/saved/${savedId}` : null,
  );
  const entities = useApi<Array<{ id: string; name: string }>>('/v1/org/legal-entities');
  const def = catalogue.data?.ready.find((r) => r.id === id);
  const props = (def?.params.properties ?? {}) as Record<string, Prop>;
  const [values, setValues] = React.useState<Record<string, string> | null>(null);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const bg = useBackgroundRun();
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveForm, setSaveForm] = React.useState({ name: '', relative: '', shared: false });

  React.useEffect(() => {
    if (!def || values) return;
    const base = defaults(props, zone);
    const fromSaved = saved.data?.spec.params ?? {};
    setValues({ ...base, ...Object.fromEntries(Object.entries(fromSaved).map(([k, v]) => [k, String(v)])) });
  }, [def, values, props, zone, saved.data]);

  if (catalogue.error) return <EmptyState level={1} title={t('reports.noAccess')} />;
  if (!catalogue.data || !values) return <Skeleton className="h-96 w-full" />;
  if (!def) return <EmptyState level={1} title={t('errors.notFound')} />;

  const params = () => {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      const v = values[k];
      if (v === undefined || v === '') continue;
      out[k] = p.type === 'integer' ? Number(v) : v;
    }
    return out;
  };
  const source = { kind: 'ready', reportId: def.id, params: params() };

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await api<ReportResult>(`/v1/reports/ready/${def!.id}/run`, {
          method: 'POST',
          json: { params: params() },
        }),
      );
    } catch (err) {
      if (err instanceof ApiProblem && err.body.code === 'useBackgroundRun') {
        // too large for the screen: run it in the background with progress, then show the stored result
        const r = await bg.start(source, 'json').catch(() => null);
        if (r?.status === 'succeeded') setResult(await api<ReportResult>(`/v1/reports/runs/${r.id}/result`));
        else toast({ title: t('reports.exportFailed'), tone: 'danger' });
      } else toast({ title: problemText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/v1/reports/saved', {
        method: 'POST',
        json: {
          name: saveForm.name,
          kind: 'ready',
          reportId: def!.id,
          params: params(),
          shared: saveForm.shared,
          ...(saveForm.relative ? { relative: saveForm.relative } : {}),
        },
      });
      toast({ title: t('reports.saved.done'), tone: 'success' });
      setSaveOpen(false);
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }

  const control = (k: string, p: Prop, a: { id: string; 'aria-describedby'?: string }) => {
    const set = (v: string) => setValues((s) => ({ ...s!, [k]: v }));
    if (k === 'entityId')
      return (
        <select {...a} className={selectClass} value={values[k] ?? ''} onChange={(e) => set(e.target.value)}>
          <option value="">{t('reports.param.allEntities')}</option>
          {(entities.data ?? []).map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
            </option>
          ))}
        </select>
      );
    if (p.anyOf)
      return (
        <select {...a} className={selectClass} value={values[k] ?? ''} onChange={(e) => set(e.target.value)}>
          {p.anyOf.map((o) => (
            <option key={o.const} value={o.const}>
              {t(k === 'sector' ? `compliance.gpg.sectorName.${o.const}` : `reports.groupBy.${o.const}`)}
            </option>
          ))}
        </select>
      );
    if (p.format === 'date')
      return (
        <Input
          {...a}
          type="date"
          value={values[k] ?? ''}
          required={def.params.required?.includes(k)}
          onChange={(e) => set(e.target.value)}
        />
      );
    if (p.type === 'integer')
      return (
        <Input
          {...a}
          type="number"
          inputMode="numeric"
          min={p.minimum}
          max={p.maximum}
          value={values[k] ?? ''}
          onChange={(e) => set(e.target.value)}
        />
      );
    return <Input {...a} value={values[k] ?? ''} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/reports" className="inline-flex w-fit items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('reports.title')}
      </Link>
      <div>
        <h1 className="text-title-2">{saved.data?.name ?? t(def.titleKey)}</h1>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t(def.descriptionKey)}
        </p>
      </div>
      <form
        onSubmit={run}
        className="grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t('reports.parameters')}
      >
        {Object.entries(props).map(([k, p]) => (
          <Field key={k} id={`p-${k}`} label={t(`reports.param.${k}`)}>
            {(a) => control(k, p, a)}
          </Field>
        ))}
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" loading={busy}>
            <Play aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.run')}
          </Button>
          <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="secondary">
                <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.saved.save')}
              </Button>
            </DialogTrigger>
            <DialogContent
              title={t('reports.saved.save')}
              description={t('reports.saved.saveBody')}
              closeLabel={t('common.close')}
            >
              <form onSubmit={save} className="flex flex-col gap-4">
                <Field id="save-name" label={t('reports.saved.name')}>
                  {(a) => (
                    <Input
                      {...a}
                      required
                      maxLength={120}
                      value={saveForm.name}
                      onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })}
                    />
                  )}
                </Field>
                <Field
                  id="save-relative"
                  label={t('reports.saved.relative')}
                  hint={t('reports.saved.relativeHint')}
                >
                  {(a) => (
                    <select
                      {...a}
                      className={selectClass}
                      value={saveForm.relative}
                      onChange={(e) => setSaveForm({ ...saveForm, relative: e.target.value })}
                    >
                      <option value="">{t('reports.relative.fixed')}</option>
                      {RELATIVE.map((r) => (
                        <option key={r} value={r}>
                          {t(`reports.relative.${r}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <label className="flex items-center gap-2 text-callout">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--color-accent)]"
                    checked={saveForm.shared}
                    onChange={(e) => setSaveForm({ ...saveForm, shared: e.target.checked })}
                  />
                  {t('reports.saved.shareWithTeam')}
                </label>
                <Button type="submit">{t('common.save')}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </form>
      {busy && bg.run ? <RunProgress run={bg.run} /> : null}
      {result ? (
        <>
          <ExportBar source={source} />
          <ReportView result={result} />
        </>
      ) : null}
    </div>
  );
}
