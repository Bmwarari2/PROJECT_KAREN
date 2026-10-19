'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { FileText, History, Pencil, Send } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Dialog, DialogContent, DialogTrigger, EmptyState, Field, Input, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useToast } from '@thapsus/ui';
import { formatDate, formatMoney, type Locale } from '@thapsus/core/i18n';
import { money, parseDecimal } from '@thapsus/core/money';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { hasPermission, useSession } from '../../shell';
import type { LeaveBalance } from '@/components/leave-balances';
import { BalancesPanel, LeaverDialog, TransferDialog } from './actions';

interface ProfileResponse {
  employee: Record<string, unknown> & { id: string; displayName?: string };
  asOf: string;
  access: Record<string, 'none' | 'read' | 'write'>;
}

const SECTIONS: Array<{ key: string; fields: string[] }> = [
  { key: 'personal', fields: ['legalFirstName', 'legalLastName', 'preferredName', 'pronouns', 'dateOfBirth', 'personalEmail', 'personalPhone', 'nationality'] },
  { key: 'job', fields: ['jobTitle', 'department', 'location', 'entity', 'employmentType', 'fte', 'weeklyHours', 'flsaStatus', 'startDate', 'workEmail'] },
  { key: 'pay', fields: ['payAmountMinor', 'payFrequency'] },
  { key: 'contract', fields: ['contractType', 'noticePeriodDays', 'probationEndDate'] },
];
const EDITABLE = ['jobTitle', 'employmentType', 'weeklyHours', 'fte', 'payAmountMinor', 'payFrequency', 'contractType', 'noticePeriodDays', 'probationEndDate', 'preferredName', 'pronouns', 'personalEmail', 'personalPhone'];

function display(field: string, v: unknown, emp: Record<string, unknown>, locale: Locale): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'payAmountMinor' && typeof emp.payCurrency === 'string') return formatMoney(money(BigInt(String(v)), emp.payCurrency), locale);
  if (/Date$|^dateOfBirth$/.test(field) && typeof v === 'string') return formatDate(v, locale);
  return String(v);
}

