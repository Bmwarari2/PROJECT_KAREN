'use client';
import * as React from 'react';
import { MessageSquare, Send } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  ListItem,
  ListSection,
  Skeleton,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/zone';
import { IntentLink } from '@/components/intent-link';
import { PageIntro, useInModule } from '@/components/module-page';
import { useSession } from '../shell';

interface HrRequest {
  id: string;
  subject: string;
  status: 'open' | 'done' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
}

const tone = { open: 'warning', done: 'success', cancelled: 'neutral' } as const;

/**
 * Contact HR (ADR-0163): employees and managers ask their own HR team. The request lands as a task in
 * the HR admins' inbox with the person's name on it; its status shows here, and a notification says
 * when it is done. Each request opens its own page.
 */
export default function ContactHrPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const inModule = useInModule();
  const zone = viewerZone(session?.timeZone);
  const mine = useApi<HrRequest[]>(session?.employeeId ? '/v1/hr-requests' : null);
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  if (session && !session.employeeId)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<MessageSquare aria-hidden />}
        title={t('actionable.hr.noEmployee')}
      />
    );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/hr-requests', { method: 'POST', json: { subject, message } });
      toast({ title: t('actionable.hr.sent'), tone: 'success' });
      setSubject('');
      setMessage('');
      mine.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-6">
      <PageIntro title={t('actionable.hr.title')} titleIsTab lead={t('actionable.hr.lead')} />
      <Card>
        <form onSubmit={send} className="flex flex-col gap-4">
          <Field id="hr-subject" label={t('actionable.hr.subject')}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={120}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </Field>
          <Field id="hr-message" label={t('actionable.hr.message')} hint={t('actionable.hr.messageHint')}>
            {(p) => (
              <Textarea
                {...p}
                required
                rows={5}
                maxLength={4000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} className="self-start">
            <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('actionable.hr.send')}
          </Button>
        </form>
      </Card>
      {!mine.data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ListSection id="hr-requests" title={t('actionable.hr.mine')}>
          {mine.data.length ? (
            mine.data.map((r) => (
              <ListItem
                key={r.id}
                href={`/app/contact-hr/${r.id}`}
                linkAs={IntentLink}
                leading={<MessageSquare aria-hidden />}
                title={r.subject}
                subtitle={
                  r.completedAt
                    ? t('actionable.hr.doneOn', { date: formatDateTime(r.completedAt, locale, zone) })
                    : t('actionable.hr.sentOn', { date: formatDateTime(r.createdAt, locale, zone) })
                }
                meta={<Badge tone={tone[r.status]}>{t(`actionable.hr.status.${r.status}`)}</Badge>}
              />
            ))
          ) : (
            <ListItem leading={<MessageSquare aria-hidden />} title={t('actionable.hr.none')} />
          )}
        </ListSection>
      )}
    </div>
  );
}
