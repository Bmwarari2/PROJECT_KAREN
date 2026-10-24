'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { BarChart3, CalendarClock, Eye, Lock, Plus, Save, Table2, Trash2, X } from 'lucide-react';
import {
  Badge,
  BarList,
  Button,
  buttonVariants,
  Card,
  cn,
  ColumnChart,
  DonutChart,
  EmptyState,
  Field,
  Input,
  Skeleton,
  useToast,
} from '@thapsus/ui';
import { dateTimeFormat, type Locale } from '@thapsus/core/i18n';
import { today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { displayCell, headerOf, type Cell, type ReportColumn, type ReportResult } from '@/lib/report-format';
import { PageTitle, useSession } from '../../shell';
import { chartModel } from '../chart-model';
import type { Catalogue } from '../page';
import {
  chartFormatter,
  DownloadMenu,
  NoReportsAccess,
  problemText,
  ReportNotes,
  ReportTable,
  SaveReportDialog,
  selectClass,
  type SaveForm,
} from '../ui';

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
  /** `none` keeps a report on the table view; otherwise the chart is chosen from the result. */
  chart?: 'bar' | 'line' | 'none';
}
type Mode = 'list' | 'summary';
type View = 'chart' | 'table';
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
// the API's limits (POST /v1/reports/builder/preview)
const MAX_FILTERS = 20;
const MAX_MEASURES = 6;
const MAX_COLUMNS = 40;

function initialSpec(d: DatasetDef, zone: string): Spec {
  const now = today(zone);
  const defaults = d.fields
    .filter((f) => !f.vault && f.sensitivity !== 'special')
    .slice(0, 6)
    .map((f) => f.key);
  return d.time === 'asOf'
    ? { dataset: d.key, columns: defaults, asOf: now, population: 'employed' }
    : { dataset: d.key, columns: defaults, from: `${now.slice(0, 7)}-01`, to: now };
}

/** The spec actually sent: a list drops grouping and measures; a summary drops the column list. */
function effectiveSpec(spec: Spec, mode: Mode): Spec {
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
}

/** Sensitivity of a field, shown wherever a chosen field is listed. */
function FieldBadge({ f }: { f: FieldDef }) {
  const t = useT();
  if (f.vault || f.sensitivity === 'special')
    return (
      <Badge tone="warning">
        <Lock aria-hidden className="h-3 w-3 stroke-[1.5]" />
        {t(f.vault ? 'reports.builder.vaultField' : 'reports.sensitiveBadge')}
      </Badge>
    );
  return f.sensitivity === 'personal' ? <Badge>{t('reports.builder.personal')}</Badge> : null;
}

/** One block of the configuration panel. */
function PanelSection({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // the floated legend sits inside the box, not in the top border
    <fieldset className="min-w-0 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <legend className="float-left mb-3 w-full text-callout font-semibold">{legend}</legend>
      {hint ? <p className="clear-left mb-3 text-footnote text-text-secondary">{hint}</p> : null}
      <div className="clear-left flex flex-col gap-3">{children}</div>
    </fieldset>
  );
}

/**
 * Report builder (ADR-0154): the configuration panel on the left (data source, columns or grouping
 * and values, filters), the chart and the result table on the right, and Save, Download and Schedule
 * in the header. Previews run on the reporting reader; downloads use background runs.
 */
