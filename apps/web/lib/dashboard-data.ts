'use client';
import * as React from 'react';
import {
  addDays,
  addMonths,
  compareDates,
  dateParts,
  daysInMonth,
  makeDate,
  startOfIsoWeek,
} from '@thapsus/core/time';
import { useCan } from '@/app/app/shell';
import { api } from './api';
import { useApi } from './use-api';

/**
 * Data for the dashboards (Home, the People directory strip and the Time overview), composed from
 * existing permission-scoped endpoints only (ADR-0154): the self-service summary, approvals, the leave
 * calendar and the report-builder preview. Every hook takes the viewer's calendar date (`today`, from
 * `@thapsus/core/time` in the viewer's zone) so the dates it sends are explicit and repeatable.
 */

/** GET /v1/me/summary */
export interface MeSummary {
  employee: { id: string; displayName: string; jobTitle: string | null } | null;
  leave: {
    available: string | null;
    unit: string | null;
    pending: number;
    next: { start: string; end: string } | null;
  } | null;
  rota: {
    nextShift: { date: string; start: string; end: string; zone: string } | null;
    pendingSwaps: number;
  } | null;
  clock: { clockedIn: boolean; since: string | null } | null;
  documents: { toSign: number };
  tasks: { open: number; overdue: number };
  notifications: { unread: number };
  payslips: {
    total: number;
    unviewed: number;
    latest: { label: string; payDate: string | null } | null;
  } | null;
  changeRequests: { pending: number };
}

/** GET /v1/approvals?view=mine */
export interface ApprovalItem {
  id: string;
  subject: string;
  status: string;
  policy: string;
  subjectEmployeeId?: string | null;
  subjectName: string | null;
  requestedAt: string;
  payload: Record<string, unknown>;
}

/** GET /v1/tasks?status=open */
export interface TaskItem {
  id: string;
  title: string;
  dueOn: string | null;
  link: string | null;
  /** The page the task is about (ADR-0160). */
  href?: string;
}

/** GET /v1/leave/calendar */
export interface CalendarEntry {
  employeeId: string;
  name: string;
  start: string;
  end: string;
  kind: string;
  status: string;
}
export interface LeaveCalendar {
  entries: CalendarEntry[];
  holidays: Array<{ date: string; name: string }>;
}

/** The leave calendar for the ISO week (Monday to Sunday) holding `today`. */
export function useWeekCalendar(today: string | null, enabled = true) {
  const [from, to] = React.useMemo(() => {
    const start = enabled && today ? startOfIsoWeek(today) : null;
    return [start, start ? addDays(start, 6) : null];
  }, [today, enabled]);
  return {
    from,
    to,
    ...useApi<LeaveCalendar>(enabled && from ? `/v1/leave/calendar?from=${from}&to=${to}` : null),
  };
}

/** Calendar entries that cover `day` (approved and waiting requests), one per person. */
export function outOn(entries: CalendarEntry[], day: string, approvedOnly = false): CalendarEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (approvedOnly && e.status !== 'approved') return false;
    if (compareDates(e.start, day) > 0 || compareDates(e.end, day) < 0 || seen.has(e.employeeId))
      return false;
    seen.add(e.employeeId);
    return true;
  });
}

// ---- report-builder preview (POST /v1/reports/builder/preview) --------------------------------------

/** The builder's marker for a group whose value the viewer may not read on those rows. */
export const RESTRICTED = '__restricted__';

interface PreviewResult {
  rows: Array<Record<string, unknown>>;
}
type Spec = Record<string, unknown> & { dataset: 'employees' };

const preview = (spec: Spec) =>
  api<PreviewResult>('/v1/reports/builder/preview', {
    method: 'POST',
    json: spec,
    capability: 'reports.run',
  }).then((r) => r.rows);
const count = (row: Record<string, unknown>) => Number(row.count_rows ?? 0) || 0;

export interface StatusCounts {
  active: number;
  pre_start: number;
  leaver: number;
}

function statusCounts(rows: Array<Record<string, unknown>>): StatusCounts {
  const out: StatusCounts = { active: 0, pre_start: 0, leaver: 0 };
  for (const r of rows) {
    const s = String(r.status);
    if (s === 'active' || s === 'pre_start' || s === 'leaver') out[s] += count(r);
  }
  return out;
}

