'use client';
import * as React from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText, Info, Lock } from 'lucide-react';
import {
  BarList,
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { dateTimeFormat, formatMoney, numberFormat, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import {
  chartValue,
  displayCell,
  headerOf,
  NUMERIC,
  type Cell,
  type ReportColumn,
  type ReportResult,
} from '@/lib/report-format';
import { ModuleFrameContext } from '../shell';
import { PersonLink } from '@/components/person-link';

/** IANA zones the browser knows (for a time-zone picker's suggestions). */
export const zones = (): string[] =>
  (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
/** Weekday name for ISO weekday 1 (Monday) … 7 (Sunday); 2026-10-19 is a Monday. */
export const weekdayName = (locale: Locale, w: number) =>
  dateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`2026-10-${String(18 + w).padStart(2, '0')}T12:00:00Z`),
  );

export const selectClass =
  'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

/**
 * "No access" for a reports page: the page's only h1 when the reports module is not shown to the viewer,
 * a section under the module header otherwise.
 */
export function NoReportsAccess({ title }: { title?: string }) {
  const t = useT();
  const inModule = React.useContext(ModuleFrameContext);
  return (
    <EmptyState
      level={inModule ? 2 : 1}
      icon={<Lock aria-hidden />}
      title={title ?? t('reports.noAccess')}
      body={title ? undefined : t('reports.noAccessBody')}
    />
  );
}

export function problemText(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiProblem) return (err.body.detail as string | undefined) ?? err.title;
  return t('common.error');
}

/** Axis, legend and tooltip text for chart values in a column's unit (money stays in one currency). */
export function chartFormatter(
  t: (k: string, v?: Record<string, string | number>) => string,
  locale: Locale,
  c: ReportColumn,
  currency?: string,
): (n: number) => string {
  return (n: number) => {
    if (c.type === 'money')
      return currency ? formatMoney(money(Math.round(n), currency), locale) : numberFormat(locale).format(n);
    if (c.type === 'decimal' || c.type === 'percent')
      return displayCell(t, locale, c, String(Number(n.toFixed(c.scale ?? 2))));
    return displayCell(t, locale, c, n);
  };
}

/**
 * The chart of a ready-made report (the API's hint): bars with their values as text for categories, a
 * line on the first series token for a trend. One series and one axis; text uses text tokens; the
 * chart has a title and a text summary, and the table that follows has every value. Nothing animates.
 */
