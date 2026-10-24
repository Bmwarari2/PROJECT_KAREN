'use client';
import * as React from 'react';
import { Send, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Field,
  Input,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { MyPayslips, type MyPayslip } from '@/components/payslips/my-payslips';
import { useSession } from '../shell';
import { PersonLink } from '@/components/person-link';

interface Item {
  id: string;
  fileName: string | null;
  hasStatement: boolean;
  matchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'manual';
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  status: string;
}
interface BatchDetail {
  id: string;
  label: string;
  status: string;
  fileCount: number;
  matchedCount: number;
  items: Item[];
  rejected: Array<{ name: string; reason: string }>;
}
interface Batch {
  id: string;
  label: string;
  kind: string;
  status: string;
  fileCount: number;
  matchedCount: number;
  createdAt: string;
}

const select = 'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';
const matchTone = {
  matched: 'success',
  manual: 'success',
  unmatched: 'warning',
  ambiguous: 'danger',
} as const;

export function PayslipsPage({ initialPayslips }: { initialPayslips?: MyPayslip[] }) {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const canManage = !!session?.permissions.some(
    (g) => g === '*' || g === 'payslips.*' || g === 'payslips.manage',
  );
  const batches = useApi<Batch[]>(canManage ? '/v1/payslips/batches' : null);
  const [form, setForm] = React.useState({
    kind: 'payslip',
    docType: 'payslip',
    label: '',
    payDate: '',
    matchBy: 'employee_number',
    pattern: '',
  });
  const [files, setFiles] = React.useState<FileList | null>(null);
  // the payroll provider's structured statements (a JSON file, ADR-0167); PDFs are optional with it
  const [statements, setStatements] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<BatchDetail | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
      tone: 'danger',
    });

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!files?.length && !statements) return;
    setBusy('upload');
    const body = new FormData();
    for (const [k, v] of Object.entries(form))
      if (v && !(k === 'pattern' && form.matchBy !== 'pattern')) body.set(k, v);
    for (const f of Array.from(files ?? [])) body.append('files', f);
    if (statements) body.append('statements', statements, statements.name);
    try {
      const res = await fetch('/v1/payslips/batches', { method: 'POST', body, credentials: 'same-origin' });
      const json = await res.json();
      if (!res.ok) throw new ApiProblem(res.status, json.code ?? 'error', json.title ?? '', json);
      setPreview(json);
      batches.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!preview) return;
    setBusy('publish');
    try {
      const r = await api<{ published: number; notified: number; unmatched: number }>(
        `/v1/payslips/batches/${preview.id}/publish`,
        { method: 'POST' },
      );
      toast({
        title: t('payslips.publishedToast', { count: r.published, notified: r.notified }),
        tone: 'success',
      });
      setPreview(await api<BatchDetail>(`/v1/payslips/batches/${preview.id}`));
      batches.reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* the module header names the page ("Pay", with "Payslips" as its section): no second title here */}

      {session?.employeeId ? <MyPayslips initial={initialPayslips} /> : null}

      {canManage ? (
        <>
          <Card>
            <CardTitle>{t('payslips.upload')}</CardTitle>
            <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
              {t('payslips.uploadBody')}
            </p>
            <form onSubmit={upload} className="mt-4 grid gap-3 md:grid-cols-3 md:items-end">
              <Field id="ps-kind" label={t('payslips.kind')}>
                {(p) => (
                  <select
                    {...p}
                    className={select}
                    value={form.kind}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        kind: e.target.value,
                        docType: e.target.value === 'payslip' ? 'payslip' : 'p60',
                      })
                    }
                  >
                    <option value="payslip">{t('payslips.kinds.payslip')}</option>
                    <option value="year_end">{t('payslips.kinds.year_end')}</option>
                  </select>
                )}
              </Field>
              <Field id="ps-type" label={t('payslips.docType')}>
                {(p) => (
                  <select
                    {...p}
                    className={select}
                    value={form.docType}
                    onChange={(e) => setForm({ ...form, docType: e.target.value })}
                  >
                    {(form.kind === 'payslip'
                      ? ['payslip']
                      : ['p60', 'p11d', 'w2', 'form_1099', 'annual_statement', 'other']
                    ).map((d) => (
                      <option key={d} value={d}>
                        {t(`payslips.docTypes.${d}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="ps-label" label={t('payslips.label')} hint={t('payslips.labelHint')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={120}
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                )}
              </Field>
              <Field id="ps-paydate" label={t('payslips.payDate')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={form.payDate}
                    onChange={(e) => setForm({ ...form, payDate: e.target.value })}
                  />
                )}
              </Field>
              <Field id="ps-match" label={t('payslips.matchBy')}>
                {(p) => (
                  <select
                    {...p}
                    className={select}
                    value={form.matchBy}
                    onChange={(e) => setForm({ ...form, matchBy: e.target.value })}
                  >
                    <option value="employee_number">{t('payslips.matchByNumber')}</option>
                    <option value="pattern">{t('payslips.matchByPattern')}</option>
                  </select>
                )}
              </Field>
              {form.matchBy === 'pattern' ? (
                <Field id="ps-pattern" label={t('payslips.pattern')} hint={t('payslips.patternHint')}>
                  {(p) => (
                    <Input
                      {...p}
                      required
                      maxLength={200}
                      className="font-mono"
                      value={form.pattern}
                      onChange={(e) => setForm({ ...form, pattern: e.target.value })}
                    />
                  )}
                </Field>
              ) : null}
              <Field
                id="ps-files"
                label={t('payslips.files')}
                hint={t('payslips.filesHint')}
                className="md:col-span-2"
              >
                {(p) => (
                  <input
                    {...p}
                    type="file"
                    multiple
                    required={!statements}
                    accept=".pdf,.zip,application/pdf,application/zip"
                    className="text-callout"
                    onChange={(e) => setFiles(e.target.files)}
                  />
                )}
              </Field>
              {form.kind === 'payslip' ? (
                <Field
                  id="ps-statements"
                  label={t('payslipView.statementsFile')}
                  hint={t('payslipView.statementsHint')}
                  className="md:col-span-2"
                >
                  {(p) => (
                    <input
                      {...p}
                      type="file"
                      accept=".json,application/json"
                      className="text-callout"
                      onChange={(e) => setStatements(e.target.files?.[0] ?? null)}
                    />
                  )}
                </Field>
              ) : null}
              <Button type="submit" loading={busy === 'upload'}>
                <Upload aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('payslips.uploadAndMatch')}
              </Button>
            </form>
          </Card>

          {preview ? (
            <Card>
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="mr-auto">{t('payslips.preview', { label: preview.label })}</CardTitle>
                <span className="text-callout text-text-secondary">
                  {t('payslips.matchedOf', {
                    matched: preview.items.filter(
                      (i) => i.matchStatus === 'matched' || i.matchStatus === 'manual',
                    ).length,
                    total: preview.items.length,
                  })}
                </span>
                <Button
                  size="sm"
                  onClick={publish}
                  loading={busy === 'publish'}
                  disabled={
                    !preview.items.some(
                      (i) =>
                        i.status === 'draft' && (i.matchStatus === 'matched' || i.matchStatus === 'manual'),
                    )
                  }
                >
                  <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('payslips.publish')}
                </Button>
              </div>
              <Table dense className="mt-3">
                <THead>
                  <tr>
                    <TH>{t('payslips.file')}</TH>
                    <TH>{t('payslips.match')}</TH>
                    <TH>{t('payslips.employee')}</TH>
                    <TH>{t('common.status')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {preview.items.map((i) => (
                    <TR key={i.id}>
                      <TD className="font-mono text-footnote">{i.fileName}</TD>
                      <TD>
                        <Badge tone={matchTone[i.matchStatus]}>
                          {t(`payslips.matchStatus.${i.matchStatus}`)}
                        </Badge>
                      </TD>
                      <TD>
                        {i.employeeName ? (
                          <>
                            <PersonLink id={i.employeeId} name={i.employeeName} />
                            {i.employeeNumber ? ` (${i.employeeNumber})` : ''}
                          </>
                        ) : (
                          ''
                        )}
                      </TD>
                      <TD>{t(`payslips.itemStatus.${i.status}`)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              {preview.rejected.length ? (
                <ul className="mt-3 flex flex-col gap-1 text-footnote text-text-secondary">
                  {preview.rejected.map((r, n) => (
                    <li key={n}>
                      {t('payslips.rejectedFile', {
                        name: r.name,
                        reason: t(`payslips.rejectReasons.${r.reason}`),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <CardTitle>{t('payslips.batches')}</CardTitle>
            {batches.data?.length ? (
              <Table dense className="mt-3">
                <THead>
                  <tr>
                    <TH>{t('payslips.label')}</TH>
                    <TH>{t('payslips.kind')}</TH>
                    <TH className="text-right">{t('payslips.matched')}</TH>
                    <TH>{t('common.status')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {batches.data.map((b) => (
                    <TR key={b.id}>
                      <TD>
                        <button
                          type="button"
                          className="text-left text-accent hover:underline"
                          onClick={async () =>
                            setPreview(await api<BatchDetail>(`/v1/payslips/batches/${b.id}`))
                          }
                        >
                          {b.label}
                        </button>
                      </TD>
                      <TD>{t(`payslips.kinds.${b.kind}`)}</TD>
                      <TD className="text-right">
                        {b.matchedCount}/{b.fileCount}
                      </TD>
                      <TD>
                        <Badge tone={b.status === 'published' ? 'success' : 'neutral'}>
                          {t(`payslips.batchStatus.${b.status}`)}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="mt-2 text-callout text-text-secondary">{t('payslips.noBatches')}</p>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
