'use client';
import * as React from 'react';
import { CalendarPlus, Link2, Stethoscope } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDate, formatUnit } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro } from '@/components/module-page';
import { EntityLink, PersonLink } from '@/components/person-link';
import { useSession } from '../shell';

interface Balance {
  leaveType: string;
  policy: string;
  unit: 'days' | 'hours';
  entitlement: number;
  publicHolidays: number;
  taken: number;
  booked: number;
  pending: number;
  carriedOver: number;
  available: number;
  inWaitingPeriod: boolean;
}
interface LeaveType {
  id: string;
  key: string;
  name: Record<string, string>;
  category: string;
}
interface Req {
  id: string;
  employeeName: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  amountDays: number;
  status: string;
}

const statusTone = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;
const rtwTone = { due: 'warning', completed: 'success', not_required: 'neutral' } as const;

interface SicknessRecord {
  id: string;
  employeeId: string;
  employeeName: string | null;
  startDate: string;
  endDate: string | null;
  rtwStatus: string;
}

/** HR and managers record sickness for someone else; medical detail is never shown here. */
function SicknessCard() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const people = useApi<{ data: Array<{ id: string; displayName?: string }> }>(
    '/v1/employees?status=active&limit=200',
  );
  const recent = useApi<SicknessRecord[]>('/v1/sickness');
  const [form, setForm] = React.useState({ employeeId: '', startDate: '', endDate: '' });
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ fitNoteRequired: boolean }>('/v1/sickness', {
        method: 'POST',
        json: {
          employeeId: form.employeeId || people.data?.data[0]?.id,
          startDate: form.startDate,
          endDate: form.endDate || undefined,
        },
      });
      toast({
        title: t(r.fitNoteRequired ? 'timeOff.sickness.fitNoteRequired' : 'timeOff.sickness.recorded'),
        tone: 'success',
      });
      setForm({ ...form, startDate: '', endDate: '' });
      recent.reload();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>{t('timeOff.sickness.title')}</CardTitle>
      <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
        <Field id="sick-employee" label={t('timeOff.sickness.employee')}>
          {(p) => (
            <select
              {...p}
              required
              value={form.employeeId}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
              className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
            >
              {(people.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.displayName ?? x.id}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="sick-start" label={t('timeOff.sickness.firstDay')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              required
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          )}
        </Field>
        <Field id="sick-end" label={t('timeOff.sickness.lastDay')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              min={form.startDate || undefined}
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          )}
        </Field>
        <Button type="submit" loading={busy} disabled={!people.data?.data.length}>
          <Stethoscope aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('timeOff.sickness.submit')}
        </Button>
      </form>
      <h3 className="mt-5 text-callout font-semibold">{t('timeOff.sickness.recent')}</h3>
      {recent.data?.length ? (
        <ul className="mt-2 flex flex-col gap-2">
          {recent.data.slice(0, 10).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 text-callout">
              <PersonLink id={r.employeeId} name={r.employeeName} tab="time-off" />
              <span className="text-text-secondary">
                {formatDate(r.startDate, locale)} –{' '}
                {r.endDate ? formatDate(r.endDate, locale) : t('timeOff.sickness.ongoing')}
              </span>
              <Badge tone={rtwTone[r.rtwStatus as keyof typeof rtwTone] ?? 'neutral'}>
                {t(`timeOff.sickness.rtw.${r.rtwStatus}`)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-callout text-text-secondary">{t('timeOff.sickness.none')}</p>
      )}
    </Card>
  );
}