export function ReportChart({ result, maxBars = 30 }: { result: ReportResult; maxBars?: number }) {
  const t = useT();
  const locale = useLocale();
  const id = React.useId();
  const chart = result.chart;
  if (!chart || !result.rows.length) return null;
  const xCol = result.columns.find((c) => c.key === chart.x);
  const yCols = chart.y
    .map((k) => result.columns.find((c) => c.key === k))
    .filter((c): c is ReportColumn => !!c && NUMERIC.includes(c.type));
  if (!xCol || !yCols.length) return null;
  const rows = result.rows.slice(0, chart.type === 'line' ? 120 : maxBars);
  const y = yCols[0]!;
  const values = rows.map((r) => chartValue(r[y.key] ?? null));
  const max = Math.max(1, ...values);
  const label = (r: Record<string, Cell>) => displayCell(t, locale, xCol, r[xCol.key] ?? null);
  const top = rows.reduce((best, r, i) => (values[i]! > values[best]! ? i : best), 0);
  const summary = t('reports.chart.summary', {
    measure: headerOf(t, y),
    dimension: headerOf(t, xCol),
    count: rows.length,
    top: label(rows[top]!),
    value: displayCell(t, locale, y, rows[top]![y.key] ?? null),
  });
  if (chart.type === 'bar') {
    const title = t('reports.chart.barTitle', { measure: headerOf(t, y), dimension: headerOf(t, xCol) });
    const firstMoney = rows.map((r) => r[y.key]).find((v) => !!v && typeof v === 'object');
    const currency =
      firstMoney && typeof firstMoney === 'object' && 'currency' in firstMoney
        ? firstMoney.currency
        : undefined;
    return (
      <figure className="m-0 flex flex-col gap-3">
        <figcaption className="text-callout font-semibold">{title}</figcaption>
        <p className="sr-only">{summary}</p>
        <BarList
          items={rows.map((r, i) => ({ label: label(r), value: values[i]! }))}
          label={title}
          format={chartFormatter(t, locale, y, currency)}
        />
        <p className="text-footnote text-text-secondary">{t('reports.chart.tableBelow')}</p>
      </figure>
    );
  }
  const W = 640;
  const H = 220;
  const pad = { l: 48, r: 16, t: 12, b: 32 };
  const step = rows.length > 1 ? (W - pad.l - pad.r) / (rows.length - 1) : 0;
  const pt = (i: number, v: number) =>
    [pad.l + i * step, pad.t + (H - pad.t - pad.b) * (1 - v / max)] as const;
  const path = values.map((v, i) => pt(i, v).join(',')).join(' ');
  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="h-auto w-full">
        <title id={`${id}-t`}>
          {t('reports.chart.lineTitle', { measure: headerOf(t, y), dimension: headerOf(t, xCol) })}
        </title>
        <desc id={`${id}-d`}>{summary}</desc>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={pad.t + (H - pad.t - pad.b) * (1 - f)}
              y2={pad.t + (H - pad.t - pad.b) * (1 - f)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={pad.l - 6}
              y={pad.t + (H - pad.t - pad.b) * (1 - f) + 4}
              textAnchor="end"
              className="fill-text-secondary text-footnote tabular-nums"
            >
              {numberFormatShort(max * f, locale)}
            </text>
          </g>
        ))}
        <polyline
          points={path}
          fill="none"
          className="stroke-chart-1"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {values.map((v, i) => {
          const [cx, cy] = pt(i, v);
          return <circle key={i} cx={cx} cy={cy} r={3} className="fill-chart-1" />;
        })}
        {[0, rows.length - 1]
          .filter((i, k, a) => a.indexOf(i) === k)
          .map((i) => (
            <text
              key={i}
              x={pt(i, 0)[0]}
              y={H - 10}
              textAnchor={i === 0 ? 'start' : 'end'}
              className="fill-text-secondary text-footnote"
            >
              {label(rows[i]!)}
            </text>
          ))}
      </svg>
      <figcaption className="text-footnote text-text-secondary">{t('reports.chart.tableBelow')}</figcaption>
    </figure>
  );
}

const numberFormatShort = (v: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: 'compact' }).format(v);

