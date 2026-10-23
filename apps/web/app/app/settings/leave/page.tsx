'use client';
import * as React from 'react';
import { CalendarDays, Plus, UserPlus } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { dateTimeFormat, formatNumber, formatUnit } from '@thapsus/core/i18n';
import { daysInMonth, today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { LeaveBalancesTable, type LeaveBalance } from '@/components/leave-balances';
import { Checkbox, FormError, PageHeader, RadioGroup, selectClass, SettingsCard, useAction, useFormat, useOrg } from '../kit';

interface LeaveType {
  id: string;
  key: string;
  name: Record<string, string>;
  category: string;
  paid: boolean;
  requiresApproval: boolean;
  deductsBalance: boolean;
}
type Accrual = { method: 'annual_upfront' | 'monthly'; days: number } | { method: 'per_hour_worked'; percent: number };
interface PolicyConfig {
  accrual: Accrual;
  unit: 'days' | 'hours';
  yearStart: string;
  proRata: boolean;
  includesPublicHolidays: boolean;
  waitingDays: number;
  carryOver?: { maxDays: number; expiresAfterMonths?: number };
  capDays?: number;
  allowNegativeDays: number;
  rounding: 'none' | 'up_half_day' | 'nearest_half_day' | 'up_whole_day';
}
interface Policy {
  id: string;
  name: string;
  leaveTypeId: string;
  leaveTypeKey: string;
  entityId: string | null;
  entityName: string | null;
  country: string | null;
  config: PolicyConfig;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignedEmployees: number;
}
interface Employee {
  id: string;
  displayName?: string;
  jobTitle?: string | null;
}

const ROUNDING: PolicyConfig['rounding'][] = ['none', 'up_half_day', 'nearest_half_day', 'up_whole_day'];

function useTypeName(types: LeaveType[] | undefined) {
  const locale = useLocale();
  return React.useCallback((key: string) => {
    const x = types?.find((y) => y.key === key);
    return x ? (x.name[locale] ?? x.name['en-GB'] ?? key) : key;
  }, [types, locale]);
}

function useMonthNames() {
  const locale = useLocale();
  return React.useMemo(() => Array.from({ length: 12 }, (_, i) => dateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, i, 1)))), [locale]);
}

