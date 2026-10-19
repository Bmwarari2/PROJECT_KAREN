'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Eye, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent, DialogTrigger, EmptyState, Field, Input, Skeleton, useToast } from '@thapsus/ui';
import { today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import type { ReportResult } from '@/lib/report-format';
import { useSession } from '../../shell';
import type { Catalogue } from '../page';
import { ExportBar, problemText, ReportView, selectClass } from '../ui';

type DatasetDef = Catalogue['datasets'][number];
type FieldDef = DatasetDef['fields'][number];
type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isEmpty' | 'isNotEmpty';
type Fn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
interface Filter {
  field: string;
  op: Op;
  value?: string | number | boolean | string[];
}
interface Spec {
  dataset: string;
  columns?: string[];
  filters?: Filter[];
  groupBy?: Array<{ field: string; granularity?: 'month' | 'year' }>;
  measures?: Array<{ fn: Fn; field?: string }>;
  asOf?: string;
  from?: string;
  to?: string;
  population?: 'employed' | 'all';
  chart?: 'bar' | 'line' | 'none';
}
const RELATIVE = ['today', 'yesterday', 'previousWeek', 'previousMonth', 'monthToDate', 'yearToDate', 'previousYear'];
const FNS: Fn[] = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'];
const OPS_FOR: Record<string, Op[]> = {
  text: ['eq', 'neq', 'contains', 'isEmpty', 'isNotEmpty'],
  enum: ['eq', 'neq', 'in', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  integer: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  decimal: ['eq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  minutes: ['eq', 'gt', 'gte', 'lt', 'lte'],
  money: ['gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
};

function initialSpec(d: DatasetDef, zone: string): Spec {
  const now = today(zone);
  const defaults = d.fields.filter((f) => !f.vault && f.sensitivity !== 'special').slice(0, 6).map((f) => f.key);
  return d.time === 'asOf' ? { dataset: d.key, columns: defaults, asOf: now, population: 'employed', chart: 'none' } : { dataset: d.key, columns: defaults, from: `${now.slice(0, 7)}-01`, to: now, chart: 'none' };
}

/** Report builder: pick a dataset, fields, filters and grouping; preview on screen; export; save; share. */
export default function BuilderPage() {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const savedId = useSearchParams().get('saved');
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<{ id: string; name: string; mine: boolean; shared: boolean; spec: Spec & { relative?: string } }>(savedId ? `/v1/reports/saved/${savedId}` : null);
  const [spec, setSpec] = React.useState<Spec | null>(null);
  const [mode, setMode] = React.useState<'list' | 'summary'>('list');
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveForm, setSaveForm] = React.useState({ name: '', relative: '', shared: false });

  React.useEffect(() => {
    if (spec || !catalogue.data?.datasets.length) return;
    if (savedId && !saved.data && !saved.error) return;
    if (saved.data) {
      const { relative, ...s } = saved.data.spec;
      setSpec(s);
      setMode(s.groupBy?.length ? 'summary' : 'list');
      setSaveForm({ name: saved.data.name, relative: relative ?? '', shared: saved.data.shared });
    } else setSpec(initialSpec(catalogue.data.datasets[0]!, zone));
  }, [catalogue.data, saved.data, saved.error, savedId, spec, zone]);

  if (catalogue.error) return <EmptyState icon={<Lock aria-hidden />} title={t('reports.noAccess')} body={t('reports.noAccessBody')} />;
  if (!catalogue.data || !spec)
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-title-2">{t('reports.builder.title')}</h1>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('reports.builder.intro')}</p>
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (!catalogue.data.datasets.length) return <EmptyState icon={<Lock aria-hidden />} title={t('reports.builder.noDatasets')} />;
  const ds = catalogue.data.datasets.find((d) => d.key === spec.dataset) ?? catalogue.data.datasets[0]!;
  const fieldOf = (k: string) => ds.fields.find((f) => f.key === k);
  const groupable = ds.fields.filter((f) => f.groupable);
  const aggregatable = ds.fields.filter((f) => f.aggregatable);
  const filterable = ds.fields.filter((f) => !f.vault);

  /** The spec actually sent: list mode drops grouping; summary mode drops the column list. */
  const effective = (): Spec => {
    const s: Spec = { ...spec, filters: (spec.filters ?? []).filter((f) => f.field) };
    if (mode === 'list') {
      delete s.groupBy;
      delete s.measures;
    } else {
      delete s.columns;
      s.groupBy = (spec.groupBy ?? []).filter((g) => g.field);
      s.measures = (spec.measures ?? []).filter((m) => m.fn === 'count' || m.field);
    }
    return s;
  };
  const update = (patch: Partial<Spec>) => {
    setSpec((s) => ({ ...s!, ...patch }));
    setResult(null);
  };

  async function preview(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      setResult(await api<ReportResult>('/v1/reports/builder/preview', { method: 'POST', json: effective() }));
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = { name: saveForm.name, kind: 'builder', spec: effective(), shared: saveForm.shared, ...(saveForm.relative ? { relative: saveForm.relative } : {}) };
    try {
      if (saved.data?.mine) await api(`/v1/reports/saved/${saved.data.id}`, { method: 'PUT', json: body });
      else await api('/v1/reports/saved', { method: 'POST', json: body });
      toast({ title: t('reports.saved.done'), tone: 'success' });
      setSaveOpen(false);
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }

  const fieldLabel = (f: FieldDef) => t(f.labelKey);
  const setFilter = (i: number, patch: Partial<Filter>) => update({ filters: (spec.filters ?? []).map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const filterValue = (flt: Filter, i: number) => {
    const f = fieldOf(flt.field);
    if (!f || flt.op === 'isEmpty' || flt.op === 'isNotEmpty') return null;
    const id = `flt-v-${i}`;
    const label = t('reports.builder.value');
    if (f.type === 'boolean')
      return (
        <select id={id} aria-label={label} className={selectClass} value={String(flt.value ?? 'true')} onChange={(e) => setFilter(i, { value: e.target.value === 'true' })}>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      );
    if (f.type === 'enum' && f.enumValues) {
      if (flt.op === 'in')
        return (
          <select id={id} aria-label={label} multiple className={`${selectClass} h-24`} value={Array.isArray(flt.value) ? flt.value : []} onChange={(e) => setFilter(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
            {f.enumValues.map((v) => (
              <option key={v} value={v}>
                {t(`reports.enum.${f.key}.${v}`)}
              </option>
            ))}
          </select>
        );
      return (
        <select id={id} aria-label={label} className={selectClass} value={String(flt.value ?? '')} onChange={(e) => setFilter(i, { value: e.target.value })}>
          <option value="" />
          {f.enumValues.map((v) => (
            <option key={v} value={v}>
              {t(`reports.enum.${f.key}.${v}`)}
            </option>
          ))}
        </select>
      );
    }
    const numeric = ['integer', 'decimal', 'minutes'].includes(f.type);
    return (
      <Input
        id={id}
        aria-label={label}
        type={f.type === 'date' ? 'date' : numeric ? 'number' : 'text'}
        inputMode={f.type === 'money' ? 'numeric' : undefined}
        step={f.type === 'decimal' ? 'any' : undefined}
        value={String(flt.value ?? '')}
        onChange={(e) => setFilter(i, { value: numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value })}
        aria-describedby={f.type === 'money' ? `${id}-hint` : undefined}
      />
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/reports" className="inline-flex w-fit items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('reports.title')}
      </Link>
      <div>
        <h1 className="text-title-2">{saved.data?.name ?? t('reports.builder.title')}</h1>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('reports.builder.intro')}</p>
      </div>
      <form onSubmit={preview} className="flex flex-col gap-5 rounded-lg bg-surface p-4" aria-label={t('reports.builder.title')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="b-dataset" label={t('reports.param.dataset')}>
            {(a) => (
              <select {...a} className={selectClass} value={ds.key} onChange={(e) => update(initialSpec(catalogue.data!.datasets.find((d) => d.key === e.target.value)!, zone))}>
                {catalogue.data!.datasets.map((d) => (
                  <option key={d.key} value={d.key}>
                    {t(d.labelKey)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {ds.time === 'asOf' ? (
            <>
              <Field id="b-asof" label={t('reports.param.asOf')}>
                {(a) => <Input {...a} type="date" required value={spec.asOf ?? ''} onChange={(e) => update({ asOf: e.target.value })} />}
              </Field>
              <Field id="b-population" label={t('reports.builder.population')}>
                {(a) => (
                  <select {...a} className={selectClass} value={spec.population ?? 'employed'} onChange={(e) => update({ population: e.target.value as 'employed' | 'all' })}>
                    <option value="employed">{t('reports.builder.populationEmployed')}</option>
                    <option value="all">{t('reports.builder.populationAll')}</option>
                  </select>
                )}
              </Field>
            </>
          ) : (
            <>
              <Field id="b-from" label={t('reports.param.from')}>
                {(a) => <Input {...a} type="date" required value={spec.from ?? ''} onChange={(e) => update({ from: e.target.value })} />}
              </Field>
              <Field id="b-to" label={t('reports.param.to')}>
                {(a) => <Input {...a} type="date" required value={spec.to ?? ''} onChange={(e) => update({ to: e.target.value })} />}
              </Field>
            </>
          )}
          <Field id="b-chart" label={t('reports.builder.chart')}>
            {(a) => (
              <select {...a} className={selectClass} value={spec.chart ?? 'none'} onChange={(e) => update({ chart: e.target.value as Spec['chart'] })}>
                {(['none', 'bar', 'line'] as const).map((c) => (
                  <option key={c} value={c}>
                    {t(`reports.builder.chartType.${c}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-2 text-callout font-semibold">{t('reports.builder.mode')}</legend>
          {(['list', 'summary'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-callout">
              <input type="radio" name="mode" className="h-5 w-5 accent-[var(--color-accent)]" checked={mode === m} onChange={() => (setMode(m), setResult(null))} />
              {t(`reports.builder.mode${m === 'list' ? 'List' : 'Summary'}`)}
            </label>
          ))}
        </fieldset>

        {mode === 'list' ? (
          <fieldset>
            <legend className="mb-2 text-callout font-semibold">{t('reports.builder.columns')}</legend>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {ds.fields.map((f) => (
                <label key={f.key} className="flex min-h-11 items-center gap-2 text-callout">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--color-accent)]"
                    checked={spec.columns?.includes(f.key) ?? false}
                    onChange={(e) => update({ columns: e.target.checked ? [...(spec.columns ?? []), f.key] : (spec.columns ?? []).filter((c) => c !== f.key) })}
                  />
                  <span>{fieldLabel(f)}</span>
                  {f.vault || f.sensitivity === 'special' ? (
                    <Badge tone="warning">
                      <Lock aria-hidden className="mr-1 inline h-3 w-3 stroke-[1.5]" />
                      {t(f.vault ? 'reports.builder.vaultField' : 'reports.sensitiveBadge')}
                    </Badge>
                  ) : f.sensitivity === 'personal' ? (
                    <Badge>{t('reports.builder.personal')}</Badge>
                  ) : null}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-callout font-semibold">{t('reports.param.groupBy')}</legend>
              {[0, 1].map((i) => {
                const g = spec.groupBy?.[i];
                const gf = g ? fieldOf(g.field) : undefined;
                return (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-2">
                    <select
                      aria-label={t('reports.builder.groupLevel', { level: i + 1 })}
                      className={selectClass}
                      value={g?.field ?? ''}
                      onChange={(e) => {
                        const next = [...(spec.groupBy ?? [])];
                        if (e.target.value) next[i] = { field: e.target.value };
                        else next.splice(i, 1);
                        update({ groupBy: next.filter(Boolean) });
                      }}
                    >
                      <option value="">{t('reports.builder.noGrouping')}</option>
                      {groupable.map((f) => (
                        <option key={f.key} value={f.key}>
                          {fieldLabel(f)}
                        </option>
                      ))}
                    </select>
                    {gf?.type === 'date' ? (
                      <select
                        aria-label={t('reports.builder.granularity')}
                        className={selectClass}
                        value={g?.granularity ?? 'month'}
                        onChange={(e) => update({ groupBy: (spec.groupBy ?? []).map((x, j) => (j === i ? { ...x, granularity: e.target.value as 'month' | 'year' } : x)) })}
                      >
                        <option value="month">{t('reports.builder.byMonth')}</option>
                        <option value="year">{t('reports.builder.byYear')}</option>
                      </select>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </fieldset>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-callout font-semibold">{t('reports.builder.measures')}</legend>
              {(spec.measures?.length ? spec.measures : [{ fn: 'count' as Fn }]).map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <select
                    aria-label={t('reports.builder.measureFn', { n: i + 1 })}
                    className={selectClass}
                    value={m.fn}
                    onChange={(e) => {
                      const next = [...(spec.measures?.length ? spec.measures : [{ fn: 'count' as Fn }])];
                      next[i] = { fn: e.target.value as Fn, ...(e.target.value === 'count' ? {} : { field: m.field }) };
                      update({ measures: next });
                    }}
                  >
                    {FNS.map((f) => (
                      <option key={f} value={f}>
                        {t(`reports.measure.${f}`)}
                      </option>
                    ))}
                  </select>
                  {m.fn === 'count' ? (
                    <span className="self-center text-callout text-text-secondary">{t('reports.builder.rows')}</span>
                  ) : (
                    <select
                      aria-label={t('reports.builder.measureField', { n: i + 1 })}
                      className={selectClass}
                      value={m.field ?? ''}
                      onChange={(e) => update({ measures: (spec.measures ?? [m]).map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}
                    >
                      <option value="" />
                      {(m.fn === 'countDistinct' ? filterable : aggregatable).map((f) => (
                        <option key={f.key} value={f.key}>
                          {fieldLabel(f)}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button type="button" size="sm" variant="ghost" aria-label={t('reports.builder.removeMeasure', { n: i + 1 })} disabled={(spec.measures?.length ?? 1) <= 1} onClick={() => update({ measures: (spec.measures ?? []).filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="secondary" className="w-fit" disabled={(spec.measures?.length ?? 1) >= 6} onClick={() => update({ measures: [...(spec.measures?.length ? spec.measures : [{ fn: 'count' as Fn }]), { fn: 'sum' }] })}>
                <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.builder.addMeasure')}
              </Button>
            </fieldset>
          </div>
        )}

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-callout font-semibold">{t('reports.param.filters')}</legend>
          {(spec.filters ?? []).map((flt, i) => {
            const f = fieldOf(flt.field);
            const ops = f ? (OPS_FOR[f.type] ?? ['eq']) : ['eq'];
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <select aria-label={t('reports.builder.filterField', { n: i + 1 })} className={selectClass} value={flt.field} onChange={(e) => setFilter(i, { field: e.target.value, op: (OPS_FOR[fieldOf(e.target.value)?.type ?? 'text'] ?? ['eq'])[0] as Op, value: undefined })}>
                  <option value="" />
                  {filterable.map((x) => (
                    <option key={x.key} value={x.key}>
                      {fieldLabel(x)}
                    </option>
                  ))}
                </select>
                <select aria-label={t('reports.builder.filterOp', { n: i + 1 })} className={selectClass} value={flt.op} onChange={(e) => setFilter(i, { op: e.target.value as Op, value: e.target.value === 'in' ? [] : undefined })}>
                  {ops.map((o) => (
                    <option key={o} value={o}>
                      {t(`reports.op.${o}`)}
                    </option>
                  ))}
                </select>
                <div>
                  {filterValue(flt, i)}
                  {f?.type === 'money' ? (
                    <p id={`flt-v-${i}-hint`} className="mt-1 text-footnote text-text-secondary">
                      {t('reports.builder.minorUnits')}
                    </p>
                  ) : null}
                </div>
                <Button type="button" size="sm" variant="ghost" aria-label={t('reports.builder.removeFilter', { n: i + 1 })} onClick={() => update({ filters: (spec.filters ?? []).filter((_, j) => j !== i) })}>
                  <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                </Button>
              </div>
            );
          })}
          <Button type="button" size="sm" variant="secondary" className="w-fit" disabled={(spec.filters?.length ?? 0) >= 20} onClick={() => update({ filters: [...(spec.filters ?? []), { field: '', op: 'eq' }] })}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.builder.addFilter')}
          </Button>
        </fieldset>

        <div className="flex flex-wrap items-end gap-2">
          <Button type="submit" loading={busy}>
            <Eye aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.builder.preview')}
          </Button>
          <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="secondary">
                <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.saved.save')}
              </Button>
            </DialogTrigger>
            <DialogContent title={t('reports.saved.save')} description={t('reports.saved.saveBody')} closeLabel={t('common.close')}>
              <form onSubmit={save} className="flex flex-col gap-4">
                <Field id="save-name" label={t('reports.saved.name')}>
                  {(a) => <Input {...a} required maxLength={120} value={saveForm.name} onChange={(e) => setSaveForm({ ...saveForm, name: e.target.value })} />}
                </Field>
                <Field id="save-relative" label={t('reports.saved.relative')} hint={t('reports.saved.relativeHint')}>
                  {(a) => (
                    <select {...a} className={selectClass} value={saveForm.relative} onChange={(e) => setSaveForm({ ...saveForm, relative: e.target.value })}>
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
                  <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={saveForm.shared} onChange={(e) => setSaveForm({ ...saveForm, shared: e.target.checked })} />
                  {t('reports.saved.shareWithTeam')}
                </label>
                <Button type="submit">{t('common.save')}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </form>
      {result ? (
        <>
          <ExportBar source={{ kind: 'builder', spec: effective() }} />
          <ReportView result={result} />
        </>
      ) : null}
    </div>
  );
}
