'use client';
import * as React from 'react';
import { CircleCheck, Undo2 } from 'lucide-react';
import { Button, Field, Input, Textarea, useToast } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useCan } from '@/app/app/shell';
import { Stepper } from './stepper';

export interface Signature {
  id: string;
  status: string;
  requestedAt: string;
  signedAt: string | null;
  signedDocumentId: string | null;
  requiresCountersign: boolean;
  approvalStatus: string | null;
  returnedReason: string | null;
  completedAt: string | null;
}
export interface Countersign {
  signatureRequestId: string;
  signerName: string | null;
  signedAt: string | null;
  documentSha256: string | null;
  signedSha256: string | null;
}

const panel = 'flex flex-col gap-4 rounded-lg bg-surface-raised p-4 shadow-sm md:p-5';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/**
 * Review and sign, next to (or under, on phones) the document in the viewer (ADR-0168): review, confirm, sign,
 * done. It uses the existing e-signature: consent and a typed name, recorded with the time, IP address, device
 * and a fingerprint of the exact document; the API appends the signature certificate to the signed copy.
 */
export function SignPanel({
  request,
  pages,
  seen,
  onSigned,
}: {
  request: Signature;
  pages: number;
  seen: number;
  onSigned: (r: { status: string; signedDocumentId: string | null }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [step, setStep] = React.useState(0);
  const [consent, setConsent] = React.useState(false);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const heading = React.useRef<HTMLHeadingElement>(null);
  // signing is offered to people who may sign documents (ADR-0188)
  const can = useCan();
  const steps = [
    t('docSign.steps.review'),
    t('docSign.steps.confirm'),
    t('docSign.steps.sign'),
    t('docSign.steps.done'),
  ];
  const move = (n: number) => {
    setStep(n);
    // keep keyboard and screen-reader users at the start of the new step
    requestAnimationFrame(() => heading.current?.focus());
  };

  if (!can('documents.signOwn')) return null;
  if (request.status === 'signed')
    return (
      <section className={panel} aria-labelledby="sign-title">
        <h2 id="sign-title" className="text-title-3">
          {t('docSign.panelTitle')}
        </h2>
        <p className="flex items-start gap-2 text-callout" role="status">
          <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-success" />
          {request.completedAt
            ? t('docSign.completed', { date: formatDate(day(request.completedAt), locale, 'long') })
            : t('docSign.awaiting', { date: formatDate(day(request.signedAt), locale, 'long') })}
        </p>
      </section>
    );

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ status: string; signedDocumentId: string | null }>(
        `/v1/signature-requests/${request.id}/sign`,
        { method: 'POST', json: { consent: true, typedName: name }, capability: 'documents.signOwn' },
      );
      setDone(r.status);
      move(3);
      onSigned(r);
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={panel} aria-labelledby="sign-title">
      <h2 id="sign-title" className="text-title-3">
        {t('docSign.panelTitle')}
      </h2>
      {request.approvalStatus === 'returned' ? (
        <p
          className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-callout"
          role="status"
        >
          <Undo2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-warning" />
          {request.returnedReason
            ? t('docSign.returned', { reason: request.returnedReason })
            : t('docSign.returnedNoReason')}
        </p>
      ) : null}
      <Stepper steps={steps} current={done ? steps.length : step} label={t('docSign.stepsLabel')} />
      <h3 ref={heading} tabIndex={-1} className="text-body font-semibold focus-visible:outline-none">
        {t('docSign.stepOf', { n: Math.min(step + 1, 4), count: 4, name: steps[step]! })}
      </h3>
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-callout text-text-secondary">{t('docSign.reviewBody')}</p>
          {pages ? (
            <p className="text-footnote text-text-secondary">
              {t('docSign.pagesSeen', { seen, count: pages })}
            </p>
          ) : null}
          <Button className="min-h-11 self-start" onClick={() => move(1)}>
            {t('docSign.read')}
          </Button>
        </div>
      ) : step === 1 ? (
        <div className="flex flex-col gap-3">
          <p className="text-callout text-text-secondary">{t('docSign.confirmBody')}</p>
          <label className="flex items-start gap-3 text-callout">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent)]"
            />
            <span>{t('documents.consent')}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={!consent} onClick={() => move(2)}>
              {t('docSign.continue')}
            </Button>
            <Button className="min-h-11" variant="secondary" onClick={() => move(0)}>
              {t('docSign.back')}
            </Button>
          </div>
        </div>
      ) : step === 2 ? (
        <form onSubmit={sign} className="flex flex-col gap-3">
          <Field id="typedName" label={t('documents.typedName')}>
            {(p) => (
              <Input
                {...p}
                required
                minLength={2}
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11" loading={busy} disabled={name.trim().length < 2}>
              {t('documents.signNow')}
            </Button>
            <Button type="button" className="min-h-11" variant="secondary" onClick={() => move(1)}>
              {t('docSign.back')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="flex items-start gap-2 text-callout" role="status">
          <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-success" />
          {done === 'completed' ? t('docSign.doneCompleted') : t('docSign.doneAwaiting')}
        </p>
      )}
    </section>
  );
}

