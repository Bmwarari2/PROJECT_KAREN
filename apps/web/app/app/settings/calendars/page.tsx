'use client';
import * as React from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { Button, EmptyState, Field, Input, Skeleton } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { FormError, PageHeader, selectClass, SettingsCard, useAction, useFormat, useOrg } from '../kit';
import { useSectionLevel } from '@/components/module-page';

interface Calendar {
  id: string;
  name: string;
  entityId: string | null;
  locationId: string | null;
  days: Array<{ date: string; name: string }>;
}
interface DayDraft {
  key: number;
  date: string;
  name: string;
}
// Row keys (and the field ids built from them) come from a counter per form, not from module state:
// a module counter keeps counting across server renders, so the server's ids would not match the client's
// and React keeps the server's id attributes on hydration, which gave two rows the same id.
const newDay = (key: number): DayDraft => ({ key, date: '', name: '' });

function AddCalendar({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const entities = useOrg('legal-entities');
  const locations = useOrg('locations');
  const action = useAction();
  const [name, setName] = React.useState('');
  const [entityId, setEntityId] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const nextKey = React.useRef(1);
  const [days, setDays] = React.useState<DayDraft[]>(() => [newDay(0)]);
  const setDay = (key: number, patch: Partial<DayDraft>) =>
    setDays((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      name: name.trim(),
      entityId: entityId || null,
      locationId: locationId || null,
      days: days.filter((x) => x.date).map((x) => ({ date: x.date, name: x.name.trim() })),
    };
    if (
      await action.run(
        () =>
          api('/v1/settings/company-calendars', {
            method: 'POST',
            json: body,
            capability: 'settings.calendars',
          }),
        t('admin.calendars.created'),
      )
    ) {
      setName('');
      setDays([newDay(nextKey.current++)]);
      onCreated();
    }
  }

  return (
    <SettingsCard
      id="calendar-add"
      title={t('admin.calendars.addTitle')}
      description={t('admin.calendars.addBody')}
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="cal-name" label={t('admin.name')}>
            {(p) => (
              <Input {...p} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field id="cal-entity" label={t('admin.leave.entity')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
              >
                <option value="">{t('admin.allEntities')}</option>
                {(entities.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="cal-location" label={t('rota.location')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">{t('rota.allLocations')}</option>
                {(locations.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-callout font-semibold">{t('admin.calendars.days')}</legend>
          <ol className="flex flex-col gap-3">
            {days.map((x, i) => (
              <li
                key={x.key}
                className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
              >
                <Field id={`day-${x.key}-date`} label={t('admin.calendars.dateN', { n: i + 1 })}>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      required
                      value={x.date}
                      onChange={(e) => setDay(x.key, { date: e.target.value })}
                    />
                  )}
                </Field>
                <Field id={`day-${x.key}-name`} label={t('admin.calendars.dayName', { n: i + 1 })}>
                  {(p) => (
                    <Input
                      {...p}
                      required
                      maxLength={120}
                      value={x.name}
                      onChange={(e) => setDay(x.key, { name: e.target.value })}
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('admin.calendars.removeDay', { n: i + 1 })}
                  disabled={days.length === 1}
                  onClick={() => setDays((xs) => xs.filter((y) => y.key !== x.key))}
                >
                  <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                </Button>
              </li>
            ))}
          </ol>
          {days.length < 366 ? (
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              onClick={() => setDays((xs) => [...xs, newDay(nextKey.current++)])}
            >
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('admin.calendars.addDay')}
            </Button>
          ) : null}
        </fieldset>
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          {t('admin.calendars.add')}
        </Button>
      </form>
    </SettingsCard>
  );
}

/** Company closure days (on top of public holidays), for everyone, an entity or a location. */
export default function CalendarsPage() {
  const t = useT();
  const sec = useSectionLevel();
  const fmt = useFormat();
  const calendars = useApi<Calendar[]>('/v1/settings/company-calendars');
  const entities = useOrg('legal-entities');
  const locations = useOrg('locations');
  const scope = (c: Calendar) =>
    [
      c.entityId ? entities.data?.find((x) => x.id === c.entityId)?.name : null,
      c.locationId ? locations.data?.find((x) => x.id === c.locationId)?.name : null,
    ]
      .filter(Boolean)
      .join(' · ') || t('admin.leave.everyone');
  return (
    <>
      <PageHeader title={t('admin.section.calendars.title')} lead={t('admin.calendars.lead')} />
      <SettingsCard
        id="calendars"
        title={t('admin.calendars.listTitle')}
        container={calendars.data?.length ? 'none' : 'card'}
      >
        {!calendars.data ? (
          <Skeleton className="h-24" />
        ) : calendars.data.length === 0 ? (
          <EmptyState
            level={sec.level}
            icon={<CalendarOff aria-hidden />}
            title={t('admin.calendars.none')}
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {calendars.data.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg bg-surface-raised p-4 shadow-sm">
                <sec.sub className="text-callout font-semibold">{c.name}</sec.sub>
                <p className="text-footnote text-text-secondary">{scope(c)}</p>
                <ul className="flex flex-col gap-1 text-callout">
                  {c.days.map((d) => (
                    <li key={d.date} className="flex flex-wrap gap-2">
                      <span className="tabular-nums">{fmt.date(d.date)}</span>
                      <span className="text-text-secondary">{d.name}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <AddCalendar onCreated={calendars.reload} />
    </>
  );
}
