'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, CalendarDays } from 'lucide-react';
import { Badge, Button, buttonVariants, Card, EmptyState, Skeleton, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime, formatUnit } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/zone';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { PageTitle, useSession } from '../../shell';

interface LeaveRequestDetail {
  id: string;
  employeeId: string;
  employeeName: string | null;
  leaveType: string;
  leaveTypeName: Record<string, string> | null;
  startDate: string;
  endDate: string;
  startHalf: string | null;
  endHalf: string | null;
  amountDays: number;
  amountHours: number;
  status: string;
  note: string | null;
  requestedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  approvalRequestId: string | null;
  canCancel: boolean;
}

const statusTone = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

/** One leave request (ADR-0160): who, what kind, which days, its status and its approval. */
export default function LeaveRequestPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<LeaveRequestDetail>(`/v1/leave/requests/${id}`);
  const [busy, setBusy] = React.useState(false);
  const crumbs = [{ label: t('timeOff.title'), href: '/app/time-off' }];

  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.leave.title') }]} />
        <EmptyState
          icon={<CalendarDays aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const kind =
    data.leaveTypeName?.[locale] ?? data.leaveTypeName?.['en-GB'] ?? t(`timeOff.kind.${data.leaveType}`);
  const dates =
    data.startDate === data.endDate
      ? formatDate(data.startDate, locale)
      : `${formatDate(data.startDate, locale)} – ${formatDate(data.endDate, locale)}`;
  const half = (h: string | null) => (h ? t(`actionable.leave.half.${h}`) : null);
  const own = data.employeeId === session?.employeeId;

  async function cancel() {
    setBusy(true);
    try {
      await api(`/v1/leave/requests/${id}/cancel`, { method: 'POST' });
      toast({ title: t('actionable.leave.cancelled'), tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="leave-detail">
      <Breadcrumbs items={[...crumbs, { label: `${kind} · ${dates}` }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">{kind}</PageTitle>
            <p className="text-body text-text-secondary">{dates}</p>
            <div>
              <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? 'neutral'}>
                {t(`timeOff.status.${data.status}`)}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.approvalRequestId ? (
              <IntentLink
                href={`/app/approvals/${data.approvalRequestId}`}
                className={`${buttonVariants({ variant: 'secondary', size: 'md' })} no-underline`}
              >
                {t('actionable.common.seeApproval')}
                <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </IntentLink>
            ) : null}
            {data.canCancel ? (
              <Button variant="secondary" loading={busy} onClick={cancel}>
                {t('actionable.leave.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
        <DetailList
          items={[
            {
              key: 'person',
              label: t('actionable.common.person'),
              value: (
                <PersonLink
                  id={data.employeeId}
                  name={data.employeeName}
                  tab={own ? undefined : 'time-off'}
                />
              ),
            },
            {
              key: 'amount',
              label: t('actionable.leave.amount'),
              value: [
                formatUnit(data.amountDays, 'day', locale),
                data.amountHours ? formatUnit(data.amountHours, 'hour', locale) : null,
              ]
                .filter(Boolean)
                .join(' · '),
            },
            ...(half(data.startHalf) || half(data.endHalf)
              ? [
                  {
                    key: 'halves',
                    label: t('actionable.leave.halfDays'),
                    value: [half(data.startHalf), half(data.endHalf)].filter(Boolean).join(' · '),
                  },
                ]
              : []),
            {
              key: 'requested',
              label: t('actionable.leave.requested'),
              value: data.requestedByName
                ? t('actionable.leave.requestedBy', {
                    date: formatDateTime(data.createdAt, locale, zone),
                    name: data.requestedByName,
                  })
                : formatDateTime(data.createdAt, locale, zone),
            },
            ...(data.decidedAt
              ? [
                  {
                    key: 'decided',
                    label: t('actionable.leave.decided'),
                    value: formatDateTime(data.decidedAt, locale, zone),
                  },
                ]
              : []),
            ...(data.note ? [{ key: 'note', label: t('timeOff.note'), value: data.note }] : []),
          ]}
        />
      </Card>
    </div>
  );
}
