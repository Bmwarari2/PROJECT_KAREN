'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bold, Heading1, Heading2, List, ListOrdered, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  ListItem,
  ListSection,
  nativeSelectClass,
  PageSection,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDate, formatMoney, formatDateTime, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import {
  entitlementInWords,
  FIELD_GROUPS,
  hoursInWords,
  MERGE_FIELDS,
  noticeInWords,
  parseMarkup,
  patternInWords,
  rateInWords,
  SAMPLE_DATES,
  SAMPLE_ENUMS,
  SAMPLE_PERSON,
  splitFields,
  unknownFields,
  type AskField,
  type Block,
  type Run,
  type SigningOrder,
} from '@thapsus/core/documents';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { viewerZone } from '@/lib/zone';
import { Checkbox, ConfirmAction, FormError, PageHeader, RadioGroup, useAction, useFormat } from '../../kit';
import { useSession } from '../../../shell';
import type { TemplateSummary } from './page';

export interface TemplateDetail extends TemplateSummary {
  body: string;
  unknownFields: string[];
  versions: Array<{ version: number; createdAt: string; createdByName: string | null }>;
  documents: number;
}

const CATEGORIES = ['letter', 'contract', 'offer', 'policy', 'other'];
const LOCALES: Locale[] = ['en-GB', 'en-US'];

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The fictional sample person the live preview is filled with, formatted for the template's language. */
function sampleValues(t: Translate, locale: Locale): Record<string, string> {
  const salary = formatMoney(money(3_200_000n, locale === 'en-US' ? 'USD' : 'GBP'), locale);
  const out: Record<string, string> = { ...SAMPLE_PERSON };
  for (const [k, v] of Object.entries(SAMPLE_DATES)) out[k] = formatDate(v, locale, 'long');
  for (const [k, [ns, v]] of Object.entries(SAMPLE_ENUMS)) out[k] = t(`${ns}.${v}`);
  Object.assign(out, {
    'employee.salary': salary,
    'pay.rate': rateInWords(salary, 'annual', t),
    'employee.weeklyHours': hoursInWords(37.5, locale, t),
    'employee.workPattern': patternInWords({ 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 7.5 }, locale, t),
    'contract.noticePeriod': noticeInWords(28, locale),
    'leave.annualEntitlement': entitlementInWords({ kind: 'days', amount: 25 }, locale, t),
    'leave.yearStart': new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 0, 1))),
    today: formatDate(SAMPLE_DATES['employee.startDate'], locale, 'long'),
  });
  return out;
}