export default function TimeOffPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const employeeId = session?.employeeId;
  const canRecordSickness = !!session?.permissions.some(
    (p) => p === '*' || p === 'absence.*' || p === 'absence.record',
  );
  const balances = useApi<Balance[]>(employeeId ? `/v1/leave/balances/${employeeId}` : null);
  const types = useApi<LeaveType[]>('/v1/leave/types');
  const mine = useApi<Req[]>(employeeId ? `/v1/leave/requests?employeeId=${employeeId}` : null);
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const team = useApi<{
    entries: Array<{
      employeeId: string;
      name: string;
      start: string;
      end: string;
      kind: string;
      status: string;
    }>;
    holidays: Array<{ date: string; name: string }>;
  }>(`/v1/leave/calendar?from=${today}&to=${in30}`);
  const [form, setForm] = React.useState({ leaveTypeId: '', startDate: today, endDate: today, note: '' });
  const [busy, setBusy] = React.useState(false);
  const typeName = (key: string) => {
    const lt = types.data?.find((x) => x.key === key);
    return lt ? (lt.name[locale] ?? lt.name['en-GB'] ?? key) : t(`timeOff.kind.${key}`);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ status: string; amountDays: number }>('/v1/leave/requests', {
        method: 'POST',
        json: {
          ...form,
          leaveTypeId: form.leaveTypeId || types.data?.find((x) => x.key === 'annual')?.id,
          note: form.note || undefined,
        },
      });
      toast({
        title: t(r.status === 'approved' ? 'timeOff.bookedToast' : 'timeOff.requested', {
          amount: formatUnit(r.amountDays, 'day', locale),
        }),
        tone: 'success',
      });
      balances.reload();
      mine.reload();
      team.reload();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function subscribe() {
    const r = await api<{ url: string }>('/v1/leave/ics-tokens', { method: 'POST', json: { scope: 'me' } });
    await navigator.clipboard?.writeText(r.url).catch(() => undefined);
    toast({ title: t('timeOff.icsCopied') });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('timeOff.title')}
        titleIsTab
        actions={
          <Button size="sm" variant="secondary" onClick={subscribe}>
            <Link2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('timeOff.subscribe')}
          </Button>
        }
      />
      {!employeeId ? (
        <EmptyState title={t('timeOff.noEmployee')} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {balances.data ? (
              balances.data.map((b) => (
                <Card key={b.leaveType}>
                  <CardTitle>{typeName(b.leaveType)}</CardTitle>
                  <p className="mt-2 text-title-1 tabular-nums">{b.available}</p>
                  <p className="text-footnote text-text-secondary">
                    {t(b.unit === 'hours' ? 'timeOff.hoursAvailable' : 'timeOff.daysAvailable')}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-1 text-footnote text-text-secondary">
                    <dt>{t('timeOff.entitlement')}</dt>
                    <dd className="text-right tabular-nums">{b.entitlement}</dd>
                    {b.publicHolidays ? (
                      <>
                        <dt>{t('timeOff.publicHolidays')}</dt>
                        <dd className="text-right tabular-nums">−{b.publicHolidays}</dd>
                      </>
                    ) : null}
                    <dt>{t('timeOff.taken')}</dt>
                    <dd className="text-right tabular-nums">{b.taken}</dd>
                    <dt>{t('timeOff.booked')}</dt>
                    <dd className="text-right tabular-nums">{b.booked + b.pending}</dd>
                    {b.carriedOver ? (
                      <>
                        <dt>{t('timeOff.carriedOver')}</dt>
                        <dd className="text-right tabular-nums">{b.carriedOver}</dd>
                      </>
                    ) : null}
                  </dl>
                </Card>
              ))
            ) : (
              <Skeleton className="h-40" />
            )}
          </div>
          <Card>
            <CardTitle>{t('timeOff.request')}</CardTitle>
            <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-5 md:items-end">
              <Field id="type" label={t('timeOff.type')}>
                {(p) => (
                  <select
                    {...p}
                    value={form.leaveTypeId}
                    onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
                    className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
                  >
                    {(types.data ?? [])
                      .filter((x) => x.category !== 'sickness')
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name[locale] ?? x.name['en-GB']}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
              <Field id="start" label={t('timeOff.from')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    value={form.startDate}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        startDate: e.target.value,
                        endDate: e.target.value > form.endDate ? e.target.value : form.endDate,
                      })
                    }
                  />
                )}
              </Field>
              <Field id="end" label={t('timeOff.to')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    min={form.startDate}
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  />
                )}
              </Field>
              <Field id="note" label={t('timeOff.note')}>
                {(p) => (
                  <Input
                    {...p}
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" loading={busy}>
                <CalendarPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('timeOff.send')}
              </Button>
            </form>
          </Card>
          <Card>
            <CardTitle>{t('timeOff.mine')}</CardTitle>
            {mine.data?.length ? (
              <Table dense className="mt-3">
                <THead>
                  <tr>
                    <TH>{t('timeOff.type')}</TH>
                    <TH>{t('timeOff.dates')}</TH>
                    <TH className="text-right">{t('timeOff.days')}</TH>
                    <TH>{t('common.status')}</TH>
                    <TH>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {mine.data.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        <EntityLink href={`/app/time-off/${r.id}`}>{typeName(r.leaveType)}</EntityLink>
                      </TD>
                      <TD>
                        {formatDate(r.startDate, locale)} – {formatDate(r.endDate, locale)}
                      </TD>
                      <TD className="text-right">{r.amountDays}</TD>
                      <TD>
                        <Badge tone={statusTone[r.status as keyof typeof statusTone] ?? 'neutral'}>
                          {t(`timeOff.status.${r.status}`)}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        {(r.status === 'pending' || (r.status === 'approved' && r.startDate > today)) &&
                        r.leaveType !== 'sickness' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              await api(`/v1/leave/requests/${r.id}/cancel`, { method: 'POST' });
                              mine.reload();
                              balances.reload();
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="mt-2 text-callout text-text-secondary">{t('timeOff.none')}</p>
            )}
          </Card>
        </>
      )}
      {canRecordSickness ? <SicknessCard /> : null}
      <Card>
        <CardTitle>{t('timeOff.team')}</CardTitle>
        {team.data?.entries.length ? (
          <ul className="mt-3 flex flex-col gap-2">
            {team.data.entries.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-callout">
                <PersonLink id={e.employeeId} name={e.name} tab="time-off" />
                <Badge>{typeName(e.kind)}</Badge>
                <span className="text-text-secondary">
                  {formatDate(e.start, locale)} – {formatDate(e.end, locale)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('timeOff.teamNone')}</p>
        )}
        {team.data?.holidays.length ? (
          <p className="mt-3 text-footnote text-text-secondary">
            {t('timeOff.upcomingHolidays')}:{' '}
            {team.data.holidays.map((h) => `${formatDate(h.date, locale, 'short')} ${h.name}`).join(' · ')}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
