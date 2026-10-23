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
import { PageTitle, selectClass, slaTone } from '../../../ui';

interface Thread {
  ticket: {
    id: string;
    reference: string;
    subject: string;
    category: string;
    priority: string;
    status: string;
    planId: string;
    requesterName: string | null;
    contextPath: string | null;
    sla: {
      firstResponse: { dueAt: string; state: string };
      resolution: { dueAt: string; state: string };
      flag: string;
    };
    createdAt: string;
  };
  messages: Array<{
    id: string;
    authorType: string;
    authorName: string | null;
    body: string;
    createdAt: string;
  }>;
  attachments: Array<{ id: string; fileName: string; sizeBytes: number }>;
}

/** Ticket content is shown because the customer submitted it to support; this view is audited in both logs. */
export default function StaffTicket() {
  const t = useT();
  const locale = useLocale() as Locale;
  const toast = useToast();
  const { tenantId, ticketId } = useParams<{ tenantId: string; ticketId: string }>();
  const base = `/v1/backoffice/support/tickets/${tenantId}/${ticketId}`;
  const th = useApi<Thread>(base);
  const [body, setBody] = React.useState('');
  const [status, setStatus] = React.useState('awaiting_customer');
  const [busy, setBusy] = React.useState(false);
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      th.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  if (!th.data) return <Skeleton className="h-64 w-full" />;
  const tk = th.data.ticket;
  return (
    <div className="flex flex-col gap-5">
      <Link href="/backoffice/support" className="inline-flex items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('backoffice.support.title')}
      </Link>
      <PageTitle
        title={tk.subject}
        lead={t('backoffice.support.ticketLead', {
          reference: tk.reference,
          plan: t(`pricing.plans.${tk.planId}.name`),
          page: tk.contextPath ?? '—',
        })}
      >
        <div className="flex flex-wrap gap-2">
          <Badge>{t(`support.statuses.${tk.status}`)}</Badge>
          <Badge tone={slaTone(tk.sla.flag)}>{t(`support.slaStates.${tk.sla.flag}`)}</Badge>
        </div>
      </PageTitle>
      <p className="text-footnote text-text-secondary">{t('backoffice.support.auditNote')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field id="prio" label={t('support.priority')}>
          {(p) => (
            <select
              {...p}
              className={`${selectClass} w-auto`}
              value={tk.priority}
              onChange={(e) =>
                run(
                  () => api(base, { method: 'PATCH', json: { priority: e.target.value } }),
                  t('backoffice.support.updated'),
                )
              }
            >
              {['urgent', 'high', 'normal', 'low'].map((x) => (
                <option key={x} value={x}>
                  {t(`support.priorities.${x}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="text-footnote text-text-secondary">
          {t('support.firstResponseDue')}: {when(tk.sla.firstResponse.dueAt)} · {t('support.resolutionDue')}:{' '}
          {when(tk.sla.resolution.dueAt)}
        </p>
      </div>
      <ol className="flex flex-col gap-3" aria-label={t('support.conversation')}>
        {th.data.messages.map((m) => (
          <li key={m.id}>
            <Card className={m.authorType === 'staff' ? 'border-l-4 border-accent' : ''}>
              <p className="text-footnote font-semibold text-text-secondary">
                {m.authorType === 'staff'
                  ? t('backoffice.support.thapsus')
                  : (m.authorName ?? t('backoffice.support.customer'))}{' '}
                · {when(m.createdAt)}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-callout">{m.body}</p>
            </Card>
          </li>
        ))}
      </ol>
      {th.data.attachments.length ? (
        <ul className="flex flex-col gap-1">
          {th.data.attachments.map((a) => (
            <li key={a.id}>
              <Button
                variant="link"
                onClick={() =>
                  run(
                    async () =>
                      window.open(
                        (await api<{ url: string }>(`${base}/attachments/${a.id}`)).url,
                        '_blank',
                        'noopener',
                      ),
                    t('backoffice.support.opened'),
                  )
                }
              >
                <Paperclip aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {a.fileName}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {tk.status !== 'closed' ? (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(`${base}/messages`, { method: 'POST', json: { body, status } });
                setBody('');
              }, t('backoffice.support.replied'));
            }}
            className="flex flex-col gap-3"
          >
            <Field id="staff-reply" label={t('backoffice.support.reply')}>
              {(p) => <Textarea {...p} required value={body} onChange={(e) => setBody(e.target.value)} />}
            </Field>
            <Field id="staff-status" label={t('backoffice.support.thenSet')}>
              {(p) => (
                <select
                  {...p}
                  className={`${selectClass} w-auto`}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {['awaiting_customer', 'open', 'resolved'].map((x) => (
                    <option key={x} value={x}>
                      {t(`support.statuses.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div>
              <Button type="submit" loading={busy}>
                {t('backoffice.support.send')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      <p className="text-footnote text-text-secondary">{t('backoffice.support.grantNote')}</p>
    </div>
  );
}
