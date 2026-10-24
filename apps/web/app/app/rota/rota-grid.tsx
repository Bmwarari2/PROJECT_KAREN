'use client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { cn, Skeleton } from '@thapsus/ui';
import { formatTimeOfDay, type Locale } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useVirtualRows } from '@/lib/use-virtual';
import { dayLabel, dayLong } from '@/lib/week';
import { PersonLink } from '@/components/person-link';

export interface ShiftDto {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  date: string;
  start: string;
  end: string;
  zone: string;
  breakMinutes: number;
  status: string;
  locationId: string | null;
  departmentId: string | null;
  role: string | null;
  notes: string | null;
}
export interface GridRowDto {
  employeeId: string;
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  shifts: ShiftDto[];
}

/** Row height in px (spacing token: 48). The grid renders only the rows in view. */
export const ROW_HEIGHT = 48;
const COLS = 'grid-cols-[minmax(10rem,14rem)_repeat(7,minmax(7rem,1fr))]';

export function shiftRange(s: Pick<ShiftDto, 'start' | 'end'>, locale: Locale) {
  return `${formatTimeOfDay(s.start, locale)}–${formatTimeOfDay(s.end, locale)}`;
}

function ShiftChip({
  shift,
  onOpen,
  label,
}: {
  shift: ShiftDto;
  onOpen?: (s: ShiftDto) => void;
  label: string;
}) {
  const locale = useLocale();
  const cls = cn(
    'inline-flex h-7 max-w-full items-center truncate rounded-sm px-2 text-footnote font-semibold tabular-nums',
    shift.status === 'draft'
      ? 'border border-dashed border-border-strong bg-surface text-text'
      : 'bg-accent-subtle text-text',
  );
  if (!onOpen) return <span className={cls}>{shiftRange(shift, locale)}</span>;
  return (
    <button
      type="button"
      className={cn(
        cls,
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
      )}
      aria-label={label}
      onClick={() => onOpen(shift)}
    >
      {shiftRange(shift, locale)}
    </button>
  );
}

