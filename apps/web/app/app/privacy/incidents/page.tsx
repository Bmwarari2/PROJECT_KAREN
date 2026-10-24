'use client';
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Textarea,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../../shell';
import { SELECT_CLASS, type RuleRef } from '../types';

interface Deadline {
  jurisdiction: string;
  audience: string;
  body: string | null;
  dueAt: string | null;
  standard: string;
  required: boolean;
  minAffected: number | null;
  rule: RuleRef;
  notifiedAt: string | null;
  overdue: boolean;
}
interface Incident {
  id: string;
  source: string;
  title: string;
  severity: string;
  status: string;
  personalDataBreach: boolean;
  awareAt: string;
  affected: Record<string, number>;
  deadlines: Deadline[];
  unmodelled: string[];
}

/** "GB=40, US-CA=12" → { GB: 40, "US-CA": 12 } */
function parseAffected(s: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = /^([A-Za-z]{2}(?:-[A-Za-z0-9]{1,3})?)\s*[=:]\s*(\d+)$/.exec(part);
    if (!m) return null;
    out[m[1]!.toUpperCase()] = Number(m[2]);
  }
  return out;
}

export default function IncidentsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? 'UTC';
  const list = useApi<Incident[]>('/v1/privacy/incidents');
  const [form, setForm] = React.useState({
    title: '',
    description: '',
    awareAt: '',
    breach: true,
    affected: '',
  });
  const [busy, setBusy] = React.useState<string | null>(null);
  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
      tone: 'danger',
    });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const affected = parseAffected(form.affected);
    if (!affected) return toast({ title: t('privacy.ui.incidents.affectedInvalid'), tone: 'danger' });
    setBusy('create');
    try {
      await api('/v1/privacy/incidents', {
        method: 'POST',
        json: {
          title: form.title,
          description: form.description || undefined,
          personalDataBreach: form.breach,
          awareAt: new Date(form.awareAt).toISOString(),
          affected,
        },
      });
      toast({ title: t('privacy.ui.incidents.created'), tone: 'success' });
      setForm({ title: '', description: '', awareAt: '', breach: true, affected: '' });
      list.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function markNotified(i: Incident, d: Deadline) {
    setBusy(`${i.id}-${d.jurisdiction}-${d.audience}`);
    try {
      await api(`/v1/privacy/incidents/${i.id}/notifications`, {
        method: 'POST',
        json: { jurisdiction: d.jurisdiction, audience: d.audience, notifiedAt: new Date().toISOString() },
      });
      list.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageSection
        headingLevel={2}
        title={t('privacy.ui.incidents.newTitle')}
        description={t('privacy.ui.incidents.newLead')}
      >
        <Card>
          <form onSubmit={create} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field id="inc-title" label={t('privacy.ui.incidents.titleField')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  minLength={3}
                  maxLength={200}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              )}
            </Field>
            <Field
              id="inc-aware"
              label={t('privacy.ui.incidents.awareAt')}
              hint={t('privacy.ui.incidents.awareHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  required
                  value={form.awareAt}
                  onChange={(e) => setForm({ ...form, awareAt: e.target.value })}
                />
              )}
            </Field>
            <Field
              id="inc-affected"
              label={t('privacy.ui.incidents.affected')}
              hint={t('privacy.ui.incidents.affectedHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.affected}
                  onChange={(e) => setForm({ ...form, affected: e.target.value })}
                />
              )}
            </Field>
            <Field id="inc-breach" label={t('privacy.ui.incidents.type')}>
              {(p) => (
                <select
                  {...p}
                  className={`${SELECT_CLASS} w-full`}
                  value={form.breach ? 'yes' : 'no'}
                  onChange={(e) => setForm({ ...form, breach: e.target.value === 'yes' })}
                >
                  <option value="yes">{t('privacy.ui.incidents.breach')}</option>
                  <option value="no">{t('privacy.ui.incidents.notBreach')}</option>
                </select>
              )}
            </Field>
            <Field
              id="inc-description"
              label={t('privacy.ui.incidents.description')}
              className="md:col-span-2"
            >
              {(p) => (
                <Textarea
                  {...p}
                  rows={3}
                  maxLength={10000}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              )}
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" loading={busy === 'create'}>
                <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('privacy.ui.incidents.log')}
              </Button>
            </div>
          </form>
        </Card>
      </PageSection>

      {!list.data ? (
        <Skeleton className="h-40" />
      ) : list.data.length ? (
        list.data.map((i) => (
          <Card key={i.id} aria-labelledby={`inc-${i.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={`inc-${i.id}`} className="mr-auto text-title-3">
                {i.title}
              </h2>
              {i.source === 'processor' ? (
                <Badge tone="accent">{t('privacy.ui.incidents.fromProcessor')}</Badge>
              ) : null}
              <Badge tone={i.status === 'closed' ? 'neutral' : 'warning'}>
                {t(`privacy.ui.incidents.status.${i.status}`)}
              </Badge>
            </div>
            <p className="mt-1 text-footnote text-text-secondary">
              {t('privacy.ui.incidents.awareLine', { at: formatDateTime(i.awareAt, locale, zone) })}
            </p>
            {i.personalDataBreach ? (
              <ul className="mt-3 grid gap-2">
                {i.deadlines
                  .filter((d) => d.required)
                  .map((d) => (
                    <li
                      key={`${d.jurisdiction}-${d.audience}`}
                      className="flex flex-wrap items-center gap-2 text-callout"
                    >
                      {d.notifiedAt ? (
                        <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5] text-success" />
                      ) : d.overdue ? (
                        <AlertTriangle aria-hidden className="h-4 w-4 stroke-[1.5] text-danger" />
                      ) : null}
                      <span>
                        {t(`privacy.ui.incidents.audience.${d.audience}`, {
                          jurisdiction: d.jurisdiction,
                          body: d.body ?? '',
                        })}
                        {': '}
                        {d.dueAt
                          ? t('privacy.ui.incidents.dueBy', { at: formatDateTime(d.dueAt, locale, zone) })
                          : d.standard}
                      </span>
                      {d.overdue ? <Badge tone="danger">{t('privacy.ui.overdue')}</Badge> : null}
                      <a
                        href={d.rule.source.url}
                        rel="noopener noreferrer"
                        target="_blank"
                        className="text-footnote"
                      >
                        {t('privacy.ui.incidents.source')}
                      </a>
                      {!d.notifiedAt && i.status !== 'closed' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === `${i.id}-${d.jurisdiction}-${d.audience}`}
                          onClick={() => markNotified(i, d)}
                        >
                          {t('privacy.ui.incidents.markNotified')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                {i.unmodelled.length ? (
                  <li className="text-callout text-warning">
                    {t('privacy.ui.incidents.unmodelled', { list: i.unmodelled.join(', ') })}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </Card>
        ))
      ) : (
        <EmptyState
          icon={<CheckCircle2 aria-hidden className="h-8 w-8 stroke-[1.5]" />}
          title={t('privacy.ui.incidents.empty')}
        />
      )}
    </div>
  );
}