export default function BuilderPage() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const savedId = useSearchParams().get('saved');
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const saved = useApi<{
    id: string;
    name: string;
    mine: boolean;
    shared: boolean;
    spec: Spec & { relative?: string };
  }>(savedId ? `/v1/reports/saved/${savedId}` : null);
  const [spec, setSpec] = React.useState<Spec | null>(null);
  const [mode, setMode] = React.useState<Mode>('list');
  const [result, setResult] = React.useState<{ data: ReportResult; groups: number } | null>(null);
  const [stale, setStale] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [scheduleNext, setScheduleNext] = React.useState(false);
  const [saveForm, setSaveForm] = React.useState<SaveForm>({ name: '', relative: '', shared: false });

  const runPreview = React.useCallback(
    async (s: Spec) => {
      setBusy(true);
      try {
        const data = await api<ReportResult>('/v1/reports/builder/preview', {
          method: 'POST',
          json: s,
          capability: 'reports.build',
        });
        setResult({ data, groups: s.groupBy?.length ?? 0 });
        setStale(false);
      } catch (err) {
        toast({ title: problemText(t, err), tone: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [t, toast],
  );

  React.useEffect(() => {
    if (spec || !catalogue.data?.datasets.length) return;
    if (savedId && !saved.data && !saved.error) return;
    let first: Spec;
    let firstMode: Mode = 'list';
    if (saved.data) {
      const { relative, ...s } = saved.data.spec;
      first = s;
      firstMode = s.groupBy?.length ? 'summary' : 'list';
      setSaveForm({ name: saved.data.name, relative: relative ?? '', shared: saved.data.shared });
    } else first = initialSpec(catalogue.data.datasets[0]!, zone);
    setSpec(first);
    setMode(firstMode);
    // the first preview runs straight away, so the builder opens with data
    void runPreview(effectiveSpec(first, firstMode));
  }, [catalogue.data, saved.data, saved.error, savedId, spec, zone, runPreview]);

  if (catalogue.error) return <NoReportsAccess />;
  // Same heading as the loaded page, so React keeps these nodes when the form arrives
  // (they are the largest paint on a phone and must not be re-created later).
  if (!catalogue.data || !spec)
    return (
      <div className="flex flex-col gap-6">
        <div>
          <PageTitle>{t('reports.builder.title')}</PageTitle>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
            {t('reports.builder.intro')}
          </p>
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (!catalogue.data.datasets.length) return <NoReportsAccess title={t('reports.builder.noDatasets')} />;
  const datasets = catalogue.data.datasets;
  const ds = datasets.find((d) => d.key === spec.dataset) ?? datasets[0]!;
  const fieldOf = (k: string) => ds.fields.find((f) => f.key === k);
  const groupable = ds.fields.filter((f) => f.groupable);
  const aggregatable = ds.fields.filter((f) => f.aggregatable);
  const filterable = ds.fields.filter((f) => !f.vault);
  const effective = () => effectiveSpec(spec, mode);
  const savedReport = saved.data;

  /** A change to the options: the result on screen stays until the next preview, marked out of date. */
  const update = (patch: Partial<Spec>) => {
    setSpec((s) => ({ ...s!, ...patch }));
    if (result) setStale(true);
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    if (result) setStale(true);
  };
  const view: View = spec.chart === 'none' ? 'table' : 'chart';
  // the view is remembered with a saved report but does not change the data
  const setView = (v: View) =>
    setSpec((s) => {
      const next = { ...s! };
      if (v === 'table') next.chart = 'none';
      else delete next.chart;
      return next;
    });

  async function preview(e?: React.FormEvent) {
    e?.preventDefault();
    await runPreview(effective());
  }

  function openSave(thenSchedule: boolean) {
    setScheduleNext(thenSchedule);
    setSaveOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      name: saveForm.name,
      kind: 'builder',
      spec: effective(),
      shared: saveForm.shared,
      ...(saveForm.relative ? { relative: saveForm.relative } : {}),
    };
    try {
      let id: string;
      if (savedReport?.mine) {
        await api(`/v1/reports/saved/${savedReport.id}`, {
          method: 'PUT',
          json: body,
          capability: 'reports.build',
        });
        id = savedReport.id;
        saved.reload();
      } else
        id = (
          await api<{ id: string }>('/v1/reports/saved', {
            method: 'POST',
            json: body,
            capability: 'reports.build',
          })
        ).id;
      toast({ title: t('reports.saved.done'), tone: 'success' });
      setSaveOpen(false);
      if (scheduleNext) router.push(`/app/reports/schedules?report=${id}`);
      // from now on the builder edits the saved report, so saving again updates it
      else if (id !== savedId) router.replace(`/app/reports/builder?saved=${id}`);
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }

  const fieldLabel = (f: FieldDef) => t(f.labelKey);
  const setFilter = (i: number, patch: Partial<Filter>) =>
    update({ filters: (spec.filters ?? []).map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const filterValue = (flt: Filter, i: number) => {
    const f = fieldOf(flt.field);
    if (!f || flt.op === 'isEmpty' || flt.op === 'isNotEmpty') return null;
    const id = `flt-v-${i}`;
    const label = t('reports.builder.value');
    if (f.type === 'boolean')
      return (
        <select
          id={id}
          aria-label={label}
          className={selectClass}
          value={String(flt.value ?? 'true')}
          onChange={(e) => setFilter(i, { value: e.target.value === 'true' })}
        >
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      );
    if (f.type === 'enum' && f.enumValues) {
      if (flt.op === 'in')
        return (
          <select
            id={id}
            aria-label={label}
            multiple
            className={`${selectClass} h-24`}
            value={Array.isArray(flt.value) ? flt.value : []}
            onChange={(e) =>
              setFilter(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })
            }
          >
            {f.enumValues.map((v) => (
              <option key={v} value={v}>
                {t(`reports.enum.${f.key}.${v}`)}
              </option>
            ))}
          </select>
        );
      return (
        <select
          id={id}
          aria-label={label}
          className={selectClass}
          value={String(flt.value ?? '')}
          onChange={(e) => setFilter(i, { value: e.target.value })}
        >
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
        onChange={(e) =>
          setFilter(i, { value: numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value })
        }
        aria-describedby={f.type === 'money' ? `${id}-hint` : undefined}
      />
    );
  };

  const measures = spec.measures?.length ? spec.measures : [{ fn: 'count' as Fn }];
  const columns = spec.columns ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="mr-auto min-w-0">
          <PageTitle>{savedReport?.name ?? t('reports.builder.title')}</PageTitle>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
            {t('reports.builder.intro')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('reports.ui.actions')}>
          <Button type="button" size="sm" variant="secondary" onClick={() => openSave(false)}>
            <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.saved.save')}
          </Button>
          <DownloadMenu source={{ kind: 'builder', spec: effective() }} />
          {catalogue.data.canSchedule ? (
            savedReport ? (
              <Link
                href={`/app/reports/schedules?report=${savedReport.id}`}
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

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:items-start">
        {/* On large screens the panel is sticky and scrolls on its own, so every option stays reachable. */}
        <form
          onSubmit={preview}
          aria-label={t('reports.parameters')}
          className="lg:sticky lg:top-[calc(var(--topbar-height)_+_var(--space-6))] lg:max-h-[calc(100dvh_-_var(--topbar-height)_-_2_*_var(--space-6))] lg:overflow-y-auto lg:overscroll-contain lg:rounded-lg"
        >
          <Card className="flex flex-col gap-4">
            <PanelSection legend={t('reports.ui.dataSource')}>
              <Field id="b-dataset" label={t('reports.param.dataset')}>
                {(a) => (
                  <select
                    {...a}
                    className={selectClass}
                    value={ds.key}
                    onChange={(e) =>
                      update(
                        initialSpec(
                          datasets.find((d) => d.key === e.target.value)!,
                          zone,
                        ),
                      )
                    }
                  >
                    {datasets.map((d) => (
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
                    {(a) => (
                      <Input
                        {...a}
                        type="date"
                        required
                        value={spec.asOf ?? ''}
                        onChange={(e) => update({ asOf: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field id="b-population" label={t('reports.builder.population')}>
                    {(a) => (
                      <select
                        {...a}
                        className={selectClass}
                        value={spec.population ?? 'employed'}
                        onChange={(e) => update({ population: e.target.value as 'employed' | 'all' })}
                      >
                        <option value="employed">{t('reports.builder.populationEmployed')}</option>
                        <option value="all">{t('reports.builder.populationAll')}</option>
                      </select>
                    )}
                  </Field>
                </>
              ) : (
                <>
                  <Field id="b-from" label={t('reports.param.from')}>
                    {(a) => (
                      <Input
                        {...a}
                        type="date"
                        required
                        value={spec.from ?? ''}
                        onChange={(e) => update({ from: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field id="b-to" label={t('reports.param.to')}>
                    {(a) => (
                      <Input
                        {...a}
                        type="date"
                        required
                        value={spec.to ?? ''}
                        onChange={(e) => update({ to: e.target.value })}
                      />
                    )}
                  </Field>
                </>
              )}
            </PanelSection>

            <PanelSection legend={t('reports.builder.mode')}>
              <div className="flex flex-wrap gap-x-4">
                {(['list', 'summary'] as const).map((m) => (
                  <label key={m} className="flex min-h-11 items-center gap-2 text-callout">
                    <input
                      type="radio"
                      name="mode"
                      className="h-5 w-5 accent-[var(--color-accent)]"
                      checked={mode === m}
                      onChange={() => switchMode(m)}
                    />
                    {t(`reports.builder.mode${m === 'list' ? 'List' : 'Summary'}`)}
                  </label>
                ))}
              </div>
            </PanelSection>

            {mode === 'list' ? (
              <PanelSection legend={t('reports.builder.columns')} hint={t('reports.ui.columnsHint')}>
                {columns.length ? (
                  <ul className="flex flex-col gap-1" aria-label={t('reports.ui.chosenColumns')}>
                    {columns.map((k) => {
                      const f = fieldOf(k);
                      if (!f) return null;
                      return (
                        <li
                          key={k}
                          className="flex min-h-10 items-center gap-2 rounded-sm bg-surface py-1 pl-3 pr-1 text-callout"
                        >
                          <span className="min-w-0 flex-1 break-words">{fieldLabel(f)}</span>
                          <FieldBadge f={f} />
                          <button
                            type="button"
                            onClick={() => update({ columns: columns.filter((c) => c !== k) })}
                            aria-label={t('reports.ui.removeColumn', { field: fieldLabel(f) })}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-footnote text-text-secondary">{t('reports.ui.noColumns')}</p>
                )}
                <AddColumn
                  fields={ds.fields.filter((f) => !columns.includes(f.key))}
                  disabled={columns.length >= MAX_COLUMNS}
                  onAdd={(k) => update({ columns: [...columns, k] })}
                />
              </PanelSection>
            ) : (
              <>
                <PanelSection legend={t('reports.ui.groupRows')} hint={t('reports.ui.groupRowsHint')}>
                  {[0, 1].map((i) => {
                    const g = spec.groupBy?.[i];
                    const gf = g ? fieldOf(g.field) : undefined;
                    // a second level needs a first
                    if (i === 1 && !spec.groupBy?.[0]) return null;
                    return (
                      <div key={i} className="flex flex-col gap-2">
                        <select
                          aria-label={t('reports.builder.groupLevel', { level: i + 1 })}
                          className={selectClass}
                          value={g?.field ?? ''}
                          onChange={(e) => {
                            const next = [...(spec.groupBy ?? [])];
                            // dates group by month unless the year is chosen
                            if (e.target.value)
                              next[i] =
                                fieldOf(e.target.value)?.type === 'date'
                                  ? { field: e.target.value, granularity: 'month' }
                                  : { field: e.target.value };
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
                            onChange={(e) =>
                              update({
                                groupBy: (spec.groupBy ?? []).map((x, j) =>
                                  j === i ? { ...x, granularity: e.target.value as 'month' | 'year' } : x,
                                ),
                              })
                            }
                          >
                            <option value="month">{t('reports.builder.byMonth')}</option>
                            <option value="year">{t('reports.builder.byYear')}</option>
                          </select>
                        ) : null}
                      </div>
                    );
                  })}
                </PanelSection>
                <PanelSection legend={t('reports.builder.measures')}>
                  {measures.map((m, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                      <div className="flex min-w-0 flex-col gap-2">
                        <select
                          aria-label={t('reports.builder.measureFn', { n: i + 1 })}
                          className={selectClass}
                          value={m.fn}
                          onChange={(e) => {
                            const next = [...measures];
                            next[i] = {
                              fn: e.target.value as Fn,
                              ...(e.target.value === 'count' ? {} : { field: m.field }),
                            };
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
                          <span className="text-footnote text-text-secondary">
                            {t('reports.ui.countsRows')}
                          </span>
                        ) : (
                          <select
                            aria-label={t('reports.builder.measureField', { n: i + 1 })}
                            className={selectClass}
                            value={m.field ?? ''}
                            onChange={(e) =>
                              update({
                                measures: measures.map((x, j) =>
                                  j === i ? { ...x, field: e.target.value } : x,
                                ),
                              })
                            }
                          >
                            <option value="" />
                            {(m.fn === 'countDistinct' ? filterable : aggregatable).map((f) => (
                              <option key={f.key} value={f.key}>
                                {fieldLabel(f)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={t('reports.builder.removeMeasure', { n: i + 1 })}
                        disabled={measures.length <= 1}
                        onClick={() => update({ measures: measures.filter((_, j) => j !== i) })}
                      >
                        <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="w-fit"
                    disabled={measures.length >= MAX_MEASURES}
                    onClick={() => update({ measures: [...measures, { fn: 'sum' }] })}
                  >
                    <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('reports.builder.addMeasure')}
                  </Button>
                </PanelSection>
              </>
            )}

            <PanelSection legend={t('reports.param.filters')}>
              {(spec.filters ?? []).map((flt, i) => {
                const f = fieldOf(flt.field);
                const ops = f ? (OPS_FOR[f.type] ?? ['eq']) : ['eq'];
                return (
                  <div
                    key={i}
                    className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <select
                        aria-label={t('reports.builder.filterField', { n: i + 1 })}
                        className={selectClass}
                        value={flt.field}
                        onChange={(e) =>
                          setFilter(i, {
                            field: e.target.value,
                            op: (OPS_FOR[fieldOf(e.target.value)?.type ?? 'text'] ?? ['eq'])[0] as Op,
                            value: undefined,
                          })
                        }
                      >
                        <option value="" />
                        {filterable.map((x) => (
                          <option key={x.key} value={x.key}>
                            {fieldLabel(x)}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={t('reports.builder.removeFilter', { n: i + 1 })}
                        onClick={() => update({ filters: (spec.filters ?? []).filter((_, j) => j !== i) })}
                      >
                        <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      </Button>
                    </div>
                    <select
                      aria-label={t('reports.builder.filterOp', { n: i + 1 })}
                      className={selectClass}
                      value={flt.op}
                      onChange={(e) =>
                        setFilter(i, {
                          op: e.target.value as Op,
                          value: e.target.value === 'in' ? [] : undefined,
                        })
                      }
                    >
                      {ops.map((o) => (
                        <option key={o} value={o}>
                          {t(`reports.op.${o}`)}
                        </option>
                      ))}
                    </select>
                    {filterValue(flt, i)}
                    {f?.type === 'money' ? (
                      <p id={`flt-v-${i}-hint`} className="text-footnote text-text-secondary">
                        {t('reports.builder.minorUnits')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-fit"
                disabled={(spec.filters?.length ?? 0) >= MAX_FILTERS}
                onClick={() => update({ filters: [...(spec.filters ?? []), { field: '', op: 'eq' }] })}
              >
                <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.builder.addFilter')}
              </Button>
            </PanelSection>

            <div className="border-t border-border pt-4">
              <Button type="submit" loading={busy} className="w-full">
                <Eye aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('reports.builder.preview')}
              </Button>
            </div>
          </Card>
        </form>

        <section aria-label={t('reports.result')} aria-busy={busy} className="flex min-w-0 flex-col gap-4">
          {stale ? (
            <p role="status" className="rounded-md bg-accent-subtle px-4 py-2 text-callout text-text">
              {t('reports.ui.stale')}
            </p>
          ) : null}
          {result ? (
            <ResultView result={result.data} groups={result.groups} view={view} onView={setView} />
          ) : busy ? (
            <Skeleton className="h-96 w-full" />
          ) : (
            <EmptyState
              icon={<BarChart3 aria-hidden />}
              title={t('reports.ui.noPreview')}
              body={t('reports.ui.noPreviewBody')}
            />
          )}
        </section>
      </div>

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

/** A field picker with an Add button (a select alone would add a field on every arrow key press). */
function AddColumn({
  fields,
  disabled,
  onAdd,
}: {
  fields: FieldDef[];
  disabled: boolean;
  onAdd: (key: string) => void;
}) {
  const t = useT();
  const [choice, setChoice] = React.useState('');
  const sensitivity = (f: FieldDef) =>
    f.vault
      ? ` · ${t('reports.builder.vaultField')}`
      : f.sensitivity === 'special'
        ? ` · ${t('reports.sensitiveBadge')}`
        : '';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
      <select
        aria-label={t('reports.ui.columnToAdd')}
        className={selectClass}
        value={choice}
        disabled={disabled || !fields.length}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">{t('reports.ui.chooseColumn')}</option>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {`${t(f.labelKey)}${sensitivity(f)}`}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-10"
        disabled={!choice}
        onClick={() => {
          onAdd(choice);
          setChoice('');
        }}
      >
        <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('reports.ui.addColumn')}
      </Button>
    </div>
  );
}

/** The result: heading and badges, the Chart/Table switch, the chart (for summaries) and the table. */
function ResultView({
  result,
  groups,
  view,
  onView,
}: {
  result: ReportResult;
  groups: number;
  view: View;
  onView: (v: View) => void;
}) {
  const t = useT();
  return (
    <>
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-title-3">{result.title}</h2>
          {result.sensitive ? <Badge tone="warning">{t('reports.sensitiveBadge')}</Badge> : null}
          {result.restricted ? (
            <Badge>{t('reports.restrictedCount', { count: result.restricted })}</Badge>
          ) : null}
          <span className="text-footnote text-text-secondary">
            {t('reports.ui.rowCount', { count: result.rows.length })}
          </span>
        </div>
        {result.parameters.length ? (
          <p className="text-footnote text-text-secondary">{result.parameters.join(' · ')}</p>
        ) : null}
        {result.truncated ? (
          <p className="text-footnote text-text-secondary">{t('reports.ui.truncated')}</p>
        ) : null}
        <div
          role="group"
          aria-label={t('reports.ui.showAs')}
          className="inline-flex w-fit rounded-pill border border-border bg-surface p-0.5"
        >
          {(['chart', 'table'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onView(v)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-pill px-3 text-callout focus-visible:outline-2 focus-visible:outline-accent',
                view === v
                  ? 'bg-surface-raised font-semibold text-text shadow-sm'
                  : 'text-text-secondary hover:text-text',
              )}
            >
              {v === 'chart' ? (
                <BarChart3 aria-hidden className="h-4 w-4 stroke-[1.5]" />
              ) : (
                <Table2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
              )}
              {t(`reports.ui.view.${v}`)}
            </button>
          ))}
        </div>
        {view === 'chart' ? <BuilderChart result={result} groups={groups} /> : null}
      </Card>
      <Card className="flex flex-col gap-4">
        <ReportTable result={result} caption={result.title} />
        <ReportNotes notes={result.notes} />
      </Card>
    </>
  );
}

/** Month or year of a grouped date ("Mar 2026", "2026"), or null for other dates. */
function periodLabel(locale: Locale, value: string, sub?: string): string | null {
  if (sub === 'reports.granularity.year') return value.slice(0, 4);
  if (sub === 'reports.granularity.month' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return dateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${value}T00:00:00Z`),
    );
  return null;
}

/** The chart for a summary (chart-model.ts decides which), with its title and a note on the table. */
function BuilderChart({ result, groups }: { result: ReportResult; groups: number }) {
  const t = useT();
  const locale = useLocale();
  const label = (c: ReportColumn, v: Cell) => {
    if (v === null || v === '') return t('reports.group.unassigned');
    if (c.type === 'date' && typeof v === 'string')
      return periodLabel(locale, v, c.subLabelKey) ?? displayCell(t, locale, c, v);
    return displayCell(t, locale, c, v);
  };
  const model = chartModel({
    result,
    groups,
    label,
    header: (c) => headerOf(t, c),
    otherLabel: t('reports.ui.other'),
  });
  if (model.kind === 'none')
    return model.reason === 'empty' ? null : (
      <p className="text-callout text-text-secondary">{t(`reports.ui.noChart.${model.reason}`)}</p>
    );
  const m = model.measure;
  const format = chartFormatter(t, locale, m, model.currency);
  const title = t(model.dimension.type === 'date' ? 'reports.chart.lineTitle' : 'reports.chart.barTitle', {
    measure: headerOf(t, m),
    dimension: headerOf(t, model.dimension),
  });
  return (
    <figure className="m-0 flex flex-col gap-3">
      <figcaption className="text-callout font-semibold">{title}</figcaption>
      {model.kind === 'column' ? (
        <ColumnChart
          categories={model.categories}
          series={model.series}
          stacked={model.stacked}
          format={format}
          label={title}
          height={220}
        />
      ) : model.kind === 'donut' ? (
        <DonutChart
          items={model.items}
          label={title}
          format={format}
          centerValue={format(model.total)}
          centerLabel={t('reports.total')}
        />
      ) : (
        <BarList items={model.items} label={title} format={format} />
      )}
      <p className="text-footnote text-text-secondary">
        {model.kind === 'bar' && model.clipped
          ? t('reports.ui.chartTop', { count: model.items.length })
          : model.kind === 'column' && model.clipped
            ? t('reports.ui.chartFirst', { count: model.categories.length })
            : t('reports.chart.tableBelow')}
      </p>
    </figure>
  );
}
