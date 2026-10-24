'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { CircleAlert, Plus, Send, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  nativeSelectClass,
  PageSection,
  Skeleton,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { personHref } from '@thapsus/core/links';
import {
  FIELD_POSITIONS,
  type FieldPosition,
  type PlacedField,
  type SigningOrder,
} from '@thapsus/core/documents';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { BackLink } from '@/components/breadcrumbs';
import { PdfViewerPlaceholder } from '@/components/documents/pdf-toolbar';
import { Checkbox, RadioGroup } from '@/app/app/settings/kit';
import { PageTitle } from '../../../../shell';

// PDF.js loads only here, only in the browser (ADR-0168)
const PdfViewer = dynamic(() => import('@/components/documents/pdf-viewer'), {
  ssr: false,
  loading: () => <PdfViewerPlaceholder />,
});

interface TemplateSummary {
  id: string;
  name: string;
  category: string;
  sampleKey: string | null;
}
interface Missing {
  key: string;
  reason: 'unknown' | 'empty' | 'required';
  label?: string;
}
interface Prepared {
  templateId: string;
  version: number;
  name: string;
  askFields: Array<{ key: string; label: string; required: boolean }>;
  missing: Missing[];
  requiresCountersign: boolean;
  signingOrder: SigningOrder;
  sampleKey: string | null;
}
interface Profile {
  employee: { id: string; displayName?: string };
}
interface DocView {
  document: { id: string; title: string; contentType: string };
}
type Box = PlacedField & { key: number };

/**
 * Send a document for signature (16.11, ADR-0195): from a person's documents ("New from template"), from a task
 * ("Prepare and send", with `template` and `task` in the address), or for a PDF already filed for them
 * (`document`). HR chooses the template, fills in the ask-when-sending fields, previews the filled PDF in the
 * viewer, sees every missing value (sending is blocked until there are none), chooses who signs, in which order,
 * by when and with what message, and sends it. With a task, the task closes when the document is complete.
 */
