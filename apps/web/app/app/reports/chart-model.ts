import { foldOther, SERIES_COUNT, type ChartDatum } from '@thapsus/ui';
// relative import: the unit tests load this module without the app's path aliases
import {
  chartValue,
  NUMERIC,
  type Cell,
  type ReportColumn,
  type ReportResult,
} from '../../../lib/report-format';

/**
 * Which chart a report-builder summary gets (DESIGN.md §6, ADR-0154), decided from the result alone:
 *  - grouped by a date (month or year)   → columns over time, one series per value of the same unit;
 *  - grouped by a category, a share       → a donut when there are at most six slices of a count or total;
 *  - grouped by a category, otherwise     → horizontal bars (long names), one series;
 *  - grouped twice                        → columns for the first level, one series per second-level value.
 * Series take the chart tokens in a fixed order and are never cycled: extra series fold into "Other",
 * which is only possible for counts and totals (an average of averages would be wrong), so other
 * measures with too many series stay a table. One y-axis: only measures of the first one's unit are drawn.
 */

export type MeasureFn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';

export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
}

interface Base {
  /** The measure the values (and the axis) are in. */
  measure: ReportColumn;
  /** The grouping the categories come from. */
  dimension: ReportColumn;
  /** Currency of money values (one currency per chart). */
  currency?: string;
}
export type ChartModel =
  | (Base & {
      kind: 'column';
      categories: string[];
      series: ChartSeries[];
      stacked: boolean;
      /** Categories past the limit are only in the table. */
      clipped: boolean;
    })
  | (Base & { kind: 'bar'; items: ChartDatum[]; clipped: boolean })
  | (Base & { kind: 'donut'; items: ChartDatum[]; total: number })
  | {
      kind: 'none';
      reason: 'list' | 'empty' | 'noMeasure' | 'currencies' | 'tooManySeries';
    };

/** At most this many columns (months, entities) and bars are drawn; the table has every row. */
export const MAX_CATEGORIES = 24;
export const MAX_BARS = 20;

/** The calculation behind a measure column (`reports.measure.sum` → `sum`). */
export function measureFn(c: Pick<ReportColumn, 'labelKey'>): MeasureFn | null {
  const m = /^reports\.measure\.(\w+)$/.exec(c.labelKey);
  return m ? (m[1] as MeasureFn) : null;
}

/** Counts and totals add up across groups, so they can be shown as shares and folded into "Other". */
export const additive = (c: Pick<ReportColumn, 'labelKey'>) => {
  const fn = measureFn(c);
  return fn === 'count' || fn === 'sum';
};

export interface ChartInput {
  result: ReportResult;
  /** Number of grouping levels in the spec that produced the result (0 for a list of rows). */
  groups: number;
  /** Display text of a category value. */
  label: (column: ReportColumn, value: Cell) => string;
  /** Display text of a column header (series names). */
  header: (column: ReportColumn) => string;
  otherLabel: string;
}

export function chartModel({ result, groups, label, header, otherLabel }: ChartInput): ChartModel {
  if (!groups) return { kind: 'none', reason: 'list' };
  if (!result.rows.length) return { kind: 'none', reason: 'empty' };
  const dims = result.columns.slice(0, groups);
  const measures = result.columns.filter((c) => measureFn(c) && NUMERIC.includes(c.type));
  const dimension = dims[0]!;
  const first = measures[0];
  if (!first) return { kind: 'none', reason: 'noMeasure' };

  // one currency per chart: money in several currencies is only comparable in the table
  const currencies = new Set(
    first.type === 'money'
      ? result.rows
          .map((r) => r[first.key])
          .filter((v): v is { amountMinor: string; currency: string } => !!v && typeof v === 'object')
          .map((v) => v.currency)
      : [],
  );
  if (currencies.size > 1) return { kind: 'none', reason: 'currencies' };
  const currency = currencies.size ? [...currencies][0] : undefined;
  const base = { measure: first, dimension, ...(currency ? { currency } : {}) };
  const value = (row: Record<string, Cell>, c: ReportColumn) => chartValue(row[c.key] ?? null);

  if (groups >= 2) {
    const second = dims[1]!;
    const categories: string[] = [];
    const seriesTotals = new Map<string, number>();
    for (const r of result.rows) {
      const c = label(dimension, r[dimension.key] ?? null);
      if (!categories.includes(c)) categories.push(c);
      const s = label(second, r[second.key] ?? null);
      seriesTotals.set(s, (seriesTotals.get(s) ?? 0) + value(r, first));
    }
    const canFold = additive(first);
    if (seriesTotals.size > SERIES_COUNT && !canFold) return { kind: 'none', reason: 'tooManySeries' };
    // the largest second-level values keep their own series; the rest become "Other"
    const kept = foldOther(
      [...seriesTotals].map(([l, v]) => ({ label: l, value: v })),
      otherLabel,
    ).map((d) => d.label);
    const shownCategories = categories.slice(0, MAX_CATEGORIES);
    const series: ChartSeries[] = kept.map((name, i) => ({
      key: `s${i}`,
      label: name,
      values: shownCategories.map(() => 0),
    }));
    for (const r of result.rows) {
      const ci = shownCategories.indexOf(label(dimension, r[dimension.key] ?? null));
      if (ci < 0) continue;
      const name = label(second, r[second.key] ?? null);
      const si = kept.includes(name) ? kept.indexOf(name) : kept.indexOf(otherLabel);
      series[si]!.values[ci]! += value(r, first);
    }
    return {
      kind: 'column',
      ...base,
      categories: shownCategories,
      series,
      stacked: canFold,
      clipped: categories.length > shownCategories.length,
    };
  }

  if (dimension.type === 'date') {
    // one axis: only measures in the first measure's unit (counts with counts, hours with hours)
    const same = measures.filter((m) => m.type === first.type).slice(0, SERIES_COUNT);
    const rows = result.rows.slice(0, MAX_CATEGORIES);
    return {
      kind: 'column',
      ...base,
      categories: rows.map((r) => label(dimension, r[dimension.key] ?? null)),
      series: same.map((m) => ({
        key: m.key,
        label: header(m),
        values: rows.map((r) => value(r, m)),
      })),
      stacked: false,
      clipped: result.rows.length > rows.length,
    };
  }

  const items = result.rows.map((r) => ({
    label: label(dimension, r[dimension.key] ?? null),
    value: value(r, first),
  }));
  if (additive(first) && items.length <= SERIES_COUNT && items.every((d) => d.value >= 0)) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    return { kind: 'donut', ...base, items: sorted, total: sorted.reduce((n, d) => n + d.value, 0) };
  }
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length <= MAX_BARS) return { kind: 'bar', ...base, items: sorted, clipped: false };
  return additive(first)
    ? { kind: 'bar', ...base, items: foldOther(sorted, otherLabel, MAX_BARS), clipped: false }
    : { kind: 'bar', ...base, items: sorted.slice(0, MAX_BARS), clipped: true };
}
