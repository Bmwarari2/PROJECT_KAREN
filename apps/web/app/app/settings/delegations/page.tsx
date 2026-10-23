'use client';
import * as React from 'react';
import { UserRoundCheck } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { addDays, addMinutes, compareDates, instantToDate, nowInstant, startOfDayInstant, today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ConfirmAction, FormError, PageHeader, SettingsCard, useAction, useFormat, UserPicker } from '../kit';

interface Delegation {
  id: string;
  fromName: string;
  toName: string;
  startsAt: string;
  endsAt: string;
  direction: 'given' | 'received';
}

function statusOf(d: Delegation, now: number): 'active' | 'scheduled' | 'ended' {
  if (new Date(d.endsAt).getTime() <= now) return 'ended';
  return new Date(d.startsAt).getTime() > now ? 'scheduled' : 'active';
}

/** A manager hands their approvals to a colleague for a period (holiday, leave). */
export default function DelegationsPage() {
  const t = useT();
  const fmt = useFormat();
  const list = useApi<Delegation[]>('/v1/delegations');
  const start = today(fmt.zone);
  const [toUserId, setTo] = React.useState('');
  const [from, setFrom] = React.useState(start);
  const [until, setUntil] = React.useState(addDays(start, 7));
  const create = useAction();
  const now = Date.now();
  // Whole days in the viewer's time zone: from the start of the first day to the end of the last.
  const period = (d: Delegation) => `${fmt.date(instantToDate(d.startsAt, fmt.zone))} – ${fmt.date(instantToDate(addMinutes(d.endsAt, -1), fmt.zone))}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (compareDates(until, from) < 0) {
      create.setError(t('admin.delegations.endBeforeStart'));
      return;
    }
    const startsAt = from === start ? nowInstant() : startOfDayInstant(from, fmt.zone);
    const endsAt = startOfDayInstant(addDays(until, 1), fmt.zone);
    if (await create.run(() => api('/v1/delegations', { method: 'POST', json: { toUserId, startsAt, endsAt } }), t('admin.delegations.created'))) {
      setTo('');
      list.reload();
    }
  }

  const given = (list.data ?? []).filter((d) => d.direction === 'given');
  const received = (list.data ?? []).filter((d) => d.direction === 'received');
  const table = (rows: Delegation[], who: 'toName' | 'fromName', canEnd: boolean) => (
    <Table dense scrollLabel={t('admin.tableScroll', { name: t(who === 'toName' ? 'admin.delegations.givenTitle' : 'admin.delegations.receivedTitle') })}>
      <THead>
        <tr>
          <TH>{t(who === 'toName' ? 'admin.delegations.to' : 'admin.delegations.from')}</TH>
          <TH>{t('admin.delegations.period')}</TH>
          <TH>{t('common.status')}</TH>
          {canEnd ? (
            <TH>
              <span className="sr-only">{t('common.actions')}</span>
            </TH>
          ) : null}
        </tr>
      </THead>
      <tbody>
        {rows.map((d) => {
          const status = statusOf(d, now);
          return (
            <TR key={d.id}>
              <TD className="font-semibold">{d[who]}</TD>
              <TD>{period(d)}</TD>
              <TD>
                <Badge tone={status === 'active' ? 'success' : status === 'scheduled' ? 'accent' : 'neutral'}>{t(`admin.delegations.status.${status}`)}</Badge>
              </TD>
              {canEnd ? (
                <TD className="text-right">
                  {status !== 'ended' ? (
                    <ConfirmAction
                      label={status === 'active' ? t('admin.delegations.endNow') : t('common.cancel')}
                      ariaLabel={t('admin.delegations.endLabel', { action: status === 'active' ? t('admin.delegations.endNow') : t('common.cancel'), name: d.toName })}
                      title={t('admin.delegations.endTitle', { name: d.toName })}
                      body={t('admin.delegations.endBody')}
                      confirmLabel={status === 'active' ? t('admin.delegations.endNow') : t('admin.delegations.cancelDelegation')}
                      onConfirm={async () => {
                        await api(`/v1/delegations/${d.id}`, { method: 'DELETE' });
                        list.reload();
                      }}
                    />
                  ) : null}
                </TD>
              ) : null}
            </TR>
          );
        })}
      </tbody>
    </Table>
  );

  return (
    <>
      <PageHeader title={t('admin.section.delegations.title')} lead={t('admin.delegations.lead')} />
      <SettingsCard id="delegation-new" title={t('admin.delegations.newTitle')} description={t('admin.delegations.newBody')}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <UserPicker id="delegate" label={t('admin.delegations.delegate')} required value={toUserId} onChange={setTo} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="delegation-from" label={t('admin.delegations.firstDay')}>
              {(p) => <Input {...p} type="date" required min={start} value={from} onChange={(e) => setFrom(e.target.value)} />}
            </Field>
            <Field id="delegation-until" label={t('admin.delegations.lastDay')}>
              {(p) => <Input {...p} type="date" required min={from} value={until} onChange={(e) => setUntil(e.target.value)} />}
            </Field>
          </div>
          <FormError message={create.error} />
          <Button type="submit" className="self-start" loading={create.busy}>
            <UserRoundCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.delegations.create')}
          </Button>
        </form>
      </SettingsCard>
      <SettingsCard id="delegations-given" title={t('admin.delegations.givenTitle')}>
        {!list.data ? <Skeleton className="h-20" /> : given.length ? table(given, 'toName', true) : <EmptyState icon={<UserRoundCheck aria-hidden />} title={t('admin.delegations.noneGiven')} />}
      </SettingsCard>
      <SettingsCard id="delegations-received" title={t('admin.delegations.receivedTitle')} description={t('admin.delegations.receivedBody')}>
        {!list.data ? <Skeleton className="h-20" /> : received.length ? table(received, 'fromName', false) : <p className="text-callout text-text-secondary">{t('admin.delegations.noneReceived')}</p>}
      </SettingsCard>
    </>
  );
}
