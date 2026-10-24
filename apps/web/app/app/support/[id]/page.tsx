'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { Badge, Button, Card, Field, Skeleton, Textarea, useToast } from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle, useSession } from '../../shell';
import { slaTone, type TicketSummary } from '../ui';

interface Thread {
  ticket: TicketSummary;
  messages: Array<{
    id: string;
    authorType: string;
    authorName: string | null;
    body: string;
    createdAt: string;
  }>;
  attachments: Array<{
    id: string;
    messageId: string | null;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    createdAt: string;
  }>;
}

export default function TicketPage() {
  const t = useT();
  const sec = useSectionLevel();
  const locale = useLocale() as Locale;
  const session = useSession();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const thread = useApi<Thread>(`/v1/support/tickets/${id}`);
  const [reply, setReply] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const tz = session?.timeZone ?? 'UTC';
  const tk = thread.data?.ticket;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast({ title: ok, tone: 'success' });
      thread.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const download = (attachmentId: string) =>
    run(async () => {
      const { url } = await api<{ url: string }>(`/v1/support/tickets/${id}/attachments/${attachmentId}`);
      window.open(url, '_blank', 'noopener');
    });
  const attach = (file: File) =>
    run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      await api(`/v1/support/tickets/${id}/attachments`, {
        method: 'POST',
        body: fd,
        capability: 'help.support',
      });
    }, t('support.attached'));

  if (!tk) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/support" className="inline-flex items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('support.back')}
      </Link>
      <div className="flex flex-col gap-2">
        <p className="text-footnote text-text-secondary">{tk.reference}</p>
        <PageTitle>{tk.subject}</PageTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{t(`support.statuses.${tk.status}`)}</Badge>
          <Badge>{t(`support.priorities.${tk.priority}`)}</Badge>
          <Badge tone={slaTone(tk.sla.flag)}>{t(`support.slaStates.${tk.sla.flag}`)}</Badge>
        </div>
        <dl className="mt-2 grid gap-1 text-footnote text-text-secondary sm:grid-cols-2">
          <div>
            <dt className="inline">{t('support.firstResponseDue')}: </dt>
            <dd className="inline">
              {formatDateTime(tk.sla.firstResponse.dueAt, locale, tz)} (
              {t(`support.slaStates.${tk.sla.firstResponse.state}`)})
            </dd>
          </div>
          <div>
            <dt className="inline">{t('support.resolutionDue')}: </dt>
            <dd className="inline">
              {formatDateTime(tk.sla.resolution.dueAt, locale, tz)} (
              {t(`support.slaStates.${tk.sla.resolution.state}`)})
            </dd>
          </div>
        </dl>
      </div>

      <ol className="flex flex-col gap-3" aria-label={t('support.conversation')}>
        {thread.data!.messages.map((m) => (
          <li key={m.id}>
            <Card className={m.authorType === 'staff' ? 'border-l-4 border-accent' : ''}>
              <p className="text-footnote font-semibold text-text-secondary">
                {m.authorType === 'staff' ? t('support.fromSupport') : (m.authorName ?? t('support.you'))} ·{' '}
                {formatDateTime(m.createdAt, locale, tz)}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-callout">{m.body}</p>
            </Card>
          </li>
        ))}
      </ol>

      {thread.data!.attachments.length ? (
        <section aria-labelledby="att-title">
          <sec.heading id="att-title" className="text-title-3">
            {t('support.attachments')}
          </sec.heading>
          <ul className="mt-2 flex flex-col gap-1">
            {thread.data!.attachments.map((a) => (
              <li key={a.id}>
                <Button variant="link" onClick={() => download(a.id)}>
                  <Paperclip aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {a.fileName}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tk.status !== 'closed' ? (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(`/v1/support/tickets/${id}/messages`, {
                  method: 'POST',
                  json: { body: reply },
                  capability: 'help.support',
                });
                setReply('');
              }, t('support.replied'));
            }}
            className="flex flex-col gap-3"
          >
            <Field id="reply" label={t('support.reply')}>
              {(p) => (
                <Textarea
                  {...p}
                  required
                  maxLength={20000}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy}>
                {t('support.send')}
              </Button>
              <label className="inline-flex cursor-pointer items-center gap-2 text-callout text-accent">
                <Paperclip aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('support.attachFile')}
                <input
                  type="file"
                  className="sr-only"
                  accept="image/png,image/jpeg,application/pdf,text/plain,text/csv"
                  onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
                />
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  run(
                    () =>
                      api(`/v1/support/tickets/${id}/close`, { method: 'POST', capability: 'help.support' }),
                    t('support.closedToast'),
                  )
                }
              >
                {t('support.close')}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <p className="text-callout text-text-secondary">{t('support.closedNote')}</p>
      )}
    </div>
  );
}