/** Dense, readable result table (sticky header, tabular numbers, numeric columns right-aligned). */
export function ReportTable({ result, caption }: { result: ReportResult; caption: string }) {
  const t = useT();
  const locale = useLocale();
  if (!result.rows.length) return <p className="text-callout text-text-secondary">{t('reports.noRows')}</p>;
  const right = (c: ReportColumn) => (NUMERIC.includes(c.type) ? 'text-right' : '');
  return (
    <Table dense scrollLabel={caption}>
      <caption className="sr-only">{caption}</caption>
      <THead>
        <tr>
          {result.columns.map((c) => (
            <TH key={c.key} className={`${right(c)} whitespace-nowrap`}>
              {headerOf(t, c)}
              {c.sensitive ? (
                <Lock
                  aria-label={t('reports.sensitive')}
                  className="ml-1 inline h-3.5 w-3.5 stroke-[1.5] align-[-2px]"
                />
              ) : null}
            </TH>
          ))}
        </tr>
      </THead>
      <tbody>
        {result.rows.map((r, i) => (
          <TR key={i}>
            {result.columns.map((c) => (
              <TD key={c.key} className={`${right(c)} h-9`}>
                {/* a person's name opens their profile where the viewer may (ADR-0161) */}
                {c.key === 'displayName' && result.rowEmployeeIds?.[i] && typeof r[c.key] === 'string' ? (
                  <PersonLink id={result.rowEmployeeIds[i]} name={r[c.key] as string} plainClassName="" />
                ) : (
                  displayCell(t, locale, c, r[c.key] ?? null)
                )}
              </TD>
            ))}
          </TR>
        ))}
        {(result.totals ?? []).map((r, i) => (
          <TR key={`t${i}`} className="font-semibold">
            {result.columns.map((c) => (
              <TD key={c.key} className={`${right(c)} h-9`}>
                {r[c.key] === null || r[c.key] === undefined
                  ? ''
                  : displayCell(t, locale, c, r[c.key] ?? null)}
              </TD>
            ))}
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

/** A ready-made report's result: summary, facts and chart in one card, the table and notes in another. */
export function ReportView({ result }: { result: ReportResult }) {
  const t = useT();
  const locale = useLocale();
  return (
    <section aria-label={t('reports.result')} className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-title-3">{result.title}</h2>
          {result.sensitive ? <Badge tone="warning">{t('reports.sensitiveBadge')}</Badge> : null}
          {result.restricted ? (
            <Badge>{t('reports.restrictedCount', { count: result.restricted })}</Badge>
          ) : null}
        </div>
        {result.parameters.length ? (
          <p className="text-footnote text-text-secondary">{result.parameters.join(' · ')}</p>
        ) : null}
        {result.facts?.length ? (
          <dl className="grid gap-x-6 gap-y-2 rounded-lg bg-surface p-4 text-callout sm:grid-cols-2">
            {result.facts.map((f) => (
              <div key={f.key} className="flex justify-between gap-3">
                <dt className="text-text-secondary">{t(f.labelKey)}</dt>
                <dd className="text-right tabular-nums">
                  {displayCell(t, locale, { type: f.type, enumKey: f.enumKey }, f.value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <ReportChart result={result} />
      </Card>
      <Card className="flex flex-col gap-4">
        <ReportTable result={result} caption={result.title} />
        <ReportNotes notes={result.notes} />
      </Card>
    </section>
  );
}

// ---- background runs: export with progress, then a short-lived download --------------------------------
/** Badge tone of a run's status. */
export const runTone = {
  succeeded: 'success',
  failed: 'danger',
  expired: 'neutral',
  queued: 'neutral',
  running: 'accent',
} as const;

interface RunStatus {
  id: string;
  status: string;
  progressPercent: number;
  fileName: string | null;
  errorCode: string | null;
}

export function useBackgroundRun() {
  const [run, setRun] = React.useState<RunStatus | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const poll = React.useCallback(async (id: string, delay = 800): Promise<RunStatus> => {
    const r = await api<RunStatus>(`/v1/reports/runs/${id}`);
    setRun(r);
    if (r.status === 'queued' || r.status === 'running') {
      await new Promise((res) => (timer.current = setTimeout(res, delay)));
      return poll(id, Math.min(3000, delay * 1.5));
    }
    return r;
  }, []);
  const start = React.useCallback(
    async (source: unknown, format: 'csv' | 'xlsx' | 'pdf' | 'json') => {
      const r = await api<RunStatus>('/v1/reports/runs', { method: 'POST', json: { source, format } });
      setRun(r);
      return poll(r.id);
    },
    [poll],
  );
  return { run, start, poll, reset: () => setRun(null) };
}

export async function downloadRun(id: string) {
  const d = await api<{ url: string }>(`/v1/reports/runs/${id}/download`);
  window.location.assign(d.url);
}

export function RunProgress({ run }: { run: RunStatus | null }) {
  const t = useT();
  if (!run) return null;
  return (
    <div className="flex flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-footnote text-text-secondary">
        <span>{t(`reports.runStatus.${run.status}`)}</span>
        <span className="tabular-nums">{run.progressPercent}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-pill bg-surface"
        role="progressbar"
        aria-label={t('reports.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={run.progressPercent}
      >
        <div className="h-full rounded-pill bg-accent" style={{ width: `${run.progressPercent}%` }} />
      </div>
      {run.errorCode ? (
        <p className="text-footnote text-danger">
          {t(`reports.runError.${run.errorCode}`) === `reports.runError.${run.errorCode}`
            ? t('common.error')
            : t(`reports.runError.${run.errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}

type ExportFormat = 'csv' | 'xlsx' | 'pdf';
const FORMATS: Array<{ format: ExportFormat; icon: React.ReactNode }> = [
  { format: 'csv', icon: <Download aria-hidden className="h-4 w-4 stroke-[1.5]" /> },
  { format: 'xlsx', icon: <FileSpreadsheet aria-hidden className="h-4 w-4 stroke-[1.5]" /> },
  { format: 'pdf', icon: <FileText aria-hidden className="h-4 w-4 stroke-[1.5]" /> },
];

/** Runs an export of a report source in the background (POST /v1/reports/runs), then downloads it. */
export function useExport(source: unknown) {
  const t = useT();
  const toast = useToast();
  const { run, start } = useBackgroundRun();
  const [busy, setBusy] = React.useState<ExportFormat | null>(null);
  async function go(format: ExportFormat) {
    setBusy(format);
    try {
      const r = await start(source, format);
      if (r.status === 'succeeded') {
        toast({ title: t('reports.exportReady'), tone: 'success' });
        await downloadRun(r.id);
      } else toast({ title: t('reports.exportFailed'), tone: 'danger' });
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }
  return { run, busy, go };
}

/** The same export as a header action: one "Download" button that opens a menu of formats. */
export function DownloadMenu({ source, disabled }: { source: unknown; disabled?: boolean }) {
  const t = useT();
  const { run, busy, go } = useExport(source);
  return (
    <>
      {/* not modal: the rest of the page is not hidden from assistive technology while the menu is open */}
      <Menu modal={false}>
        <MenuTrigger asChild disabled={disabled || !!busy}>
          <Button size="sm" variant="secondary" loading={!!busy}>
            <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('reports.ui.download')}
            <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
          </Button>
        </MenuTrigger>
        <MenuContent aria-label={t('reports.export')}>
          {FORMATS.map(({ format, icon }) => (
            <MenuItem key={format} onSelect={() => void go(format)}>
              {icon}
              {t(`reports.format.${format}`)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {busy ? (
        <div className="basis-full">
          <RunProgress run={run} />
        </div>
      ) : null}
    </>
  );
}

/** Rolling date ranges a saved report can use when it runs later (the API resolves them). */
export const RELATIVE = [
  'today',
  'yesterday',
  'previousWeek',
  'previousMonth',
  'monthToDate',
  'yearToDate',
  'previousYear',
] as const;

export interface SaveForm {
  name: string;
  relative: string;
  shared: boolean;
}

/** Name, rolling dates and sharing for a saved report (ready-made or built). */
export function SaveReportDialog({
  open,
  onOpenChange,
  form,
  onChange,
  onSubmit,
  note,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: SaveForm;
  onChange: (form: SaveForm) => void;
  onSubmit: (e: React.FormEvent) => void;
  /** Extra line under the description (e.g. why saving comes before scheduling). */
  note?: string;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('reports.saved.save')}
        description={t('reports.saved.saveBody')}
        closeLabel={t('common.close')}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {note ? <p className="text-callout text-text-secondary">{note}</p> : null}
          <Field id="save-name" label={t('reports.saved.name')}>
            {(a) => (
              <Input
                {...a}
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
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
                value={form.relative}
                onChange={(e) => onChange({ ...form, relative: e.target.value })}
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
              checked={form.shared}
              onChange={(e) => onChange({ ...form, shared: e.target.checked })}
            />
            {t('reports.saved.shareWithTeam')}
          </label>
          <Button type="submit">{t('common.save')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Report notes (method and source explanations) under a result. */
export function ReportNotes({ notes }: { notes: string[] }) {
  const t = useT();
  if (!notes.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-footnote text-text-secondary">
      {notes.map((n) => (
        <li key={n} className="flex gap-2">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
          <span>{t(n)}</span>
        </li>
      ))}
    </ul>
  );
}
