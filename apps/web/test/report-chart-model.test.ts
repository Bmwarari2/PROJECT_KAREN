import { describe, expect, it } from 'vitest';
import { chartModel, MAX_BARS } from '../app/app/reports/chart-model';
import type { Cell, ReportColumn, ReportResult } from '../lib/report-format';

/** Chart choice for report-builder summaries (DESIGN.md §6). Fictional departments and values only. */
const col = (key: string, type: ReportColumn['type'], labelKey = `reports.field.${key}`): ReportColumn => ({
  key,
  labelKey,
  type,
});
const result = (columns: ReportColumn[], rows: Array<Record<string, Cell>>): ReportResult => ({
  title: 'Fictional',
  parameters: [],
  generatedAt: '2026-10-23T10:00:00Z',
  columns,
  rows,
  notes: [],
});
const input = (r: ReportResult, groups: number) => ({
  result: r,
  groups,
  label: (_c: ReportColumn, v: Cell) => (v === null ? 'Unassigned' : String(v)),
  header: (c: ReportColumn) => c.labelKey,
  otherLabel: 'Other',
});
const count = col('count_rows', 'integer', 'reports.measure.count');
const avg = col('avg_fte', 'decimal', 'reports.measure.avg');
const dept = col('department', 'text');
const month = { ...col('startDate_month', 'date'), subLabelKey: 'reports.granularity.month' };

describe('report builder chart model', () => {
  it('draws no chart for a list of rows or an empty summary', () => {
    expect(chartModel(input(result([dept], [{ department: 'Engineering' }]), 0))).toEqual({
      kind: 'none',
      reason: 'list',
    });
    expect(chartModel(input(result([dept, count], []), 1)).kind).toBe('none');
  });

  it('shows up to six shares of a count as a donut, largest first', () => {
    const m = chartModel(
      input(
        result(
          [dept, count],
          [
            { department: 'Sales', count_rows: 2 },
            { department: 'Engineering', count_rows: 5 },
            { department: null, count_rows: 1 },
          ],
        ),
        1,
      ),
    );
    expect(m.kind).toBe('donut');
    if (m.kind !== 'donut') return;
    expect(m.items.map((d) => d.label)).toEqual(['Engineering', 'Sales', 'Unassigned']);
    expect(m.total).toBe(8);
  });

  it('uses bars for averages and for more than six categories, folding counts past the limit into Other', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      department: `Team ${i}`,
      avg_fte: 1,
      count_rows: i,
    }));
    expect(chartModel(input(result([dept, avg], rows), 1)).kind).toBe('bar');
    expect(chartModel(input(result([dept, count], rows), 1)).kind).toBe('bar');
    const many = Array.from({ length: MAX_BARS + 5 }, (_, i) => ({ department: `Team ${i}`, count_rows: 1 }));
    const folded = chartModel(input(result([dept, count], many), 1));
    expect(folded.kind === 'bar' && folded.items.length).toBe(MAX_BARS);
    expect(folded.kind === 'bar' && folded.items.at(-1)).toEqual({ label: 'Other', value: 6 });
    const clipped = chartModel(
      input(
        result(
          [dept, avg],
          many.map((r) => ({ ...r, avg_fte: 1 })),
        ),
        1,
      ),
    );
    expect(clipped.kind === 'bar' && clipped.clipped).toBe(true);
  });

  it('draws months as columns on one axis: only measures in the first measure’s unit', () => {
    const hours = col('sum_workedMinutes', 'minutes', 'reports.measure.sum');
    const m = chartModel(
      input(
        result(
          [month, count, hours],
          [
            { startDate_month: '2026-01-01', count_rows: 3, sum_workedMinutes: 600 },
            { startDate_month: '2026-02-01', count_rows: 4, sum_workedMinutes: 900 },
          ],
        ),
        1,
      ),
    );
    expect(m.kind).toBe('column');
    if (m.kind !== 'column') return;
    expect(m.categories).toEqual(['2026-01-01', '2026-02-01']);
    expect(m.series.map((s) => s.key)).toEqual(['count_rows']);
    expect(m.series[0]!.values).toEqual([3, 4]);
  });

  it('stacks a second grouping level, never cycling colours: the seventh value folds into Other', () => {
    const second = col('location', 'text');
    const rows = Array.from({ length: 8 }, (_, i) => ({
      startDate_month: '2026-01-01',
      location: `Site ${i}`,
      count_rows: 10 - i,
    }));
    const m = chartModel(input(result([month, second, count], rows), 2));
    expect(m.kind).toBe('column');
    if (m.kind !== 'column') return;
    expect(m.stacked).toBe(true);
    expect(m.series).toHaveLength(6);
    expect(m.series.at(-1)).toMatchObject({ label: 'Other', values: [3 + 4 + 5] });
    // averages cannot be folded, so too many series leave only the table
    const avgRows = rows.map(({ count_rows, ...r }) => ({ ...r, avg_fte: count_rows }));
    expect(chartModel(input(result([month, second, avg], avgRows), 2))).toEqual({
      kind: 'none',
      reason: 'tooManySeries',
    });
  });

  it('keeps money in several currencies out of one chart', () => {
    const pay = col('sum_payAmount', 'money', 'reports.measure.sum');
    const m = chartModel(
      input(
        result(
          [dept, col('currency', 'text', 'reports.col.currency'), pay],
          [
            { department: 'Sales', currency: 'GBP', sum_payAmount: { amountMinor: '100', currency: 'GBP' } },
            { department: 'Sales', currency: 'EUR', sum_payAmount: { amountMinor: '100', currency: 'EUR' } },
          ],
        ),
        1,
      ),
    );
    expect(m).toEqual({ kind: 'none', reason: 'currencies' });
  });
});
