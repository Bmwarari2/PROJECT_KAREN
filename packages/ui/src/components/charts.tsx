import * as React from 'react';
import { cn } from './primitives';

/**
 * Small dashboard charts (DESIGN.md §6, ADR-0154). Series take the categorical tokens in a fixed order
 * (`--color-chart-1` … `-6`), never cycled: a seventh category folds into "Other". Marks are thin with
 * 4px rounded data ends and 2px gaps; text uses text tokens, never the series colour, and is real HTML so
 * it keeps its type size at every width. Every chart has an accessible summary and shows its values as
 * text (legend values, bar labels or a table), because three light-mode series colours sit below 3:1.
 */
export const SERIES_COUNT = 6;
export const seriesColor = (i: number) => `var(--color-chart-${Math.min(i, SERIES_COUNT - 1) + 1})`;

export interface ChartDatum {
  label: string;
  value: number;
}

/** Folds categories past the palette into one "Other" entry (largest first). */
export function foldOther(items: ChartDatum[], otherLabel: string, max = SERIES_COUNT): ChartDatum[] {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const kept = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((n, d) => n + d.value, 0);
  return [...kept, { label: otherLabel, value: rest }];
}

/**
 * Round axis values from 0 to at least `max`, in about `count` steps. With `integer` (counts of
 * people, requests) every tick is a whole number.
 */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 2.5, 5, 10]
    .map((m) => m * mag)
    .filter((s) => !integer || (s >= 1 && Number.isInteger(s)));
  const step = steps.find((s) => s >= raw) ?? (integer ? Math.max(1, Math.ceil(raw)) : raw);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6));
}

export interface LegendItem {
  label: string;
  /** Position in the series order (decides the colour). */
  index: number;
  value?: string;
}

