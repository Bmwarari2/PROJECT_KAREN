'use client';
import * as React from 'react';
import { CalendarClock, CalendarDays, Clock, Receipt } from 'lucide-react';
import { Badge } from '@thapsus/ui';
import { addDays } from '@thapsus/core/time';
import {
  dateTimeFormat,
  formatDate,
  formatInstantTime,
  formatTimeOfDay,
  numberFormat,
  type Locale,
} from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import type { MeSummary } from '@/lib/dashboard-data';
import { IconTile, PanelLink, type HeadingLevel } from './parts';

/** "Mon 3 Nov" or "Mon 3 – Wed 5 Nov": calendar dates, formatted in UTC so they never shift. */
export function formatDayRange(from: string, to: string, locale: Locale): string {
  const f = dateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const a = new Date(`${from}T00:00:00Z`);
  return from === to ? f.format(a) : f.formatRange(a, new Date(`${to}T00:00:00Z`));
}

/** One self-service tile: icon and title, a headline value, detail lines and one action. */
function Tile({
  level,
  icon,
  title,
  value,
  badge,
  children,
  action,
  testId,
}: {
  level: HeadingLevel;
  icon: React.ReactNode;
  title: string;
  value: React.ReactNode;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  action: React.ReactNode;
  testId?: string;
}) {
  const Heading = `h${level}` as const;
  return (
    <li
      data-testid={testId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-raised p-5"
    >
      <div className="flex items-center gap-3">
        <IconTile>{icon}</IconTile>
        <Heading className="min-w-0 flex-1 text-callout font-semibold text-text-secondary">{title}</Heading>
        {badge}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-title-3 text-text">{value}</p>
        {children}
      </div>
      <div className="mt-auto">{action}</div>
    </li>
  );
}

const Detail = ({ children, tone }: { children: React.ReactNode; tone?: 'warning' }) => (
  <p className={tone === 'warning' ? 'text-footnote text-warning' : 'text-footnote text-text-secondary'}>
    {children}
  </p>
);

/**
 * The viewer's own time off, next shift, clock status and latest payslip from GET /v1/me/summary.
 * A tile appears only when the summary has that part (it is null without the permission or record).
 */
function MeTilesImpl({
  summary,
  level,
  today,
  zone,
  parts = ['leave', 'rota', 'clock', 'payslips'],
  className = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4',
}: {
  summary: MeSummary;
  level: HeadingLevel;
  today: string;
  zone: string;
  parts?: Array<'leave' | 'rota' | 'clock' | 'payslips'>;
  /** The grid the tiles sit in. */
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const n = (v: number) => numberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  const tiles: React.ReactNode[] = [];

  if (parts.includes('leave') && summary.leave) {
    const l = summary.leave;
    const available = l.available === null ? null : Number(l.available);
    tiles.push(
      <Tile
        key="leave"
        testId="tile-leave"
        level={level}
        icon={<CalendarDays />}
        title={t('dashboard.you.timeOff')}
        value={
          available === null ? (
            t('dashboard.you.noBalance')
          ) : (
            <>
              {n(available)}{' '}
              <span className="text-callout font-normal text-text-secondary">
                {t(l.unit === 'hours' ? 'dashboard.you.hoursAvailable' : 'dashboard.you.daysAvailable', {
                  count: available,
                })}
              </span>
            </>
          )
        }
        action={<PanelLink href="/app/time-off">{t('dashboard.you.requestLeave')}</PanelLink>}
      >
        <Detail>
          {l.next
            ? t('dashboard.you.nextLeave', { dates: formatDayRange(l.next.start, l.next.end, locale) })
            : t('dashboard.you.noLeave')}
        </Detail>
        {l.pending ? (
          <Detail tone="warning">{t('dashboard.you.pending', { count: l.pending, n: n(l.pending) })}</Detail>
        ) : null}
      </Tile>,
    );
  }

  if (parts.includes('rota') && summary.rota) {
    const s = summary.rota.nextShift;
    // the summary gives a shift's start and end as local wall-clock timestamps ('YYYY-MM-DDTHH:MM')
    const time = (local: string) =>
      formatTimeOfDay((local.includes('T') ? local.split('T')[1]! : local).slice(0, 5), locale);
    const day = (d: string) =>
      d === today
        ? t('dashboard.you.today')
        : d === addDays(today, 1)
          ? t('dashboard.you.tomorrow')
          : formatDayRange(d, d, locale);
    tiles.push(
      <Tile
        key="rota"
        testId="tile-shift"
        level={level}
        icon={<CalendarClock />}
        title={t('dashboard.you.shift')}
        value={s ? day(s.date) : t('dashboard.you.noShift')}
        action={<PanelLink href="/app/rota">{t('dashboard.you.openRota')}</PanelLink>}
      >
        {s ? (
          <Detail>{t('dashboard.you.shiftTime', { start: time(s.start), end: time(s.end) })}</Detail>
        ) : null}
      </Tile>,
    );
  }

  if (parts.includes('clock') && summary.clock) {
    const c = summary.clock;
    tiles.push(
      <Tile
        key="clock"
        testId="tile-clock"
        level={level}
        icon={<Clock />}
        title={t('dashboard.you.clock')}
        value={c.clockedIn ? t('dashboard.you.clockedIn') : t('dashboard.you.clockedOut')}
        badge={c.clockedIn ? <Badge tone="success">{t('dashboard.you.onShift')}</Badge> : undefined}
        action={
          <PanelLink href="/app/clock">
            {c.clockedIn ? t('dashboard.you.clockOut') : t('dashboard.you.clockIn')}
          </PanelLink>
        }
      >
        {c.clockedIn && c.since ? (
          <Detail>{t('dashboard.you.since', { time: formatInstantTime(c.since, locale, zone) })}</Detail>
        ) : null}
      </Tile>,
    );
  }

  if (parts.includes('payslips') && summary.payslips) {
    const p = summary.payslips;
    tiles.push(
      <Tile
        key="payslips"
        testId="tile-payslip"
        level={level}
        icon={<Receipt />}
        title={t('dashboard.you.payslip')}
        value={p.latest ? p.latest.label : t('dashboard.you.noPayslip')}
        badge={p.unviewed ? <Badge tone="accent">{t('dashboard.you.new')}</Badge> : undefined}
        action={<PanelLink href="/app/payslips">{t('dashboard.you.viewPayslips')}</PanelLink>}
      >
        {p.latest?.payDate ? (
          <Detail>{t('dashboard.you.paidOn', { date: formatDate(p.latest.payDate, locale) })}</Detail>
        ) : null}
      </Tile>,
    );
  }

  if (!tiles.length) return null;
  return <ul className={className}>{tiles}</ul>;
}

/** Re-renders only when its own props change (the page around it re-renders as each request lands). */
export const MeTiles = React.memo(MeTilesImpl);
