'use client';
import * as React from 'react';
import { ArrowRightLeft, DoorOpen, Scale } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTrigger, Field, Input, Skeleton, Textarea } from '@thapsus/ui';
import { today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { LeaveBalancesTable, type LeaveBalance } from '@/components/leave-balances';
import { FormError, selectClass, useAction, useFormat, useOrg } from '../../settings/kit';

interface Person {
  id: string;
  displayName?: string;
}
const usePeople = (enabled: boolean) => useApi<{ data: Person[] }>(enabled ? '/v1/employees?status=active&limit=200' : null);

/** Starts a leaver: last working day, reason, and who their reports move to (offboarding starts automatically). */
export function LeaverDialog({ employeeId, name, onDone }: { employeeId: string; name: string; onDone: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const [open, setOpen] = React.useState(false);
  const reports = useApi<{ data: Person[] }>(open ? `/v1/employees?managerId=${employeeId}&status=active&limit=1` : null);
  const people = usePeople(open && !!reports.data?.data.length);
  const [endDate, setEndDate] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [reassign, setReassign] = React.useState('');
  const action = useAction();
  const hasReports = !!reports.data?.data.length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { endDate, reason: reason.trim(), ...(hasReports && reassign ? { reassignReportsTo: reassign } : {}) };
    if (await action.run(() => api(`/v1/employees/${employeeId}/terminate`, { method: 'POST', json: body }), t('admin.leaver.done', { name, date: fmt.date(endDate) }))) {
      setOpen(false);
      onDone();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), action.setError(null))}>
      <DialogTrigger asChild>
        <Button variant="secondary" className="self-end">
          <DoorOpen aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.leaver.start')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('admin.leaver.title', { name })} description={t('admin.leaver.body')} closeLabel={t('common.close')}>
        <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field id="leaver-date" label={t('admin.leaver.lastDay')}>
            {(p) => <Input {...p} type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
          <Field id="leaver-reason" label={t('admin.leaver.reason')} hint={t('admin.leaver.reasonHint')}>
            {(p) => <Textarea {...p} required minLength={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {!reports.data ? (
            <Skeleton className="h-10" />
          ) : hasReports ? (
            <Field id="leaver-reassign" label={t('admin.leaver.reassign')} hint={t('admin.leaver.reassignHint')}>
              {(p) => (
                <select {...p} required className={selectClass} value={reassign} onChange={(e) => setReassign(e.target.value)}>
                  <option value="">{t('admin.userPicker.none')}</option>
                  {(people.data?.data ?? [])
                    .filter((x) => x.id !== employeeId)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.displayName ?? x.id}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          ) : null}
          <FormError message={action.error} />
          <Button type="submit" variant="danger" className="self-start" loading={action.busy}>
            {t('admin.leaver.confirm')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Internal transfer: new entity, location, department, job title or manager from a date. */
export function TransferDialog({ employeeId, name, onDone }: { employeeId: string; name: string; onDone: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const [open, setOpen] = React.useState(false);
  const entities = useOrg('legal-entities');
  const locations = useOrg('locations');
  const departments = useOrg('departments');
  const people = usePeople(open);
  const [v, setV] = React.useState({ effectiveDate: today(fmt.zone), entityId: '', locationId: '', departmentId: '', jobTitle: '', managerId: '', reason: '' });
  const action = useAction();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const changes = Object.fromEntries((['entityId', 'locationId', 'departmentId', 'jobTitle', 'managerId'] as const).map((k) => [k, v[k].trim()]).filter(([, x]) => x));
    if (!Object.keys(changes).length) {
      action.setError(t('admin.transfer.nothing'));
      return;
    }
    const body = { effectiveDate: v.effectiveDate, ...changes, ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) };
    if (await action.run(() => api(`/v1/employees/${employeeId}/transfer`, { method: 'POST', json: body }), t('admin.transfer.done', { name, date: fmt.date(v.effectiveDate) }))) {
      setOpen(false);
      onDone();
    }
  }

  const orgSelect = (k: 'entityId' | 'locationId' | 'departmentId', label: string, list: Array<{ id: string; name: string }> | undefined) => (
    <Field id={`transfer-${k}`} label={label}>
      {(p) => (
        <select {...p} className={selectClass} value={v[k]} onChange={set(k)}>
          <option value="">{t('admin.transfer.noChange')}</option>
          {(list ?? []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), action.setError(null))}>
      <DialogTrigger asChild>
        <Button variant="secondary" className="self-end">
          <ArrowRightLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.transfer.start')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('admin.transfer.title', { name })} description={t('admin.transfer.body')} closeLabel={t('common.close')}>
        <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field id="transfer-date" label={t('people.effectiveDate')}>
            {(p) => <Input {...p} type="date" required value={v.effectiveDate} onChange={set('effectiveDate')} />}
          </Field>
          {orgSelect('entityId', t('admin.transfer.entity'), entities.data)}
          {orgSelect('locationId', t('rota.location'), locations.data)}
          {orgSelect('departmentId', t('admin.absence.department'), departments.data)}
          <Field id="transfer-job" label={t('people.field.jobTitle')} hint={t('admin.transfer.blankKeeps')}>
            {(p) => <Input {...p} maxLength={200} value={v.jobTitle} onChange={set('jobTitle')} />}
          </Field>
          <Field id="transfer-manager" label={t('admin.transfer.manager')}>
            {(p) => (
              <select {...p} className={selectClass} value={v.managerId} onChange={set('managerId')}>
                <option value="">{t('admin.transfer.noChange')}</option>
                {(people.data?.data ?? [])
                  .filter((x) => x.id !== employeeId)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.displayName ?? x.id}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Field id="transfer-reason" label={t('admin.leaver.reason')} hint={t('admin.optional')}>
            {(p) => <Input {...p} maxLength={200} value={v.reason} onChange={set('reason')} />}
          </Field>
          <FormError message={action.error} />
          <Button type="submit" className="self-start" loading={action.busy}>
            {t('admin.transfer.confirm')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface LeaveType {
  id: string;
  key: string;
  name: Record<string, string>;
  deductsBalance: boolean;
}

/** The person's leave balances, and (with leave.adjust) a balance adjustment such as TOIL earned. */
export function BalancesPanel({ employeeId, name, canAdjust, balances, onChanged }: { employeeId: string; name: string; canAdjust: boolean; balances: LeaveBalance[]; onChanged: () => void }) {
  const t = useT();
  const locale = useLocale();
  const fmt = useFormat();
  const types = useApi<LeaveType[]>('/v1/leave/types');
  const typeName = (key: string) => {
    const x = types.data?.find((y) => y.key === key);
    return x ? (x.name[locale] ?? x.name['en-GB'] ?? key) : key;
  };
  const [v, setV] = React.useState({ leaveTypeId: '', amount: '', kind: 'manual', effectiveDate: today(fmt.zone), reason: '' });
  const action = useAction();
  const deducting = (types.data ?? []).filter((x) => x.deductsBalance);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { employeeId, leaveTypeId: v.leaveTypeId || deducting[0]?.id, amount: Number(v.amount), kind: v.kind, effectiveDate: v.effectiveDate, reason: v.reason.trim() };
    if (await action.run(() => api('/v1/leave/adjustments', { method: 'POST', json: body }), t('admin.balances.adjusted'))) {
      setV({ ...v, amount: '', reason: '' });
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <LeaveBalancesTable balances={balances} typeName={typeName} caption={t('admin.balances.caption', { name })} />
      {canAdjust ? (
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg bg-surface-raised p-5 shadow-sm" aria-labelledby="adjust-title">
          <h3 id="adjust-title" className="text-title-3">
            {t('admin.balances.adjustTitle')}
          </h3>
          <p className="text-callout text-text-secondary">{t('admin.balances.adjustBody')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="adj-type" label={t('timeOff.type')}>
              {(p) => (
                <select {...p} className={selectClass} value={v.leaveTypeId || deducting[0]?.id || ''} onChange={(e) => setV({ ...v, leaveTypeId: e.target.value })}>
                  {deducting.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name[locale] ?? x.name['en-GB'] ?? x.key}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="adj-kind" label={t('admin.balances.kind')}>
              {(p) => (
                <select {...p} className={selectClass} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
                  {['manual', 'toil', 'carry_over', 'correction'].map((k) => (
                    <option key={k} value={k}>
                      {t(`admin.balances.kinds.${k}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="adj-amount" label={t('admin.balances.amount')} hint={t('admin.balances.amountHint')}>
              {(p) => <Input {...p} type="number" inputMode="decimal" required min={-3000} max={3000} step="0.25" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}
            </Field>
            <Field id="adj-date" label={t('people.effectiveDate')}>
              {(p) => <Input {...p} type="date" required value={v.effectiveDate} onChange={(e) => setV({ ...v, effectiveDate: e.target.value })} />}
            </Field>
          </div>
          <Field id="adj-reason" label={t('admin.leaver.reason')}>
            {(p) => <Input {...p} required minLength={3} maxLength={300} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />}
          </Field>
          <FormError message={action.error} />
          <Button type="submit" variant="secondary" className="self-start" loading={action.busy}>
            <Scale aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.balances.adjust')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
