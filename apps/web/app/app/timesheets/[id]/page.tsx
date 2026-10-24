'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, ClipboardList } from 'lucide-react';
import { Badge, Button, buttonVariants, Card, EmptyState, Skeleton, useToast } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { PageTitle, useSession } from '../../shell';
import { tone, WeekBody, type Timesheet } from '../week';

interface StoredTimesheet extends Timesheet {
  employeeId: string;
  employeeName: string;
  approvalRequestId: string | null;
}

/**
 * One person's timesheet for a week (ADR-0161): the days against the rota, overtime and findings; the
 * approver of a submitted week decides here.
 */
export default function TimesheetPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<StoredTimesheet>(`/v1/timesheets/${id}`);
  const mine = useApi<Array<{ id: string; payload: { timesheetId?: string } }>>('/v1/approvals?view=mine');
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const crumbs = [{ label: t('timesheets.title'), href: '/app/timesheets' }];
  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.timesheet.title') }]} />
        <EmptyState
          icon={<ClipboardList aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  // decided here by its approver; the request's page is linked for them and for the person who sent it
  const approval = (mine.data ?? []).find((a) => a.payload.timesheetId === data.id)?.id ?? null;
  const own = data.employeeId === session?.employeeId;
  const approvalLink = data.approvalRequestId && (approval || own) ? data.approvalRequestId : null;
  const week = t('rota.weekOf', { date: formatDate(data.weekStart, locale) });

  async function decide(decision: 'approve' | 'reject') {
    if (!approval) return;
    setBusy(decision);
    try {
      await api(`/v1/approvals/${approval}/decide`, {
        method: 'POST',
        json: { decision },
        capability: 'inbox.approvals.decide',
      });
      toast({ title: t('timesheets.decided'), tone: 'success' });
      reload();
      mine.reload();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="timesheet-detail">
      <Breadcrumbs items={[...crumbs, { label: `${data.employeeName} · ${week}` }]} />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">{week}</PageTitle>
            <p className="text-body">
              <PersonLink id={data.employeeId} name={data.employeeName} />
            </p>
            <div>
              <Badge tone={tone[data.status as keyof typeof tone] ?? 'neutral'}>
                {t(`timesheets.status.${data.status}`)}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {approval && data.status === 'submitted' ? (
              <>
                <Button loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}>
                  {t('common.approve')}
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === 'reject'}
                  disabled={!!busy}
                  onClick={() => decide('reject')}
                >
                  {t('common.reject')}
                </Button>
              </>
            ) : null}
            {approvalLink ? (
              <IntentLink
                href={`/app/approvals/${approvalLink}`}
                className={`${buttonVariants({ variant: 'secondary', size: 'md' })} no-underline`}
              >
                {t('actionable.common.seeApproval')}
                <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </IntentLink>
            ) : null}
          </div>
        </div>
        <WeekBody d={data} label={week} />
      </Card>
    </div>
  );
}
