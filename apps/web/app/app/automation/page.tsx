'use client';
import * as React from 'react';
import { Zap } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, Skeleton, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { type: string };
  actions: Array<{ type: string }>;
}

export default function AutomationPage() {
  const t = useT();
  const toast = useToast();
  const { data, reload } = useApi<Rule[]>('/v1/automation/rules');
  const [name, setName] = React.useState('');
  const [trigger, setTrigger] = React.useState('record.created');
  const [title, setTitle] = React.useState('');
  const [dry, setDry] = React.useState<Record<string, string>>({});

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trig =
      trigger === 'date.reached'
        ? { type: 'date.reached', dateField: 'workAnniversary', offsetDays: 0 }
        : trigger === 'document.expiring'
          ? { type: 'document.expiring', offsetDays: 30 }
          : { type: trigger, entity: 'employee' };
    try {
      await api('/v1/automation/rules', {
        method: 'POST',
        json: {
          name,
          trigger: trig,
          actions: [{ type: 'task', title, assignee: { type: 'role', value: 'hr_admin' }, dueInDays: 7 }],
        },
      });
      setName('');
      setTitle('');
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    }
  }

  async function dryRun(id: string) {
    const r = await api<{ matched: boolean; candidates: number; actions: unknown[] }>(
      `/v1/automation/rules/${id}/dry-run`,
      { method: 'POST', json: {} },
    );
    setDry((d) => ({
      ...d,
      [id]: t('automation.dryResult', {
        people: t('automation.dryPeople', { count: r.candidates }),
        actions: t('automation.dryActions', { count: r.actions.length }),
      }),
    }));
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('automation.title')}</h1>
      <Card>
        <CardTitle>{t('automation.new')}</CardTitle>
        <form onSubmit={create} className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
          <Field id="name" label={t('automation.name')}>
            {(p) => <Input {...p} required value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field id="trigger" label={t('automation.trigger')}>
            {(p) => (
              <select
                {...p}
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
              >
                {['record.created', 'record.changed', 'date.reached', 'document.expiring'].map((x) => (
                  <option key={x} value={x}>
                    {t(`automation.triggers.${x}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="title" label={t('automation.taskTitle')}>
            {(p) => <Input {...p} required value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Button type="submit">{t('common.add')}</Button>
        </form>
      </Card>
      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : data.length === 0 ? (
        <EmptyState icon={<Zap aria-hidden />} title={t('automation.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <Zap aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
              <span className="text-callout font-semibold">{r.name}</span>
              <Badge>{t(`automation.triggers.${r.trigger.type}`)}</Badge>
              <Badge tone={r.enabled ? 'success' : 'neutral'}>
                {r.enabled ? t('automation.on') : t('automation.off')}
              </Badge>
              <span className="ml-auto text-footnote text-text-secondary">{dry[r.id]}</span>
              <Button size="sm" variant="secondary" onClick={() => dryRun(r.id)}>
                {t('automation.dryRun')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