export default function NewDocumentPage() {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const taskId = search.get('task');
  const documentId = search.get('document');
  const person = useApi<Profile>(`/v1/employees/${id}`);
  const templates = useApi<TemplateSummary[]>(documentId ? null : '/v1/document-templates');
  const doc = useApi<DocView>(documentId ? `/v1/documents/${documentId}` : null);
  const [templateId, setTemplateId] = React.useState(search.get('template') ?? '');
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [prep, setPrep] = React.useState<Prepared | null>(null);
  const [prepError, setPrepError] = React.useState<string | null>(null);
  const [employeeSigns, setEmployeeSigns] = React.useState(true);
  const [companySigns, setCompanySigns] = React.useState(true);
  const [order, setOrder] = React.useState<SigningOrder>('employee_first');
  const [dueOn, setDueOn] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [boxes, setBoxes] = React.useState<Box[]>([]);
  const [pages, setPages] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const nextBox = React.useRef(1);
  const defaultsFor = React.useRef<string | null>(null);
  const name = person.data?.employee.displayName ?? '';
  const typed = useDebounced(values);

  // what the template needs for this person, and its defaults (again whenever the typed values change)
  React.useEffect(() => {
    if (!templateId || documentId) return;
    let cancelled = false;
    api<Prepared>(`/v1/document-templates/${templateId}/prepare`, {
      method: 'POST',
      json: { employeeId: id, values: typed },
    })
      .then((p) => {
        if (cancelled) return;
        setPrepError(null);
        // a newly chosen template brings its own defaults: the company's signature and the signing order
        if (defaultsFor.current !== p.templateId) {
          defaultsFor.current = p.templateId;
          setCompanySigns(p.requiresCountersign);
          setOrder(p.signingOrder);
        }
        setPrep(p);
      })
      .catch((err) => {
        if (!cancelled) setPrepError(err instanceof ApiProblem ? err.title : t('common.error'));
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, documentId, id, typed, t]);

  const sendOptions = { employeeSigns, companySigns, signingOrder: order };
  const previewKey = JSON.stringify({ templateId, typed, ...sendOptions });
  const loadPreview = React.useCallback(async () => {
    const res = await fetch(`/v1/document-templates/${templateId}/preview`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/pdf' },
      body: JSON.stringify({ employeeId: id, values: typed, ...sendOptions }),
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.arrayBuffer();
    // previewKey carries every input the request uses
  }, [previewKey]);

  const missing = prep?.missing ?? [];
  const fieldLabel = (m: Missing) =>
    m.label ?? (m.key.startsWith('ask.') ? m.key.slice(4) : t(`docFields.${m.key}`));
  const ready =
    !!name && (employeeSigns || companySigns) && (documentId ? !!doc.data : !!prep && missing.length === 0);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const r = await api<{ documentId: string }>('/v1/signature-requests', {
        method: 'POST',
        json: {
          employeeId: id,
          ...(documentId
            ? { documentId, fields: boxes.map(({ key: _k, ...b }) => b) }
            : { templateId, values }),
          ...sendOptions,
          ...(dueOn ? { dueOn } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(taskId ? { taskId } : {}),
        },
      });
      toast({ title: t('docSend.sent', { name }), tone: 'success' });
      router.push(`/app/documents/${r.documentId}`);
    } catch (err) {
      const body = err instanceof ApiProblem ? err.body : {};
      if (Array.isArray(body.missing)) setPrep((p) => (p ? { ...p, missing: body.missing as Missing[] } : p));
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (person.error)
    return <EmptyState level={2} title={t('docSend.noPerson')} icon={<CircleAlert aria-hidden />} />;
  const chosen = templates.data?.find((x) => x.id === templateId);

  return (
    <form onSubmit={send} className="flex flex-col gap-6">
      <BackLink href={personHref(id, 'documents')} label={name || t('docSend.back')} />
      <div className="flex flex-col gap-1">
        <PageTitle className="text-title-2 wrap-anywhere">
          {name ? t('docSend.title', { name }) : <Skeleton className="h-8 w-64" />}
        </PageTitle>
        <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">
          {documentId ? t('docSend.leadDocument') : t('docSend.lead')}
        </p>
        {taskId ? <p className="text-footnote text-text-secondary">{t('docSend.fromTask')}</p> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {documentId ? null : (
            <PageSection title={t('docSend.templateSection')} headingLevel={3}>
              <Card className="flex flex-col gap-3">
                {templates.data ? (
                  templates.data.length ? (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="send-template" className="text-callout font-semibold">
                        {t('docSend.template')}
                      </label>
                      <select
                        id="send-template"
                        className={nativeSelectClass}
                        value={templateId}
                        onChange={(e) => {
                          setTemplateId(e.target.value);
                          setValues({});
                          setPrep(null);
                        }}
                      >
                        <option value="">{t('docSend.chooseTemplate')}</option>
                        {templates.data.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.sampleKey ? t('docSend.sampleOption', { name: x.name }) : x.name}
                          </option>
                        ))}
                      </select>
                      {chosen?.sampleKey ? (
                        <p className="flex items-start gap-2 text-footnote text-text-secondary">
                          <Badge tone="warning">{t('docTpl.sample')}</Badge>
                          {t('docTpl.sampleHint')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-callout text-text-secondary">{t('docSend.noTemplates')}</p>
                  )
                ) : (
                  <Skeleton className="h-11 w-full" />
                )}
                {prepError ? (
                  <p role="alert" className="text-callout text-danger">
                    {prepError}
                  </p>
                ) : null}
              </Card>
            </PageSection>
          )}

          {prep?.askFields.length ? (
            <PageSection title={t('docSend.askSection')} description={t('docSend.askLead')} headingLevel={3}>
              <Card className="flex flex-col gap-4">
                {prep.askFields.map((a) => (
                  <Field
                    key={a.key}
                    id={`ask-${a.key}`}
                    label={a.label}
                    hint={a.required ? undefined : t('admin.optional')}
                  >
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
          ) : null}

          {prep && missing.length ? (
            <section
              aria-labelledby="send-missing"
              className="flex flex-col gap-2 rounded-lg border border-warning bg-surface-raised p-4"
            >
              <h3 id="send-missing" className="flex items-center gap-2 text-callout font-semibold">
                <CircleAlert aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-warning" />
                {t('docSend.missingTitle', { count: missing.length })}
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-6 text-callout">
                {missing.map((m) => (
                  <li key={m.key}>{t(`docSend.missing.${m.reason}`, { field: fieldLabel(m), name })}</li>
                ))}
              </ul>
              <p className="text-footnote text-text-secondary">{t('docSend.missingHint')}</p>
            </section>
          ) : null}

          {documentId ? (
            <PageSection
              title={t('docSend.boxesSection')}
              description={t('docSend.boxesLead')}
              headingLevel={3}
            >
              <Card className="flex flex-col gap-4">
                {boxes.length ? (
                  <ul className="flex flex-col gap-4">
                    {boxes.map((b, i) => (
                      <li
                        key={b.key}
                        className="flex flex-col gap-3 border-b border-border pb-4 last:border-b-0"
                      >
                        <p className="text-callout font-semibold">{t('docSend.box', { n: i + 1 })}</p>
                        <div className="flex flex-wrap items-end gap-3">
                          <BoxSelect
                            id={`box-${b.key}-party`}
                            label={t('docSend.boxParty')}
                            value={b.party}
                            options={(['employee', 'company'] as const).map((v) => ({
                              value: v,
                              label: v === 'employee' ? name : t('docSend.company'),
                            }))}
                            onChange={(v) =>
                              setBoxes((xs) => xs.map((x) => (x.key === b.key ? { ...x, party: v } : x)))
                            }
                          />
                          <BoxSelect
                            id={`box-${b.key}-kind`}
                            label={t('docSend.boxKind')}
                            value={b.kind}
                            options={(['signature', 'date'] as const).map((v) => ({
                              value: v,
                              label: t(`docSend.kind.${v}`),
                            }))}
                            onChange={(v) =>
                              setBoxes((xs) => xs.map((x) => (x.key === b.key ? { ...x, kind: v } : x)))
                            }
                          />
                          <Field id={`box-${b.key}-page`} label={t('docSend.boxPage')} className="w-28">
                            {(p) => (
                              <Input
                                {...p}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={pages || undefined}
                                value={String(b.page)}
                                onChange={(e) =>
                                  setBoxes((xs) =>
                                    xs.map((x) =>
                                      x.key === b.key
                                        ? { ...x, page: Math.max(1, Number(e.target.value) || 1) }
                                        : x,
                                    ),
                                  )
                                }
                              />
                            )}
                          </Field>
                          <BoxSelect
                            id={`box-${b.key}-position`}
                            label={t('docSend.boxPosition')}
                            value={b.position}
                            options={FIELD_POSITIONS.map((v) => ({
                              value: v,
                              label: t(`docSend.position.${v}`),
                            }))}
                            onChange={(v: FieldPosition) =>
                              setBoxes((xs) => xs.map((x) => (x.key === b.key ? { ...x, position: v } : x)))
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            className="min-h-11"
                            aria-label={t('docSend.removeBox', { n: i + 1 })}
                            onClick={() => setBoxes((xs) => xs.filter((x) => x.key !== b.key))}
                          >
                            <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-callout text-text-secondary">{t('docSend.noBoxes')}</p>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11 self-start"
                  onClick={() =>
                    setBoxes((xs) => [
                      ...xs,
                      {
                        key: nextBox.current++,
                        party:
                          xs.some((x) => x.party === 'employee') && companySigns ? 'company' : 'employee',
                        kind: 'signature',
                        page: pages || 1,
                        position: 'bottom_left',
                      },
                    ])
                  }
                >
                  <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('docSend.addBox')}
                </Button>
              </Card>
            </PageSection>
          ) : null}

          <PageSection title={t('docSend.previewSection')} headingLevel={3}>
            {documentId ? (
              doc.data ? (
                <PdfViewer
                  src={`/v1/documents/${documentId}/content`}
                  title={doc.data.document.title}
                  onPages={setPages}
                />
              ) : (
                <PdfViewerPlaceholder />
              )
            ) : templateId && prep ? (
              <PdfViewer
                src={`preview:${previewKey}`}
                load={loadPreview}
                title={t('docSend.previewTitle', { name: prep.name })}
              />
            ) : (
              <p className="rounded-lg bg-surface-raised p-4 text-callout text-text-secondary shadow-sm">
                {t('docSend.previewEmpty')}
              </p>
            )}
          </PageSection>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-[calc(var(--topbar-height)_+_var(--space-6))]">
          <PageSection title={t('docSend.signingSection')} headingLevel={3}>
            <Card className="flex flex-col gap-4">
              <Checkbox
                id="send-employee"
                label={t('docSend.employeeSigns', { name })}
                checked={employeeSigns}
                onChange={setEmployeeSigns}
              />
              <Checkbox
                id="send-company"
                label={t('docSend.companySigns')}
                hint={t('docSend.companySignsHint')}
                checked={companySigns}
                onChange={setCompanySigns}
              />
              {employeeSigns && companySigns ? (
                <RadioGroup
                  name="send-order"
                  legend={t('docSend.order')}
                  value={order}
                  onChange={setOrder}
                  options={(['employee_first', 'company_first', 'any'] as const).map((v) => ({
                    value: v,
                    label: t(`docSend.orderOption.${v}`, { name }),
                  }))}
                />
              ) : null}
              <Field id="send-due" label={t('docSend.dueOn')} hint={t('admin.optional')}>
                {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
              </Field>
              <Field id="send-message" label={t('docSend.message')} hint={t('docSend.messageHint', { name })}>
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
              {!employeeSigns && !companySigns ? (
                <p role="alert" className="text-callout text-danger">
                  {t('docSend.nobody')}
                </p>
              ) : null}
              <Button type="submit" className="min-h-11" loading={busy} disabled={!ready}>
                <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('docSend.send')}
              </Button>
              {prep && missing.length ? (
                <p className="text-footnote text-text-secondary">{t('docSend.blocked')}</p>
              ) : null}
            </Card>
          </PageSection>
        </div>
      </div>
    </form>
  );
}

function BoxSelect<V extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: V;
  options: Array<{ value: V; label: string }>;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <label htmlFor={id} className="text-footnote font-semibold text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        className={nativeSelectClass}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
