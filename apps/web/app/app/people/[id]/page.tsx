'use client';
import * as React from 'react';
import { usePathname, useSearchParams, useParams } from 'next/navigation';
import { History, Pencil, Send } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  ListItem,
  ListSection,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@thapsus/ui';
import { formatDate, formatMoney, numberFormat, type Locale } from '@thapsus/core/i18n';
import { money, parseDecimal } from '@thapsus/core/money';
import { today } from '@thapsus/core/time';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/zone';
import { Avatar } from '@/components/dashboard/parts';
import { PersonLink } from '@/components/person-link';
import { PageTitle, hasPermission, useSession } from '../../shell';
import type { LeaveBalance } from '@/components/leave-balances';
import { BalancesPanel, LeaverDialog, TransferDialog } from './actions';
import { PersonDocuments } from '@/components/documents/person-documents';
import { ComplianceTab } from './compliance-tab';

/** Profile tabs a link can open (`?tab=`, ADR-0161; the keys are `PROFILE_TABS` in @thapsus/core/links). */
type Tab = 'overview' | 'history' | 'documents' | 'time-off' | 'compliance';

interface ProfileResponse {
  employee: Record<string, unknown> & { id: string; displayName?: string };
  asOf: string;
  access: Record<string, 'none' | 'read' | 'write'>;
}

const SECTIONS: Array<{ key: string; fields: string[] }> = [
  {
    key: 'personal',
    fields: [
      'legalFirstName',
      'legalLastName',
      'preferredName',
      'pronouns',
      'dateOfBirth',
      'personalEmail',
      'personalPhone',
      'nationality',
    ],
  },
  {
    key: 'job',
    fields: [
      'jobTitle',
      'department',
      'location',
      'entity',
      'employmentType',
      'fte',
      'weeklyHours',
      'flsaStatus',
      'startDate',
      'workEmail',
    ],
  },
  { key: 'pay', fields: ['payAmountMinor', 'payFrequency'] },
  { key: 'contract', fields: ['contractType', 'noticePeriodDays', 'probationEndDate'] },
];
const EDITABLE = [
  'jobTitle',
  'employmentType',
  'weeklyHours',
  'fte',
  'payAmountMinor',
  'payFrequency',
  'contractType',
  'noticePeriodDays',
  'probationEndDate',
  'preferredName',
  'pronouns',
  'personalEmail',
  'personalPhone',
];

const ENUM_FIELDS = new Set(['employmentType', 'contractType', 'payFrequency']);
const NUMBER_FIELDS = new Set(['fte', 'weeklyHours', 'noticePeriodDays']);
const statusTone = { active: 'success', pre_start: 'accent', leaver: 'neutral' } as const;

/**
 * A field's value for reading. With `t`, coded values (employment type, contract type, pay frequency)
 * are shown in words and numbers in the locale's format; without it (form placeholders) the raw value
 * the API expects is kept.
 */
function display(
  field: string,
  v: unknown,
  emp: Record<string, unknown>,
  locale: Locale,
  t?: (k: string) => string,
): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'payAmountMinor' && typeof emp.payCurrency === 'string')
    return formatMoney(money(BigInt(String(v)), emp.payCurrency), locale);
  if (/Date$|^dateOfBirth$/.test(field) && typeof v === 'string') return formatDate(v, locale);
  if (t && ENUM_FIELDS.has(field)) {
    const key = `reports.enum.${field}.${String(v)}`;
    return t(key) === key ? String(v) : t(key);
  }
  if (t && NUMBER_FIELDS.has(field) && v !== '' && Number.isFinite(Number(v)))
    return numberFormat(locale, { maximumFractionDigits: 4 }).format(Number(v));
  return String(v);
}

