'use client';
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { ColumnChart, Table, TD, TH, THead, TR, cn, focusRing, type BarSeries } from '@thapsus/ui';

/**
 * A column chart with its table twin (DESIGN.md §6 charts, ADR-0154): the chart is an image to assistive
 * technology, so every value is also in a table behind "Show as a table". On phones only the last
 * `phoneColumns` categories are drawn, because twelve labels do not fit at 320px; the table keeps them all.
 */
export function ChartWithTable({
  label,
  categories,
  tableCategories,
  series,
  format,
  integer,
  stacked,
  showTable,
  categoryHeading,
  phoneColumns = 6,
  height = 160,
}: {
  label: string;
  categories: string[];
  /** Longer category names for the table (defaults to the chart's). */
  tableCategories?: string[];
  series: BarSeries[];
  format: (n: number) => string;
  integer?: boolean;
  stacked?: boolean;
  showTable: string;
  categoryHeading: string;
  phoneColumns?: number;
  height?: number;
}) {
  const chart = (from: number) => (
    <ColumnChart
      label={label}
      categories={categories.slice(from)}
      series={series.map((s) => ({ ...s, values: s.values.slice(from) }))}
      format={format}
      integer={integer}
      stacked={stacked}
      height={height}
    />
  );
  const names = tableCategories ?? categories;
  return (
    <>
      <div className="sm:hidden">{chart(Math.max(0, categories.length - phoneColumns))}</div>
      <div className="hidden sm:block">{chart(0)}</div>
      <details className="group">
        <summary
          className={cn(
            'inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-callout font-semibold text-accent [&::-webkit-details-marker]:hidden',
            focusRing,
          )}
        >
          <ChevronDown
            aria-hidden
            className="h-4 w-4 stroke-[1.5] transition-transform duration-[var(--duration-fast)] group-open:rotate-180"
          />
          {showTable}
        </summary>
        <div className="mt-3">
          <Table dense scrollLabel={label} stack={false}>
            <THead>
              <tr>
                <TH>{categoryHeading}</TH>
                {series.map((s) => (
                  <TH key={s.key} className="text-right">
                    {s.label}
                  </TH>
                ))}
              </tr>
            </THead>
            <tbody>
              {names.map((c, i) => (
                <TR key={`${c}-${i}`}>
                  <TD>{c}</TD>
                  {series.map((s) => (
                    <TD key={s.key} className="text-right">
                      {format(s.values[i] ?? 0)}
                    </TD>
                  ))}
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </>
  );
}

/** A section of a dashboard page: an h2 and a grid of tiles or panels. */
export function DashboardSection({
  title,
  children,
  footer,
  id,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  id: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="px-1 text-title-3 text-text">
        {title}
      </h2>
      {children}
      {footer ? <p className="px-1 text-footnote text-text-secondary">{footer}</p> : null}
    </section>
  );
}
