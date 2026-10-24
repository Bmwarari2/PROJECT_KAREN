'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { LifeBuoy, Mail, MessageSquare, Phone, Ticket } from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDateTime, type Locale } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import {
  ListCard,
  ListFilter,
  ListNoMatches,
  ListSearch,
  matches,
  PageIntro,
  useInModule,
} from '@/components/module-page';
import { hasPermission, useSession } from '../shell';
import { duration, selectClass, slaTone, type TicketSummary } from './ui';

interface Contact {
  planId: string;
  region: string;
  coverage: string;
  hours: { timeZone: string; days: number[]; start: string; end: string } | null;
  channels: Array<{ kind: string; value?: string | null; hours?: string }>;
  sla: Record<string, { firstResponseMinutes: number; resolutionMinutes: number }>;
}
const STATUSES = ['open', 'awaiting_customer', 'resolved', 'closed'];
const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email: <Mail aria-hidden className="h-4 w-4 stroke-[1.5]" />,
  phone: <Phone aria-hidden className="h-4 w-4 stroke-[1.5]" />,
  chat: <MessageSquare aria-hidden className="h-4 w-4 stroke-[1.5]" />,
  ticket: <Ticket aria-hidden className="h-4 w-4 stroke-[1.5]" />,
  help_centre: <LifeBuoy aria-hidden className="h-4 w-4 stroke-[1.5]" />,
};

/**
 * Support from Thapsus-HR is for the workspace's administrators (ADR-0163); everyone else asks their
 * own HR team, so a direct visit here points them to Contact HR.
 */
export default function SupportPage() {
  const t = useT();
  const session = useSession();
  // outside the Help module's tabs for these readers, so the message is the page's heading
  const inModule = useInModule();
  if (session && !hasPermission(session, 'support.ticket')) {
    const hr = hasPermission(session, 'hr.contact');
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<LifeBuoy aria-hidden />}
        title={t('actionable.support.adminsOnly')}
        body={hr ? t('actionable.support.askHr') : t('actionable.support.noHr')}
        action={
          hr ? (
            <Link
              href="/app/contact-hr"
              className={`${buttonVariants({ variant: 'primary', size: 'md' })} no-underline`}
            >
              {t('actionable.hr.contact')}
            </Link>
          ) : undefined
        }
      />
    );
  }
  return <SupportDesk />;
}