export default function EmployeePage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const [asOf, setAsOf] = React.useState<string>('');
  const { data, error, reload } = useApi<ProfileResponse>(
    `/v1/employees/${id}${asOf ? `?asOf=${asOf}` : ''}`,
  );
  const history = useApi<Record<string, Array<Record<string, unknown>>>>(
    data?.access.jobTitle !== 'none' ? `/v1/employees/${id}/history` : null,
  );
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const session = useSession();
  // a change takes effect from today in the viewer's zone unless they pick another date
  const [effectiveDate, setEffectiveDate] = React.useState(() => today(viewerZone(session?.timeZone)));
  const [saving, setSaving] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const canInvite = hasPermission(session, 'users.invite');
  const balances = useApi<LeaveBalance[]>(`/v1/leave/balances/${id}`);
  // the tab is part of the address, so a link can open the profile on it and the back button returns to it
  const path = usePathname();
  const search = useSearchParams();
  const asked = (search.get('tab') ?? 'overview') as Tab;
  const canCompliance = hasPermission(session, 'compliance.read');
  const available: Record<Tab, boolean> = {
    overview: true,
    history: !!history.data,
    documents: true,
    'time-off': !!balances.data,
    compliance: canCompliance,
  };
  // a tab that is not (yet) available shows the overview until it is
  const tab: Tab = available[asked] ? asked : 'overview';
  const selectTab = (v: string) => {
    const q = new URLSearchParams(window.location.search);
    if (v === 'overview') q.delete('tab');
    else q.set('tab', v);
    const qs = q.toString();
    window.history.replaceState(null, '', `${path}${qs ? `?${qs}` : ''}`);
  };

  if (error)
    return (
      <EmptyState level={2} title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')} />
    );
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
        body[k] = ['weeklyHours', 'fte', 'noticePeriodDays'].includes(k)
          ? Number(v)
          : k === 'payAmountMinor'
            ? Number(parseDecimal(v, String(e.payCurrency ?? 'GBP')).amountMinor)
            : v;
      }
      const res = await fetch(`/v1/employees/${id}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ApiProblem(res.status, 'error', (await res.json()).title, {});
      toast({
        title: res.status === 202 ? t('people.changePending') : t('people.changeSaved'),
        tone: 'success',
      });
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

  const manager =
    e.manager && typeof e.manager === 'object' ? (e.manager as { id: string; displayName: string }) : null;
  const meta: Array<{ key: string; label: string; value: React.ReactNode }> = [];
  if ('manager' in e)
    meta.push({
      key: 'manager',
      label: t('people.field.managerId'),
      value: manager ? (
        <PersonLink id={manager.id} name={manager.displayName} />
      ) : (
        t('people.profile.noManager')
      ),
    });
  for (const f of ['department', 'location', 'startDate', 'employeeNumber', 'workEmail'] as const)
    if (f in e && (f !== 'workEmail' || e.workEmail))
      meta.push({
        key: f,
        label: t(`people.field.${f}`),
        value:
          f === 'workEmail' && typeof e.workEmail === 'string' ? (
            <a href={`mailto:${e.workEmail}`} className="break-all text-text hover:text-accent">
              {e.workEmail}
            </a>
          ) : (
            display(f, e[f], e, locale, t)
          ),
      });
  const name = String(e.displayName ?? '');

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-0" data-testid="profile-header">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4 p-5 md:p-6">
          <Avatar name={name} size="lg" />
          <div className="min-w-0 flex-1 basis-56">
            <PageTitle className="text-title-2 break-words">{e.displayName}</PageTitle>
            {e.jobTitle ? <p className="text-body text-text-secondary">{String(e.jobTitle)}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {e.status ? (
                <Badge tone={statusTone[e.status as keyof typeof statusTone] ?? 'neutral'}>
                  {t(`people.status.${e.status}`)}
                </Badge>
              ) : null}
              {typeof e.endDate === 'string' && e.status !== 'leaver' ? (
                <Badge tone="warning" data-testid="leaving-on">
                  {t('admin.leaver.leavingOn', { date: formatDate(e.endDate, locale) })}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {writable.length ? (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Pencil aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('people.makeChange')}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={t('people.makeChange')}
                  description={t('people.makeChangeBody')}
                  closeLabel={t('common.close')}
                >
                  <form onSubmit={save} className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
                    <Field id="effectiveDate" label={t('people.effectiveDate')}>
                      {(p) => (
                        <Input
                          {...p}
                          type="date"
                          required
                          value={effectiveDate}
                          onChange={(ev) => setEffectiveDate(ev.target.value)}
                        />
                      )}
                    </Field>
                    {writable.map((f) => (
                      <Field key={f} id={`f-${f}`} label={t(`people.field.${f}`)}>
                        {(p) => (
                          <Input
                            {...p}
                            type={
                              /Date$/.test(f)
                                ? 'date'
                                : ['weeklyHours', 'fte', 'noticePeriodDays', 'payAmountMinor'].includes(f)
                                  ? 'number'
                                  : 'text'
                            }
                            step="any"
                            placeholder={display(f, e[f], e, locale)}
                            value={values[f] ?? ''}
                            onChange={(ev) => setValues((v) => ({ ...v, [f]: ev.target.value }))}
                          />
                        )}
                      </Field>
                    ))}
                    <Button type="submit" loading={saving}>
                      {t('common.save')}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            ) : null}
            {hasPermission(session, 'employees.update') && e.status !== 'leaver' ? (
              <TransferDialog employeeId={id} name={name} onDone={() => (reload(), history.reload())} />
            ) : null}
            {hasPermission(session, 'employees.terminate') && e.status !== 'leaver' && !e.endDate ? (
              <LeaverDialog employeeId={id} name={name} onDone={reload} />
            ) : null}
            {canInvite ? (
              <Button
                variant="secondary"
                loading={inviting}
                onClick={async () => {
                  setInviting(true);
                  try {
                    await api(`/v1/employees/${id}/invite`, { method: 'POST', json: {} });
                    toast({ title: t('people.invited'), tone: 'success' });
                  } catch (err) {
                    toast({
                      title: err instanceof ApiProblem ? err.title : t('common.error'),
                      tone: 'danger',
                    });
                  } finally {
                    setInviting(false);
                  }
                }}
              >
                <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('people.invite')}
              </Button>
            ) : null}
          </div>
        </div>
        {meta.length ? (
          <dl className="grid gap-x-6 gap-y-3 border-t border-border p-5 text-callout sm:grid-cols-2 md:px-6 lg:grid-cols-3 xl:grid-cols-6">
            {meta.map((m) => (
              <div key={m.key} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-footnote text-text-secondary">{m.label}</dt>
                <dd className="break-words font-semibold text-text">{m.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      <Tabs value={tab} onValueChange={selectTab}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <TabsList>
            <TabsTrigger value="overview">{t('people.tab.overview')}</TabsTrigger>
            {history.data ? <TabsTrigger value="history">{t('people.tab.history')}</TabsTrigger> : null}
            <TabsTrigger value="documents">{t('people.tab.documents')}</TabsTrigger>
            {balances.data ? <TabsTrigger value="time-off">{t('admin.balances.tab')}</TabsTrigger> : null}
            {canCompliance ? (
              <TabsTrigger value="compliance">{t('actionable.person.complianceTab')}</TabsTrigger>
            ) : null}
          </TabsList>
          <label className="flex items-center gap-2 text-footnote text-text-secondary">
            {t('people.asOf')}
            <Input
              type="date"
              value={asOf || data.asOf}
              onChange={(ev) => setAsOf(ev.target.value)}
              className="w-44"
            />
          </label>
        </div>
        <TabsContent value="overview" className="pt-5">
          <div className="grid gap-4 md:grid-cols-2">
            {SECTIONS.map((s) => {
              const visible = s.fields.filter((f) => f in e);
              if (!visible.length) return null;
              return (
                <Card key={s.key}>
                  <CardTitle as="h3">{t(`people.section.${s.key}`)}</CardTitle>
                  <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-2 text-callout">
                    {visible.map((f) => (
                      <React.Fragment key={f}>
                        <dt className="text-text-secondary">{t(`people.field.${f}`)}</dt>
                        <dd className="break-words">{display(f, e[f], e, locale, t)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </Card>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="history" className="pt-5">
          {/* grouped rows (ADR-0180): each job, newest first, with its dates under it */}
          <ListSection>
            {(history.data?.job ?? []).map((j) => (
              <ListItem
                key={String(j.id)}
                leading={<History aria-hidden />}
                title={String(j.job_title)}
                subtitle={`${formatDate(String(j.valid_from), locale)} – ${j.valid_to ? formatDate(String(j.valid_to), locale) : t('people.ongoing')}`}
              />
            ))}
          </ListSection>
        </TabsContent>
        {balances.data ? (
          <TabsContent value="time-off" className="pt-5">
            <BalancesPanel
              employeeId={id}
              name={String(e.displayName ?? '')}
              canAdjust={hasPermission(session, 'leave.adjust')}
              balances={balances.data}
              onChanged={balances.reload}
            />
          </TabsContent>
        ) : null}
        {canCompliance ? (
          <TabsContent value="compliance" className="pt-5">
            {tab === 'compliance' ? <ComplianceTab employeeId={id} /> : null}
          </TabsContent>
        ) : null}
        <TabsContent value="documents" className="pt-5">
          <PersonDocuments
            employeeId={id}
            name={String(e.displayName ?? '')}
            canAttach={hasPermission(session, 'documents.manage')}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
