'use client';
import * as React from 'react';
import { ListChecks, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../../shell';
import { PageIntro } from '@/components/module-page';
import { selectClass, StatusBadge } from '../ui';
import { PersonLink, ROW_LINK } from '@/components/person-link';

const KINDS = ['licence', 'certification', 'background_check', 'training', 'other'] as const;
const STATUSES = ['missing', 'expired', 'expiring', 'compliant'] as const;
interface Requirement {
  id: string;
  kind: string;
  name: string;
  appliesTo: { jobTitles?: string[] };
  validityMonths: number | null;
  reminderDays: number[];
  evidenceRequired: boolean;
  active: boolean;
}
interface MatrixRow {
  employeeId: string;
  employeeName: string;
  jobTitle: string | null;
  requirementId: string;
  requirementName: string;
  kind: string;
  status: string;
  issuedOn: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
}
interface Matrix {
  asOf: string;
  summary: Record<(typeof STATUSES)[number], number>;
  total: number;
  rows: MatrixRow[];
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export default function MatrixPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const canManage = !!session?.permissions.some(
    (p) => p === '*' || p === 'compliance.*' || p === 'compliance.manage',
  );
  const [status, setStatus] = React.useState('');
  const [kind, setKind] = React.useState('');
  const [requirementId, setRequirementId] = React.useState('');
  const query = new URLSearchParams(
    Object.entries({ status, kind, requirementId }).filter(([, v]) => v),
  ).toString();
  const matrix = useApi<Matrix>(`/v1/compliance/matrix${query ? `?${query}` : ''}`);
  const reqs = useApi<Requirement[]>('/v1/compliance/requirements');
  const [adding, setAdding] = React.useState(false);
  const [reqForm, setReqForm] = React.useState({
    kind: 'licence',
    name: '',
    jobTitles: '',
    validityMonths: '',
    reminderDays: '',
    evidenceRequired: false,
  });
  const [recording, setRecording] = React.useState<MatrixRow | null>(null);
  const [recForm, setRecForm] = React.useState({ issuedOn: '', expiresOn: '', reference: '' });
  const [busy, setBusy] = React.useState(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      matrix.reload();
      reqs.reload();
      return true;
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function addRequirement(e: React.FormEvent) {
    e.preventDefault();
    const days = list(reqForm.reminderDays)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    const ok = await run(
      () =>
        api('/v1/compliance/requirements', {
          method: 'POST',
          json: {
            kind: reqForm.kind,
            name: reqForm.name,
            appliesTo: list(reqForm.jobTitles).length ? { jobTitles: list(reqForm.jobTitles) } : {},
            validityMonths: reqForm.validityMonths ? Number(reqForm.validityMonths) : null,
            reminderDays: days,
            evidenceRequired: reqForm.evidenceRequired,
          },
        }),
      t('compliance.matrix.added'),
    );
    if (ok) setAdding(false);
  }
  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!recording) return;
    const ok = await run(
      () =>
        api('/v1/compliance/records', {
          method: 'POST',
          json: {
            requirementId: recording.requirementId,
            employeeId: recording.employeeId,
            issuedOn: recForm.issuedOn,
            expiresOn: recForm.expiresOn || undefined,
            reference: recForm.reference || undefined,
          },
        }),
      t('compliance.matrix.recorded'),
    );
    if (ok) setRecording(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageIntro
        title={t('compliance.matrix.title')}
        titleIsTab
        lead={t('compliance.matrix.intro')}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('compliance.matrix.addRequirement')}
            </Button>
          ) : undefined
        }
      />
      {matrix.data ? (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {STATUSES.map((s) => (
            <Card key={s} className="flex flex-col gap-1">
              <dt className="text-footnote text-text-secondary">{t(`compliance.status.${s}`)}</dt>
              <dd className="text-title-2 tabular-nums">{formatNumber(matrix.data!.summary[s], locale)}</dd>
            </Card>
          ))}
        </dl>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Field id="f-status" label={t('compliance.matrix.filterStatus')}>
          {(p) => (
            <select {...p} className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('compliance.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`compliance.status.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="f-kind" label={t('compliance.matrix.filterKind')}>
          {(p) => (
            <select {...p} className={selectClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('compliance.all')}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`compliance.kind.${k}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="f-req" label={t('compliance.matrix.filterRequirement')}>
          {(p) => (
            <select
              {...p}
              className={selectClass}
              value={requirementId}
              onChange={(e) => setRequirementId(e.target.value)}
            >
              <option value="">{t('compliance.all')}</option>
              {(reqs.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {!matrix.data ? (
        matrix.error ? (
          <EmptyState title={t('compliance.noAccess')} />
        ) : (
          <Skeleton className="h-40 w-full" />
        )
      ) : !reqs.data?.length ? (
        <EmptyState
          icon={<ListChecks aria-hidden />}
          title={t('compliance.matrix.empty')}
          body={t('compliance.matrix.emptyBody')}
        />
      ) : matrix.data.rows.length === 0 ? (
        <p className="text-callout text-text-secondary">{t('compliance.matrix.noRows')}</p>
      ) : (
        <Card className="p-0">
          <Table dense>
            <THead>
              <tr>
                <TH>{t('compliance.col.person')}</TH>
                <TH>{t('compliance.matrix.requirement')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>{t('compliance.matrix.expires')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {matrix.data.rows.map((r) => (
                <TR key={`${r.employeeId}:${r.requirementId}`}>
                  <TD>
                    <PersonLink
                      id={r.employeeId}
                      name={r.employeeName}
                      tab="compliance"
                      className={ROW_LINK}
                    />
                    {r.jobTitle ? (
                      <span className="block text-footnote font-normal text-text-secondary">
                        {r.jobTitle}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    {r.requirementName}{' '}
                    <Badge className="ml-1 max-sm:hidden">{t(`compliance.kind.${r.kind}`)}</Badge>
                  </TD>
                  <TD phone="inline">
                    <StatusBadge status={r.status} />
                  </TD>
                  <TD phone="inline" label={t('compliance.matrix.expires')}>
                    {r.expiresOn
                      ? `${formatDate(r.expiresOn, locale)}${r.daysLeft !== null && r.daysLeft >= 0 ? ` · ${t('compliance.matrix.daysLeft', { days: r.daysLeft, count: r.daysLeft })}` : ''}`
                      : '—'}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setRecForm({ issuedOn: '', expiresOn: '', reference: '' });
                        setRecording(r);
                      }}
                      aria-label={t('compliance.matrix.recordFor', {
                        requirement: r.requirementName,
                        name: r.employeeName,
                      })}
                    >
                      {t('compliance.matrix.record')}
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {reqs.data?.length ? (
        <PageSection headingLevel={2} title={t('compliance.matrix.requirements')}>
          <Card>
            <ul className="flex flex-col gap-2 text-callout">
              {reqs.data.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <Badge>{t(`compliance.kind.${r.kind}`)}</Badge>
                  <span className="text-text-secondary">
                    {r.appliesTo.jobTitles?.length
                      ? r.appliesTo.jobTitles.join(', ')
                      : t('compliance.matrix.everyone')}
                  </span>
                  {r.validityMonths ? (
                    <span className="text-text-secondary">
                      {t('compliance.matrix.validFor', { months: r.validityMonths, count: r.validityMonths })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </PageSection>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title={t('compliance.matrix.addRequirement')} closeLabel={t('common.close')}>
          <form onSubmit={addRequirement} className="flex flex-col gap-3">
            <Field id="r-kind" label={t('compliance.matrix.kind')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={reqForm.kind}
                  onChange={(e) => setReqForm({ ...reqForm, kind: e.target.value })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`compliance.kind.${k}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="r-name" label={t('compliance.matrix.name')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  value={reqForm.name}
                  onChange={(e) => setReqForm({ ...reqForm, name: e.target.value })}
                />
              )}
            </Field>
            <Field
              id="r-jobs"
              label={t('compliance.matrix.jobTitles')}
              hint={t('compliance.matrix.jobTitlesHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  value={reqForm.jobTitles}
                  onChange={(e) => setReqForm({ ...reqForm, jobTitles: e.target.value })}
                />
              )}
            </Field>
            <Field id="r-valid" label={t('compliance.matrix.validity')}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={reqForm.validityMonths}
                  onChange={(e) => setReqForm({ ...reqForm, validityMonths: e.target.value })}
                />
              )}
            </Field>
            <Field
              id="r-rem"
              label={t('compliance.matrix.reminders')}
              hint={t('compliance.matrix.remindersHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={reqForm.reminderDays}
                  onChange={(e) => setReqForm({ ...reqForm, reminderDays: e.target.value })}
                />
              )}
            </Field>
            <label className="flex items-center gap-3 text-callout">
              <input
                type="checkbox"
                checked={reqForm.evidenceRequired}
                onChange={(e) => setReqForm({ ...reqForm, evidenceRequired: e.target.checked })}
                className="accent-[var(--color-accent)]"
              />
              {t('compliance.matrix.evidence')}
            </label>
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!recording} onOpenChange={(o) => !o && setRecording(null)}>
        {recording ? (
          <DialogContent
            title={t('compliance.matrix.recordTitle', {
              requirement: recording.requirementName,
              name: recording.employeeName,
            })}
            closeLabel={t('common.close')}
          >
            <form onSubmit={record} className="flex flex-col gap-3">
              <Field id="c-issued" label={t('compliance.matrix.issuedOn')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    value={recForm.issuedOn}
                    onChange={(e) => setRecForm({ ...recForm, issuedOn: e.target.value })}
                  />
                )}
              </Field>
              <Field
                id="c-exp"
                label={t('compliance.matrix.expiresOn')}
                hint={t('compliance.matrix.expiresHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={recForm.expiresOn}
                    onChange={(e) => setRecForm({ ...recForm, expiresOn: e.target.value })}
                  />
                )}
              </Field>
              <Field id="c-ref" label={t('compliance.matrix.reference')}>
                {(p) => (
                  <Input
                    {...p}
                    value={recForm.reference}
                    onChange={(e) => setRecForm({ ...recForm, reference: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" loading={busy}>
                {t('common.save')}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