function PolicySummary({ p, typeName }: { p: Policy; typeName: (k: string) => string }) {
  const t = useT();
  const locale = useLocale();
  const fmt = useFormat();
  const months = useMonthNames();
  const c = p.config;
  const unit = c.unit === 'hours' ? 'hour' : 'day';
  const [mm, dd] = c.yearStart.split('-').map(Number);
  const accrual =
    c.accrual.method === 'per_hour_worked'
      ? t('admin.leave.accrualText.per_hour_worked', { percent: formatNumber(c.accrual.percent, locale, { maximumFractionDigits: 2 }) })
      : t(`admin.leave.accrualText.${c.accrual.method}`, { amount: formatUnit(c.accrual.days, unit, locale) });
  const rows: Array<[string, string]> = [
    [t('admin.leave.appliesTo'), p.entityName ?? (p.country ? t('admin.leave.country', { country: p.country }) : t('admin.leave.everyone'))],
    [t('admin.leave.accrual'), accrual],
    [t('admin.leave.yearStart'), t('admin.leave.yearStartText', { day: dd ?? 1, month: months[(mm ?? 1) - 1] ?? '' })],
    [t('admin.leave.waiting'), c.waitingDays ? formatUnit(c.waitingDays, 'day', locale) : t('common.none')],
    [t('admin.leave.carryOver'), c.carryOver ? (c.carryOver.expiresAfterMonths ? t('admin.leave.carryOverExpires', { amount: formatUnit(c.carryOver.maxDays, 'day', locale), months: c.carryOver.expiresAfterMonths }) : t('admin.leave.carryOverText', { amount: formatUnit(c.carryOver.maxDays, 'day', locale) })) : t('common.none')],
    [t('admin.leave.cap'), c.capDays !== undefined ? formatUnit(c.capDays, 'day', locale) : t('common.none')],
    [t('admin.leave.negative'), c.allowNegativeDays ? formatUnit(c.allowNegativeDays, 'day', locale) : t('common.none')],
    [t('admin.leave.options'), [c.proRata ? t('admin.leave.proRata') : null, c.includesPublicHolidays ? t('admin.leave.includesPublicHolidays') : null, t(`admin.leave.roundingText.${c.rounding}`)].filter(Boolean).join(' · ')],
    [t('admin.leave.effective'), p.effectiveTo ? `${fmt.date(p.effectiveFrom)} – ${fmt.date(p.effectiveTo)}` : t('admin.leave.effectiveFrom', { date: fmt.date(p.effectiveFrom) })],
  ];
  return (
    <>
      <p className="text-footnote text-text-secondary">{typeName(p.leaveTypeKey)}</p>
      <dl className="grid gap-x-4 gap-y-1 text-footnote sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-text-secondary">{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </>
  );
}

function AssignDialog({ policy, onClose, onDone }: { policy: Policy; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const [q, setQ] = React.useState('');
  const query = useDebounced(q.trim());
  const people = useApi<{ data: Employee[] }>(`/v1/employees?status=active&limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [validFrom, setValidFrom] = React.useState(today(fmt.zone));
  const action = useAction();
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected.size) {
      action.setError(t('admin.leave.assignNone'));
      return;
    }
    if (await action.run(() => api(`/v1/leave/policies/${policy.id}/assign`, { method: 'POST', json: { employeeIds: [...selected], validFrom } }), t('admin.leave.assigned', { n: selected.size }))) onDone();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('admin.leave.assignTitle', { name: policy.name })} description={t('admin.leave.assignBody')} closeLabel={t('common.close')}>
        <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field id="assign-from" label={t('admin.leave.assignFrom')}>
            {(p) => <Input {...p} type="date" required value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-callout font-semibold">{t('admin.leave.assignPeople', { n: selected.size })}</legend>
            <Input type="search" aria-label={t('admin.userPicker.searchPlaceholder')} placeholder={t('admin.userPicker.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
            {!people.data ? (
              <Skeleton className="h-24" />
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {people.data.data.map((p) => (
                  <li key={p.id} className="px-3 py-2">
                    <Checkbox id={`assign-${p.id}`} label={p.displayName ?? p.id} hint={p.jobTitle ?? undefined} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <FormError message={action.error} />
          <Button type="submit" className="self-start" loading={action.busy}>
            {t('admin.leave.assign')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Draft {
  name: string;
  leaveTypeId: string;
  entityId: string;
  country: string;
  effectiveFrom: string;
  method: Accrual['method'];
  amount: string;
  unit: PolicyConfig['unit'];
  month: string;
  day: string;
  proRata: boolean;
  includesPublicHolidays: boolean;
  waitingDays: string;
  carry: boolean;
  carryMax: string;
  carryExpires: string;
  cap: string;
  negative: string;
  rounding: PolicyConfig['rounding'];
}
const EMPTY: Draft = { name: '', leaveTypeId: '', entityId: '', country: '', effectiveFrom: '', method: 'annual_upfront', amount: '', unit: 'days', month: '1', day: '1', proRata: true, includesPublicHolidays: false, waitingDays: '0', carry: false, carryMax: '5', carryExpires: '', cap: '', negative: '0', rounding: 'up_half_day' };

function AddPolicy({ types, onCreated }: { types: LeaveType[]; onCreated: () => void }) {
  const t = useT();
  const locale = useLocale();
  const months = useMonthNames();
  const entities = useOrg('legal-entities');
  const action = useAction();
  const [d, setD] = React.useState<Draft>({ ...EMPTY, leaveTypeId: types.find((x) => x.key === 'annual')?.id ?? types[0]?.id ?? '' });
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const maxDay = daysInMonth(2001, Number(d.month));
  const isToil = types.find((x) => x.id === d.leaveTypeId)?.category === 'toil';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setWarnings([]);
    const accrual: Accrual = d.method === 'per_hour_worked' ? { method: d.method, percent: Number(d.amount) } : { method: d.method, days: Number(d.amount) };
    const config: PolicyConfig = {
      accrual,
      unit: d.unit,
      yearStart: `${d.month.padStart(2, '0')}-${d.day.padStart(2, '0')}`,
      proRata: d.proRata,
      includesPublicHolidays: d.includesPublicHolidays,
      waitingDays: Number(d.waitingDays),
      ...(d.carry ? { carryOver: { maxDays: Number(d.carryMax), ...(d.carryExpires ? { expiresAfterMonths: Number(d.carryExpires) } : {}) } } : {}),
      ...(d.cap ? { capDays: Number(d.cap) } : {}),
      allowNegativeDays: Number(d.negative),
      rounding: d.rounding,
    };
    const body = { name: d.name.trim(), leaveTypeId: d.leaveTypeId, entityId: d.entityId || null, country: d.country ? d.country.toUpperCase() : null, config, ...(d.effectiveFrom ? { effectiveFrom: d.effectiveFrom } : {}) };
    await action.run(async () => {
      const r = await api<{ id: string; warnings: string[] }>('/v1/leave/policies', { method: 'POST', json: body });
      setWarnings(r.warnings);
      setD({ ...EMPTY, leaveTypeId: d.leaveTypeId });
      onCreated();
    }, t('admin.leave.created'));
  }

  return (
    <SettingsCard id="leave-add" title={t('admin.leave.addTitle')} description={t('admin.leave.addBody')}>
      {warnings.length ? (
        <div role="status" className="rounded-md bg-surface p-3 text-callout text-warning">
          {warnings.map((w) => {
            const [code, days] = w.split(':');
            return <p key={w}>{code === 'belowStatutoryMinimum' ? t('admin.leave.belowMinimum', { amount: formatUnit(Number(days), 'day', locale) }) : w}</p>;
          })}
        </div>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="lp-name" label={t('admin.name')}>
            {(p) => <Input {...p} required maxLength={120} value={d.name} onChange={(e) => set('name', e.target.value)} />}
          </Field>
          <Field id="lp-type" label={t('timeOff.type')} hint={isToil ? t('admin.leave.toilHint') : undefined}>
            {(p) => (
              <select {...p} required className={selectClass} value={d.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}>
                {types.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name[locale] ?? x.name['en-GB'] ?? x.key}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="lp-entity" label={t('admin.leave.entity')} hint={t('admin.leave.entityHint')}>
            {(p) => (
              <select {...p} className={selectClass} value={d.entityId} onChange={(e) => set('entityId', e.target.value)}>
                <option value="">{t('admin.allEntities')}</option>
                {(entities.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="lp-country" label={t('admin.leave.countryLabel')} hint={t('admin.leave.countryHint')}>
            {(p) => <Input {...p} maxLength={2} pattern="[A-Za-z]{2}" autoCapitalize="characters" spellCheck={false} className="uppercase sm:w-24" value={d.country} onChange={(e) => set('country', e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase())} />}
          </Field>
          <Field id="lp-from" label={t('admin.leave.effectiveFromLabel')} hint={t('admin.optional')}>
            {(p) => <Input {...p} type="date" value={d.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />}
          </Field>
          <Field id="lp-unit" label={t('admin.leave.unit')}>
            {(p) => (
              <select {...p} className={selectClass} value={d.unit} onChange={(e) => set('unit', e.target.value as Draft['unit'])}>
                <option value="days">{t('admin.leave.units.days')}</option>
                <option value="hours">{t('admin.leave.units.hours')}</option>
              </select>
            )}
          </Field>
        </div>
        <RadioGroup
          name="lp-method"
          legend={t('admin.leave.accrual')}
          value={d.method}
          onChange={(v) => set('method', v)}
          options={(['annual_upfront', 'monthly', 'per_hour_worked'] as const).map((m) => ({ value: m, label: t(`admin.leave.method.${m}`), hint: t(`admin.leave.methodHint.${m}`) }))}
        />
        <div className="grid gap-4 md:grid-cols-3">
          {d.method === 'per_hour_worked' ? (
            <Field id="lp-amount" label={t('admin.leave.percent')} hint={t('admin.leave.percentHint')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={0} max={100} step="0.01" value={d.amount} onChange={(e) => set('amount', e.target.value)} />}
            </Field>
          ) : (
            <Field id="lp-amount" label={t('admin.leave.daysPerYear')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={0} max={366} step="0.5" value={d.amount} onChange={(e) => set('amount', e.target.value)} />}
            </Field>
          )}
          <Field id="lp-month" label={t('admin.leave.yearStartMonth')}>
            {(p) => (
              <select {...p} className={selectClass} value={d.month} onChange={(e) => setD((x) => ({ ...x, month: e.target.value, day: String(Math.min(Number(x.day), daysInMonth(2001, Number(e.target.value)))) }))}>
                {months.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="lp-day" label={t('admin.leave.yearStartDay')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" required min={1} max={maxDay} step={1} value={d.day} onChange={(e) => set('day', e.target.value)} />}
          </Field>
          <Field id="lp-waiting" label={t('admin.leave.waiting')} hint={t('admin.leave.waitingHint')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" required min={0} max={365} step={1} value={d.waitingDays} onChange={(e) => set('waitingDays', e.target.value)} />}
          </Field>
          <Field id="lp-cap" label={t('admin.leave.cap')} hint={t('admin.leave.capHint')}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="0.5" value={d.cap} onChange={(e) => set('cap', e.target.value)} />}
          </Field>
          <Field id="lp-negative" label={t('admin.leave.negative')} hint={t('admin.leave.negativeHint')}>
            {(p) => <Input {...p} type="number" inputMode="decimal" required min={0} max={30} step="0.5" value={d.negative} onChange={(e) => set('negative', e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <Checkbox id="lp-prorata" label={t('admin.leave.proRata')} hint={t('admin.leave.proRataHint')} checked={d.proRata} onChange={(v) => set('proRata', v)} />
          <Checkbox id="lp-holidays" label={t('admin.leave.includesPublicHolidays')} hint={t('admin.leave.includesPublicHolidaysHint')} checked={d.includesPublicHolidays} onChange={(v) => set('includesPublicHolidays', v)} />
          <Checkbox id="lp-carry" label={t('admin.leave.carryOverOn')} checked={d.carry} onChange={(v) => set('carry', v)} />
        </div>
        {d.carry ? (
          <div className="grid gap-4 md:grid-cols-3">
            <Field id="lp-carry-max" label={t('admin.leave.carryMax')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={0} step="0.5" value={d.carryMax} onChange={(e) => set('carryMax', e.target.value)} />}
            </Field>
            <Field id="lp-carry-expires" label={t('admin.leave.carryExpires')} hint={t('admin.leave.carryExpiresHint')}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={24} step={1} value={d.carryExpires} onChange={(e) => set('carryExpires', e.target.value)} />}
            </Field>
          </div>
        ) : null}
        <Field id="lp-rounding" label={t('admin.leave.rounding')} className="md:w-1/3">
          {(p) => (
            <select {...p} className={selectClass} value={d.rounding} onChange={(e) => set('rounding', e.target.value as Draft['rounding'])}>
              {ROUNDING.map((r) => (
                <option key={r} value={r}>
                  {t(`admin.leave.roundingText.${r}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.leave.add')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function BalanceCheck({ typeName, version }: { typeName: (k: string) => string; version: number }) {
  const t = useT();
  const fmt = useFormat();
  const people = useApi<{ data: Employee[] }>('/v1/employees?status=active&limit=200');
  const [employeeId, setEmployeeId] = React.useState('');
  const [asOf, setAsOf] = React.useState(today(fmt.zone));
  const balances = useApi<LeaveBalance[]>(employeeId ? `/v1/leave/balances/${employeeId}?asOf=${asOf}` : null);
  const name = people.data?.data.find((p) => p.id === employeeId)?.displayName ?? '';
  const { reload } = balances;
  // a policy was just created or assigned: show the balance it now produces
  React.useEffect(() => {
    if (version) reload();
  }, [version]);
  return (
    <SettingsCard id="leave-check" title={t('admin.leave.checkTitle')} description={t('admin.leave.checkBody')}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="check-employee" label={t('admin.leave.checkEmployee')}>
          {(p) => (
            <select {...p} className={selectClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">{t('admin.userPicker.none')}</option>
              {(people.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.displayName ?? x.id}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="check-asof" label={t('people.asOf')}>
          {(p) => <Input {...p} type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
        </Field>
      </div>
      <div aria-live="polite">
        {employeeId && balances.data ? <LeaveBalancesTable balances={balances.data} typeName={typeName} caption={t('admin.balances.caption', { name })} /> : null}
        {balances.error ? <FormError message={balances.error.title} /> : null}
      </div>
    </SettingsCard>
  );
}

/** Leave types and policies: entitlement, accrual, carry-over, caps, waiting periods, TOIL. */
export default function LeaveSettingsPage() {
  const t = useT();
  const types = useApi<LeaveType[]>('/v1/leave/types');
  const policies = useApi<Policy[]>('/v1/leave/policies');
  const typeName = useTypeName(types.data);
  const [assigning, setAssigning] = React.useState<Policy | null>(null);
  const [version, setVersion] = React.useState(0);
  const changed = () => (policies.reload(), setVersion((v) => v + 1));
  const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'));

  return (
    <>
      <PageHeader title={t('admin.section.leave.title')} lead={t('admin.leave.lead')} />
      <SettingsCard id="leave-types" title={t('admin.leave.typesTitle')} description={t('admin.leave.typesBody')}>
        {!types.data ? (
          <Skeleton className="h-24" />
        ) : (
          <Table dense scrollLabel={t('admin.tableScroll', { name: t('admin.leave.typesTitle') })}>
            <THead>
              <tr>
                <TH>{t('admin.name')}</TH>
                <TH>{t('admin.leave.category')}</TH>
                <TH>{t('admin.leave.paid')}</TH>
                <TH>{t('admin.leave.needsApproval')}</TH>
                <TH>{t('admin.leave.usesBalance')}</TH>
              </tr>
            </THead>
            <tbody>
              {types.data.map((x) => (
                <TR key={x.id}>
                  <TD className="font-semibold">{typeName(x.key)}</TD>
                  <TD>{t(`admin.leave.categories.${x.category}`)}</TD>
                  <TD>{yesNo(x.paid)}</TD>
                  <TD>{yesNo(x.requiresApproval)}</TD>
                  <TD>{yesNo(x.deductsBalance)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </SettingsCard>
      <SettingsCard id="leave-policies" title={t('admin.leave.policiesTitle')} description={t('admin.leave.policiesBody')}>
        {!policies.data ? (
          <Skeleton className="h-40" />
        ) : policies.data.length === 0 ? (
          <EmptyState icon={<CalendarDays aria-hidden />} title={t('admin.leave.none')} />
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2">
            {policies.data.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="mr-auto text-callout font-semibold">{p.name}</h4>
                  <Badge>{t('admin.leave.assignedN', { n: p.assignedEmployees })}</Badge>
                  <Button size="sm" variant="ghost" aria-label={t('admin.leave.assignLabel', { name: p.name })} onClick={() => setAssigning(p)}>
                    <UserPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('admin.leave.assign')}
                  </Button>
                </div>
                <PolicySummary p={p} typeName={typeName} />
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      {types.data ? <AddPolicy types={types.data} onCreated={changed} /> : null}
      <BalanceCheck typeName={typeName} version={version} />
      {assigning ? (
        <AssignDialog
          policy={assigning}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            changed();
          }}
        />
      ) : null}
    </>
  );
}
