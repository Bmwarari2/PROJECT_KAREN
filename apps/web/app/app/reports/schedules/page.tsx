'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, Plus, Trash2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TableToolbar,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatTimeOfDay } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { PageTitle, useSession } from '../../shell';
import { NoReportsAccess, problemText, selectClass, weekdayName, zones } from '../ui';

interface Schedule {
  id: string;
  savedReportId: string;
  savedReportName: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  timeOfDay: string;
  weekday: number | null;
  dayOfMonth: number | null;
  timeZone: string;
  format: string;
  recipientUserIds: string[];
  enabled: boolean;
  lastPeriodKey: string | null;
}
interface Saved {
  id: string;
  name: string;
  mine: boolean;
}
interface Person {
  id: string;
  displayName: string;
}

/** Recipient picker: search active users who may use reports; selected people shown as removable chips. */
function RecipientPicker({ value, onChange }: { value: Person[]; onChange: (v: Person[]) => void }) {
  const t = useT();
  const [q, setQ] = React.useState('');
  const dq = useDebounced(q.trim());
  const found = useApi<Person[]>(`/v1/reports/recipients${dq ? `?q=${encodeURIComponent(dq)}` : ''}`);
  const options = (found.data ?? []).filter((p) => !value.some((v) => v.id === p.id));
  return (
    <div className="flex flex-col gap-2">
      <Field
        id="rcpt-q"
        label={t('reports.schedules.recipients')}
        hint={t('reports.schedules.recipientsHint')}
      >
        {(a) => <Input {...a} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
      </Field>
      {value.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('reports.schedules.selected')}>
          {value.map((p) => (
            <li key={p.id}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onChange(value.filter((v) => v.id !== p.id))}
                aria-label={t('reports.schedules.removeRecipient', { name: p.displayName })}
              >
                {p.displayName}
                <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ul
        className="flex max-h-40 flex-col overflow-auto rounded-sm border border-border"
        aria-label={t('reports.schedules.matches')}
      >
        {options.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-callout hover:bg-surface"
              onClick={() => onChange([...value, p])}
            >
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {p.displayName}
            </button>
          </li>
        ))}
        {!options.length ? (
          <li className="px-3 py-2 text-footnote text-text-secondary">{t('reports.schedules.noMatches')}</li>
        ) : null}
      </ul>
    </div>
  );
}

export default function SchedulesPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedules = useApi<Schedule[]>('/v1/reports/schedules');
  const saved = useApi<Saved[]>('/v1/reports/saved');
  const [open, setOpen] = React.useState(false);
  const blank = {
    savedReportId: '',
    frequency: 'weekly' as Schedule['frequency'],
    timeOfDay: '07:00',
    weekday: 1,
    dayOfMonth: 1,
    timeZone: zone,
    format: 'pdf',
    recipients: [] as Person[],
  };
  const [form, setForm] = React.useState(blank);
  const tzList = React.useMemo(zones, []);
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<'all' | 'on' | 'off'>('all');
  // "Schedule" in the builder or on a ready-made report opens the form for that saved report
  const preselect = useSearchParams().get('report');
  const [preselected, setPreselected] = React.useState(false);
  React.useEffect(() => {
    if (preselected || !preselect || !saved.data) return;
    setPreselected(true);
    if (saved.data.some((r) => r.id === preselect)) {
      setForm((f) => ({ ...f, savedReportId: preselect }));
      setOpen(true);
    }
  }, [preselect, preselected, saved.data]);

  if (schedules.error) return <NoReportsAccess />;
  if (!schedules.data) return <Skeleton className="h-64 w-full" />;
  const q = query.trim().toLocaleLowerCase();
  const rows = schedules.data
    .filter((s) => status === 'all' || (status === 'on' ? s.enabled : !s.enabled))
    .filter((s) => !q || s.savedReportName.toLocaleLowerCase().includes(q));

  const when = (s: Pick<Schedule, 'frequency' | 'timeOfDay' | 'weekday' | 'dayOfMonth' | 'timeZone'>) => {
    const time = formatTimeOfDay(s.timeOfDay, locale);
    if (s.frequency === 'daily') return t('reports.schedules.whenDaily', { time, zone: s.timeZone });
    if (s.frequency === 'weekly')
      return t('reports.schedules.whenWeekly', {
        day: weekdayName(locale, s.weekday ?? 1),
        time,
        zone: s.timeZone,
      });
    return t('reports.schedules.whenMonthly', { day: s.dayOfMonth ?? 1, time, zone: s.timeZone });
  };

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/v1/reports/schedules', {
        method: 'POST',
        json: {
          savedReportId: form.savedReportId,
          frequency: form.frequency,
          timeOfDay: form.timeOfDay,
          ...(form.frequency === 'weekly' ? { weekday: form.weekday } : {}),
          ...(form.frequency === 'monthly' ? { dayOfMonth: form.dayOfMonth } : {}),
          timeZone: form.timeZone,
          format: form.format,
          recipientUserIds: form.recipients.map((r) => r.id),
        },
        capability: 'reports.schedules',
      });
      toast({ title: t('reports.schedules.created'), tone: 'success' });
      setOpen(false);
      setForm(blank);
      await schedules.reload();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }
  async function toggle(s: Schedule) {
    try {
      await api(`/v1/reports/schedules/${s.id}`, {
        method: 'PATCH',
        json: { enabled: !s.enabled },
        capability: 'reports.schedules',
      });
      await schedules.reload();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }
  async function remove(s: Schedule) {
    try {
      await api(`/v1/reports/schedules/${s.id}`, { method: 'DELETE', capability: 'reports.schedules' });
      toast({ title: t('reports.schedules.deleted'), tone: 'success' });
      await schedules.reload();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="mr-auto min-w-0">
          <PageTitle>{t('reports.schedules.title')}</PageTitle>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
            {t('reports.schedules.intro')}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!saved.data?.length}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('reports.schedules.new')}
            </Button>
          </DialogTrigger>
          <DialogContent
            title={t('reports.schedules.new')}
            description={t('reports.schedules.newBody')}
            closeLabel={t('common.close')}
          >
            <form onSubmit={create} className="flex flex-col gap-4">
              <Field id="s-report" label={t('reports.schedules.report')}>
                {(a) => (
                  <select
                    {...a}
                    required
                    className={selectClass}
                    value={form.savedReportId}
                    onChange={(e) => setForm({ ...form, savedReportId: e.target.value })}
                  >
                    <option value="" />
                    {(saved.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="s-frequency" label={t('reports.schedules.frequency')}>
                  {(a) => (
                    <select
                      {...a}
                      className={selectClass}
                      value={form.frequency}
                      onChange={(e) =>
                        setForm({ ...form, frequency: e.target.value as Schedule['frequency'] })
                      }
                    >
                      {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                        <option key={f} value={f}>
                          {t(`reports.schedules.freq.${f}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {form.frequency === 'weekly' ? (
                  <Field id="s-weekday" label={t('reports.schedules.weekday')}>
                    {(a) => (
                      <select
                        {...a}
                        className={selectClass}
                        value={form.weekday}
                        onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                          <option key={w} value={w}>
                            {weekdayName(locale, w)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                ) : form.frequency === 'monthly' ? (
                  <Field
                    id="s-dom"
                    label={t('reports.schedules.dayOfMonth')}
                    hint={t('reports.schedules.dayOfMonthHint')}
                  >
                    {(a) => (
                      <Input
                        {...a}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={28}
                        value={form.dayOfMonth}
                        onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}
                      />
                    )}
                  </Field>
                ) : (
                  <span />
                )}
                <Field id="s-time" label={t('reports.schedules.time')}>
                  {(a) => (
                    <Input
                      {...a}
                      type="time"
                      required
                      value={form.timeOfDay}
                      onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}
                    />
                  )}
                </Field>
                <Field id="s-zone" label={t('reports.schedules.timeZone')}>
                  {(a) => (
                    <>
                      <Input
                        {...a}
                        required
                        list="s-zones"
                        value={form.timeZone}
                        onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
                      />
                      <datalist id="s-zones">
                        {tzList.map((z) => (
                          <option key={z} value={z} />
                        ))}
                      </datalist>
                    </>
                  )}
                </Field>
                <Field id="s-format" label={t('reports.schedules.format')}>
                  {(a) => (
                    <select
                      {...a}
                      className={selectClass}
                      value={form.format}
                      onChange={(e) => setForm({ ...form, format: e.target.value })}
                    >
                      {['pdf', 'xlsx', 'csv'].map((f) => (
                        <option key={f} value={f}>
                          {t(`reports.format.${f}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <RecipientPicker
                value={form.recipients}
                onChange={(recipients) => setForm({ ...form, recipients })}
              />
              <p className="text-footnote text-text-secondary">{t('reports.schedules.privacy')}</p>
              <Button type="submit" disabled={!form.recipients.length || !form.savedReportId}>
                {t('common.save')}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {schedules.data.length ? (
        <Card className="overflow-hidden p-0">
          <TableToolbar
            count={t('reports.ui.scheduleCount', { count: rows.length })}
            search={
              <Input
                type="search"
                aria-label={t('reports.ui.searchSchedules')}
                placeholder={t('reports.ui.searchSchedules')}
                className="h-10 w-full sm:w-56"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            }
            filters={
              <select
                aria-label={t('reports.ui.statusFilter.label')}
                className={cn(selectClass, 'w-auto')}
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="all">{t('reports.ui.statusFilter.all')}</option>
                <option value="on">{t('reports.schedules.on')}</option>
                <option value="off">{t('reports.schedules.off')}</option>
              </select>
            }
          />
          {rows.length ? (
            <Table scrollLabel={t('reports.schedules.title')}>
              <caption className="sr-only">{t('reports.schedules.title')}</caption>
              <THead>
                <tr>
                  <TH>{t('reports.schedules.report')}</TH>
                  <TH>{t('reports.schedules.when')}</TH>
                  <TH>{t('reports.schedules.format')}</TH>
                  <TH className="text-right">{t('reports.schedules.recipients')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((s) => (
                  <TR key={s.id}>
                    <TD>{s.savedReportName}</TD>
                    <TD label={t('reports.schedules.when')}>{when(s)}</TD>
                    <TD phone="inline" label={t('reports.schedules.format')}>
                      {t(`reports.format.${s.format}`)}
                    </TD>
                    <TD className="text-right tabular-nums" label={t('reports.schedules.recipients')}>
                      {s.recipientUserIds.length}
                    </TD>
                    <TD>
                      <Badge tone={s.enabled ? 'success' : 'neutral'}>
                        {t(s.enabled ? 'reports.schedules.on' : 'reports.schedules.off')}
                      </Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => toggle(s)}>
                        {t(s.enabled ? 'reports.schedules.pause' : 'reports.schedules.resume')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(s)}
                        aria-label={t('reports.schedules.deleteNamed', { name: s.savedReportName })}
                      >
                        <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <p role="status" className="px-5 py-6 text-callout text-text-secondary">
              {t('reports.ui.noScheduleMatches')}
            </p>
          )}
        </Card>
      ) : (
        <EmptyState
          icon={<CalendarClock aria-hidden />}
          title={t('reports.schedules.empty')}
          body={t(saved.data?.length ? 'reports.schedules.emptyBody' : 'reports.schedules.needSaved')}
        />
      )}
    </div>
  );
}