/** One employee row; memoised so scrolling renders only rows entering the window. */
const RowView = React.memo(function RowView({
  index,
  row: r,
  days,
  canEdit,
  onAdd,
  onOpen,
  chipLabel,
}: {
  index: number;
  row: GridRowDto | undefined;
  days: string[];
  canEdit: boolean;
  onAdd?: (employeeId: string | null, date: string, name?: string) => void;
  onOpen?: (s: ShiftDto) => void;
  chipLabel: (s: ShiftDto, who: string) => string;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <div
      role="row"
      aria-rowindex={index + 3}
      data-row={index}
      className={cn('absolute inset-x-0 grid border-b border-border', COLS)}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
    >
      {r ? (
        <>
          <div
            role="rowheader"
            className="sticky left-0 z-10 flex min-w-0 flex-col justify-center bg-surface-raised px-3"
          >
            <PersonLink
              id={r.employeeId}
              name={r.name}
              quiet
              className="block truncate text-callout font-semibold"
              plainClassName="block truncate text-callout font-semibold"
            />
            {r.jobTitle ? (
              <span className="truncate text-footnote text-text-secondary">{r.jobTitle}</span>
            ) : null}
          </div>
          {days.map((d) => {
            const here = r.shifts.filter((s) => s.date === d);
            return (
              <div
                key={d}
                role="gridcell"
                className="group flex min-w-0 items-center gap-1 border-l border-border px-1.5"
              >
                {here.slice(0, 1).map((s) => (
                  <ShiftChip
                    key={s.id}
                    shift={s}
                    onOpen={canEdit ? onOpen : undefined}
                    label={chipLabel(s, r.name)}
                  />
                ))}
                {here.length > 1 ? (
                  <span className="text-footnote text-text-secondary">+{here.length - 1}</span>
                ) : null}
                {canEdit && !here.length ? (
                  <button
                    type="button"
                    onClick={() => onAdd?.(r.employeeId, d, r.name)}
                    aria-label={t('rota.addShiftFor', { name: r.name, day: dayLong(d, locale) })}
                    className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary opacity-0 hover:bg-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100"
                  >
                    <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </>
      ) : (
        <div role="gridcell" aria-busy className="col-span-8 flex items-center px-3">
          <Skeleton className="h-4 w-48" />
        </div>
      )}
    </div>
  );
});

export function RotaGrid(props: {
  days: string[];
  rows: Array<GridRowDto | undefined>;
  openShifts: ShiftDto[];
  canEdit: boolean;
  onAdd?: (employeeId: string | null, date: string, name?: string) => void;
  onOpen?: (s: ShiftDto) => void;
  /** Called with the last row index in view so the page can fetch the next keyset page. */
  onRangeEnd?: (end: number) => void;
  label: string;
}) {
  const { days, rows, openShifts, canEdit, onAdd, onOpen, onRangeEnd, label } = props;
  const t = useT();
  const locale = useLocale();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const headRef = React.useRef<HTMLDivElement>(null);
  const [headH, setHeadH] = React.useState(ROW_HEIGHT * 2);
  React.useLayoutEffect(() => {
    if (headRef.current) setHeadH(headRef.current.offsetHeight);
  }, [openShifts, days]);
  const { start, end, totalHeight } = useVirtualRows({
    count: rows.length,
    rowHeight: ROW_HEIGHT,
    scrollRef,
    headerHeight: headH,
  });
  React.useEffect(() => onRangeEnd?.(end), [end, onRangeEnd]);

  const chipLabel = React.useCallback(
    (s: ShiftDto, who: string) =>
      t('rota.shiftAria', {
        status: t(`rota.status.${s.status}`),
        name: who,
        day: dayLong(s.date, locale),
        range: shiftRange(s, locale),
      }),
    [t, locale],
  );

  const visible = [];
  for (let i = start; i < end; i++)
    visible.push(
      <RowView
        key={rows[i]?.employeeId ?? `p${i}`}
        index={i}
        row={rows[i]}
        days={days}
        canEdit={canEdit}
        onAdd={onAdd}
        onOpen={onOpen}
        chipLabel={chipLabel}
      />,
    );

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length + 2}
      aria-colcount={8}
      data-testid="rota-grid"
      className="relative max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface-raised"
    >
      <div ref={headRef} role="rowgroup" className="sticky top-0 z-20 min-w-[59rem] bg-surface">
        <div role="row" aria-rowindex={1} className={cn('grid border-b border-border', COLS)}>
          <div
            role="columnheader"
            className="sticky left-0 z-10 flex h-11 items-center bg-surface px-3 text-footnote font-semibold text-text-secondary"
          >
            {t('rota.people')}
          </div>
          {days.map((d) => (
            <div
              key={d}
              role="columnheader"
              className="flex h-11 items-center border-l border-border px-2 text-footnote font-semibold text-text-secondary"
            >
              <span aria-hidden>{dayLabel(d, locale)}</span>
              <span className="sr-only">{dayLong(d, locale)}</span>
            </div>
          ))}
        </div>
        <div
          role="row"
          aria-rowindex={2}
          className={cn('grid border-b border-border bg-surface-raised', COLS)}
        >
          <div
            role="rowheader"
            className="sticky left-0 z-10 flex items-center bg-surface-raised px-3 py-2 text-callout font-semibold"
          >
            {t('rota.openShifts')}
          </div>
          {days.map((d) => {
            const here = openShifts.filter((s) => s.date === d);
            return (
              <div
                key={d}
                role="gridcell"
                className="group flex min-h-12 min-w-0 flex-wrap items-center gap-1 border-l border-border px-1.5 py-1.5"
              >
                {here.slice(0, 3).map((s) => (
                  <ShiftChip
                    key={s.id}
                    shift={s}
                    onOpen={canEdit ? onOpen : undefined}
                    label={chipLabel(s, t('rota.openShift'))}
                  />
                ))}
                {here.length > 3 ? (
                  <span className="text-footnote text-text-secondary">+{here.length - 3}</span>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => onAdd?.(null, d)}
                    aria-label={t('rota.addOpenShift', { day: dayLong(d, locale) })}
                    className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary opacity-0 hover:bg-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100"
                  >
                    <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div role="rowgroup" className="relative min-w-[59rem]" style={{ height: totalHeight }}>
        {visible}
      </div>
    </div>
  );
}
