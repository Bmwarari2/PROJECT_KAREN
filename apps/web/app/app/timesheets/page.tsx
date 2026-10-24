'use client';
import * as React from 'react';
import { ChevronLeft, ChevronRight, ClipboardList, Download, Send } from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { addDays } from '@thapsus/core/time';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { thisWeek, viewerZone } from '@/lib/week';
import { PageIntro } from '@/components/module-page';
import { EntityLink, PersonLink } from '@/components/person-link';
import { Hours, tone, WeekBody, type Timesheet } from './week';
import { hasPermission, useSession } from '../shell';

interface TeamRow {
  id: string;
  employeeId: string;
  employeeName: string;
  status: string;
  workedMinutes: number;
  overtimeMinutes: number;
  doubleMinutes: number;
  violations: number;
  approvalRequestId: string | null;
}

function MyWeek({ employeeId, week, onChange }: { employeeId: string; week: string; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const ts = useApi<Timesheet>(`/v1/timesheets/employees/${employeeId}/weeks/${week}`);
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api(`/v1/timesheets/employees/${employeeId}/weeks/${week}/submit`, { method: 'POST' });
      toast({ title: t('timesheets.submitted'), tone: 'success' });
      ts.reload();
      onChange();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }
  if (!ts.data) return <Skeleton className="h-64 w-full" />;
  const d = ts.data;
  return (
    <Card className="flex flex-col gap-4" data-testid="my-timesheet">
      <div className="flex flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">{t('timesheets.mine')}</CardTitle>
        <Badge tone={tone[d.status as keyof typeof tone] ?? 'neutral'}>
          {t(`timesheets.status.${d.status}`)}
        </Badge>
        {['open', 'rejected'].includes(d.status) ? (
          <Button size="sm" onClick={submit} loading={busy}>
            <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('timesheets.submit')}
          </Button>
        ) : null}
      </div>
      <WeekBody d={d} label={t('timesheets.mine')} />
    </Card>
  );
}

function TeamWeek({ week }: { week: string }) {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const list = useApi<{ data: TeamRow[] }>(`/v1/timesheets?weekStart=${week}&limit=200`);
  const mine = useApi<Array<{ id: string; payload: { timesheetId?: string } }>>('/v1/approvals?view=mine');
  const approvable = new Map(
    (mine.data ?? []).filter((a) => a.payload.timesheetId).map((a) => [a.payload.timesheetId!, a.id]),
  );
  const canExport = hasPermission(session, 'time.export');
  async function decide(approvalId: string, decision: 'approve' | 'reject') {
    try {
      await api(`/v1/approvals/${approvalId}/decide`, { method: 'POST', json: { decision } });
      toast({ title: t('timesheets.decided'), tone: 'success' });
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    }
    list.reload();
    mine.reload();
  }
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">{t('timesheets.team')}</CardTitle>
        {canExport ? (
          <a
            href={`/v1/timesheets/export?weekStart=${week}`}
            download
            className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} no-underline`}
          >
            <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('timesheets.export')}
          </a>
        ) : null}
      </div>
      {!list.data ? (
        <Skeleton className="h-32" />
      ) : list.data.data.length ? (
        <Table dense scrollLabel={t('timesheets.team')}>
          <THead>
            <tr>
              <TH>{t('timesheets.person')}</TH>
              <TH>{t('common.status')}</TH>
              <TH className="text-right">{t('timesheets.worked')}</TH>
              <TH className="text-right">{t('timesheets.overtime')}</TH>
              <TH className="text-right">{t('timesheets.issues')}</TH>
              <TH>
                <span className="sr-only">{t('common.actions')}</span>
              </TH>
            </tr>
          </THead>
          <tbody>
            {list.data.data.map((r) => {
              const approval = approvable.get(r.id);
              return (
                <TR key={r.id}>
                  <TD>
                    <PersonLink id={r.employeeId} name={r.employeeName} />
                  </TD>
                  <TD>
                    <Badge tone={tone[r.status as keyof typeof tone] ?? 'neutral'}>
                      {t(`timesheets.status.${r.status}`)}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <Hours minutes={r.workedMinutes} />
                  </TD>
                  <TD className="text-right">
                    <Hours minutes={r.overtimeMinutes + r.doubleMinutes} />
                  </TD>
                  <TD className={`text-right ${r.violations ? 'text-warning' : ''}`}>{r.violations}</TD>
                  <TD className="text-right">
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <EntityLink
                        href={`/app/timesheets/${r.id}`}
                        className="inline-flex min-h-8 items-center px-1"
                        aria-label={t('actionable.timesheet.viewFor', { name: r.employeeName })}
                      >
                        {t('actionable.common.view')}
                      </EntityLink>
                      {approval && r.status === 'submitted' ? (
                        <span className="inline-flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => decide(approval, 'approve')}
                            aria-label={t('timesheets.approveFor', { name: r.employeeName })}
                          >
                            {t('common.approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => decide(approval, 'reject')}
                            aria-label={t('timesheets.rejectFor', { name: r.employeeName })}
                          >
                            {t('common.reject')}
                          </Button>
                        </span>
                      ) : null}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <p className="text-callout text-text-secondary">{t('timesheets.teamEmpty')}</p>
      )}
    </Card>
  );
}

export default function TimesheetsPage() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const settings = useApi<{ workweekStartsOn: number }>('/v1/settings/time');
  const [week, setWeek] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    // default to last week: the one people usually submit
    if (settings.data && !week) setWeek(addDays(thisWeek(zone, settings.data.workweekStartsOn), -7));
  }, [settings.data, week, zone]);
  if (!session) return null;
  const canTeam = hasPermission(session, 'time.read');
  return (
    <div className="flex flex-col gap-5">
      <PageIntro
        title={t('timesheets.title')}
        titleIsTab
        lead={t('timesheets.lead')}
        actions={
          week ? (
            <div className="flex items-center gap-2" role="group" aria-label={t('rota.weekNav')}>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('rota.prevWeek')}
                onClick={() => setWeek(addDays(week, -7))}
              >
                <ChevronLeft aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Button>
              <span className="text-callout font-semibold" aria-live="polite">
                {t('rota.weekOf', { date: formatDate(week, locale) })}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('rota.nextWeek')}
                onClick={() => setWeek(addDays(week, 7))}
              >
                <ChevronRight aria-hidden className="h-5 w-5 stroke-[1.5]" />
              </Button>
            </div>
          ) : null
        }
      />
      {!week ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {session.employeeId ? (
            <MyWeek
              key={week}
              employeeId={session.employeeId}
              week={week}
              onChange={() => setVersion((v) => v + 1)}
            />
          ) : !canTeam ? (
            <EmptyState icon={<ClipboardList aria-hidden />} title={t('clock.noEmployee')} />
          ) : null}
          {canTeam ? <TeamWeek key={`team-${week}-${version}`} week={week} /> : null}
        </>
      )}
    </div>
  );
}