function SupportDesk() {
  const t = useT();
  const locale = useLocale() as Locale;
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const isAdmin = hasPermission(session, 'support.manage');
  const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
  const tickets = useApi<TicketSummary[]>(`/v1/support/tickets?scope=${scope}`);
  const contact = useApi<Contact>('/v1/support/contact');
  const [form, setForm] = React.useState({ subject: '', body: '', category: 'question', priority: 'normal' });
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  // The tickets (the latest the API returns for the scope) are searched and filtered on the page.
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState('');
  const rows = tickets.data ?? [];
  const shown = rows.filter(
    (tk) => (!status || tk.status === status) && matches(query, tk.reference, tk.subject),
  );
  const filtered = !!status || !!query.trim();
  const listTitle = scope === 'all' ? t('support.allTickets') : t('support.myTickets');
  const tz = session?.timeZone ?? 'UTC';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api<TicketSummary>('/v1/support/tickets', {
        method: 'POST',
        json: { ...form, contextPath: params.get('context') ?? null },
      });
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api(`/v1/support/tickets/${created.id}/attachments`, { method: 'POST', body: fd });
      }
      toast({ title: t('support.created', { reference: created.reference }), tone: 'success' });
      router.push(`/app/support/${created.id}`);
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('support.title')}
        titleIsTab
        actions={
          <Link href="/app/help" className="text-callout">
            {t('support.searchHelpFirst')}
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PageSection headingLevel={2} title={t('support.newTitle')}>
          <Card>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Field id="t-subject" label={t('support.subject')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    minLength={3}
                    maxLength={200}
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="t-category" label={t('support.category')}>
                  {(p) => (
                    <select
                      {...p}
                      className={selectClass}
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                    >
                      {['question', 'problem', 'billing', 'account', 'data', 'feature_request'].map((c) => (
                        <option key={c} value={c}>
                          {t(`support.categories.${c}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field id="t-priority" label={t('support.priority')} hint={t('support.priorityHint')}>
                  {(p) => (
                    <select
                      {...p}
                      className={selectClass}
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: e.target.value })}
                    >
                      {(isAdmin ? ['urgent', 'high', 'normal', 'low'] : ['high', 'normal', 'low']).map(
                        (c) => (
                          <option key={c} value={c}>
                            {t(`support.priorities.${c}`)}
                          </option>
                        ),
                      )}
                    </select>
                  )}
                </Field>
              </div>
              <Field id="t-body" label={t('support.description')} hint={t('support.descriptionHint')}>
                {(p) => (
                  <Textarea
                    {...p}
                    required
                    maxLength={20000}
                    rows={6}
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                  />
                )}
              </Field>
              <Field id="t-file" label={t('support.attachment')} hint={t('support.attachmentHint')}>
                {(p) => (
                  <input
                    {...p}
                    type="file"
                    accept="image/png,image/jpeg,application/pdf,text/plain,text/csv"
                    className="text-callout"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                )}
              </Field>
              <p className="text-footnote text-text-secondary">{t('support.privacyNote')}</p>
              <div>
                <Button type="submit" loading={busy}>
                  {t('support.submit')}
                </Button>
              </div>
            </form>
          </Card>
        </PageSection>
        <PageSection headingLevel={2} title={t('support.contactTitle')}>
          <Card>
            {contact.data ? (
              <>
                <p className="mt-2 text-callout text-text-secondary">
                  {t('support.planLine', { plan: t(`pricing.plans.${contact.data.planId}.name`) })}
                </p>
                <ul className="mt-4 flex flex-col gap-2 text-callout">
                  {contact.data.channels.map((c, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      {CHANNEL_ICON[c.kind]}
                      <span>{t(`support.channels.${c.kind}`)}</span>
                      {c.value ? (
                        c.kind === 'email' ? (
                          <a href={`mailto:${c.value}`} className="break-all">
                            {c.value}
                          </a>
                        ) : c.kind === 'phone' ? (
                          <a href={`tel:${c.value.replace(/\s/g, '')}`}>{c.value}</a>
                        ) : (
                          <span>{c.value}</span>
                        )
                      ) : null}
                      {c.hours ? (
                        <span className="text-footnote text-text-secondary">
                          ({t(`support.coverage.${c.hours}`)})
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-footnote text-text-secondary">
                  {contact.data.hours
                    ? t('support.hoursLine', {
                        start: contact.data.hours.start,
                        end: contact.data.hours.end,
                        zone: contact.data.hours.timeZone,
                      })
                    : t('support.alwaysLine')}
                </p>
                <h3 className="mt-4 text-callout font-semibold">{t('support.slaTitle')}</h3>
                <Table dense className="mt-2" scrollLabel={t('support.slaTitle')}>
                  <caption className="sr-only">{t('support.slaTitle')}</caption>
                  <THead>
                    <tr>
                      <TH>{t('support.priority')}</TH>
                      <TH>{t('support.firstResponse')}</TH>
                      <TH>{t('support.resolution')}</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {['urgent', 'high', 'normal', 'low'].map((p) => (
                      <TR key={p}>
                        <TD>{t(`support.priorities.${p}`)}</TD>
                        <TD label={t('support.firstResponse')}>
                          {duration(contact.data!.sla[p]!.firstResponseMinutes, t)}
                        </TD>
                        <TD label={t('support.resolution')}>
                          {duration(contact.data!.sla[p]!.resolutionMinutes, t)}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : null}
          </Card>
        </PageSection>
      </div>

      <ListCard
        title={listTitle}
        count={
          tickets.data
            ? filtered
              ? t('support.list.countFiltered', { shown: shown.length, count: rows.length })
              : t('support.list.count', { count: rows.length })
            : undefined
        }
        search={
          rows.length ? (
            <ListSearch value={query} onChange={setQuery} label={t('support.list.search')} />
          ) : undefined
        }
        filters={
          <>
            {rows.length ? (
              <ListFilter
                value={status}
                onChange={setStatus}
                label={t('common.status')}
                anyLabel={t('support.list.anyStatus')}
                options={STATUSES.map((x) => ({ value: x, label: t(`support.statuses.${x}`) }))}
              />
            ) : null}
            {isAdmin ? (
              <div role="group" aria-label={t('support.scopeLabel')} className="flex gap-2">
                <Button
                  size="sm"
                  variant={scope === 'mine' ? 'primary' : 'secondary'}
                  aria-pressed={scope === 'mine'}
                  onClick={() => setScope('mine')}
                >
                  {t('support.myTickets')}
                </Button>
                <Button
                  size="sm"
                  variant={scope === 'all' ? 'primary' : 'secondary'}
                  aria-pressed={scope === 'all'}
                  onClick={() => setScope('all')}
                >
                  {t('support.allTickets')}
                </Button>
              </div>
            ) : null}
          </>
        }
        applied={
          status
            ? [
                {
                  key: 'status',
                  label: t('support.list.statusChip', { status: t(`support.statuses.${status}`) }),
                  clear: () => setStatus(''),
                },
              ]
            : []
        }
        empty={
          !tickets.data ? (
            <Skeleton className="h-24 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState level={3} icon={<Ticket aria-hidden />} title={t('support.noTickets')} />
          ) : shown.length === 0 ? (
            <ListNoMatches
              onClear={() => {
                setQuery('');
                setStatus('');
              }}
            />
          ) : undefined
        }
      >
        <Table scrollLabel={listTitle}>
          <caption className="sr-only">{listTitle}</caption>
          <THead>
            <tr>
              <TH>{t('support.reference')}</TH>
              <TH>{t('support.subject')}</TH>
              <TH>{t('support.priority')}</TH>
              <TH>{t('common.status')}</TH>
              <TH>{t('support.sla')}</TH>
              <TH>{t('support.updated')}</TH>
            </tr>
          </THead>
          <tbody>
            {shown.map((tk) => (
              <TR key={tk.id}>
                <TD>
                  <Link href={`/app/support/${tk.id}`}>{tk.reference}</Link>
                </TD>
                <TD className="max-w-[28ch] truncate">{tk.subject}</TD>
                <TD phone="inline" label={t('support.priority')}>
                  {t(`support.priorities.${tk.priority}`)}
                </TD>
                <TD phone="inline">{t(`support.statuses.${tk.status}`)}</TD>
                <TD phone="inline">
                  <Badge tone={slaTone(tk.sla.flag)}>{t(`support.slaStates.${tk.sla.flag}`)}</Badge>
                </TD>
                <TD className="text-footnote text-text-secondary" label={t('support.updated')}>
                  {formatDateTime(tk.lastActivityAt, locale, tz)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </ListCard>
    </div>
  );
}
