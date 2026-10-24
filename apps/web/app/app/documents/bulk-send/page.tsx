'use client';
import * as React from 'react';
import { Send, Users } from 'lucide-react';
import {
  Button,
  Card,
  Field,
  Input,
  nativeSelectClass,
  PageSection,
  Skeleton,
  Textarea,
  useToast,
} from '@thapsus/ui';
import type { SigningOrder } from '@thapsus/core/documents';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { BackLink } from '@/components/breadcrumbs';
import { Checkbox, RadioGroup, ReadOnlyNote, useOrg, usePermission } from '../../settings/kit';
import { PageTitle } from '../../shell';

interface TemplateSummary {
  id: string;
  name: string;
  requiresCountersign: boolean;
  signingOrder: SigningOrder;
  askFields: Array<{ key: string; label: string; required: boolean }>;
}
interface Job {
  status: string;
  progressDone: string;
  progressTotal: string | null;
  result: { sent?: number; skipped?: number; missing?: number } | null;
  error: string | null;
}

/**
 * Send a template to many people at once (16.11): filters by entity, department and location, the same signing
 * options as a single send, a count before sending, and the background job's progress. People whose records lack a
 * value the template needs are skipped and counted, never sent a document with blanks.
 */
export default function BulkSendPage() {
  const t = useT();
  const toast = useToast();
  const has = usePermission();
  const canManage = has('documents.manage');
  const templates = useApi<TemplateSummary[]>(canManage ? '/v1/document-templates' : null);
  const entities = useOrg('legal-entities');
  const departments = useOrg('departments');
  const locations = useOrg('locations');
  const [templateId, setTemplateId] = React.useState('');
  const [filter, setFilter] = React.useState({ entityId: '', departmentId: '', locationId: '' });
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [employeeSigns, setEmployeeSigns] = React.useState(true);
  const [companySigns, setCompanySigns] = React.useState(false);
  const [order, setOrder] = React.useState<SigningOrder>('employee_first');
  const [dueOn, setDueOn] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [count, setCount] = React.useState<number | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<Job | null>(null);
  const [busy, setBusy] = React.useState(false);
  const tpl = templates.data?.find((x) => x.id === templateId);

  // the job's progress, until it has finished
  React.useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api<Job>(`/v1/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (!['succeeded', 'failed'].includes(j.status)) setTimeout(tick, 1000);
      } catch {
        if (!stop) setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId]);

  if (!canManage) return <ReadOnlyNote />;
  const body = (dryRun: boolean) => ({
    templateId,
    requireSignature: employeeSigns,
    requireCountersign: employeeSigns && companySigns,
    signingOrder: order,
    ...(dueOn ? { dueOn } : {}),
    ...(message.trim() ? { message: message.trim() } : {}),
    values,
    dryRun,
    filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v)),
  });
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ jobId: string | null; recipients: number }>('/v1/documents/bulk-send', {
        method: 'POST',
        json: body(dryRun),
      });
      setCount(r.recipients);
      if (!dryRun && r.jobId) {
        setJob(null);
        setJobId(r.jobId);
      }
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const changed = () => {
    setCount(null);
    setJobId(null);
    setJob(null);
  };
  const orgSelect = (key: keyof typeof filter, label: string, list: ReturnType<typeof useOrg>) => (
    <div className="flex min-w-48 flex-1 flex-col gap-1.5">
      <label htmlFor={`bulk-${key}`} className="text-callout font-semibold">
        {label}
      </label>
      <select
        id={`bulk-${key}`}
        className={nativeSelectClass}
        value={filter[key]}
        onChange={(e) => {
          setFilter((f) => ({ ...f, [key]: e.target.value }));
          changed();
        }}
      >
        <option value="">{t('docBulk.any')}</option>
        {(list.data ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
  const done = Number(job?.progressDone ?? 0);
  const total = Number(job?.progressTotal ?? count ?? 0);
  const finished = job && ['succeeded', 'failed'].includes(job.status);
  const missingRequired = (tpl?.askFields ?? []).some((a) => a.required && !values[a.key]?.trim());

  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/app/documents" label={t('documents.title')} />
      <div className="flex flex-col gap-1">
        <PageTitle>{t('docBulk.title')}</PageTitle>
        <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('docBulk.lead')}</p>
      </div>
      <PageSection title={t('docBulk.what')} headingLevel={3}>
        <Card className="flex flex-col gap-4">
          {templates.data ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bulk-template" className="text-callout font-semibold">
                {t('docSend.template')}
              </label>
              <select
                id="bulk-template"
                className={nativeSelectClass}
                value={templateId}
                onChange={(e) => {
                  const next = templates.data!.find((x) => x.id === e.target.value);
                  setTemplateId(e.target.value);
                  setValues({});
                  if (next) {
                    setCompanySigns(next.requiresCountersign);
                    setOrder(next.signingOrder);
                  }
                  changed();
                }}
              >
                <option value="">{t('docSend.chooseTemplate')}</option>
                {templates.data.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <Skeleton className="h-11 w-full" />
          )}
          {tpl?.askFields.map((a) => (
            <Field key={a.key} id={`bulk-ask-${a.key}`} label={a.label} hint={t('docBulk.askHint')}>
              {(p) => (
                <Input
                  {...p}
                  required={a.required}
                  maxLength={500}
                  value={values[a.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [a.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </Card>
      </PageSection>
      <PageSection title={t('docBulk.who')} headingLevel={3}>
        <Card className="flex flex-wrap gap-4">
          {orgSelect('entityId', t('docBulk.entity'), entities)}
          {orgSelect('departmentId', t('docBulk.department'), departments)}
          {orgSelect('locationId', t('docBulk.location'), locations)}
        </Card>
      </PageSection>
      <PageSection title={t('docSend.signingSection')} headingLevel={3}>
        <Card className="flex flex-col gap-4">
          <Checkbox
            id="bulk-employee"
            label={t('docBulk.employeeSigns')}
            checked={employeeSigns}
            onChange={setEmployeeSigns}
          />
          {employeeSigns ? (
            <Checkbox
              id="bulk-company"
              label={t('docSend.companySigns')}
              hint={t('docSend.companySignsHint')}
              checked={companySigns}
              onChange={setCompanySigns}
            />
          ) : null}
          {employeeSigns && companySigns ? (
            <RadioGroup
              name="bulk-order"
              legend={t('docSend.order')}
              value={order}
              onChange={setOrder}
              options={(['employee_first', 'company_first', 'any'] as const).map((v) => ({
                value: v,
                label: t(`docSend.orderOption.${v}`, { name: t('docBulk.eachPerson') }),
              }))}
            />
          ) : null}
          <Field id="bulk-due" label={`${t('docSend.dueOn')} ${t('admin.optional')}`}>
            {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
          </Field>
          <Field id="bulk-message" label={`${t('docSend.message')} ${t('admin.optional')}`}>
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                maxLength={1000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            )}
          </Field>
        </Card>
      </PageSection>
      <div className="flex flex-col gap-3" aria-live="polite">
        {count !== null && !jobId ? (
          <p className="flex items-center gap-2 text-callout font-semibold">
            <Users aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
            {t('docBulk.matching', { count })}
          </p>
        ) : null}
        {jobId ? (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-raised p-4 shadow-sm">
            <p className="text-callout font-semibold">
              {finished
                ? job!.status === 'succeeded'
                  ? t('docBulk.done')
                  : t('docBulk.failed')
                : t('docBulk.sending', { done, count: total })}
            </p>
            <div
              role="progressbar"
              aria-label={t('docBulk.progress')}
              aria-valuemin={0}
              aria-valuemax={total || 1}
              aria-valuenow={done}
              className="h-2 w-full overflow-hidden rounded-full bg-surface"
            >
              <div
                className="h-full rounded-full bg-accent transition-transform duration-[var(--duration-base)] motion-reduce:transition-none"
                style={{
                  width: '100%',
                  transform: `translateX(${total ? (done / total) * 100 - 100 : -100}%)`,
                }}
              />
            </div>
            {finished && job!.result ? (
              <p className="text-callout text-text-secondary">
                {t('docBulk.result', {
                  sent: job!.result.sent ?? 0,
                  skipped: job!.result.skipped ?? 0,
                  missing: job!.result.missing ?? 0,
                })}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="min-h-11"
            loading={busy && count === null}
            disabled={!templateId}
            onClick={() => run(true)}
          >
            {t('docBulk.count')}
          </Button>
          <Button
            className="min-h-11"
            loading={busy && count !== null}
            disabled={!templateId || count === null || count === 0 || !!jobId || missingRequired}
            onClick={() => run(false)}
          >
            <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {count ? t('docBulk.send', { count }) : t('docBulk.sendNone')}
          </Button>
        </div>
      </div>
    </div>
  );
}
