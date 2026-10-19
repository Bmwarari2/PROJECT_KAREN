'use client';
import * as React from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Hand, LayoutTemplate, Plus, Repeat, Save, Send } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Dialog, DialogContent, EmptyState, Field, Input, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useToast } from '@thapsus/ui';
import { addDays, dayOfWeek } from '@thapsus/core/time';
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { dayLong, thisWeek, viewerZone, weekDays, weekStartOf } from '@/lib/week';
import { FindingList, type FindingDto } from '@/components/findings';
import { hasPermission, useSession } from '../shell';
import { RotaGrid, shiftRange, type GridRowDto, type ShiftDto } from './rota-grid';

const PAGE = 200;
const fieldSelect = 'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : fallback;
}

/** Week navigation shared by both views. */
function WeekNav({ week, setWeek, zone, startsOn }: { week: string; setWeek: (w: string) => void; zone: string; startsOn: number }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('rota.weekNav')}>
      <Button size="icon" variant="ghost" aria-label={t('rota.prevWeek')} onClick={() => setWeek(addDays(week, -7))}>
        <ChevronLeft aria-hidden className="h-5 w-5 stroke-[1.5]" />
      </Button>
      <span className="min-w-[12ch] text-callout font-semibold" aria-live="polite">
        {t('rota.weekOf', { date: formatDate(week, locale) })}
      </span>
      <Button size="icon" variant="ghost" aria-label={t('rota.nextWeek')} onClick={() => setWeek(addDays(week, 7))}>
        <ChevronRight aria-hidden className="h-5 w-5 stroke-[1.5]" />
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setWeek(thisWeek(zone, startsOn))}>
        {t('rota.thisWeek')}
      </Button>
    </div>
  );
}

interface Draft {
  id?: string;
  employeeId: string | null;
  name?: string;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  notes: string;
}