interface Loaded<T> {
  data: T | undefined;
  /** True when the endpoint refused or failed: the widget is hidden rather than shown broken. */
  failed: boolean;
}

function usePreview<T>(wanted: string | null, run: () => Promise<T>): Loaded<T> {
  // only for someone who may run reports (the preview route's capability, ADR-0188)
  const can = useCan();
  const key = can('reports.run') ? wanted : null;
  const [state, setState] = React.useState<Loaded<T>>({ data: undefined, failed: false });
  const runRef = React.useRef(run);
  runRef.current = run;
  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ data: undefined, failed: false });
    runRef
      .current()
      .then((data) => !cancelled && setState({ data, failed: false }))
      .catch(() => !cancelled && setState({ data: undefined, failed: true }));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}

/** People by status on `asOf` (active, starting soon, left), in the viewer's scope. */
export function useStatusCounts(asOf: string | null, enabled: boolean): Loaded<StatusCounts> {
  return usePreview(enabled && asOf ? `status:${asOf}` : null, async () =>
    statusCounts(
      await preview({
        dataset: 'employees',
        population: 'all',
        asOf: asOf!,
        groupBy: [{ field: 'status' }],
        measures: [{ fn: 'count' }],
      }),
    ),
  );
}

export interface PeopleInsights {
  status: StatusCounts;
  /** Active people by employment type (null: not set; RESTRICTED: not readable by the viewer). */
  byType: Array<{ key: string | null; value: number }>;
  /** Active people by department (null: none). */
  byDepartment: Array<{ key: string | null; value: number }>;
  /** Joiners per month, oldest first, the last month being the current one. */
  joiners: Array<{ month: string; value: number }>;
}

/** The twelve months ending with the month of `today`, as first-of-month civil dates. */
export function lastTwelveMonths(today: string): string[] {
  const { year, month } = dateParts(today);
  const first = makeDate(year, month, 1);
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i - 11));
}

/** Headcount insights for the home dashboard: three grouped previews run side by side. */
export function usePeopleInsights(today: string | null, enabled: boolean): Loaded<PeopleInsights> {
  return usePreview(enabled && today ? `insights:${today}` : null, async () => {
    const asOf = today!;
    const months = lastTwelveMonths(asOf);
    const { year, month } = dateParts(asOf);
    const lastDay = makeDate(year, month, daysInMonth(year, month));
    const [typeRows, deptRows, joinerRows] = await Promise.all([
      preview({
        dataset: 'employees',
        population: 'all',
        asOf,
        groupBy: [{ field: 'status' }, { field: 'employmentType' }],
        measures: [{ fn: 'count' }],
      }),
      preview({
        dataset: 'employees',
        asOf,
        groupBy: [{ field: 'department' }],
        measures: [{ fn: 'count' }],
        sort: { key: 'count_rows', dir: 'desc' },
      }),
      preview({
        dataset: 'employees',
        population: 'all',
        asOf,
        groupBy: [{ field: 'startDate', granularity: 'month' }],
        measures: [{ fn: 'count' }],
        filters: [
          { field: 'startDate', op: 'gte', value: months[0]! },
          { field: 'startDate', op: 'lte', value: lastDay },
        ],
      }),
    ]);
    const perMonth = new Map<string, number>();
    for (const r of joinerRows) {
      const m = typeof r.startDate_month === 'string' ? r.startDate_month.slice(0, 7) : null;
      if (m) perMonth.set(m, (perMonth.get(m) ?? 0) + count(r));
    }
    return {
      status: statusCounts(typeRows),
      byType: typeRows
        .filter((r) => r.status === 'active')
        .map((r) => ({
          key: typeof r.employmentType === 'string' ? r.employmentType : null,
          value: count(r),
        })),
      byDepartment: deptRows.map((r) => ({
        key: typeof r.department === 'string' ? r.department : null,
        value: count(r),
      })),
      joiners: months.map((m) => ({ month: m, value: perMonth.get(m.slice(0, 7)) ?? 0 })),
    };
  });
}
