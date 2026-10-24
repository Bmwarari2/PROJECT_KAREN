'use client';
import * as React from 'react';
import { Webhook } from 'lucide-react';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  errorText,
  FeatureOff,
  PageHeader,
  SecretOnce,
  StatusBadge,
  useDateTime,
} from '@/components/platform';
import { useFeature } from '../../shell';
import { useSectionLevel } from '@/components/module-page';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: 'active' | 'disabled';
  secrets: Array<{ id: string; createdAt: string; expiresAt: string | null }>;
  createdAt: string;
}
interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastResponseStatus: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
}
type Page<T> = { data: T[]; nextCursor: string | null };

function DeliveryLog({ endpoint }: { endpoint: Endpoint }) {
  const t = useT();
  const toast = useToast();
  const when = useDateTime();
  const log = useApi<Page<Delivery>>(`/v1/webhooks/${endpoint.id}/deliveries?limit=50`);
  async function replay(d: Delivery) {
    try {
      await api(`/v1/webhooks/deliveries/${d.id}/replay`, {
        method: 'POST',
        capability: 'settings.webhooks',
      });
      toast({ title: t('platform.webhooks.replayed'), tone: 'success' });
      log.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }
  if (log.data && !log.data.data.length)
    return <p className="text-footnote text-text-secondary">{t('platform.webhooks.noDeliveries')}</p>;
  return (
    <Table dense>
      <caption className="sr-only">{t('platform.webhooks.logCaption', { url: endpoint.url })}</caption>
      <THead>
        <tr>
          <TH>{t('platform.webhooks.event')}</TH>
          <TH>{t('common.status')}</TH>
          <TH>{t('platform.webhooks.attempts')}</TH>
          <TH>{t('platform.webhooks.response')}</TH>
          <TH>{t('platform.webhooks.duration')}</TH>
          <TH>{t('platform.webhooks.createdAt')}</TH>
          <TH>
            <span className="sr-only">{t('common.actions')}</span>
          </TH>
        </tr>
      </THead>
      <tbody>
        {(log.data?.data ?? []).map((d) => (
          <TR key={d.id}>
            <TD className="text-footnote">
              <code>{d.eventType}</code>
              {d.replayOf ? (
                <span className="ml-2 text-text-secondary">{t('platform.webhooks.replay')}</span>
              ) : null}
            </TD>
            <TD phone="inline">
              <StatusBadge status={d.status} />
            </TD>
            <TD className="tabular-nums" phone="inline" label={t('platform.webhooks.attempts')}>
              {d.attempts}
            </TD>
            <TD className="tabular-nums text-footnote" label={t('platform.webhooks.response')}>
              {d.lastResponseStatus ?? d.lastError ?? '—'}
            </TD>
            <TD className="tabular-nums text-footnote" phone="inline" label={t('platform.webhooks.duration')}>
              {d.lastDurationMs === null ? '—' : t('platform.webhooks.ms', { ms: d.lastDurationMs })}
            </TD>
            <TD className="text-footnote" phone="inline">
              {when(d.createdAt)}
            </TD>
            <TD>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => replay(d)}
                aria-label={t('platform.webhooks.replayNamed', { event: d.eventType })}
              >
                {t('platform.webhooks.replayAction')}
              </Button>
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

export default function WebhooksPage() {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const enabled = useFeature('webhooks');
  const endpoints = useApi<Page<Endpoint>>(enabled ? '/v1/webhooks?limit=200' : null);
  const eventTypes = useApi<string[]>(enabled ? '/v1/webhooks/event-types' : null);
  const [url, setUrl] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [events, setEvents] = React.useState<string[]>(['employee.*']);
  const [secret, setSecret] = React.useState<{ title: string; value: string } | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!enabled)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('platform.webhooks.title')} />
        <FeatureOff />
      </div>
    );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<Endpoint & { secret: string }>('/v1/webhooks', {
        method: 'POST',
        json: { url: url.trim(), eventTypes: events, description: description || undefined },
        capability: 'settings.webhooks',
      });
      setSecret({ title: t('platform.webhooks.createdTitle'), value: r.secret });
      setUrl('');
      setDescription('');
      endpoints.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function act(ep: Endpoint, action: 'ping' | 'rotate' | 'toggle' | 'delete') {
    try {
      if (action === 'ping') {
        await api(`/v1/webhooks/${ep.id}/ping`, { method: 'POST', capability: 'settings.webhooks' });
        toast({ title: t('platform.webhooks.pinged'), tone: 'success' });
      } else if (action === 'rotate') {
        const r = await api<{ secret: string }>(`/v1/webhooks/${ep.id}/rotate-secret`, {
          method: 'POST',
          json: { graceHours: 24 },
          capability: 'settings.webhooks',
        });
        setSecret({ title: t('platform.webhooks.rotated'), value: r.secret });
      } else if (action === 'toggle') {
        await api(`/v1/webhooks/${ep.id}`, {
          method: 'PATCH',
          json: { status: ep.status === 'active' ? 'disabled' : 'active' },
          capability: 'settings.webhooks',
        });
      } else {
        await api(`/v1/webhooks/${ep.id}`, { method: 'DELETE', capability: 'settings.webhooks' });
      }
      endpoints.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }

  const options = [...new Set(['*', 'employee.*', ...(eventTypes.data ?? [])])];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.webhooks.title')} lead={t('platform.webhooks.lead')} />
      {secret ? (
        <SecretOnce
          title={secret.title}
          items={[{ label: t('platform.webhooks.signingSecret'), value: secret.value }]}
          onDone={() => setSecret(null)}
        />
      ) : null}

      <PageSection headingLevel={sec.level} title={t('platform.webhooks.createTitle')}>
        <Card>
          <form onSubmit={create} className="flex flex-col gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="wh-url" label={t('platform.webhooks.url')} hint={t('platform.webhooks.urlHint')}>
                {(p) => (
                  <Input
                    {...p}
                    type="url"
                    required
                    inputMode="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                )}
              </Field>
              <Field id="wh-desc" label={t('platform.webhooks.description')}>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={300}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-callout font-semibold">{t('platform.webhooks.events')}</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {options.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-callout">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--color-accent)]"
                      checked={events.includes(ev)}
                      onChange={(e) =>
                        setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))
                      }
                    />
                    <code className="text-footnote">{ev}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <Button type="submit" loading={busy} disabled={!events.length}>
                {t('platform.webhooks.create')}
              </Button>
            </div>
          </form>
        </Card>
      </PageSection>

      {endpoints.data && !endpoints.data.data.length ? (
        <Card>
          <EmptyState
            level={sec.level}
            icon={<Webhook aria-hidden />}
            title={t('platform.webhooks.none')}
            body={t('platform.webhooks.noneBody')}
          />
        </Card>
      ) : null}
      {(endpoints.data?.data ?? []).map((ep) => (
        <Card key={ep.id}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="mr-auto min-w-0">
              <CardTitle as={sec.heading} className="break-all">
                {ep.url}
              </CardTitle>
              <p className="mt-1 text-footnote text-text-secondary">
                {ep.description ? `${ep.description} · ` : ''}
                {ep.eventTypes.join(', ')}
              </p>
              <p className="mt-1 text-footnote text-text-secondary">
                {t('platform.webhooks.secretCount', {
                  n: ep.secrets.filter((s) => !s.expiresAt || new Date(s.expiresAt) > new Date()).length,
                })}
              </p>
            </div>
            <StatusBadge status={ep.status} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act(ep, 'ping')}
              disabled={ep.status !== 'active'}
            >
              {t('platform.webhooks.ping')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act(ep, 'rotate')}>
              {t('platform.webhooks.rotate')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act(ep, 'toggle')}>
              {t(ep.status === 'active' ? 'platform.webhooks.disable' : 'platform.webhooks.enable')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={open === ep.id}
              aria-controls={`log-${ep.id}`}
              onClick={() => setOpen(open === ep.id ? null : ep.id)}
            >
              {t('platform.webhooks.log')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => act(ep, 'delete')}>
              {t('common.delete')}
            </Button>
          </div>
          {open === ep.id ? (
            // the log runs to the card's edges, so it is part of the card rather than a box inside it
            <div
              id={`log-${ep.id}`}
              data-flush
              className="-mx-5 -mb-5 mt-4 border-t border-border [&>div]:rounded-t-none [&>div]:border-0 [&>p]:px-5 [&>p]:py-4"
            >
              <DeliveryLog endpoint={ep} />
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
