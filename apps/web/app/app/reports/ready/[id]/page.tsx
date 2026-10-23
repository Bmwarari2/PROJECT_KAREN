'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, CalendarClock, Play, Save } from 'lucide-react';
import { Button, buttonVariants, Card, cn, EmptyState, Field, Input, Skeleton, useToast } from '@thapsus/ui';
import { today } from '@thapsus/core/time';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import type { ReportResult } from '@/lib/report-format';
import { PageTitle, useSession } from '../../../shell';
import type { Catalogue } from '../../page';
import {
  DownloadMenu,
  NoReportsAccess,
  problemText,
  ReportView,
  RunProgress,
  SaveReportDialog,
  selectClass,
  useBackgroundRun,
  type SaveForm,
} from '../../ui';

type Prop = {
  type?: string;
  format?: string;
  anyOf?: Array<{ const?: string }>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

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

/** A ready-made report: its options in a card, Save, Download and Schedule in the header, then the result. */
export default function ReadyReportPage() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { id } = useParams<{ id: string }>();
  const savedId = useSearchParams().get('saved');
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<{
    id: string;
    name: string;
    mine: boolean;
    spec: { params?: Record<string, unknown> };
  }>(savedId ? `/v1/reports/saved/${savedId}` : null);
  const entities = useApi<Array<{ id: string; name: string }>>('/v1/org/legal-entities');
  const def = catalogue.data?.ready.find((r) => r.id === id);
  const props = (def?.params.properties ?? {}) as Record<string, Prop>;
  const [values, setValues] = React.useState<Record<string, string> | null>(null);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const bg = useBackgroundRun();
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [scheduleNext, setScheduleNext] = React.useState(false);
  const [saveForm, setSaveForm] = React.useState<SaveForm>({ name: '', relative: '', shared: false });

  React.useEffect(() => {
    if (!def || values) return;
    // a saved report's options apply once it has loaded
    if (savedId && !saved.data && !saved.error) return;
    const base = defaults(props, zone);
    const fromSaved = saved.data?.spec.params ?? {};
    setValues({ ...base, ...Object.fromEntries(Object.entries(fromSaved).map(([k, v]) => [k, String(v)])) });
    if (saved.data) setSaveForm((f) => ({ ...f, name: saved.data!.name }));
  }, [def, values, props, zone, saved.data, saved.error, savedId]);

  if (catalogue.error) return <NoReportsAccess />;
  if (!catalogue.data || !values) return <Skeleton className="h-96 w-full" />;
  if (!def) return <NoReportsAccess title={t('errors.notFound')} />;

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
    const body = {
      name: saveForm.name,
      kind: 'ready',
      reportId: def!.id,
      params: params(),
      shared: saveForm.shared,
      ...(saveForm.relative ? { relative: saveForm.relative } : {}),
    };
    try {
      let savedReport: string;
      if (saved.data?.mine) {
        await api(`/v1/reports/saved/${saved.data.id}`, { method: 'PUT', json: body });
        savedReport = saved.data.id;
      } else
        savedReport = (await api<{ id: string }>('/v1/reports/saved', { method: 'POST', json: body })).id;
      toast({ title: t('reports.saved.done'), tone: 'success' });
      setSaveOpen(false);
      if (scheduleNext) router.push(`/app/reports/schedules?report=${savedReport}`);
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }
  const openSave = (thenSchedule: boolean) => {
    setScheduleNext(thenSchedule);
    setSaveOpen(true);
  };

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
        {t('reports.ui.catalogueTitle')}
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <div className="mr-auto min-w-0">
          <PageTitle>{saved.data?.name ?? t(def.titleKey)}</PageTitle>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
            {t(def.descriptionKey)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('reports.ui.actions')}>
          <Button type="button" size="sm" variant="secondary" onClick={() => openSave(false)}>
            <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.saved.save')}
          </Button>
          <DownloadMenu source={source} />
          {catalogue.data.canSchedule ? (
            saved.data ? (
              <Link
                href={`/app/reports/schedules?report=${saved.data.id}`}
                className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }), 'no-underline')}
              >
                <CalendarClock aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.ui.schedule')}
              </Link>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={() => openSave(true)}>
                <CalendarClock aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.ui.schedule')}
              </Button>
            )
          ) : null}
        </div>
      </div>
      <Card>
        <form
          onSubmit={run}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
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
          </div>
        </form>
      </Card>
      {busy && bg.run ? <RunProgress run={bg.run} /> : null}
      {result ? (
        <ReportView result={result} />
      ) : busy ? null : (
        <EmptyState
          icon={<Play aria-hidden />}
          title={t('reports.ui.notRun')}
          body={t('reports.ui.notRunBody')}
        />
      )}
      <SaveReportDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        form={saveForm}
        onChange={setSaveForm}
        onSubmit={save}
        note={scheduleNext ? t('reports.ui.saveBeforeSchedule') : undefined}
      />
    </div>
  );
}
