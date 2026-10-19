'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil, Send } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Dialog, DialogContent, DialogTrigger, EmptyState, Field, Input, Skeleton, Textarea, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime, formatMoney, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { today } from '@thapsus/core/time';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../../shell';
import { problemText } from '../../reports/ui';

interface Profile {
  employee: Record<string, unknown> & { id: string; displayName?: string };
  asOf: string;
  access: Record<string, 'none' | 'read' | 'write'>;
  requestable: string[];
}
interface ChangeRequest {
  id: string;
  status: string;
  fields: string[];
  effectiveDate: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const SECTIONS: Array<{ key: string; fields: string[] }> = [
  { key: 'personal', fields: ['legalFirstName', 'legalLastName', 'preferredName', 'pronouns', 'dateOfBirth', 'nationality', 'personalEmail', 'personalPhone'] },
  { key: 'job', fields: ['jobTitle', 'department', 'location', 'entity', 'employmentType', 'fte', 'weeklyHours', 'startDate', 'workEmail', 'workPhone'] },
  { key: 'pay', fields: ['payAmountMinor', 'payFrequency'] },
  { key: 'contract', fields: ['contractType', 'noticePeriodDays', 'probationEndDate'] },
];
/** Contact details an employee keeps up to date themselves (when their grants allow it). */
const SELF_EDITABLE = ['preferredName', 'pronouns', 'personalEmail', 'personalPhone'];
const statusTone = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const;

function display(field: string, v: unknown, emp: Record<string, unknown>, locale: Locale): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'payAmountMinor' && typeof emp.payCurrency === 'string') return formatMoney(money(BigInt(String(v)), emp.payCurrency), locale);
  if (/Date$|^dateOfBirth$/.test(field) && typeof v === 'string') return formatDate(v, locale);
  return String(v);
}

