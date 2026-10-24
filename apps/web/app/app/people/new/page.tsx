'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, nativeSelectClass, PageSection, useToast } from '@thapsus/ui';
import { parseDecimal } from '@thapsus/core/money';
import { today } from '@thapsus/core/time';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/zone';
import { PageTitle, useSession } from '../../shell';

interface Ref {
  id: string;
  name: string;
  currency?: string;
}

export default function NewEmployeePage() {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const session = useSession();
  const entities = useApi<Ref[]>('/v1/org/legal-entities');
  const departments = useApi<Ref[]>('/v1/org/departments');
  const locations = useApi<Ref[]>('/v1/org/locations');
  const [v, setV] = React.useState<Record<string, string>>({
    startDate: today(viewerZone(session?.timeZone)),
    payFrequency: 'annual',
    contractType: 'permanent',
    employmentType: 'full_time',
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const entity = entities.data?.find((x) => x.id === v.entityId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const currency = entity?.currency ?? 'GBP';
      // money: the decimal amount → integer minor units for the entity's currency (no floating point)
      const body: Record<string, unknown> = {
        ...v,
        payCurrency: currency,
        payAmountMinor: Number(parseDecimal(v.salary || '0', currency).amountMinor),
      };
      delete body.salary;
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      const r = await api<{ id: string }>('/v1/employees', { method: 'POST', json: body });
      toast({ title: t('people.hired'), tone: 'success' });
      router.push(`/app/people/${r.id}`);
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const select = (id: string, label: string, opts: Ref[] | undefined, required = false) => (
    <Field id={id} label={label}>
      {(p) => (
        <select
          {...p}
          required={required}
          value={v[id] ?? ''}
          onChange={set(id)}
          className={nativeSelectClass}
        >
          <option value="">{t('common.none')}</option>
          {(opts ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} className="flex max-w-[var(--prose-width)] flex-col gap-6">
      <PageTitle>{t('people.add')}</PageTitle>
      <PageSection headingLevel={3} title={t('people.section.personal')}>
        <Card className="grid gap-4 md:grid-cols-2">
          <Field id="legalFirstName" label={t('people.field.legalFirstName')}>
            {(p) => <Input {...p} required value={v.legalFirstName ?? ''} onChange={set('legalFirstName')} />}
          </Field>
          <Field id="legalLastName" label={t('people.field.legalLastName')}>
            {(p) => <Input {...p} required value={v.legalLastName ?? ''} onChange={set('legalLastName')} />}
          </Field>
          <Field id="workEmail" label={t('people.field.workEmail')}>
            {(p) => <Input {...p} type="email" value={v.workEmail ?? ''} onChange={set('workEmail')} />}
          </Field>
          <Field id="startDate" label={t('people.field.startDate')}>
            {(p) => <Input {...p} type="date" required value={v.startDate} onChange={set('startDate')} />}
          </Field>
        </Card>
      </PageSection>
      <PageSection headingLevel={3} title={t('people.section.job')}>
        <Card className="grid gap-4 md:grid-cols-2">
          <Field id="jobTitle" label={t('people.field.jobTitle')}>
            {(p) => <Input {...p} required value={v.jobTitle ?? ''} onChange={set('jobTitle')} />}
          </Field>
          {select('entityId', t('people.field.entity'), entities.data, true)}
          {select('departmentId', t('people.field.department'), departments.data)}
          {select('locationId', t('people.field.location'), locations.data)}
          <Field id="weeklyHours" label={t('people.field.weeklyHours')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                step="0.5"
                value={v.weeklyHours ?? ''}
                onChange={set('weeklyHours')}
              />
            )}
          </Field>
          <Field id="salary" label={t('people.field.payAmountMinor')} hint={entity?.currency}>
            {(p) => (
              <Input
                {...p}
                type="number"
                step="0.01"
                min="0"
                required
                value={v.salary ?? ''}
                onChange={set('salary')}
              />
            )}
          </Field>
        </Card>
      </PageSection>
      <Button type="submit" loading={busy} className="self-start">
        {t('people.hire')}
      </Button>
    </form>
  );
}