function ShiftDialog({ draft, onClose, onSaved, locationId, zone }: { draft: Draft | null; onClose: () => void; onSaved: () => void; locationId: string; zone: string }) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = React.useState<Draft | null>(draft);
  const [blocked, setBlocked] = React.useState<FindingDto[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setForm(draft);
    setBlocked([]);
  }, [draft]);
  if (!form) return null;
  const set = (p: Partial<Draft>) => setForm({ ...form, ...p });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setBlocked([]);
    try {
      const body = { date: form.date, start: form.start, end: form.end, breakMinutes: form.breakMinutes, notes: form.notes || null };
      const r = form.id
        ? await api<{ warnings: FindingDto[] }>(`/v1/shifts/${form.id}`, { method: 'PATCH', json: body })
        : await api<{ warnings: FindingDto[] }>('/v1/shifts', { method: 'POST', json: { ...body, employeeId: form.employeeId, ...(form.employeeId ? {} : locationId ? { locationId } : { zone }) } });
      toast({ title: t('rota.saved'), body: r.warnings.length ? r.warnings.map((w) => t(`time.rule.${w.rule}`)).join(' · ') : undefined, tone: r.warnings.length ? 'neutral' : 'success' });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 422 && Array.isArray(err.body.violations)) setBlocked(err.body.violations as FindingDto[]);
      else toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function cancelShift() {
    if (!form?.id) return;
    setBusy(true);
    try {
      await api(`/v1/shifts/${form.id}/cancel`, { method: 'POST' });
      onSaved();
      onClose();
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={form.id ? t('rota.editShift') : t('rota.addShift')} description={form.employeeId ? form.name : t('rota.openShift')} closeLabel={t('common.close')}>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Field id="shift-date" label={t('rota.date')}>{(p) => <Input {...p} type="date" required value={form.date} onChange={(e) => set({ date: e.target.value })} />}</Field>
          <Field id="shift-break" label={t('rota.break')}>{(p) => <Input {...p} type="number" min={0} max={480} inputMode="numeric" value={form.breakMinutes} onChange={(e) => set({ breakMinutes: Number(e.target.value) })} />}</Field>
          <Field id="shift-start" label={t('rota.start')}>{(p) => <Input {...p} type="time" required value={form.start} onChange={(e) => set({ start: e.target.value })} />}</Field>
          <Field id="shift-end" label={t('rota.end')} hint={t('rota.overnightHint')}>{(p) => <Input {...p} type="time" required value={form.end} onChange={(e) => set({ end: e.target.value })} />}</Field>
          <Field id="shift-notes" label={t('rota.notes')} className="sm:col-span-2">{(p) => <Input {...p} maxLength={500} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />}</Field>
          {blocked.length ? (
            <div role="alert" className="rounded-md bg-surface p-3 sm:col-span-2">
              <p className="mb-2 text-callout font-semibold text-danger">{t('rota.blocked')}</p>
              <FindingList findings={blocked} tone="danger" />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
            {form.id ? (
              <Button type="button" variant="ghost" onClick={cancelShift} disabled={busy}>
                {t('rota.cancelShift')}
              </Button>
            ) : null}
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Template {
  id: string;
  name: string;
  slots: unknown[];
}

function TeamRota({ week, zone }: { week: string; zone: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const canEdit = hasPermission(session, 'rota.manage');
  const locations = useApi<Array<{ id: string; name: string }>>('/v1/org/locations');
  const templates = useApi<Template[]>('/v1/rota/templates');
  const [locationId, setLocationId] = React.useState('');
  const [q, setQ] = React.useState('');
  const query = useDebounced(q, 300);
  const [rows, setRows] = React.useState<Array<GridRowDto | undefined>>([]);
  const [days, setDays] = React.useState<string[]>(weekDays(week));
  const [open, setOpen] = React.useState<ShiftDto[]>([]);
  const [total, setTotal] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const state = React.useRef({ gen: 0, cursor: null as string | null, loaded: 0, loading: false, done: false });
  /** Last row index in view; pages keep loading (keyset, in order) until the window is covered. */
  const wanted = React.useRef(0);
  const loadRef = React.useRef<() => Promise<void>>(async () => undefined);

  const filters = `weekStart=${week}${locationId ? `&locationId=${locationId}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const loadPage = React.useCallback(async () => {
    const s = state.current;
    if (s.loading || s.done) return;
    s.loading = true;
    const gen = s.gen;
    try {
      const page = await api<{ days: string[]; total: number | null; rows: GridRowDto[]; openShifts: ShiftDto[]; nextCursor: string | null }>(`/v1/rota?${filters}&limit=${PAGE}${s.cursor ? `&cursor=${s.cursor}` : ''}`);
      if (gen !== state.current.gen) return;
      if (page.total !== null) {
        setTotal(page.total);
        setOpen(page.openShifts);
        setDays(page.days);
      }
      const offset = s.loaded;
      setRows((prev) => {
        const next = prev.length ? [...prev] : new Array<GridRowDto | undefined>(page.total ?? page.rows.length);
        page.rows.forEach((r, i) => (next[offset + i] = r));
        return next;
      });
      s.loaded += page.rows.length;
      s.cursor = page.nextCursor;
      s.done = !page.nextCursor;
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    } finally {
      if (gen === state.current.gen) {
        s.loading = false;
        if (!s.done && wanted.current > s.loaded - PAGE / 2) void loadRef.current();
      }
    }
  }, [filters, t, toast]);
  loadRef.current = loadPage;

  const reset = React.useCallback(() => {
    state.current = { gen: state.current.gen + 1, cursor: null, loaded: 0, loading: false, done: false };
    wanted.current = 0;
    setRows([]);
    setTotal(null);
    void loadPage();
  }, [loadPage]);
  React.useEffect(() => reset(), [reset]);

  // fetch the next keyset page when the window nears the end of what is loaded
  const onRangeEnd = React.useCallback(
    (end: number) => {
      wanted.current = end;
      if (end > state.current.loaded - PAGE / 2) void loadPage();
    },
    [loadPage],
  );

  const onAdd = React.useCallback((employeeId: string | null, date: string, name?: string) => setDraft({ employeeId, name, date, start: '09:00', end: '17:00', breakMinutes: 30, notes: '' }), []);
  const onOpen = React.useCallback((s: ShiftDto) => setDraft({ id: s.id, employeeId: s.employeeId, name: s.employeeName ?? undefined, date: s.date, start: s.start, end: s.end, breakMinutes: s.breakMinutes, notes: s.notes ?? '' }), []);

  async function publish() {
    setBusy(true);
    try {
      const r = await api<{ published: number; notified: number }>('/v1/rota/publish', { method: 'POST', json: { from: days[0], to: days[6], ...(locationId ? { locationId } : {}) } });
      toast({ title: t('rota.publishedToast', { count: r.published, notified: r.notified }), tone: 'success' });
      reset();
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function applyTemplate(id: string) {
    try {
      const r = await api<{ created: number; openedInstead: unknown[] }>(`/v1/rota/templates/${id}/apply`, { method: 'POST', json: { weekStart: days[0] } });
      toast({ title: t('rota.appliedToast', { count: r.created }), body: r.openedInstead.length ? t('rota.openedInstead', { count: r.openedInstead.length }) : undefined, tone: 'success' });
      setTemplateOpen(false);
      reset();
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    }
  }
  async function saveAsTemplate() {
    const loaded = rows.filter((r): r is GridRowDto => !!r);
    const slots = [
      ...loaded.flatMap((r) => r.shifts.map((s) => ({ weekday: dayOfWeek(s.date), start: s.start, end: s.end, breakMinutes: s.breakMinutes, employeeId: r.employeeId }))),
      ...open.map((s) => ({ weekday: dayOfWeek(s.date), start: s.start, end: s.end, breakMinutes: s.breakMinutes })),
    ];
    if (!slots.length) {
      toast({ title: t('rota.nothingToSave') });
      return;
    }
    try {
      await api('/v1/rota/templates', { method: 'POST', json: { name: t('rota.templateName', { date: formatDate(days[0]!, locale) }), locationId: locationId || null, slots: slots.slice(0, 500) } });
      toast({ title: t('rota.templateSaved'), tone: 'success' });
      templates.reload();
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="rota-location" label={t('rota.location')} className="w-full sm:w-56">
          {(p) => (
            <select {...p} className={fieldSelect} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">{t('rota.allLocations')}</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="rota-search" label={t('rota.search')} className="w-full sm:w-56">
          {(p) => <Input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <span className="text-footnote text-text-secondary sm:mr-auto" aria-live="polite">
          {total === null ? t('common.loading') : t('rota.peopleCount', { count: formatNumber(total, locale) })}
        </span>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDraft({ employeeId: null, date: days[0]!, start: '09:00', end: '17:00', breakMinutes: 30, notes: '' })}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('rota.addOpen')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setTemplateOpen(true)}>
              <LayoutTemplate aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('rota.applyTemplate')}
            </Button>
            <Button size="sm" variant="secondary" onClick={saveAsTemplate}>
              <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('rota.saveTemplate')}
            </Button>
            <Button size="sm" onClick={publish} loading={busy}>
              <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('rota.publish')}
            </Button>
          </div>
        ) : null}
      </div>
      {total === 0 ? (
        <EmptyState icon={<CalendarClock aria-hidden />} title={t('rota.noPeople')} />
      ) : (
        <RotaGrid
          label={t('rota.gridLabel', { date: formatDate(days[0]!, locale) })}
          days={days}
          rows={rows}
          openShifts={open}
          canEdit={canEdit}
          onRangeEnd={onRangeEnd}
          onAdd={onAdd}
          onOpen={onOpen}
        />
      )}
      <ShiftDialog draft={draft} onClose={() => setDraft(null)} onSaved={reset} locationId={locationId} zone={zone} />
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent title={t('rota.applyTemplate')} description={t('rota.applyTemplateBody', { date: formatDate(days[0]!, locale) })} closeLabel={t('common.close')}>
          {templates.data?.length ? (
            <ul className="flex flex-col gap-2">
              {templates.data.map((tp) => (
                <li key={tp.id} className="flex items-center justify-between gap-3">
                  <span className="text-callout">
                    {tp.name} <span className="text-text-secondary">· {t('rota.slots', { count: tp.slots.length })}</span>
                  </span>
                  <Button size="sm" onClick={() => applyTemplate(tp.id)}>
                    {t('rota.apply')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-callout text-text-secondary">{t('rota.noTemplates')}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface Swap {
  id: string;
  kind: string;
  status: string;
  fromEmployeeId: string;
  fromEmployeeName: string | null;
  toEmployeeId: string | null;
  toEmployeeName: string | null;
  acceptedAt: string | null;
  shift: ShiftDto;
}

function SwapDialog({ shift, onClose, onDone }: { shift: ShiftDto | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const [q, setQ] = React.useState('');
  const query = useDebounced(q, 250);
  const people = useApi<{ data: Array<{ id: string; displayName: string; jobTitle: string | null }> }>(shift && query.length >= 2 ? `/v1/directory?q=${encodeURIComponent(query)}&limit=10` : null);
  if (!shift) return null;
  async function offer(toEmployeeId: string) {
    try {
      await api(`/v1/shifts/${shift!.id}/swap`, { method: 'POST', json: { toEmployeeId } });
      toast({ title: t('rota.swapSent'), tone: 'success' });
      onDone();
      onClose();
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('rota.swapTitle')} description={`${dayLong(shift.date, locale)} · ${shiftRange(shift, locale)}`} closeLabel={t('common.close')}>
        <Field id="swap-search" label={t('rota.colleague')} hint={t('rota.searchHint')}>
          {(p) => <Input {...p} type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <ul className="mt-3 flex flex-col gap-2" aria-live="polite">
          {(people.data?.data ?? [])
            .filter((p) => p.id !== session?.employeeId)
            .map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span className="text-callout">
                  {p.displayName}
                  {p.jobTitle ? <span className="text-text-secondary"> · {p.jobTitle}</span> : null}
                </span>
                <Button size="sm" variant="secondary" onClick={() => offer(p.id)}>
                  {t('rota.offer')}
                </Button>
              </li>
            ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function MyRota({ week }: { week: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const to = addDays(week, 6);
  const mine = useApi<ShiftDto[]>(session?.employeeId ? `/v1/me/shifts?from=${week}&to=${to}` : null);
  const open = useApi<Array<ShiftDto & { claimedByMe: boolean }>>(session?.employeeId ? `/v1/shifts/open?from=${week}&to=${to}` : null);
  const swaps = useApi<Swap[]>('/v1/shift-swaps');
  const [swapFor, setSwapFor] = React.useState<ShiftDto | null>(null);
  const canSwap = hasPermission(session, 'rota.swap_request');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
    } catch (err) {
      toast({ title: errorText(err, t('common.error')), tone: 'danger' });
    }
    mine.reload();
    open.reload();
    swaps.reload();
  };
  if (!session?.employeeId) return <EmptyState title={t('rota.noEmployee')} />;
  const swapTone = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardTitle>{t('rota.myShifts')}</CardTitle>
        {!mine.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : mine.data.length ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {mine.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-callout">
                  <span className="font-semibold">{dayLong(s.date, locale)}</span>
                  <span className="text-text-secondary"> · {shiftRange(s, locale)}</span>
                </span>
                {canSwap ? (
                  <Button size="sm" variant="ghost" onClick={() => setSwapFor(s)} aria-label={t('rota.swapFor', { day: dayLong(s.date, locale) })}>
                    <Repeat aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('rota.swap')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('rota.noShifts')}</p>
        )}
      </Card>
      <Card>
        <CardTitle>{t('rota.openShifts')}</CardTitle>
        {!open.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : open.data.length ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {open.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-callout">
                  <span className="font-semibold">{dayLong(s.date, locale)}</span>
                  <span className="text-text-secondary"> · {shiftRange(s, locale)}</span>
                </span>
                {s.claimedByMe ? (
                  <Badge tone="warning">{t('rota.requested')}</Badge>
                ) : canSwap ? (
                  <Button size="sm" variant="secondary" onClick={() => run(() => api(`/v1/shifts/${s.id}/claim`, { method: 'POST', json: {} }), t('rota.claimSent'))} aria-label={t('rota.claimFor', { day: dayLong(s.date, locale) })}>
                    <Hand aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('rota.claim')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('rota.noOpenShifts')}</p>
        )}
      </Card>
      <Card className="lg:col-span-2">
        <CardTitle>{t('rota.swaps')}</CardTitle>
        {swaps.data?.length ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {swaps.data.map((w) => {
              const incoming = w.toEmployeeId === session.employeeId && w.kind === 'swap';
              const label =
                w.kind === 'claim_open'
                  ? t('rota.claimLine', { date: dayLong(w.shift.date, locale) })
                  : incoming
                    ? t('rota.swapFrom', { name: w.fromEmployeeName ?? '', date: dayLong(w.shift.date, locale) })
                    : t('rota.swapTo', { name: w.toEmployeeName ?? '', date: dayLong(w.shift.date, locale) });
              return (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="text-callout">{label}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={swapTone[w.status as keyof typeof swapTone] ?? 'neutral'}>{t(`rota.swapStatus.${w.status}`)}</Badge>
                    {incoming && w.status === 'pending' && !w.acceptedAt ? (
                      <>
                        <Button size="sm" onClick={() => run(() => api(`/v1/shift-swaps/${w.id}/respond`, { method: 'POST', json: { accept: true } }), t('rota.swapAccepted'))}>
                          {t('rota.accept')}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => run(() => api(`/v1/shift-swaps/${w.id}/respond`, { method: 'POST', json: { accept: false } }), t('rota.swapDeclinedToast'))}>
                          {t('rota.decline')}
                        </Button>
                      </>
                    ) : null}
                    {!incoming && w.status === 'pending' && w.fromEmployeeId === session.employeeId ? (
                      <Button size="sm" variant="ghost" onClick={() => run(() => api(`/v1/shift-swaps/${w.id}/cancel`, { method: 'POST' }), t('rota.requestCancelled'))}>
                        {t('common.cancel')}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('rota.noSwaps')}</p>
        )}
      </Card>
      <SwapDialog shift={swapFor} onClose={() => setSwapFor(null)} onDone={() => swaps.reload()} />
    </div>
  );
}

export default function RotaPage() {
  const t = useT();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const settings = useApi<{ workweekStartsOn: number }>('/v1/settings/time');
  const startsOn = settings.data?.workweekStartsOn ?? 1;
  const [week, setWeek] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (settings.data && !week) setWeek(thisWeek(zone, startsOn));
  }, [settings.data, week, zone, startsOn]);
  const canView = hasPermission(session, 'rota.view');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{t('rota.title')}</h1>
        {week ? <WeekNav week={week} setWeek={(w) => setWeek(weekStartOf(w, startsOn))} zone={zone} startsOn={startsOn} /> : null}
      </div>
      {/* Rendered with the heading, before the week loads: it is the page's largest text on a phone. */}
      {canView ? <p className="-mt-2 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('rota.legend')}</p> : null}
      {!week ? (
        <Skeleton className="h-64 w-full" />
      ) : canView ? (
        <Tabs defaultValue="team" className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="team">{t('rota.tabTeam')}</TabsTrigger>
            <TabsTrigger value="mine">{t('rota.tabMine')}</TabsTrigger>
          </TabsList>
          <TabsContent value="team">
            <TeamRota week={week} zone={zone} />
          </TabsContent>
          <TabsContent value="mine">
            <MyRota week={week} />
          </TabsContent>
        </Tabs>
      ) : (
        <MyRota week={week} />
      )}
    </div>
  );
}
