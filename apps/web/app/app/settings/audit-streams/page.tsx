'use client';
import * as React from 'react';
import { Radio } from 'lucide-react';
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

interface Stream {
  id: string;
  name: string;
  kind: 'https' | 's3';
  url: string | null;
  s3: { bucket: string; prefix: string; region: string; roleArn: string; externalId: string } | null;
  filters: { actions?: string[]; sensitiveOnly?: boolean; actorTypes?: string[] };
  cursorSeq: string;
  status: 'active' | 'paused';
  lastDeliveredAt: string | null;
  lastError: string | null;
}
interface Batch {
  id: string;
  fromSeq: string;
  toSeq: string;
  eventCount: number;
  status: string;
  attempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  objectKey: string | null;
  createdAt: string;
}
type Page<T> = { data: T[]; nextCursor: string | null };

function Batches({ stream }: { stream: Stream }) {
  const t = useT();
  const when = useDateTime();
  const log = useApi<Page<Batch>>(`/v1/settings/audit-streams/${stream.id}/batches?limit=50`);
  if (log.data && !log.data.data.length)
    return <p className="text-footnote text-text-secondary">{t('platform.streams.noBatches')}</p>;
  return (
    <Table dense>
      <caption className="sr-only">{t('platform.streams.logCaption', { name: stream.name })}</caption>
      <THead>
        <tr>
          <TH>{t('platform.streams.range')}</TH>
          <TH>{t('platform.streams.events')}</TH>
          <TH>{t('common.status')}</TH>
          <TH>{t('platform.webhooks.attempts')}</TH>
          <TH>{t('platform.webhooks.duration')}</TH>
          <TH>{t('platform.webhooks.createdAt')}</TH>
        </tr>
      </THead>
      <tbody>
        {(log.data?.data ?? []).map((b) => (
          <TR key={b.id}>
            <TD className="tabular-nums text-footnote">{`${b.fromSeq}–${b.toSeq}`}</TD>
            <TD className="tabular-nums">{b.eventCount}</TD>
            <TD>
              <StatusBadge status={b.status} />
            </TD>
            <TD className="tabular-nums">{b.attempts}</TD>
            <TD className="tabular-nums text-footnote">
              {b.durationMs === null ? '—' : t('platform.webhooks.ms', { ms: b.durationMs })}
            </TD>
            <TD className="text-footnote">{when(b.createdAt)}</TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

export default function AuditStreamsPage() {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const when = useDateTime();
  const enabled = useFeature('auditStreaming');
  const streams = useApi<Page<Stream>>(enabled ? '/v1/settings/audit-streams' : null);
  const [kind, setKind] = React.useState<'https' | 's3'>('https');
  const [form, setForm] = React.useState({
    name: '',
    url: '',
    bucket: '',
    prefix: '',
    roleArn: '',
    actions: '',
    sensitiveOnly: false,
    backfill: false,
  });
  const [created, setCreated] = React.useState<{
    title: string;
    items: Array<{ label: string; value: string }>;
  } | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!enabled)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('platform.streams.title')} />
        <FeatureOff />
      </div>
    );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const actions = form.actions
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    const filters = {
      ...(actions.length ? { actions } : {}),
      ...(form.sensitiveOnly ? { sensitiveOnly: true } : {}),
    };
    try {
      const body =
        kind === 'https'
          ? {
              name: form.name,
              kind,
              url: form.url.trim(),
              filters,
              startFrom: form.backfill ? 'beginning' : 'now',
            }
          : {
              name: form.name,
              kind,
              bucket: form.bucket.trim(),
              prefix: form.prefix.trim() || undefined,
              roleArn: form.roleArn.trim(),
              filters,
              startFrom: form.backfill ? 'beginning' : 'now',
            };
      const r = await api<Stream & { secret: string | null }>('/v1/settings/audit-streams', {
        method: 'POST',
        json: body,
        capability: 'settings.streams',
      });
      setCreated(
        r.kind === 'https'
          ? {
              title: t('platform.streams.created'),
              items: [{ label: t('platform.webhooks.signingSecret'), value: r.secret! }],
            }
          : {
              title: t('platform.streams.createdS3'),
              items: [
                { label: t('platform.streams.externalId'), value: r.s3!.externalId },
                { label: t('platform.streams.region'), value: r.s3!.region },
              ],
            },
      );
      setForm({ ...form, name: '', url: '', bucket: '', prefix: '', roleArn: '' });
      streams.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function act(s: Stream, action: 'toggle' | 'sync' | 'delete') {
    try {
      if (action === 'toggle')
        await api(`/v1/settings/audit-streams/${s.id}`, {
          method: 'PATCH',
          json: { status: s.status === 'active' ? 'paused' : 'active' },
          capability: 'settings.streams',
        });
      else if (action === 'sync') {
        await api(`/v1/settings/audit-streams/${s.id}/sync`, {
          method: 'POST',
          capability: 'settings.streams',
        });
        toast({ title: t('platform.streams.syncQueued'), tone: 'success' });
      } else
        await api(`/v1/settings/audit-streams/${s.id}`, { method: 'DELETE', capability: 'settings.streams' });
      streams.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.streams.title')} lead={t('platform.streams.lead')} />
      {created ? (
        <SecretOnce title={created.title} items={created.items} onDone={() => setCreated(null)} />
      ) : null}
      <PageSection headingLevel={sec.level} title={t('platform.streams.createTitle')}>
        <Card>
          <form onSubmit={create} className="flex flex-col gap-4">
            <fieldset className="flex flex-wrap gap-4">
              <legend className="mb-2 text-callout font-semibold">{t('platform.streams.destination')}</legend>
              {(['https', 's3'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-callout">
                  <input
                    type="radio"
                    name="stream-kind"
                    value={k}
                    checked={kind === k}
                    onChange={() => setKind(k)}
                    className="h-5 w-5 accent-[var(--color-accent)]"
                  />
                  {t(`platform.streams.kind_${k}`)}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="st-name" label={t('platform.api.name')}>
                {(p) => <Input {...p} required maxLength={120} value={form.name} onChange={set('name')} />}
              </Field>
              {kind === 'https' ? (
                <Field id="st-url" label={t('platform.webhooks.url')} hint={t('platform.webhooks.urlHint')}>
                  {(p) => <Input {...p} type="url" required value={form.url} onChange={set('url')} />}
                </Field>
              ) : (
                <>
                  <Field
                    id="st-bucket"
                    label={t('platform.streams.bucket')}
                    hint={t('platform.streams.bucketHint')}
                  >
                    {(p) => <Input {...p} required value={form.bucket} onChange={set('bucket')} />}
                  </Field>
                  <Field id="st-prefix" label={t('platform.streams.prefix')}>
                    {(p) => <Input {...p} value={form.prefix} onChange={set('prefix')} />}
                  </Field>
                  <Field
                    id="st-role"
                    label={t('platform.streams.roleArn')}
                    hint={t('platform.streams.roleArnHint')}
                  >
                    {(p) => <Input {...p} required value={form.roleArn} onChange={set('roleArn')} />}
                  </Field>
                </>
              )}
              <Field
                id="st-actions"
                label={t('platform.streams.actions')}
                hint={t('platform.streams.actionsHint')}
              >
                {(p) => <Input {...p} value={form.actions} onChange={set('actions')} />}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-callout">
              <input
                type="checkbox"
                className="h-5 w-5 accent-[var(--color-accent)]"
                checked={form.sensitiveOnly}
                onChange={set('sensitiveOnly')}
              />
              {t('platform.streams.sensitiveOnly')}
            </label>
            <label className="flex items-center gap-2 text-callout">
              <input
                type="checkbox"
                className="h-5 w-5 accent-[var(--color-accent)]"
                checked={form.backfill}
                onChange={set('backfill')}
              />
              {t('platform.streams.backfill')}
            </label>
            <div>
              <Button type="submit" loading={busy}>
                {t('platform.streams.create')}
              </Button>
            </div>
          </form>
        </Card>
      </PageSection>

      {streams.data && !streams.data.data.length ? (
        <EmptyState level={sec.level} icon={<Radio aria-hidden />} title={t('platform.streams.none')} />
      ) : null}
      {(streams.data?.data ?? []).map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="mr-auto min-w-0">
              <CardTitle as={sec.heading}>{s.name}</CardTitle>
              <p className="mt-1 break-all text-footnote text-text-secondary">
                {s.kind === 'https' ? s.url : `s3://${s.s3!.bucket}/${s.s3!.prefix} (${s.s3!.region})`}
              </p>
              <p className="mt-1 text-footnote text-text-secondary">
                {t('platform.streams.cursor', { seq: s.cursorSeq })} ·{' '}
                {t('platform.streams.lastDelivered', { when: when(s.lastDeliveredAt) })}
              </p>
              {s.lastError ? (
                <p className="mt-1 text-footnote text-danger">
                  {t('platform.streams.lastError', { error: s.lastError })}
                </p>
              ) : null}
            </div>
            <StatusBadge status={s.status} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act(s, 'sync')}
              disabled={s.status !== 'active'}
            >
              {t('platform.streams.syncNow')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act(s, 'toggle')}>
              {t(s.status === 'active' ? 'platform.streams.pause' : 'platform.streams.resume')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={open === s.id}
              aria-controls={`batches-${s.id}`}
              onClick={() => setOpen(open === s.id ? null : s.id)}
            >
              {t('platform.webhooks.log')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => act(s, 'delete')}>
              {t('common.delete')}
            </Button>
          </div>
          {open === s.id ? (
            <div id={`batches-${s.id}`} className="mt-4">
              <Batches stream={s} />
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