/** The body as it will read: the sample person's values, ask-when-sending fields by their label, unknown fields marked. */
function Preview({
  body,
  ask,
  values,
  title,
}: {
  body: string;
  ask: AskField[];
  values: Record<string, string>;
  title: string;
}) {
  const t = useT();
  const runs = (rs: Run[]) =>
    rs.map((r, i) => (
      <React.Fragment key={i}>
        {splitFields(r.text).map((part, j) => {
          if (typeof part === 'string')
            return r.bold ? <strong key={j}>{part}</strong> : <React.Fragment key={j}>{part}</React.Fragment>;
          const a = part.field.startsWith('ask.')
            ? ask.find((x) => `ask.${x.key}` === part.field)
            : undefined;
          const v = values[part.field];
          if (a)
            return (
              <mark key={j} className="rounded-sm bg-accent-subtle px-1 text-text">
                {t('docTpl.askPlaceholder', { label: a.label })}
              </mark>
            );
          if (v === undefined)
            return (
              <mark key={j} className="rounded-sm border border-danger bg-transparent px-1 text-danger">
                {`{{${part.field}}}`}
              </mark>
            );
          return r.bold ? <strong key={j}>{v}</strong> : <React.Fragment key={j}>{v}</React.Fragment>;
        })}
      </React.Fragment>
    ));
  const block = (b: Block, i: number) =>
    b.type === 'heading' ? (
      b.level === 1 ? (
        <p key={i} className="mt-2 text-body font-semibold">
          {runs(b.runs)}
        </p>
      ) : (
        <p key={i} className="mt-1 text-callout font-semibold">
          {runs(b.runs)}
        </p>
      )
    ) : b.type === 'paragraph' ? (
      <p key={i} className="text-callout">
        {b.lines.map((l, j) => (
          <React.Fragment key={j}>
            {j ? <br /> : null}
            {runs(l)}
          </React.Fragment>
        ))}
      </p>
    ) : b.ordered ? (
      <ol key={i} className="flex flex-col gap-1 pl-6 text-callout">
        {b.items.map((it, j) => (
          <li key={j} className="list-none" style={{ textIndent: '-1.5rem' }}>
            {`${it.marker} `}
            {runs(it.runs)}
          </li>
        ))}
      </ol>
    ) : (
      <ul key={i} className="flex list-disc flex-col gap-1 pl-6 text-callout">
        {b.items.map((it, j) => (
          <li key={j}>{runs(it.runs)}</li>
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-raised p-5 shadow-sm" aria-live="off">
      <p className="text-footnote text-text-secondary">{values['entity.name']}</p>
      <p className="text-title-3 wrap-anywhere">{title || t('docTpl.untitled')}</p>
      {parseMarkup(body).map(block)}
    </div>
  );
}

/**
 * The template editor (16.9, 16.10): name, type and language, whether the company signs and who signs first, the
 * ask-when-sending fields, and the wording with simple formatting (headings, lists, bold) and a field picker. The
 * live preview fills it with a fictional sample person; fields Thapsus-HR does not know are flagged and the
 * template cannot be saved until they are fixed. Saving an existing template makes a new version; documents
 * already sent keep theirs.
 */
export function TemplateEditor({ initial, onSaved }: { initial?: TemplateDetail; onSaved?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const fmt = useFormat();
  const session = useSession();
  const action = useAction();
  const area = React.useRef<HTMLTextAreaElement>(null);
  const [name, setName] = React.useState(initial?.name ?? '');
  const [category, setCategory] = React.useState(initial?.category ?? 'letter');
  const [docLocale, setDocLocale] = React.useState<Locale>((initial?.locale as Locale) ?? locale);
  const [countersign, setCountersign] = React.useState(initial?.requiresCountersign ?? false);
  const [order, setOrder] = React.useState<SigningOrder>(
    (initial?.signingOrder as SigningOrder) ?? 'employee_first',
  );
  const [body, setBody] = React.useState(initial?.body ?? '');
  const [ask, setAsk] = React.useState<AskField[]>(initial?.askFields ?? []);
  const [field, setField] = React.useState('');
  const archived = initial?.status === 'archived';
  const unknown = unknownFields(body, ask);
  const badKeys = ask.some(
    (a, i) => !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(a.key) || ask.findIndex((b) => b.key === a.key) !== i,
  );
  const values = React.useMemo(() => sampleValues(t, docLocale), [t, docLocale]);
  const zone = viewerZone(session?.timeZone);

  /** Replaces the selection (or the selected lines) and keeps the caret after the change. */
  function edit(fn: (text: string, start: number, end: number) => { text: string; caret: number }) {
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const r = fn(body, start, end);
    setBody(r.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  }
  const linePrefix = (prefix: (n: number) => string) =>
    edit((text, start, end) => {
      const from = text.lastIndexOf('\n', start - 1) + 1;
      const to = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end);
      const lines = text
        .slice(from, to)
        .split('\n')
        .map((l, i) => `${prefix(i)}${l.replace(/^(#{1,3}\s+|[-*]\s+|\d{1,3}[.)]\s+)/, '')}`);
      const replaced = lines.join('\n');
      return { text: text.slice(0, from) + replaced + text.slice(to), caret: from + replaced.length };
    });
  const insert = (s: string) =>
    edit((text, start, end) => ({
      text: text.slice(0, start) + s + text.slice(end),
      caret: start + s.length,
    }));
  const bold = () =>
    edit((text, start, end) => {
      const sel = text.slice(start, end) || t('docTpl.boldText');
      return { text: `${text.slice(0, start)}**${sel}**${text.slice(end)}`, caret: start + sel.length + 4 };
    });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (unknown.length || badKeys) return;
    const payload = {
      name: name.trim(),
      body,
      locale: docLocale,
      category,
      requiresCountersign: countersign,
      signingOrder: order,
      askFields: ask.map((a) => ({ ...a, label: a.label.trim() })),
    };
    await action.run(async () => {
      if (initial) {
        const r = await api<{ version: number }>(`/v1/document-templates/${initial.id}`, {
          method: 'PUT',
          json: payload,
        });
        toast({ title: t('docTpl.savedVersion', { version: r.version }), tone: 'success' });
        onSaved?.();
      } else {
        const r = await api<{ id: string }>('/v1/document-templates', { method: 'POST', json: payload });
        toast({ title: t('docTpl.created'), tone: 'success' });
        router.replace(`/app/settings/documents/templates/${r.id}`);
      }
    });
  }

  const tool = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11 min-w-11"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={archived}
    >
      {icon}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={initial ? initial.name : t('docTpl.new')}
        lead={
          initial
            ? t('docTpl.editLead', { version: initial.version, count: initial.documents })
            : t('docTpl.newLead')
        }
      >
        {initial ? (
          archived ? (
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={() =>
                action.run(async () => {
                  await api(`/v1/document-templates/${initial.id}/restore`, { method: 'POST' });
                  toast({ title: t('docTpl.restored'), tone: 'success' });
                  onSaved?.();
                })
              }
            >
              {t('docTpl.restore')}
            </Button>
          ) : (
            <ConfirmAction
              label={t('docTpl.archive')}
              title={t('docTpl.archiveTitle', { name: initial.name })}
              body={t('docTpl.archiveBody')}
              confirmLabel={t('docTpl.archive')}
              triggerVariant="secondary"
              triggerClassName="min-h-11"
              onConfirm={async () => {
                await api(`/v1/document-templates/${initial.id}/archive`, { method: 'POST' });
                toast({ title: t('docTpl.archivedToast'), tone: 'success' });
                onSaved?.();
              }}
            />
          )
        ) : null}
      </PageHeader>
      {initial?.sampleKey ? (
        <p
          className="flex items-start gap-2 rounded-lg bg-surface-raised p-4 text-callout shadow-sm"
          role="note"
        >
          <Badge tone="warning">{t('docTpl.sample')}</Badge>
          <span>{t('docTpl.sampleHint')}</span>
        </p>
      ) : null}
      {archived ? (
        <p className="rounded-md bg-surface p-3 text-callout text-text-secondary">
          {t('docTpl.archivedNote')}
        </p>
      ) : null}
      <form
        onSubmit={save}
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] lg:items-start"
      >
        <div className="flex min-w-0 flex-col gap-6">
          <PageSection title={t('docTpl.details')} headingLevel={3}>
            <Card className="flex flex-col gap-4">
              <Field id="tpl-name" label={t('docTpl.name')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={200}
                    value={name}
                    disabled={archived}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-4">
                <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                  <label htmlFor="tpl-category" className="text-callout font-semibold">
                    {t('docTpl.category')}
                  </label>
                  <select
                    id="tpl-category"
                    className={nativeSelectClass}
                    value={category}
                    disabled={archived}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      if (!initial) setCountersign(['contract', 'offer', 'policy'].includes(e.target.value));
                    }}
                  >
                    {[...new Set([...CATEGORIES, category])].map((c) => (
                      <option key={c} value={c}>
                        {t(`documents.categoryName.${c}`) === `documents.categoryName.${c}`
                          ? c
                          : t(`documents.categoryName.${c}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                  <label htmlFor="tpl-locale" className="text-callout font-semibold">
                    {t('docTpl.language')}
                  </label>
                  <select
                    id="tpl-locale"
                    className={nativeSelectClass}
                    value={docLocale}
                    disabled={archived}
                    onChange={(e) => setDocLocale(e.target.value as Locale)}
                  >
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {t(`locales.${l}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Checkbox
                id="tpl-countersign"
                label={t('docTpl.countersign')}
                hint={t('docTpl.countersignHint')}
                checked={countersign}
                disabled={archived}
                onChange={setCountersign}
              />
              {countersign ? (
                <RadioGroup
                  name="tpl-order"
                  legend={t('docTpl.order')}
                  value={order}
                  disabled={archived}
                  onChange={setOrder}
                  options={(['employee_first', 'company_first', 'any'] as const).map((v) => ({
                    value: v,
                    label: t(`docSend.orderOption.${v}`, { name: t('docTpl.theEmployee') }),
                  }))}
                />
              ) : null}
            </Card>
          </PageSection>

          <PageSection title={t('docTpl.askTitle')} description={t('docTpl.askLead')} headingLevel={3}>
            <Card className="flex flex-col gap-4">
              {ask.length ? (
                <ul className="flex flex-col gap-4">
                  {ask.map((a, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-end gap-3 border-b border-border pb-4 last:border-b-0"
                    >
                      <Field id={`ask-${i}-label`} label={t('docTpl.askLabel')} className="min-w-48 flex-1">
                        {(p) => (
                          <Input
                            {...p}
                            required
                            maxLength={80}
                            value={a.label}
                            disabled={archived}
                            onChange={(e) =>
                              setAsk((xs) =>
                                xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                              )
                            }
                          />
                        )}
                      </Field>
                      <Field
                        id={`ask-${i}-key`}
                        label={t('docTpl.askKey')}
                        hint={t('docTpl.askKeyHint', { key: a.key || '…' })}
                        className="min-w-40"
                      >
                        {(p) => (
                          <Input
                            {...p}
                            required
                            maxLength={40}
                            pattern="[a-zA-Z][a-zA-Z0-9_]*"
                            value={a.key}
                            disabled={archived}
                            onChange={(e) =>
                              setAsk((xs) =>
                                xs.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)),
                              )
                            }
                          />
                        )}
                      </Field>
                      <Checkbox
                        id={`ask-${i}-required`}
                        label={t('docTpl.askRequired')}
                        checked={a.required}
                        disabled={archived}
                        onChange={(v) =>
                          setAsk((xs) => xs.map((x, j) => (j === i ? { ...x, required: v } : x)))
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          className="min-h-11"
                          disabled={archived || !a.key}
                          onClick={() => insert(`{{ask.${a.key}}}`)}
                        >
                          {t('docTpl.insert')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11"
                          aria-label={t('docTpl.askRemove', { label: a.label || String(i + 1) })}
                          disabled={archived}
                          onClick={() => setAsk((xs) => xs.filter((_, j) => j !== i))}
                        >
                          <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-callout text-text-secondary">{t('docTpl.askNone')}</p>
              )}
              {badKeys ? (
                <p role="alert" className="text-callout text-danger">
                  {t('docTpl.askBadKey')}
                </p>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="min-h-11 self-start"
                disabled={archived || ask.length >= 20}
                onClick={() =>
                  setAsk((xs) => [...xs, { key: `field${xs.length + 1}`, label: '', required: true }])
                }
              >
                <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('docTpl.askAdd')}
              </Button>
            </Card>
          </PageSection>

          <PageSection title={t('docTpl.wording')} description={t('docTpl.wordingLead')} headingLevel={3}>
            <Card className="flex flex-col gap-3">
              <div
                role="toolbar"
                aria-label={t('docTpl.formatting')}
                aria-controls="tpl-body"
                className="flex flex-wrap items-center gap-1"
              >
                {tool(
                  t('docTpl.tool.heading'),
                  <Heading1 aria-hidden className="h-4 w-4 stroke-[1.5]" />,
                  () => linePrefix(() => '# '),
                )}
                {tool(
                  t('docTpl.tool.subheading'),
                  <Heading2 aria-hidden className="h-4 w-4 stroke-[1.5]" />,
                  () => linePrefix(() => '## '),
                )}
                {tool(t('docTpl.tool.bold'), <Bold aria-hidden className="h-4 w-4 stroke-[1.5]" />, bold)}
                {tool(t('docTpl.tool.bullets'), <List aria-hidden className="h-4 w-4 stroke-[1.5]" />, () =>
                  linePrefix(() => '- '),
                )}
                {tool(
                  t('docTpl.tool.numbers'),
                  <ListOrdered aria-hidden className="h-4 w-4 stroke-[1.5]" />,
                  () => linePrefix((n) => `${n + 1}. `),
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-56 flex-1 flex-col gap-1.5">
                  <label htmlFor="tpl-field" className="text-footnote font-semibold text-text-secondary">
                    {t('docTpl.fieldPicker')}
                  </label>
                  <select
                    id="tpl-field"
                    className={nativeSelectClass}
                    value={field}
                    disabled={archived}
                    onChange={(e) => setField(e.target.value)}
                  >
                    <option value="">{t('docTpl.chooseField')}</option>
                    {FIELD_GROUPS.map((g) => (
                      <optgroup key={g} label={t(`docFields.group.${g}`)}>
                        {MERGE_FIELDS.filter((f) => f.group === g).map((f) => (
                          <option key={f.key} value={f.key}>
                            {t(`docFields.${f.key}`)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {ask.filter((a) => a.key).length ? (
                      <optgroup label={t('docFields.group.ask')}>
                        {ask
                          .filter((a) => a.key)
                          .map((a) => (
                            <option key={a.key} value={`ask.${a.key}`}>
                              {a.label || a.key}
                            </option>
                          ))}
                      </optgroup>
                    ) : null}
                  </select>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  disabled={!field || archived}
                  onClick={() => {
                    insert(`{{${field}}}`);
                    setField('');
                  }}
                >
                  {t('docTpl.insertField')}
                </Button>
              </div>
              <Field id="tpl-body" label={t('docTpl.body')} hint={t('docTpl.bodyHint')}>
                {(p) => (
                  <Textarea
                    {...p}
                    ref={area}
                    required
                    rows={16}
                    maxLength={50_000}
                    value={body}
                    disabled={archived}
                    aria-invalid={unknown.length ? true : undefined}
                    onChange={(e) => setBody(e.target.value)}
                    className="font-mono text-footnote"
                  />
                )}
              </Field>
              {unknown.length ? (
                <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger p-3">
                  <p className="text-callout font-semibold text-danger">
                    {t('docTpl.unknownTitle', { count: unknown.length })}
                  </p>
                  <ul className="flex list-disc flex-col pl-6 text-callout">
                    {unknown.map((k) => (
                      <li key={k} className="break-all">{`{{${k}}}`}</li>
                    ))}
                  </ul>
                  <p className="text-footnote text-text-secondary">{t('docTpl.unknownHint')}</p>
                </div>
              ) : null}
            </Card>
          </PageSection>
          <FormError message={action.error} />
          {archived ? null : (
            <Button
              type="submit"
              className="min-h-11 self-start"
              loading={action.busy}
              disabled={!!unknown.length || badKeys || !name.trim() || !body.trim()}
            >
              {initial ? t('docTpl.saveVersion') : t('docTpl.create')}
            </Button>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-[calc(var(--topbar-height)_+_var(--space-6))]">
          <PageSection title={t('docTpl.preview')} description={t('docTpl.previewLead')} headingLevel={3}>
            <Preview body={body} ask={ask} values={values} title={name} />
          </PageSection>
          {initial?.versions.length ? (
            <ListSection title={t('docTpl.versions')} headingLevel={3} id="tpl-versions">
              {initial.versions.map((v) => (
                <ListItem
                  key={v.version}
                  title={t('docTpl.versionShort', { version: v.version })}
                  subtitle={
                    v.createdByName
                      ? t('docTpl.versionBy', {
                          date: formatDateTime(v.createdAt, locale, zone),
                          name: v.createdByName,
                        })
                      : fmt.dateTime(v.createdAt)
                  }
                  meta={
                    v.version === initial.version ? (
                      <Badge tone="accent">{t('docTpl.current')}</Badge>
                    ) : undefined
                  }
                />
              ))}
            </ListSection>
          ) : null}
        </div>
      </form>
    </div>
  );
}
