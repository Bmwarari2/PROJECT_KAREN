'use client';
import * as React from 'react';
import { Zap } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  ListItem,
  Skeleton,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ListCard, PageIntro } from '@/components/module-page';

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
      <PageIntro title={t('automation.title')} titleIsTab lead={t('automation.lead')} />
      <PageSection headingLevel={2} title={t('automation.new')}>
        <Card>
          <form onSubmit={create} className="grid gap-3 md:grid-cols-4 md:items-end">
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
      </PageSection>
      <ListCard
        title={t('automation.list.title')}
        count={data ? t('automation.list.count', { count: data.length }) : undefined}
        empty={
          !data ? (
            <Skeleton className="h-40 w-full" />
          ) : data.length === 0 ? (
            <EmptyState level={3} icon={<Zap aria-hidden />} title={t('automation.empty')} />
          ) : undefined
        }
      >
        {/* grouped rows (ADR-0180): the rule's name takes the width; the dry run sits under it on phones */}
        <ul role="list" aria-label={t('automation.list.title')}>
          {(data ?? []).map((r) => (
            <ListItem
              key={r.id}
              leading={<Zap aria-hidden />}
              title={r.name}
              subtitle={t(`automation.triggers.${r.trigger.type}`)}
              meta={dry[r.id] || undefined}
              accessory={
                <Badge tone={r.enabled ? 'success' : 'neutral'}>
                  {r.enabled ? t('automation.on') : t('automation.off')}
                </Badge>
              }
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => dryRun(r.id)}
                  aria-label={t('actionable.automation.dryRunNamed', { name: r.name })}
                >
                  {t('automation.dryRun')}
                </Button>
              }
            />
          ))}
        </ul>
      </ListCard>
    </div>
  );
}