/** My details: view my record, update my contact details, and ask HR to change legal details (approval flow). */
export default function MyDetailsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const profile = useApi<Profile>('/v1/me/profile');
  const requests = useApi<ChangeRequest[]>('/v1/me/change-requests');
  const [editOpen, setEditOpen] = React.useState(false);
  const [reqOpen, setReqOpen] = React.useState(false);
  const [edit, setEdit] = React.useState<Record<string, string>>({});
  const [ask, setAsk] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  if (profile.error) return <EmptyState title={profile.error.status === 404 ? t('ess.noEmployee') : t('common.error')} />;
  if (!profile.data) return <Skeleton className="h-96 w-full" />;
  const e = profile.data.employee;
  const editable = SELF_EDITABLE.filter((f) => profile.data!.access[f] === 'write');
  const requestable = profile.data.requestable;

  async function saveContact(ev: React.FormEvent) {
    ev.preventDefault();
    const changes = Object.fromEntries(Object.entries(edit).filter(([, v]) => v.trim() !== ''));
    if (!Object.keys(changes).length) return setEditOpen(false);
    setBusy(true);
    try {
      await api(`/v1/employees/${e.id}/changes`, { method: 'POST', json: { effectiveDate: today(zone), ...changes } });
      toast({ title: t('ess.details.saved'), tone: 'success' });
      setEditOpen(false);
      setEdit({});
      profile.reload();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function sendRequest(ev: React.FormEvent) {
    ev.preventDefault();
    const body = Object.fromEntries(Object.entries(ask).filter(([, v]) => v.trim() !== ''));
    setBusy(true);
    try {
      await api('/v1/me/change-requests', { method: 'POST', json: body });
      toast({ title: t('ess.details.requestSent'), tone: 'success' });
      setReqOpen(false);
      setAsk({});
      requests.reload();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/me" className="inline-flex w-fit items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('ess.title')}
      </Link>
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-title-2">{t('ess.details.title')}</h1>
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('ess.details.intro')}</p>
        </div>
        {editable.length ? (
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="secondary">
                <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('ess.details.editContact')}
              </Button>
            </DialogTrigger>
            <DialogContent title={t('ess.details.editContact')} description={t('ess.details.editContactBody')} closeLabel={t('common.close')}>
              <form onSubmit={saveContact} className="flex flex-col gap-4">
                {editable.map((f) => (
                  <Field key={f} id={`c-${f}`} label={t(`people.field.${f}`)}>
                    {(a) => (
                      <Input
                        {...a}
                        type={f === 'personalEmail' ? 'email' : f === 'personalPhone' ? 'tel' : 'text'}
                        autoComplete={f === 'personalEmail' ? 'email' : f === 'personalPhone' ? 'tel' : 'off'}
                        placeholder={display(f, e[f], e, locale)}
                        value={edit[f] ?? ''}
                        onChange={(ev) => setEdit((v) => ({ ...v, [f]: ev.target.value }))}
                      />
                    )}
                  </Field>
                ))}
                <Button type="submit" loading={busy}>
                  {t('common.save')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
        {requestable.length ? (
          <Dialog open={reqOpen} onOpenChange={setReqOpen}>
            <DialogTrigger asChild>
              <Button>
                <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('ess.details.requestChange')}
              </Button>
            </DialogTrigger>
            <DialogContent title={t('ess.details.requestChange')} description={t('ess.details.requestChangeBody')} closeLabel={t('common.close')}>
              <form onSubmit={sendRequest} className="flex flex-col gap-4">
                {requestable.map((f) => (
                  <Field key={f} id={`r-${f}`} label={t(`people.field.${f}`)} hint={f === 'nationality' ? t('ess.details.countryHint') : undefined}>
                    {(a) => (
                      <Input
                        {...a}
                        type={f === 'dateOfBirth' ? 'date' : 'text'}
                        maxLength={f === 'nationality' ? 2 : 100}
                        pattern={f === 'nationality' ? '[A-Z]{2}' : undefined}
                        placeholder={f === 'dateOfBirth' ? undefined : display(f, e[f], e, locale)}
                        value={ask[f] ?? ''}
                        onChange={(ev) => setAsk((v) => ({ ...v, [f]: f === 'nationality' ? ev.target.value.toUpperCase() : ev.target.value }))}
                      />
                    )}
                  </Field>
                ))}
                <Field id="r-effective" label={t('people.effectiveDate')}>
                  {(a) => <Input {...a} type="date" value={ask.effectiveDate ?? ''} onChange={(ev) => setAsk((v) => ({ ...v, effectiveDate: ev.target.value }))} />}
                </Field>
                <Field id="r-reason" label={t('ess.details.reason')}>
                  {(a) => <Textarea {...a} rows={3} maxLength={300} value={ask.reason ?? ''} onChange={(ev) => setAsk((v) => ({ ...v, reason: ev.target.value }))} />}
                </Field>
                <p className="text-footnote text-text-secondary">{t('ess.details.requestPrivacy')}</p>
                <Button type="submit" loading={busy} disabled={!requestable.some((f) => ask[f]?.trim())}>
                  {t('ess.details.send')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => {
          const visible = s.fields.filter((f) => f in e);
          if (!visible.length) return null;
          return (
            <Card key={s.key}>
              <CardTitle>{t(`people.section.${s.key}`)}</CardTitle>
              <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-2 text-callout">
                {visible.map((f) => (
                  <React.Fragment key={f}>
                    <dt className="text-text-secondary">{t(`people.field.${f}`)}</dt>
                    <dd className="break-words">{display(f, e[f], e, locale)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>

      <section aria-labelledby="cr-h" className="flex flex-col gap-3">
        <h2 id="cr-h" className="text-title-3">
          {t('ess.details.requests')}
        </h2>
        {requests.data?.length ? (
          <ul className="flex flex-col gap-2">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
                <span className="mr-auto text-callout">{r.fields.map((f) => t(`people.field.${f}`)).join(', ')}</span>
                <span className="text-footnote text-text-secondary">{formatDateTime(r.createdAt, locale, zone)}</span>
                <Badge tone={statusTone[r.status as keyof typeof statusTone] ?? 'neutral'}>{t(`ess.details.status_${r.status}`)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-callout text-text-secondary">{t('ess.details.noRequests')}</p>
        )}
      </section>
    </div>
  );
}
