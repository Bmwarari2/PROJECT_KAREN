'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { BellRing, CircleCheck, Clock, FileX2, RotateCcw, Send } from 'lucide-react';
import { Badge, Button, Dialog, DialogContent, Field, Textarea, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { viewerZone } from '@/lib/zone';
import { IntentLink } from '@/components/intent-link';
import { useSession } from '@/app/app/shell';

export interface SigningEvent {
  kind: string;
  at: string;
  actorName: string | null;
  sha256: string | null;
  detail: Record<string, unknown>;
}
export interface Signing {
  id: string;
  stage: 'employee' | 'company' | 'both' | 'completed' | 'voided';
  signingOrder: string;
  requiresEmployeeSignature: boolean;
  requiresCompanySignature: boolean;
  employeeName: string | null;
  companySigners: string[];
  waitingSince: string | null;
  dueOn: string | null;
  message: string | null;
  reminderCount: number;
  remindedAt: string | null;
  voidReason: string | null;
  signedDocumentId: string | null;
  replacedBy: string | null;
  templateId: string | null;
  taskId: string | null;
  events: SigningEvent[];
}

const EVENT_ICON: Record<string, React.ReactNode> = {
  sent: <Send aria-hidden />,
  reminded: <BellRing aria-hidden />,
  employee_signed: <CircleCheck aria-hidden />,
  company_signed: <CircleCheck aria-hidden />,
  returned: <RotateCcw aria-hidden />,
  voided: <FileX2 aria-hidden />,
  resent: <Send aria-hidden />,
  completed: <CircleCheck aria-hidden />,
};

/**
 * Where a document is in its signing (16.12): who sent it, whose turn it is and since when, each signature with
 * when and by whom, and the completed copy, each step with the SHA-256 of the version it produced. People who manage
 * the person's documents can remind whoever's turn it is, void it (and send a new one), or send a voided one again.
 */
export function SigningStatus({
  signing,
  canManage,
  onChanged,
}: {
  signing: Signing;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState<null | 'void' | 'replace'>(null);
  const [reason, setReason] = React.useState('');
  const when = (iso: string) => formatDateTime(iso, locale, zone);
  const s = signing;
  const open = s.stage !== 'completed' && s.stage !== 'voided';
  const company = s.companySigners.length
    ? t('docStatus.companyNamed', { names: s.companySigners.join(', ') })
    : t('docStatus.company');

  const headline =
    s.stage === 'completed'
      ? t('docStatus.completed')
      : s.stage === 'voided'
        ? t('docStatus.voided')
        : s.stage === 'both'
          ? t('docStatus.waitingBoth', { name: s.employeeName ?? '', company })
          : s.stage === 'company'
            ? t('docStatus.waitingCompany', { company })
            : t('docStatus.waitingEmployee', { name: s.employeeName ?? '' });

  async function act(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const eventText = (e: SigningEvent) => {
    const name = e.actorName ?? '';
    switch (e.kind) {
      case 'sent':
        return name ? t('docStatus.event.sentBy', { name }) : t('docStatus.event.sent');
      case 'reminded':
        return t('docStatus.event.reminded', { name });
      case 'employee_signed':
        return t(`docStatus.event.employeeSigned.${e.detail.method === 'drawn' ? 'drawn' : 'typed'}`, {
          name,
        });
      case 'company_signed':
        return t('docStatus.event.companySigned', { name });
      case 'returned':
        return e.detail.reason
          ? t('docStatus.event.returnedReason', { reason: String(e.detail.reason) })
          : t('docStatus.event.returned');
      case 'voided':
        return t('docStatus.event.voided', { name, reason: String(e.detail.reason ?? '') });
      case 'resent':
        return t('docStatus.event.resent', { name });
      default:
        return t('docStatus.event.completed');
    }
  };

  return (
    <section aria-labelledby="signing-status" className="flex flex-col gap-2">
      <h2 id="signing-status" className="px-1 text-title-3">
        {t('docStatus.title')}
      </h2>
      <div className="flex flex-col gap-4 rounded-lg bg-surface-raised p-4 shadow-sm">
        <div className="flex flex-col gap-1" role="status">
          <p className="flex items-start gap-2 text-callout font-semibold">
            {open ? (
              <Clock aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-warning" />
            ) : s.stage === 'completed' ? (
              <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-success" />
            ) : (
              <FileX2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-text-secondary" />
            )}
            <span>{headline}</span>
          </p>
          {open && s.waitingSince ? (
            <p className="text-footnote text-text-secondary">
              {t('docStatus.since', { date: when(s.waitingSince) })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Badge>{t(`docStatus.order.${s.signingOrder}`)}</Badge>
            {s.dueOn ? (
              <Badge tone={open ? 'warning' : 'neutral'}>
                {t('docStatus.due', { date: formatDate(s.dueOn, locale) })}
              </Badge>
            ) : null}
          </div>
          {s.stage === 'completed' && s.signedDocumentId ? (
            <IntentLink href={`/app/documents/${s.signedDocumentId}`} className="text-callout text-accent">
              {t('docStatus.openSigned')}
            </IntentLink>
          ) : null}
        </div>
        <ol className="flex flex-col gap-3" aria-label={t('docStatus.timeline')}>
          {s.events.map((e, i) => (
            <li key={`${e.kind}-${i}`} className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent-subtle text-accent [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[1.75]"
              >
                {EVENT_ICON[e.kind] ?? <Clock aria-hidden />}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-callout wrap-anywhere">{eventText(e)}</span>
                <span className="text-footnote text-text-secondary">{when(e.at)}</span>
                {e.sha256 ? (
                  <span className="break-all text-footnote text-text-secondary" title={e.sha256}>
                    {t('docStatus.fingerprint', { hash: e.sha256.slice(0, 16) })}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {open ? (
              <Button
                variant="secondary"
                className="min-h-11"
                loading={busy === 'remind'}
                onClick={() =>
                  act('remind', async () => {
                    await api(`/v1/signature-requests/${s.id}/remind`, { method: 'POST' });
                    toast({ title: t('docStatus.reminded'), tone: 'success' });
                    onChanged();
                  })
                }
              >
                <BellRing aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('docStatus.remind')}
              </Button>
            ) : null}
            {open ? (
              <>
                <Button variant="secondary" className="min-h-11" onClick={() => setVoiding('replace')}>
                  {t('docStatus.voidReplace')}
                </Button>
                <Button variant="ghost" className="min-h-11" onClick={() => setVoiding('void')}>
                  {t('docStatus.void')}
                </Button>
              </>
            ) : null}
            {s.stage === 'voided' && !s.replacedBy ? (
              <Button
                variant="secondary"
                className="min-h-11"
                loading={busy === 'resend'}
                onClick={() =>
                  act('resend', async () => {
                    await api(`/v1/signature-requests/${s.id}/resend`, { method: 'POST' });
                    toast({ title: t('docStatus.resent'), tone: 'success' });
                    onChanged();
                  })
                }
              >
                <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('docStatus.resend')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog open={!!voiding} onOpenChange={(o) => (o ? undefined : setVoiding(null))}>
        <DialogContent
          title={voiding === 'replace' ? t('docStatus.voidReplaceTitle') : t('docStatus.voidTitle')}
          description={voiding === 'replace' ? t('docStatus.voidReplaceBody') : t('docStatus.voidBody')}
          closeLabel={t('common.close')}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act('void', async () => {
                const r = await api<{ replaceHref: string | null }>(`/v1/signature-requests/${s.id}/void`, {
                  method: 'POST',
                  json: { reason: reason.trim(), replace: voiding === 'replace' },
                });
                setVoiding(null);
                setReason('');
                toast({ title: t('docStatus.voidedToast'), tone: 'success' });
                if (r.replaceHref) router.push(r.replaceHref);
                else onChanged();
              });
            }}
          >
            <Field id="void-reason" label={t('docStatus.reason')} hint={t('docStatus.reasonHint')}>
              {(p) => (
                <Textarea
                  {...p}
                  required
                  minLength={3}
                  maxLength={1000}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setVoiding(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={busy === 'void'}
                disabled={reason.trim().length < 3}
              >
                {voiding === 'replace' ? t('docStatus.voidReplace') : t('docStatus.void')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