export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-footnote text-text-secondary', className)}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: seriesColor(it.index) }}
          />
          <span className="text-text">{it.label}</span>
          {it.value !== undefined ? <span className="tabular-nums">{it.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export interface BarSeries {
  key: string;
  label: string;
  values: number[];
}

/**
 * Vertical columns over categories (months, weeks): one or several series, side by side or stacked,
 * on one y-axis. `format` renders axis values, tooltips and the accessible summary.
 */
export function ColumnChart({
  categories,
  series,
  stacked = false,
  height = 200,
  format = (n: number) => String(n),
  label,
  integer = false,
}: {
  categories: string[];
  series: BarSeries[];
  stacked?: boolean;
  height?: number;
  format?: (n: number) => string;
  /** Accessible name of the chart. */
  label: string;
  /** Whole-number data (counts): the axis shows whole numbers only. */
  integer?: boolean;
}) {
  const [hover, setHover] = React.useState<{ c: number; s: number } | null>(null);
  const totals = categories.map((_, c) =>
    stacked
      ? series.reduce((n, s) => n + (s.values[c] ?? 0), 0)
      : Math.max(0, ...series.map((s) => s.values[c] ?? 0)),
  );
  const ticks = niceTicks(Math.max(0, ...totals), 4, integer);
  const top = ticks[ticks.length - 1] || 1;
  const pct = (v: number) => `${(v / top) * 100}%`;
  const summary = `${label}: ${categories
    .map(
      (c, i) =>
        `${c} ${series.map((s) => `${series.length > 1 ? `${s.label} ` : ''}${format(s.values[i] ?? 0)}`).join(', ')}`,
    )
    .join('; ')}`;
  const width = `${100 / Math.max(1, categories.length)}%`;
  return (
    <figure className="m-0" onMouseLeave={() => setHover(null)}>
      <div role="img" aria-label={summary} className="flex gap-2">
        <div aria-hidden className="relative w-10 shrink-0" style={{ height }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 translate-y-1/2 text-footnote tabular-nums text-text-secondary"
              style={{ bottom: pct(t) }}
            >
              {format(t)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div aria-hidden className="relative" style={{ height }}>
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute inset-x-0 border-t border-border"
                style={{ bottom: pct(t) }}
              />
            ))}
            <div className="absolute inset-0 flex items-end">
              {categories.map((cat, c) => (
                <div
                  key={cat}
                  className="relative flex h-full items-end justify-center gap-0.5"
                  style={{ width }}
                >
                  {stacked ? (
                    <div className="flex h-full w-[min(28px,70%)] flex-col-reverse gap-0.5">
                      {series.map((s, si) => {
                        const v = s.values[c] ?? 0;
                        const isTop = series.slice(si + 1).every((n) => !(n.values[c] ?? 0));
                        return v > 0 ? (
                          <span
                            key={s.key}
                            onMouseEnter={() => setHover({ c, s: si })}
                            className={cn('block w-full shrink-0', isTop && 'rounded-t-[4px]')}
                            style={{ height: pct(v), background: seriesColor(si) }}
                          />
                        ) : null;
                      })}
                    </div>
                  ) : (
                    series.map((s, si) => {
                      const v = s.values[c] ?? 0;
                      return (
                        <span
                          key={s.key}
                          onMouseEnter={() => setHover({ c, s: si })}
                          className="block w-[min(14px,30%)] rounded-t-[4px]"
                          style={{ height: v > 0 ? pct(v) : 0, background: seriesColor(si) }}
                        />
                      );
                    })
                  )}
                  {hover?.c === c ? (
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-raised px-2 py-1 text-footnote tabular-nums text-text shadow-md">
                      <span className="font-semibold">{cat}</span>{' '}
                      {series.length > 1 ? `${series[hover.s]!.label} ` : ''}
                      {format(series[hover.s]!.values[c] ?? 0)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden className="mt-1 flex">
            {categories.map((cat) => (
              <span
                key={cat}
                className="truncate text-center text-footnote text-text-secondary"
                style={{ width }}
              >
                {cat}
              </span>
            ))}
          </div>
        </div>
      </div>
      {series.length > 1 ? (
        <Legend className="mt-3" items={series.map((s, i) => ({ label: s.label, index: i }))} />
      ) : null}
    </figure>
  );
}

/** Horizontal bars for categories with long names (departments, locations): one series, values shown. */
export function BarList({
  items,
  format = (n: number) => String(n),
  label,
  colorIndex = 0,
}: {
  items: ChartDatum[];
  format?: (n: number) => string;
  label: string;
  colorIndex?: number;
}) {
  const max = Math.max(1, ...items.map((d) => d.value));
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {items.map((d) => (
        <li key={d.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-callout text-text" title={d.label}>
            {d.label}
          </span>
          <span className="text-callout tabular-nums text-text-secondary">{format(d.value)}</span>
          <span aria-hidden className="col-span-2 block h-2 w-full overflow-hidden rounded-full bg-surface">
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: seriesColor(colorIndex) }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Share of a whole (statuses, types). Up to six slices; the legend carries every value as text. */
export function DonutChart({
  items,
  label,
  centerValue,
  centerLabel,
  format = (n: number) => String(n),
}: {
  items: ChartDatum[];
  label: string;
  centerValue?: string;
  centerLabel?: string;
  format?: (n: number) => string;
}) {
  const total = items.reduce((n, d) => n + d.value, 0);
  const size = 160;
  const r = 64;
  const c = 2 * Math.PI * r;
  // a 2px surface gap between slices when there is more than one
  const gap = items.filter((d) => d.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  const summary = `${label}: ${items.map((d) => `${d.label} ${format(d.value)}`).join(', ')}`;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-36 w-36 shrink-0">
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full" role="img" aria-label={summary}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--color-surface)"
            strokeWidth={14}
          />
          {total > 0
            ? items.map((d, i) => {
                const len = (d.value / total) * c;
                const dash = Math.max(0, len - gap);
                const el = (
                  <circle
                    key={d.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={seriesColor(i)}
                    strokeWidth={14}
                    strokeDasharray={`${dash} ${c - dash}`}
                    strokeDashoffset={-offset}
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                  >
                    <title>{`${d.label}: ${format(d.value)}`}</title>
                  </circle>
                );
                offset += len;
                return el;
              })
            : null}
        </svg>
        {centerValue || centerLabel ? (
          <span
            aria-hidden
            className="absolute inset-0 flex flex-col items-center justify-center text-center"
          >
            {centerValue ? <span className="text-title-3 tabular-nums text-text">{centerValue}</span> : null}
            {centerLabel ? <span className="text-footnote text-text-secondary">{centerLabel}</span> : null}
          </span>
        ) : null}
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {items.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2 text-callout">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: seriesColor(i) }}
            />
            <span className="min-w-0 flex-1 truncate text-text">{d.label}</span>
            <span className="tabular-nums text-text-secondary">{format(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A headline number with an optional change: a stat tile, not a plot. */
export function KpiTile({
  label,
  value,
  delta,
  hint,
  href,
  icon,
  linkAs: LinkAs = 'a',
}: {
  label: string;
  value: string;
  delta?: {
    text: string;
    direction: 'up' | 'down' | 'flat';
    tone?: 'good' | 'bad' | 'neutral';
    label: string;
  };
  hint?: string;
  href?: string;
  icon?: React.ReactNode;
  /** The app passes its router link so tiles navigate without a full page load. */
  linkAs?: React.ElementType;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-callout text-text-secondary [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[1.5]">
        {icon}
        {label}
      </span>
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-title-1 tabular-nums text-text">{value}</span>
        {delta ? (
          <span
            className={cn(
              'text-footnote tabular-nums',
              delta.tone === 'good'
                ? 'text-success'
                : delta.tone === 'bad'
                  ? 'text-danger'
                  : 'text-text-secondary',
            )}
          >
            <span aria-hidden>
              {delta.direction === 'up' ? '▲ ' : delta.direction === 'down' ? '▼ ' : ''}
            </span>
            <span className="sr-only">{delta.label} </span>
            {delta.text}
          </span>
        ) : null}
      </span>
      {hint ? <span className="text-footnote text-text-secondary">{hint}</span> : null}
    </>
  );
  const className =
    'flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-surface-raised p-5 text-left text-text no-underline';
  return href ? (
    <LinkAs
      href={href}
      className={cn(
        className,
        'transition-colors duration-[var(--duration-fast)] hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent',
      )}
    >
      {body}
    </LinkAs>
  ) : (
    <div className={className}>{body}</div>
  );
}