/**
 * The approver's side (ADR-0169): review the document someone signed, then countersign it for the company (same
 * e-signature method) or return it to them with a reason. It decides the approval in the approvals service.
 */
export function CountersignPanel({
  request,
  onDone,
}: {
  request: Countersign;
  onDone: (r: { status: string; signedDocumentId: string | null }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [step, setStep] = React.useState(0);
  const [choice, setChoice] = React.useState<'approve' | 'return'>('approve');
  const [consent, setConsent] = React.useState(false);
  const [name, setName] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const signer = request.signerName ?? '';
  const steps = [t('docSign.steps.review'), t('docSign.steps.decide'), t('docSign.steps.done')];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ status: string; signedDocumentId: string | null }>(
        `/v1/signature-requests/${request.signatureRequestId}/countersign`,
        {
          method: 'POST',
          json:
            choice === 'approve'
              ? { decision: 'approve', consent: true, typedName: name }
              : { decision: 'return', reason },
          capability: 'documents.countersign',
        },
      );
      setDone(r.status);
      setStep(2);
      onDone(r);
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={panel} aria-labelledby="countersign-title">
      <h2 id="countersign-title" className="text-title-3">
        {t('docSign.countersignTitle')}
      </h2>
      <Stepper steps={steps} current={done ? steps.length : step} label={t('docSign.stepsLabel')} />
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-callout text-text-secondary">
            {t('docSign.countersignBody', {
              name: signer,
              date: request.signedAt ? formatDate(day(request.signedAt), locale, 'long') : '',
            })}
          </p>
          {request.signedSha256 ? (
            <p className="break-all text-footnote text-text-secondary">
              {t('docSign.fingerprint', { hash: request.signedSha256 })}
            </p>
          ) : null}
          <Button className="min-h-11 self-start" onClick={() => setStep(1)}>
            {t('docSign.read')}
          </Button>
        </div>
      ) : step === 1 ? (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-callout font-semibold">{t('docSign.decision')}</legend>
            {(['approve', 'return'] as const).map((c) => (
              <label key={c} className="flex min-h-11 items-center gap-3 text-callout">
                <input
                  type="radio"
                  name="countersign-decision"
                  checked={choice === c}
                  onChange={() => setChoice(c)}
                  className="h-5 w-5 accent-[var(--color-accent)]"
                />
                {c === 'approve' ? t('docSign.approve') : t('docSign.return', { name: signer })}
              </label>
            ))}
          </fieldset>
          {choice === 'approve' ? (
            <>
              <label className="flex items-start gap-3 text-callout">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                />
                <span>{t('docSign.countersignConsent')}</span>
              </label>
              <Field id="countersignName" label={t('documents.typedName')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    minLength={2}
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                )}
              </Field>
            </>
          ) : (
            <Field
              id="returnReason"
              label={t('docSign.reason')}
              hint={t('docSign.reasonHint', { name: signer })}
            >
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
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11"
              loading={busy}
              variant={choice === 'approve' ? 'primary' : 'secondary'}
              disabled={choice === 'approve' ? !consent || name.trim().length < 2 : reason.trim().length < 3}
            >
              {choice === 'approve' ? t('docSign.countersignNow') : t('docSign.returnNow')}
            </Button>
            <Button type="button" className="min-h-11" variant="secondary" onClick={() => setStep(0)}>
              {t('docSign.back')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="flex items-start gap-2 text-callout" role="status">
          <CircleCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-success" />
          {done === 'completed'
            ? t('docSign.doneCountersigned')
            : t('docSign.doneReturned', { name: signer })}
        </p>
      )}
    </section>
  );
}
