'use client';
import * as React from 'react';
import { PartyPopper } from 'lucide-react';
import { Badge, Skeleton } from '@thapsus/ui';
import { compareDates } from '@thapsus/core/time';
import { numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { outOn, type CalendarEntry, type LeaveCalendar } from '@/lib/dashboard-data';
import { formatDayRange } from './me-tiles';
import { Avatar, Panel, PanelLink, type HeadingLevel } from './parts';
import { PersonLink } from '@/components/person-link';

/**
 * Who is off today and later this week, from the leave calendar (the API decides whose leave the
 * viewer may see and shows sensitive kinds as "away"), plus this week's public holidays.
 */
export function WhosOut({
  calendar,
  today,
  level,
  max = 6,
  link,
  className,
}: {
  calendar: LeaveCalendar | undefined;
  today: string;
  level: HeadingLevel;
  max?: number;
  link?: { href: string; label: string };
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const kind = (k: string) => {
    const key = `timeOff.kind.${k}`;
    return t(key) === key ? t('timeOff.kind.away') : t(key);
  };
  const body = () => {
    if (!calendar) return <Skeleton className="h-40 w-full" />;
    const now = outOn(calendar.entries, today);
    const nowIds = new Set(now.map((e) => e.employeeId));
    const later = calendar.entries
      .filter((e) => compareDates(e.start, today) > 0 && !nowIds.has(e.employeeId))
      .sort((a, b) => compareDates(a.start, b.start));
    const holidays = calendar.holidays.filter((h) => compareDates(h.date, today) >= 0);
    if (!now.length && !later.length && !holidays.length)
      return (
        <p className="flex items-center gap-2 text-callout text-text-secondary">
          <PartyPopper aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5]" />
          {t('dashboard.out.nobody')}
        </p>
      );
    const group = (title: string, entries: CalendarEntry[], testId: string) => {
      if (!entries.length) return null;
      const shown = entries.slice(0, max);
      return (
        <div className="flex flex-col gap-2" data-testid={testId}>
          <p className="text-footnote font-semibold text-text-secondary">{title}</p>
          <ul className="flex flex-col gap-3">
            {shown.map((e, i) => (
              <li key={`${e.employeeId}-${e.start}-${i}`} className="flex min-w-0 items-center gap-3">
                <Avatar name={e.name} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  {/* the person's time off on their profile, where the viewer may open it (ADR-0161) */}
                  <PersonLink
                    id={e.employeeId}
                    name={e.name}
                    tab="time-off"
                    className="truncate text-callout"
                    plainClassName="truncate text-callout font-semibold text-text"
                  />
                  <span className="text-footnote text-text-secondary">
                    {kind(e.kind)} · {formatDayRange(e.start, e.end, locale)}
                  </span>
                </span>
                {e.status === 'pending' ? <Badge tone="warning">{t('timeOff.status.pending')}</Badge> : null}
              </li>
            ))}
          </ul>
          {entries.length > shown.length ? (
            <p className="text-footnote text-text-secondary">
              {t('dashboard.out.more', {
                n: numberFormat(locale).format(entries.length - shown.length),
                count: entries.length - shown.length,
              })}
            </p>
          ) : null}
        </div>
      );
    };
    return (
      <div className="flex flex-col gap-5">
        {group(t('dashboard.out.today'), now, 'out-today')}
        {group(t('dashboard.out.later'), later, 'out-later')}
        {!now.length && !later.length ? (
          <p className="text-callout text-text-secondary">{t('dashboard.out.nobody')}</p>
        ) : null}
        {holidays.length ? (
          <ul className="flex flex-col gap-1 border-t border-border pt-4">
            {holidays.map((h) => (
              <li key={h.date} className="text-footnote text-text-secondary">
                <span className="font-semibold text-text">{formatDayRange(h.date, h.date, locale)}</span>{' '}
                {h.name ? t('dashboard.out.holiday', { name: h.name }) : t('dashboard.out.holidayUnnamed')}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };
  return (
    <Panel
      level={level}
      title={t('dashboard.out.title')}
      className={className}
      action={link ? <PanelLink href={link.href}>{link.label}</PanelLink> : undefined}
    >
      {body()}
    </Panel>
  );
}