export default function EmployeePage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const [asOf, setAsOf] = React.useState<string>('');
  const { data, error, reload } = useApi<ProfileResponse>(`/v1/employees/${id}${asOf ? `?asOf=${asOf}` : ''}`);
  const history = useApi<Record<string, Array<Record<string, unknown>>>>(data?.access.jobTitle !== 'none' ? `/v1/employees/${id}/history` : null);
  const docs = useApi<Array<{ id: string; title: string; createdAt: string; category: string }>>(`/v1/documents?employeeId=${id}`);
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [effectiveDate, setEffectiveDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const session = useSession();
  const canInvite = session?.permissions.some((p) => p === '*' || p === 'users.*' || p === 'users.invite');
  const balances = useApi<LeaveBalance[]>(`/v1/leave/balances/${id}`);

  if (error) return <EmptyState title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')} />;
  if (!data) return <Skeleton className="h-96 w-full" />;
  const e = data.employee;
  const writable = EDITABLE.filter((f) => data.access[f] === 'write');

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setSaving(true);
    const body: Record<string, unknown> = { effectiveDate };
    try {
      for (const [k, v] of Object.entries(values)) {
        if (v === '') continue;
        // money: decimal input → integer minor units for the person's pay currency (no floating point)
        body[k] = ['weeklyHours', 'fte', 'noticePeriodDays'].includes(k) ? Number(v) : k === 'payAmountMinor' ? Number(parseDecimal(v, String(e.payCurrency ?? 'GBP')).amountMinor) : v;
      }
      const res = await fetch(`/v1/employees/${id}/changes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new ApiProblem(res.status, 'error', (await res.json()).title, {});
      toast({ title: res.status === 202 ? t('people.changePending') : t('people.changeSaved'), tone: 'success' });
      setOpen(false);
      setValues({});
      reload();
      history.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-pill bg-accent-subtle text-title-3 text-accent">
          {String(e.displayName ?? '?').split(' ').map((p) => p[0]).slice(0, 2).join('')}
        </span>
        <div className="mr-auto">
          <h1 className="text-title-2">{e.displayName}</h1>
          <p className="text-callout text-text-secondary">
            {[e.jobTitle, e.department, e.location].filter(Boolean).join(' · ')}
          </p>
          {e.status ? <Badge className="mt-2" tone={e.status === 'active' ? 'success' : 'neutral'}>{t(`people.status.${e.status}`)}</Badge> : null}
          {typeof e.endDate === 'string' && e.status !== 'leaver' ? (
            <Badge className="ml-2 mt-2" tone="warning" data-testid="leaving-on">
              {t('admin.leaver.leavingOn', { date: formatDate(e.endDate, locale) })}
            </Badge>
          ) : null}
        </div>
        {canInvite ? (
          <Button
            variant="secondary"
            className="self-end"
            loading={inviting}
            onClick={async () => {
              setInviting(true);
              try {
                await api(`/v1/employees/${id}/invite`, { method: 'POST', json: {} });
                toast({ title: t('people.invited'), tone: 'success' });
              } catch (err) {
                toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
              } finally {
                setInviting(false);
              }
            }}
          >
            <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('people.invite')}
          </Button>
        ) : null}
        {hasPermission(session, 'employees.update') && e.status !== 'leaver' ? <TransferDialog employeeId={id} name={String(e.displayName ?? '')} onDone={() => (reload(), history.reload())} /> : null}
        {hasPermission(session, 'employees.terminate') && e.status !== 'leaver' && !e.endDate ? <LeaverDialog employeeId={id} name={String(e.displayName ?? '')} onDone={reload} /> : null}
        <label className="flex flex-col gap-1 text-footnote text-text-secondary">
          {t('people.asOf')}
          <Input type="date" value={asOf || data.asOf} onChange={(ev) => setAsOf(ev.target.value)} className="w-44" />
        </label>
        {writable.length ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="secondary" className="self-end">
                <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('people.makeChange')}
              </Button>
            </DialogTrigger>
            <DialogContent title={t('people.makeChange')} description={t('people.makeChangeBody')} closeLabel={t('common.close')}>
              <form onSubmit={save} className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
                <Field id="effectiveDate" label={t('people.effectiveDate')}>
                  {(p) => <Input {...p} type="date" required value={effectiveDate} onChange={(ev) => setEffectiveDate(ev.target.value)} />}
                </Field>
                {writable.map((f) => (
                  <Field key={f} id={`f-${f}`} label={t(`people.field.${f}`)}>
                    {(p) => <Input {...p} type={/Date$/.test(f) ? 'date' : ['weeklyHours', 'fte', 'noticePeriodDays', 'payAmountMinor'].includes(f) ? 'number' : 'text'} step="any" placeholder={display(f, e[f], e, locale)} value={values[f] ?? ''} onChange={(ev) => setValues((v) => ({ ...v, [f]: ev.target.value }))} />}
                  </Field>
                ))}
                <Button type="submit" loading={saving}>
                  {t('common.save')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('people.tab.overview')}</TabsTrigger>
          {history.data ? <TabsTrigger value="history">{t('people.tab.history')}</TabsTrigger> : null}
          <TabsTrigger value="documents">{t('people.tab.documents')}</TabsTrigger>
          {balances.data ? <TabsTrigger value="time-off">{t('admin.balances.tab')}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview" className="pt-5">
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
        </TabsContent>
        <TabsContent value="history" className="pt-5">
          <ol className="flex flex-col gap-3">
            {(history.data?.job ?? []).map((j) => (
              <li key={String(j.id)} className="flex gap-3 rounded-md border border-border p-3">
                <History aria-hidden className="mt-0.5 h-5 w-5 stroke-[1.5] text-accent" />
                <div>
                  <p className="text-callout font-semibold">{String(j.job_title)}</p>
                  <p className="text-footnote text-text-secondary">
                    {formatDate(String(j.valid_from), locale)} – {j.valid_to ? formatDate(String(j.valid_to), locale) : t('people.ongoing')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </TabsContent>
        {balances.data ? (
          <TabsContent value="time-off" className="pt-5">
            <BalancesPanel employeeId={id} name={String(e.displayName ?? '')} canAdjust={hasPermission(session, 'leave.adjust')} balances={balances.data} onChanged={balances.reload} />
          </TabsContent>
        ) : null}
        <TabsContent value="documents" className="pt-5">
          {docs.data?.length ? (
            <ul className="flex flex-col gap-2">
              {docs.data.map((d) => (
                <li key={d.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <FileText aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                  <button type="button" className="text-left text-callout text-accent hover:underline" onClick={async () => window.open((await api<{ url: string }>(`/v1/documents/${d.id}/download`)).url, '_blank', 'noopener')}>
                    {d.title}
                  </button>
                  <span className="ml-auto text-footnote text-text-secondary">{formatDate(d.createdAt.slice(0, 10), locale)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<FileText aria-hidden />} title={t('documents.empty')} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
