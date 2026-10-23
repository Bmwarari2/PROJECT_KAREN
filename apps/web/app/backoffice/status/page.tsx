'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Field,
  Input,
  Table,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass } from '../ui';

interface Post {
  id: string;
  kind: string;
  impact: string;
  title: string;
  components: string[];
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string;
  resolvedAt: string | null;
}
const COMPONENTS = ['api', 'database', 'worker', 'email'];

/** Incidents and maintenance for this cell's region, shown on the public status page (audited). */
export default function StatusAdmin() {
  const t = useT();
  const locale = useLocale() as Locale;
  const toast = useToast();
  const posts = useApi<Post[]>('/v1/backoffice/status/incidents');
  const [f, setF] = React.useState({
    kind: 'incident',
    impact: 'minor',
    title: '',
    body: '',
    components: ['api'] as string[],
    start: '',
    end: '',
  });
  const [updates, setUpdates] = React.useState<Record<string, { status: string; body: string }>>({});
  const [busy, setBusy] = React.useState(false);
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      posts.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const toIso = (local: string) => (local ? new Date(`${local}:00Z`).toISOString() : undefined);
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.status.title')} lead={t('backoffice.status.lead')}>
        <Link href="/status" className="text-callout">
          {t('backoffice.status.viewPublic')}
        </Link>
      </PageTitle>
      <Card>
        <CardTitle>{t('backoffice.status.newTitle')}</CardTitle>
        <form
          className="mt-4 grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api('/v1/backoffice/status/incidents', {
                  method: 'POST',
                  json: {
                    kind: f.kind,
                    impact: f.kind === 'maintenance' ? 'maintenance' : f.impact,
                    title: f.title,
                    body: f.body,
                    components: f.components,
                    ...(f.kind === 'maintenance'
                      ? { scheduledStart: toIso(f.start), scheduledEnd: toIso(f.end) }
                      : {}),
                  },
                }),
              t('backoffice.status.posted'),
            );
          }}
        >
          <Field id="s-kind" label={t('backoffice.status.kind')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={f.kind}
                onChange={(e) => setF({ ...f, kind: e.target.value })}
              >
                <option value="incident">{t('backoffice.status.incident')}</option>
                <option value="maintenance">{t('backoffice.status.maintenance')}</option>
              </select>
            )}
          </Field>
          {f.kind === 'incident' ? (
            <Field id="s-impact" label={t('backoffice.status.impact')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={f.impact}
                  onChange={(e) => setF({ ...f, impact: e.target.value })}
                >
                  {['minor', 'major', 'critical'].map((x) => (
                    <option key={x} value={x}>
                      {t(`backoffice.status.impacts.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="s-start" label={t('backoffice.status.startUtc')}>
                {(p) => (
                  <Input
                    {...p}
                    type="datetime-local"
                    required
                    value={f.start}
                    onChange={(e) => setF({ ...f, start: e.target.value })}
                  />
                )}
              </Field>
              <Field id="s-end" label={t('backoffice.status.endUtc')}>
                {(p) => (
                  <Input
                    {...p}
                    type="datetime-local"
                    required
                    value={f.end}
                    onChange={(e) => setF({ ...f, end: e.target.value })}
                  />
                )}
              </Field>
            </div>
          )}
          <Field id="s-title" label={t('backoffice.status.postTitle')} className="md:col-span-2">
            {(p) => (
              <Input
                {...p}
                required
                minLength={3}
                maxLength={160}
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
              />
            )}
          </Field>
          <fieldset className="flex flex-wrap gap-4 md:col-span-2">
            <legend className="mb-1 text-callout font-semibold">{t('backoffice.status.components')}</legend>
            {COMPONENTS.map((c) => (
              <label key={c} className="flex items-center gap-2 text-callout">
                <input
                  type="checkbox"
                  checked={f.components.includes(c)}
                  onChange={(e) =>
                    setF({
                      ...f,
                      components: e.target.checked
                        ? [...f.components, c]
                        : f.components.filter((x) => x !== c),
                    })
                  }
                />
                {t(`statusPage.components.${c}`)}
              </label>
            ))}
          </fieldset>
          <Field
            id="s-body"
            label={t('backoffice.status.message')}
            hint={t('backoffice.status.noPersonalData')}
            className="md:col-span-2"
          >
            {(p) => (
              <Textarea
                {...p}
                required
                value={f.body}
                onChange={(e) => setF({ ...f, body: e.target.value })}
              />
            )}
          </Field>
          <div className="md:col-span-2">
            <Button type="submit" loading={busy}>
              {t('backoffice.status.post')}
            </Button>
          </div>
        </form>
      </Card>
      <Table>
        <caption className="sr-only">{t('backoffice.status.title')}</caption>
        <THead>
          <tr>
            <TH>{t('backoffice.status.postTitle')}</TH>
            <TH>{t('common.status')}</TH>
            <TH>{t('backoffice.status.when')}</TH>
            <TH>{t('backoffice.status.update')}</TH>
          </tr>
        </THead>
        <tbody>
          {(posts.data ?? []).map((p) => {
            const u = updates[p.id] ?? {
              status: p.kind === 'maintenance' ? 'in_progress' : 'identified',
              body: '',
            };
            const options =
              p.kind === 'maintenance'
                ? ['scheduled', 'in_progress', 'completed']
                : ['investigating', 'identified', 'monitoring', 'resolved'];
            return (
              <TR key={p.id}>
                <TD>
                  {p.title} <Badge>{t(`backoffice.status.${p.kind}`)}</Badge>
                </TD>
                <TD>{t(`statusPage.postStatus.${p.status}`)}</TD>
                <TD className="text-footnote">
                  {p.resolvedAt ? when(p.resolvedAt) : when(p.scheduledStart ?? p.startedAt)}
                </TD>
                <TD>
                  {!p.resolvedAt ? (
                    <form
                      className="flex flex-wrap items-center gap-2 py-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(
                          () =>
                            api(`/v1/backoffice/status/incidents/${p.id}/updates`, {
                              method: 'POST',
                              json: u,
                            }),
                          t('backoffice.status.updated'),
                        );
                      }}
                    >
                      <label className="sr-only" htmlFor={`u-s-${p.id}`}>
                        {t('common.status')}
                      </label>
                      <select
                        id={`u-s-${p.id}`}
                        className={`${selectClass} w-auto`}
                        value={u.status}
                        onChange={(e) => setUpdates({ ...updates, [p.id]: { ...u, status: e.target.value } })}
                      >
                        {options.map((x) => (
                          <option key={x} value={x}>
                            {t(`statusPage.postStatus.${x}`)}
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor={`u-b-${p.id}`}>
                        {t('backoffice.status.message')}
                      </label>
                      <Input
                        id={`u-b-${p.id}`}
                        required
                        className="w-56"
                        value={u.body}
                        onChange={(e) => setUpdates({ ...updates, [p.id]: { ...u, body: e.target.value } })}
                      />
                      <Button size="sm" type="submit" loading={busy}>
                        {t('backoffice.status.postUpdate')}
                      </Button>
                    </form>
                  ) : null}
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
