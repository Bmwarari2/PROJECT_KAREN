'use client';
import * as React from 'react';
import { Download, FileJson, FilePlus2, Inbox, ShieldAlert, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { SELECT_CLASS, type Dsr, type ErasurePlan } from './types';
import { PersonLink } from '@/components/person-link';
import { useCan } from '../shell';

const KINDS = ['access', 'correction', 'deletion'] as const;
const CHANNELS = ['email', 'portal', 'letter', 'phone', 'in_person', 'other'] as const;
const IDENTITY = [
  'signed_in_account',
  'known_contact_details',
  'document_check',
  'agent_authorisation',
  'other',
] as const;
const CORRECTABLE = [
  'legalFirstName',
  'legalLastName',
  'preferredName',
  'pronouns',
  'personalEmail',
  'personalPhone',
  'dateOfBirth',
] as const;
const statusTone = {
  received: 'warning',
  in_progress: 'accent',
  completed: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

function useProblem() {
  const t = useT();
  const toast = useToast();
  return (err: unknown) =>
    toast({
      title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
      tone: 'danger',
    });
}

function DueBadge({ r }: { r: Dsr }) {
  const t = useT();
  if (!r.effectiveDueOn) return <Badge>{t('privacy.ui.noDeadline')}</Badge>;
  if (r.overdue) return <Badge tone="danger">{t('privacy.ui.overdue')}</Badge>;
  if (['completed', 'rejected', 'cancelled'].includes(r.status)) return null;
  return (
    <Badge tone={r.daysRemaining !== null && r.daysRemaining <= 7 ? 'warning' : 'neutral'}>
      {t('privacy.ui.daysLeft', { days: r.daysRemaining ?? 0, count: r.daysRemaining ?? 0 })}
    </Badge>
  );
}

export default function PrivacyRequestsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const problem = useProblem();
  const [status, setStatus] = React.useState('open');
  const can = useCan();
  const canHandle = can('privacy.requests.manage');
  const list = useApi<Dsr[]>(`/v1/privacy/requests?status=${status}`);
  const [selected, setSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('request');
    if (id) setSelected(id);
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = React.useState({
    kind: 'access' as (typeof KINDS)[number],
    subjectEmployeeId: '',
    receivedOn: today,
    channel: 'email',
    identityMethod: '',
    identityNote: '',
    details: '',
  });
  const [query, setQuery] = React.useState('');
  const q = useDebounced(query);
  const people = useApi<{ data: Array<{ id: string; displayName: string; jobTitle?: string | null }> }>(
    q.trim().length >= 2 ? `/v1/employees?q=${encodeURIComponent(q.trim())}&status=all&limit=20` : null,
  );
  const [busy, setBusy] = React.useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form.subjectEmployeeId) return toast({ title: t('privacy.ui.form.pickSubject'), tone: 'danger' });
    setBusy(true);
    try {
      const r = await api<Dsr>('/v1/privacy/requests', {
        method: 'POST',
        json: {
          kind: form.kind,
          subjectEmployeeId: form.subjectEmployeeId,
          receivedOn: form.receivedOn,
          channel: form.channel,
          details: form.details || undefined,
          identity: form.identityMethod
            ? { method: form.identityMethod, note: form.identityNote || undefined }
            : undefined,
        },
        capability: 'privacy.requests.manage',
      });
      toast({
        title: r.effectiveDueOn
          ? t('privacy.ui.created', { date: formatDate(r.effectiveDueOn, locale) })
          : t('privacy.ui.createdNoDeadline'),
        tone: 'success',
      });
      setSelected(r.id);
      list.reload();
    } catch (err) {
      problem(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      {canHandle ? (
        <PageSection
          headingLevel={2}
          title={t('privacy.ui.form.title')}
          description={t('privacy.ui.form.lead')}
        >
          <Card>
            <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field id="dsr-kind" label={t('privacy.ui.form.kind')}>
                {(p) => (
                  <select
                    {...p}
                    className={`${SELECT_CLASS} w-full`}
                    value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value as (typeof KINDS)[number] })}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`privacy.ui.kind.${k}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                id="dsr-search"
                label={t('privacy.ui.form.findPerson')}
                hint={t('privacy.ui.form.findHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field id="dsr-subject" label={t('privacy.ui.form.subject')}>
                {(p) => (
                  <select
                    {...p}
                    className={`${SELECT_CLASS} w-full`}
                    value={form.subjectEmployeeId}
                    onChange={(e) => setForm({ ...form, subjectEmployeeId: e.target.value })}
                  >
                    <option value="">{t('privacy.ui.form.choose')}</option>
                    {(people.data?.data ?? []).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="dsr-received" label={t('privacy.ui.form.received')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    max={today}
                    value={form.receivedOn}
                    onChange={(e) => setForm({ ...form, receivedOn: e.target.value })}
                  />
                )}
              </Field>
              <Field id="dsr-channel" label={t('privacy.ui.form.channel')}>
                {(p) => (
                  <select
                    {...p}
                    className={`${SELECT_CLASS} w-full`}
                    value={form.channel}
                    onChange={(e) => setForm({ ...form, channel: e.target.value })}
                  >
                    {CHANNELS.map((k) => (
                      <option key={k} value={k}>
                        {t(`privacy.ui.channel.${k}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="dsr-identity" label={t('privacy.ui.form.identity')}>
                {(p) => (
                  <select
                    {...p}
                    className={`${SELECT_CLASS} w-full`}
                    value={form.identityMethod}
                    onChange={(e) => setForm({ ...form, identityMethod: e.target.value })}
                  >
                    <option value="">{t('privacy.ui.form.notYet')}</option>
                    {IDENTITY.map((k) => (
                      <option key={k} value={k}>
                        {t(`privacy.ui.identity.${k}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                id="dsr-identity-note"
                label={t('privacy.ui.form.identityNote')}
                hint={t('privacy.ui.form.identityNoteHint')}
                className="md:col-span-3"
              >
                {(p) => (
                  <Input
                    {...p}
                    maxLength={1000}
                    value={form.identityNote}
                    onChange={(e) => setForm({ ...form, identityNote: e.target.value })}
                  />
                )}
              </Field>
              <Field id="dsr-details" label={t('privacy.ui.form.details')} className="md:col-span-3">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={2}
                    maxLength={4000}
                    value={form.details}
                    onChange={(e) => setForm({ ...form, details: e.target.value })}
                  />
                )}
              </Field>
              <div className="md:col-span-3">
                <Button type="submit" loading={busy}>
                  <FilePlus2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('privacy.ui.form.submit')}
                </Button>
              </div>
            </form>
          </Card>
        </PageSection>
      ) : (
        <p className="text-callout text-text-secondary">{t('visibility.readOnly')}</p>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="mr-auto">{t('privacy.ui.queue')}</CardTitle>
          <label htmlFor="dsr-filter" className="text-footnote text-text-secondary">
            {t('privacy.ui.filter')}
          </label>
          <select
            id="dsr-filter"
            className={SELECT_CLASS}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {['open', 'all', 'completed', 'rejected'].map((s) => (
              <option key={s} value={s}>
                {t(`privacy.ui.statusFilter.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {list.loading && !list.data ? (
          <Skeleton className="mt-4 h-32" />
        ) : list.data?.length ? (
          <div className="mt-3">
            <Table dense scrollLabel={t('privacy.ui.queue')}>
              <THead>
                <tr>
                  <TH>{t('privacy.ui.col.subject')}</TH>
                  <TH>{t('privacy.ui.col.kind')}</TH>
                  <TH>{t('privacy.ui.col.received')}</TH>
                  <TH>{t('privacy.ui.col.due')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {list.data.map((r) => (
                  <TR key={r.id} className={selected === r.id ? 'bg-accent-subtle' : undefined}>
                    <TD>
                      <PersonLink id={r.subjectEmployeeId} name={r.subjectName} />
                    </TD>
                    <TD>{t(`privacy.ui.kind.${r.kind}`)}</TD>
                    <TD className="tabular-nums" label={t('privacy.ui.col.received')}>
                      {formatDate(r.receivedOn, locale)}
                    </TD>
                    <TD className="tabular-nums" label={t('privacy.ui.col.due')}>
                      <span className="mr-2">
                        {r.effectiveDueOn ? formatDate(r.effectiveDueOn, locale) : '—'}
                      </span>
                      <DueBadge r={r} />
                    </TD>
                    <TD>
                      <Badge tone={statusTone[r.status as keyof typeof statusTone] ?? 'neutral'}>
                        {t(`privacy.ui.status.${r.status}`)}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(r.id)}
                        aria-label={t('privacy.ui.openFor', { name: r.subjectName ?? '—' })}
                      >
                        {t('privacy.ui.open')}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={<Inbox aria-hidden className="h-8 w-8 stroke-[1.5]" />}
            title={t('privacy.ui.empty')}
            body={t('privacy.ui.emptyBody')}
          />
        )}
      </Card>

      {selected ? <RequestDetail key={selected} id={selected} onChanged={list.reload} /> : null}
    </div>
  );
}

function RequestDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useT();
  const can = useCan();
  const canHandle = can('privacy.requests.manage');
  const locale = useLocale();
  const toast = useToast();
  const problem = useProblem();
  const r = useApi<Dsr>(`/v1/privacy/requests/${id}`);
  const [identity, setIdentity] = React.useState({
    method: 'document_check',
    note: '',
    informationReceivedOn: '',
  });
  const [reason, setReason] = React.useState('');
  const [correction, setCorrection] = React.useState({
    field: 'legalLastName',
    value: '',
    effectiveDate: new Date().toISOString().slice(0, 10),
  });
  const [plan, setPlan] = React.useState<ErasurePlan | null>(null);
  const [confirmErase, setConfirmErase] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function act(name: string, fn: () => Promise<unknown>, success: string) {
    setBusy(name);
    try {
      await fn();
      toast({ title: success, tone: 'success' });
      r.reload();
      onChanged();
    } catch (err) {
      problem(err);
    } finally {
      setBusy(null);
    }
  }

  async function download(file: 'json' | 'pdf') {
    try {
      const { url } = await api<{ url: string }>(`/v1/privacy/requests/${id}/download?file=${file}`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      problem(err);
    }
  }

  if (!r.data) return <Skeleton className="h-48" />;
  const d = r.data;
  // readers (privacy.read) follow a request; handling it needs privacy.dsr, erasing privacy.erase (ADR-0188)
  const open = !['completed', 'rejected', 'cancelled'].includes(d.status) && canHandle;
  return (
    <Card aria-labelledby="dsr-detail-title">
      <h2 id="dsr-detail-title" className="text-title-3">
        {t('privacy.ui.detail.title', { kind: t(`privacy.ui.kind.${d.kind}`), name: d.subjectName ?? '—' })}
      </h2>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-callout sm:grid-cols-2">
        <div>
          <dt className="text-footnote text-text-secondary">{t('privacy.ui.detail.law')}</dt>
          <dd>{d.jurisdiction}</dd>
        </div>
        <div>
          <dt className="text-footnote text-text-secondary">{t('privacy.ui.col.due')}</dt>
          <dd>
            {d.effectiveDueOn ? formatDate(d.effectiveDueOn, locale) : t('privacy.ui.noDeadline')}{' '}
            <DueBadge r={d} />
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-footnote text-text-secondary">{t('privacy.ui.detail.source')}</dt>
          <dd>
            {d.rule ? (
              <a href={d.rule.source.url} rel="noopener noreferrer" target="_blank">
                {d.rule.source.title}
              </a>
            ) : (
              t('privacy.ui.detail.noLaw', { jurisdiction: d.jurisdiction })
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-footnote text-text-secondary">{t('privacy.ui.detail.identity')}</dt>
          <dd>
            {d.identityVerifiedAt
              ? t('privacy.ui.detail.verified', { method: t(`privacy.ui.identity.${d.identityMethod}`) })
              : t('privacy.ui.detail.notVerified')}
          </dd>
        </div>
      </dl>

      {open && !d.identityVerifiedAt ? (
        <form
          className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4 md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'identity',
              () =>
                api(`/v1/privacy/requests/${id}/identity`, {
                  method: 'POST',
                  json: {
                    method: identity.method,
                    note: identity.note || undefined,
                    informationReceivedOn: identity.informationReceivedOn || undefined,
                  },
                  capability: 'privacy.requests.manage',
                }),
              t('privacy.ui.detail.identitySaved'),
            );
          }}
        >
          <Field id="id-method" label={t('privacy.ui.form.identity')}>
            {(p) => (
              <select
                {...p}
                className={`${SELECT_CLASS} w-full`}
                value={identity.method}
                onChange={(e) => setIdentity({ ...identity, method: e.target.value })}
              >
                {IDENTITY.map((k) => (
                  <option key={k} value={k}>
                    {t(`privacy.ui.identity.${k}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="id-note" label={t('privacy.ui.form.identityNote')}>
            {(p) => (
              <Input
                {...p}
                value={identity.note}
                onChange={(e) => setIdentity({ ...identity, note: e.target.value })}
              />
            )}
          </Field>
          <Field id="id-received" label={t('privacy.ui.detail.informationReceived')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={identity.informationReceivedOn}
                onChange={(e) => setIdentity({ ...identity, informationReceivedOn: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" loading={busy === 'identity'}>
            {t('privacy.ui.detail.recordIdentity')}
          </Button>
        </form>
      ) : null}

      {open && d.extensionAllowed ? (
        <form
          className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'extend',
              () =>
                api(`/v1/privacy/requests/${id}/extend`, {
                  method: 'POST',
                  json: { reason },
                  capability: 'privacy.requests.manage',
                }),
              t('privacy.ui.detail.extended'),
            );
          }}
        >
          <Field
            id="ext-reason"
            label={t('privacy.ui.detail.extendReason')}
            hint={
              d.extensionNoticeBy
                ? t('privacy.ui.detail.extendBy', { date: formatDate(d.extensionNoticeBy, locale) })
                : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                required
                minLength={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" loading={busy === 'extend'}>
            {t('privacy.ui.detail.extend')}
          </Button>
        </form>
      ) : null}

      {d.kind === 'access' ? (
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="text-callout font-semibold">{t('privacy.ui.detail.exportTitle')}</h3>
          {d.outcome?.export ? (
            <p className="mt-1 text-footnote text-text-secondary">
              {t('privacy.ui.detail.exportSummary', {
                kinds: t('privacy.ui.detail.exportKinds', {
                  count: Object.values(d.outcome.export.summary.tables).filter((n) => n > 0).length,
                }),
                values: t('privacy.ui.detail.exportValues', {
                  count: d.outcome.export.summary.sensitiveValues,
                }),
              })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {open ? (
              <Button
                size="sm"
                loading={busy === 'export'}
                onClick={() =>
                  act(
                    'export',
                    () =>
                      api(`/v1/privacy/requests/${id}/export`, {
                        method: 'POST',
                        capability: 'privacy.requests.manage',
                      }),
                    t('privacy.ui.detail.exportReady'),
                  )
                }
              >
                <FileJson aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {d.exportReady ? t('privacy.ui.detail.regenerate') : t('privacy.ui.detail.generate')}
              </Button>
            ) : null}
            {d.exportReady && canHandle ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => download('json')}>
                  <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('privacy.ui.detail.downloadJson')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => download('pdf')}>
                  <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('privacy.ui.detail.downloadPdf')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {d.kind === 'correction' && open && d.subjectEmployeeId ? (
        <form
          className="mt-5 grid grid-cols-1 gap-3 border-t border-border pt-4 md:grid-cols-4 md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'correct',
              () =>
                api(`/v1/privacy/requests/${id}/correction`, {
                  method: 'POST',
                  json: {
                    effectiveDate: correction.effectiveDate,
                    changes: { [correction.field]: correction.value },
                  },
                  capability: 'privacy.requests.manage',
                }),
              t('privacy.ui.detail.corrected'),
            );
          }}
        >
          <Field id="corr-field" label={t('privacy.ui.detail.field')}>
            {(p) => (
              <select
                {...p}
                className={`${SELECT_CLASS} w-full`}
                value={correction.field}
                onChange={(e) => setCorrection({ ...correction, field: e.target.value })}
              >
                {CORRECTABLE.map((f) => (
                  <option key={f} value={f}>
                    {t(`people.field.${f}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="corr-value" label={t('privacy.ui.detail.newValue')}>
            {(p) => (
              <Input
                {...p}
                required
                value={correction.value}
                onChange={(e) => setCorrection({ ...correction, value: e.target.value })}
              />
            )}
          </Field>
          <Field id="corr-date" label={t('privacy.ui.detail.effective')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                required
                value={correction.effectiveDate}
                onChange={(e) => setCorrection({ ...correction, effectiveDate: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit" loading={busy === 'correct'}>
            {t('privacy.ui.detail.applyCorrection')}
          </Button>
        </form>
      ) : null}

      {d.kind === 'deletion' && open ? (
        <div className="mt-5 border-t border-border pt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={async () =>
              setPlan(
                await api<ErasurePlan>(`/v1/privacy/requests/${id}/erasure-plan`).catch(
                  (e) => (problem(e), null),
                ),
              )
            }
          >
            <ShieldAlert aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('privacy.ui.detail.reviewPlan')}
          </Button>
          {plan ? (
            <div className="mt-3 grid gap-3 text-callout">
              <p>
                {plan.erase.length
                  ? t('privacy.ui.detail.willErase', {
                      list: plan.erase.map((c) => t(`privacy.ui.category.${c}`)).join(', '),
                    })
                  : t('privacy.ui.detail.nothingToErase')}
              </p>
              {plan.retain.length ? (
                <ul className="grid gap-1">
                  {plan.retain.map((k) => (
                    <li key={k.category}>
                      {t(
                        k.reason === 'legal_hold'
                          ? 'privacy.ui.detail.keptHold'
                          : k.until
                            ? 'privacy.ui.detail.keptUntil'
                            : 'privacy.ui.detail.keptOpen',
                        {
                          category: t(`privacy.ui.category.${k.category}`),
                          date: k.until ? formatDate(k.until, locale) : '',
                        },
                      )}
                      {k.rules[0] ? (
                        <>
                          {' '}
                          <a href={k.rules[0].source.url} rel="noopener noreferrer" target="_blank">
                            {k.rules[0].source.title}
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {plan.erase.length ? (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={confirmErase}
                      onChange={(e) => setConfirmErase(e.target.checked)}
                      className="h-5 w-5 accent-[var(--color-danger)]"
                    />
                    {t('privacy.ui.detail.confirmErase')}
                  </label>
                  {can('privacy.requests.erase') ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!confirmErase}
                      loading={busy === 'erase'}
                      onClick={() =>
                        act(
                          'erase',
                          () =>
                            api(`/v1/privacy/requests/${id}/erase`, {
                              method: 'POST',
                              json: { confirm: true },
                              capability: 'privacy.requests.erase',
                            }),
                          t('privacy.ui.detail.erased'),
                        )
                      }
                    >
                      <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      {t('privacy.ui.detail.erase')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'complete'}
            onClick={() =>
              act(
                'complete',
                () =>
                  api(`/v1/privacy/requests/${id}/close`, {
                    method: 'POST',
                    json: { outcome: 'completed' },
                    capability: 'privacy.requests.manage',
                  }),
                t('privacy.ui.detail.closed'),
              )
            }
          >
            {t('privacy.ui.detail.complete')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'reject'}
            onClick={() =>
              act(
                'reject',
                () =>
                  api(`/v1/privacy/requests/${id}/close`, {
                    method: 'POST',
                    json: { outcome: 'rejected' },
                    capability: 'privacy.requests.manage',
                  }),
                t('privacy.ui.detail.closed'),
              )
            }
          >
            {t('privacy.ui.detail.reject')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
