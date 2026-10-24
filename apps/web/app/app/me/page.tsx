'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Bell,
  CalendarClock,
  CalendarDays,
  Clock,
  FileSignature,
  ListChecks,
  Receipt,
  UserRound,
} from 'lucide-react';
import { Badge, EmptyState, ListItem, ListSection, Skeleton } from '@thapsus/ui';
import { formatDate, formatInstantTime, formatTimeOfDay, numberFormat } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro } from '@/components/module-page';
import { useSession } from '../shell';

interface Summary {
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

/** A hub row (ADR-0180): the whole row is one link, with a short status line under the title. */
function Tile({
  href,
  icon,
  title,
  status,
  badge,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  status: string;
  badge?: React.ReactNode;
}) {
  return (
    <ListItem href={href} linkAs={Link} leading={icon} title={title} subtitle={status} accessory={badge} />
  );
}

/** Employee self-service hub ("Me"): one place for my details, leave, shifts, clock, documents, tasks, notifications and payslips. */
export default function MePage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data, error } = useApi<Summary>('/v1/me/summary');

  // The heading renders straight away (it is the largest paint on a phone); the tiles follow the summary.
  if (error || !data)
    return (
      <div className="flex flex-col gap-6">
        <PageIntro title={t('ess.title')} titleIsTab lead={t('ess.intro')} />
        {error ? (
          <EmptyState icon={<UserRound aria-hidden />} title={t('common.error')} />
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </div>
    );
  const count = (n: number) => numberFormat(locale).format(n);
  const leaveStatus = () => {
    const l = data.leave!;
    const parts: string[] = [];
    if (l.available !== null)
      parts.push(
        t(l.unit === 'hours' ? 'ess.leave.availableHours' : 'ess.leave.availableDays', {
          n: numberFormat(locale, { maximumFractionDigits: 2 }).format(Number(l.available)),
          count: Number(l.available),
        }),
      );
    if (l.next)
      parts.push(
        t('ess.leave.next', { from: formatDate(l.next.start, locale), to: formatDate(l.next.end, locale) }),
      );
    if (l.pending) parts.push(t('ess.leave.pending', { n: count(l.pending) }));
    return parts.join(' · ') || t('ess.leave.none');
  };
  // The summary gives a shift's start and end as local wall-clock timestamps ('YYYY-MM-DDTHH:MM').
  const timeOf = (local: string) =>
    formatTimeOfDay((local.includes('T') ? local.split('T')[1]! : local).slice(0, 5), locale);
  const shiftStatus = () => {
    const r = data.rota!;
    const s = r.nextShift;
    const parts = [
      s
        ? t('ess.rota.next', { date: formatDate(s.date, locale), start: timeOf(s.start), end: timeOf(s.end) })
        : t('ess.rota.none'),
    ];
    if (r.pendingSwaps) parts.push(t('ess.rota.swaps', { n: count(r.pendingSwaps) }));
    return parts.join(' · ');
  };
  const payslipStatus = () => {
    const p = data.payslips!;
    if (!p.latest) return t('ess.payslips.none');
    return p.latest.payDate
      ? t('ess.payslips.latestPaid', { label: p.latest.label, date: formatDate(p.latest.payDate, locale) })
      : t('ess.payslips.latest', { label: p.latest.label });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageIntro title={t('ess.title')} titleIsTab lead={t('ess.intro')}>
        <p className="text-callout text-text-secondary">
          {data.employee
            ? [data.employee.displayName, data.employee.jobTitle].filter(Boolean).join(' · ')
            : t('ess.noEmployee')}
        </p>
      </PageIntro>
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <ListSection title={t('ess.section.work')}>
          {data.employee ? (
            <Tile
              href="/app/me/details"
              icon={<UserRound />}
              title={t('ess.details.title')}
              status={
                data.changeRequests.pending
                  ? t('ess.details.pending', { n: count(data.changeRequests.pending) })
                  : t('ess.details.status')
              }
            />
          ) : null}
          {data.leave ? (
            <Tile
              href="/app/time-off"
              icon={<CalendarDays />}
              title={t('ess.leave.title')}
              status={leaveStatus()}
            />
          ) : null}
          {data.rota ? (
            <Tile
              href="/app/rota"
              icon={<CalendarClock />}
              title={t('ess.rota.title')}
              status={shiftStatus()}
            />
          ) : null}
          {data.clock ? (
            <Tile
              href="/app/clock"
              icon={<Clock />}
              title={t('ess.clock.title')}
              status={
                data.clock.clockedIn && data.clock.since
                  ? t('ess.clock.inSince', { time: formatInstantTime(data.clock.since, locale, zone) })
                  : t('ess.clock.out')
              }
              badge={data.clock.clockedIn ? <Badge tone="success">{t('ess.clock.in')}</Badge> : undefined}
            />
          ) : null}
        </ListSection>
        <ListSection title={t('ess.section.inbox')}>
          <Tile
            href="/app/documents"
            icon={<FileSignature />}
            title={t('ess.documents.title')}
            status={
              data.documents.toSign
                ? t('ess.documents.toSign', { n: count(data.documents.toSign) })
                : t('ess.documents.none')
            }
            badge={
              data.documents.toSign ? <Badge tone="warning">{count(data.documents.toSign)}</Badge> : undefined
            }
          />
          <Tile
            href="/app/tasks"
            icon={<ListChecks />}
            title={t('ess.tasks.title')}
            status={
              data.tasks.open
                ? t('ess.tasks.open', { n: count(data.tasks.open), overdue: count(data.tasks.overdue) })
                : t('ess.tasks.none')
            }
            badge={
              data.tasks.overdue ? (
                <Badge tone="danger">{t('ess.tasks.overdue', { n: count(data.tasks.overdue) })}</Badge>
              ) : undefined
            }
          />
          <Tile
            href="/app/notifications"
            icon={<Bell />}
            title={t('ess.notifications.title')}
            status={
              data.notifications.unread
                ? t('ess.notifications.unread', { n: count(data.notifications.unread) })
                : t('ess.notifications.none')
            }
            badge={
              data.notifications.unread ? (
                <Badge tone="accent">{count(data.notifications.unread)}</Badge>
              ) : undefined
            }
          />
          {data.payslips ? (
            <Tile
              href="/app/payslips"
              icon={<Receipt />}
              title={t('ess.payslips.title')}
              status={payslipStatus()}
              badge={
                data.payslips.unviewed ? (
                  <Badge tone="accent">{t('ess.payslips.new', { n: count(data.payslips.unviewed) })}</Badge>
                ) : undefined
              }
            />
          ) : null}
        </ListSection>
      </div>
    </div>
  );
}
