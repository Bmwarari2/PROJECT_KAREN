'use client';
import * as React from 'react';
import { CalendarDays, ClipboardList, Inbox } from 'lucide-react';
import { Badge, Skeleton } from '@thapsus/ui';
import { addDays, today as todayIn } from '@thapsus/core/time';
import { formatUnit, numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone, weekStartOf } from '@/lib/week';
import { useWeekCalendar, type ApprovalItem, type MeSummary } from '@/lib/dashboard-data';
import { MeTiles, formatDayRange } from '@/components/dashboard/me-tiles';
import { Avatar, IconTile, Panel, PanelLink } from '@/components/dashboard/parts';
import { WhosOut } from '@/components/dashboard/whos-out';
import { hasPermission, useSession } from '../shell';

interface WeekSheet {
  status: string;
  weekStart: string;
  workedMinutes: number;
}

const sheetTone = { open: 'warning', submitted: 'neutral', approved: 'success', rejected: 'danger' } as const;

/**
 * Time overview (the first tab of the Time module): who is out today and this week, requests waiting
 * for the viewer, their own balance, next shift and clock, and last week's timesheet. Composed from
 * existing endpoints; each panel shows only what the viewer's permissions return.
 */
export default function TimeOverviewPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession()!;
  const n = (v: number) => numberFormat(locale).format(v);
  const [deviceZone, setDeviceZone] = React.useState<string | null>(null);
  React.useEffect(() => setDeviceZone(viewerZone(null)), []);
  const zone = session.timeZone || deviceZone;
  const today = zone ? todayIn(zone) : null;

  const employeeId = session.employeeId;
  const canClock = !!employeeId && hasPermission(session, 'time.clock');
  const approver = ['leave.approve', 'time.approve', 'approvals.act'].some((p) => hasPermission(session, p));

  const summary = useApi<MeSummary>(employeeId ? '/v1/me/summary' : null);
  const approvals = useApi<ApprovalItem[]>('/v1/approvals?view=mine');
  const calendar = useWeekCalendar(today);
  const settings = useApi<{ workweekStartsOn: number }>(canClock ? '/v1/settings/time' : null);
  const lastWeek =
    settings.data && today ? addDays(weekStartOf(today, settings.data.workweekStartsOn), -7) : null;
  const sheet = useApi<WeekSheet>(
    canClock && lastWeek ? `/v1/timesheets/employees/${employeeId}/weeks/${lastWeek}` : null,
  );

  const pending = (approvals.data ?? []).filter((a) => a.status === 'pending');
  const leave = pending
    .filter((a) => a.subject === 'leave.request')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const timesheets = pending.filter((a) => a.subject === 'timesheet');
  const showWaiting = approver || leave.length > 0 || timesheets.length > 0;
  const kind = (k: unknown) => {
    const key = `timeOff.kind.${String(k)}`;
    return t(key) === key ? t('timeOff.kind.away') : t(key);
  };
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

  return (
    <div className="flex flex-col gap-6">
      {employeeId ? (
        summary.data && today && zone ? (
          <MeTiles
            summary={summary.data}
            level={2}
            today={today}
            zone={zone}
            parts={['leave', 'rota', 'clock']}
            className="grid gap-4 md:grid-cols-3"
          />
        ) : summary.error ? null : (
          <Skeleton className="h-40 w-full" />
        )
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {today && !calendar.error ? (
          <WhosOut
            calendar={calendar.data}
            today={today}
            level={2}
            max={8}
            className={showWaiting || canClock ? 'lg:col-span-2' : 'lg:col-span-3'}
            link={{ href: '/app/time-off', label: t('timeOverview.teamCalendar') }}
          />
        ) : null}

        <div className="flex min-w-0 flex-col gap-4">
          {showWaiting ? (
            <Panel
              level={2}
              title={t('timeOverview.waiting.title')}
              data-testid="time-waiting"
              action={
                pending.length ? (
                  <PanelLink href="/app/approvals">{t('timeOverview.waiting.review')}</PanelLink>
                ) : undefined
              }
            >
              {!approvals.data && !approvals.error ? (
                <Skeleton className="h-24 w-full" />
              ) : !leave.length && !timesheets.length ? (
                <p className="flex items-center gap-2 text-callout text-text-secondary">
                  <Inbox aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5]" />
                  {t('timeOverview.waiting.none')}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {leave.length ? (
                    <div className="flex flex-col gap-2">
                      <p className="flex items-center gap-2 text-callout font-semibold text-text">
                        <CalendarDays aria-hidden className="h-4 w-4 stroke-[1.5] text-text-secondary" />
                        {t('timeOverview.waiting.leave', { n: n(leave.length), count: leave.length })}
                      </p>
                      <ul className="flex flex-col gap-3">
                        {leave.slice(0, 5).map((a) => {
                          const from = date(a.payload.startDate);
                          const to = date(a.payload.endDate) ?? from;
                          const days = typeof a.payload.amountDays === 'number' ? a.payload.amountDays : null;
                          return (
                            <li key={a.id} className="flex min-w-0 items-center gap-3">
                              <Avatar name={a.subjectName ?? ''} size="sm" />
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-callout font-semibold text-text">
                                  {a.subjectName ?? a.policy}
                                </span>
                                <span className="text-footnote text-text-secondary">
                                  {[
                                    kind(a.payload.leaveType),
                                    from && to ? formatDayRange(from, to, locale) : null,
                                    days !== null ? formatUnit(days, 'day', locale) : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {timesheets.length ? (
                    <p className="flex items-center gap-2 text-callout font-semibold text-text">
                      <ClipboardList aria-hidden className="h-4 w-4 stroke-[1.5] text-text-secondary" />
                      {t('timeOverview.waiting.timesheets', {
                        n: n(timesheets.length),
                        count: timesheets.length,
                      })}
                    </p>
                  ) : null}
                </div>
              )}
            </Panel>
          ) : null}

          {canClock && !settings.error && !sheet.error ? (
            <Panel
              level={2}
              title={t('timeOverview.sheet.title')}
              data-testid="time-sheet"
              description={lastWeek ? formatDayRange(lastWeek, addDays(lastWeek, 6), locale) : undefined}
            >
              {!sheet.data ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <IconTile tone="muted">
                      <ClipboardList />
                    </IconTile>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-callout font-semibold text-text">
                        {t('timeOverview.sheet.worked', {
                          hours: formatUnit(sheet.data.workedMinutes / 60, 'hour', locale),
                        })}
                      </span>
                    </span>
                    <Badge tone={sheetTone[sheet.data.status as keyof typeof sheetTone] ?? 'neutral'}>
                      {t(`timesheets.status.${sheet.data.status}`)}
                    </Badge>
                  </div>
                  <PanelLink href="/app/timesheets">
                    {['open', 'rejected'].includes(sheet.data.status)
                      ? t('timeOverview.sheet.submit')
                      : t('timeOverview.sheet.open')}
                  </PanelLink>
                </div>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
