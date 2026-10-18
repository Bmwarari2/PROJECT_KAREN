'use client';
import * as React from 'react';
import { Button, Card, CardTitle, Input, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useT } from '@/lib/i18n-client';
import { PageTitle, selectClass } from '../ui';

interface Channel {
  kind: string;
  value?: string | null;
  hours?: string;
}
interface Resp {
  region: string;
  defaults: Record<string, Channel[]>;
  override: Record<string, Channel[]> | null;
}
const KINDS = ['help_centre', 'ticket', 'email', 'phone', 'chat'];

/** Support contact channels per plan for this region (append-only settings; newest wins; audited). */
export default function BackofficeSettings() {
  const t = useT();
  const toast = useToast();
  const r = useApi<Resp>('/v1/backoffice/settings/contact-channels');
  const [edit, setEdit] = React.useState<Record<string, Channel[]> | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (r.data && !edit) setEdit(structuredClone(r.data.override ?? r.data.defaults));
  }, [r.data, edit]);
  if (!r.data || !edit) return null;
  const update = (plan: string, i: number, patch: Partial<Channel>) => setEdit({ ...edit, [plan]: edit[plan]!.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  async function save() {
    setBusy(true);
    try {
      const channels = Object.fromEntries(Object.entries(edit!).map(([p, list]) => [p, list.map((c) => ({ kind: c.kind, ...(c.value ? { value: c.value } : {}), ...(c.hours ? { hours: c.hours } : {}) }))]));
      await api('/v1/backoffice/settings/contact-channels', { method: 'PUT', json: { channels } });
      toast({ title: t('backoffice.settings.saved'), tone: 'success' });
      r.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.settings.title')} lead={t('backoffice.settings.lead', { region: t(`regions.${r.data.region}`) })} />
      {Object.entries(edit).map(([plan, list]) => (
        <Card key={plan}>
          <CardTitle>{t(`pricing.plans.${plan}.name`)}</CardTitle>
          <ul className="mt-3 flex flex-col gap-3">
            {list.map((c, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_10rem_auto] sm:items-center">
                <label className="sr-only" htmlFor={`${plan}-${i}-kind`}>{t('backoffice.settings.kind')}</label>
                <select id={`${plan}-${i}-kind`} className={selectClass} value={c.kind} onChange={(e) => update(plan, i, { kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k} value={k}>{t(`support.channels.${k}`)}</option>)}
                </select>
                <label className="sr-only" htmlFor={`${plan}-${i}-value`}>{t('backoffice.settings.value')}</label>
                <Input id={`${plan}-${i}-value`} placeholder={t('backoffice.settings.valuePlaceholder')} value={c.value ?? ''} onChange={(e) => update(plan, i, { value: e.target.value })} />
                <label className="sr-only" htmlFor={`${plan}-${i}-hours`}>{t('backoffice.settings.hours')}</label>
                <select id={`${plan}-${i}-hours`} className={selectClass} value={c.hours ?? ''} onChange={(e) => update(plan, i, { hours: e.target.value || undefined })}>
                  <option value="">—</option>
                  <option value="business_hours">{t('support.coverage.business_hours')}</option>
                  <option value="always">{t('support.coverage.always')}</option>
                </select>
                <Button variant="ghost" size="sm" onClick={() => setEdit({ ...edit, [plan]: list.filter((_, j) => j !== i) })}>{t('backoffice.settings.remove')}</Button>
              </li>
            ))}
          </ul>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => setEdit({ ...edit, [plan]: [...list, { kind: 'email', value: '' }] })}>{t('backoffice.settings.addChannel')}</Button>
        </Card>
      ))}
      <div>
        <Button loading={busy} onClick={save}>{t('backoffice.settings.save')}</Button>
      </div>
    </div>
  );
}
