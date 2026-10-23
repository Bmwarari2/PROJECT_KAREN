'use client';
import * as React from 'react';
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
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDate, type Locale } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass, staffCan, useStaff } from '../ui';

interface Entry {
  id: string;
  jurisdiction: string;
  effectiveDate: string;
  title: Record<string, string>;
  summary: Record<string, string>;
  whatToDo: Record<string, string>;
  sourceUrl: string | null;
  status: string;
  publishedAt: string | null;
}

/** Law-changes feed (phase 5 API: /v1/backoffice/law-changes). Customers see published entries for their jurisdictions. */
export default function LawChangesAdmin() {
  const t = useT();
  const locale = useLocale() as Locale;
  const staff = useStaff();
  const toast = useToast();
  const list = useApi<Entry[]>('/v1/backoffice/law-changes');
  const canEdit = staffCan(staff, 'rules_editor');
  const [f, setF] = React.useState({
    jurisdiction: 'GB',
    effectiveDate: '',
    titleGb: '',
    titleUs: '',
    summaryGb: '',
    summaryUs: '',
    whatGb: '',
    whatUs: '',
    sourceUrl: '',
    status: 'draft',
  });
  const [busy, setBusy] = React.useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      list.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const loc = (gb: string, us: string) => ({ 'en-GB': gb, ...(us ? { 'en-US': us } : {}) });
  const pick = (m: Record<string, string>) => m[locale] ?? m['en-GB'] ?? '';
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.lawChanges.title')} lead={t('backoffice.lawChanges.lead')} />
      <Table scrollLabel={t('backoffice.lawChanges.title')}>
        <caption className="sr-only">{t('backoffice.lawChanges.title')}</caption>
        <THead>
          <tr>
            <TH>{t('backoffice.lawChanges.effective')}</TH>
            <TH>{t('backoffice.rules.jurisdiction')}</TH>
            <TH>{t('backoffice.lawChanges.entry')}</TH>
            <TH>{t('common.status')}</TH>
            <TH>
              <span className="sr-only">{t('common.actions')}</span>
            </TH>
          </tr>
        </THead>
        <tbody>
          {(list.data ?? []).map((e) => (
            <TR key={e.id}>
              <TD className="text-footnote">{formatDate(e.effectiveDate, locale)}</TD>
              <TD>{e.jurisdiction}</TD>
              <TD>
                <p className="font-semibold">{pick(e.title)}</p>
                <p className="text-footnote text-text-secondary">{pick(e.summary)}</p>
              </TD>
              <TD>
                <Badge tone={e.status === 'published' ? 'success' : 'neutral'}>
                  {t(`backoffice.lawChanges.status.${e.status}`)}
                </Badge>
              </TD>
              <TD>
                {canEdit ? (
                  e.status !== 'published' ? (
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={() =>
                        run(
                          () =>
                            api(`/v1/backoffice/law-changes/${e.id}`, {
                              method: 'PATCH',
                              json: { status: 'published' },
                            }),
                          t('backoffice.lawChanges.published'),
                        )
                      }
                    >
                      {t('backoffice.lawChanges.publish')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      onClick={() =>
                        run(
                          () =>
                            api(`/v1/backoffice/law-changes/${e.id}`, {
                              method: 'PATCH',
                              json: { status: 'withdrawn' },
                            }),
                          t('backoffice.lawChanges.withdrawn'),
                        )
                      }
                    >
                      {t('backoffice.lawChanges.withdraw')}
                    </Button>
                  )
                ) : null}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
      {canEdit ? (
        <Card>
          <CardTitle>{t('backoffice.lawChanges.newTitle')}</CardTitle>
          <form
            className="mt-4 grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api('/v1/backoffice/law-changes', {
                    method: 'POST',
                    json: {
                      jurisdiction: f.jurisdiction.toUpperCase(),
                      effectiveDate: f.effectiveDate,
                      title: loc(f.titleGb, f.titleUs),
                      summary: loc(f.summaryGb, f.summaryUs),
                      whatToDo: loc(f.whatGb, f.whatUs),
                      sourceUrl: f.sourceUrl || null,
                      status: f.status,
                    },
                  }),
                t('backoffice.lawChanges.created'),
              );
            }}
          >
            <Field id="l-j" label={t('backoffice.rules.jurisdiction')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  pattern="EU|[A-Za-z]{2}(-[A-Za-z0-9]{1,3}){0,2}"
                  value={f.jurisdiction}
                  onChange={(e) => setF({ ...f, jurisdiction: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-date" label={t('backoffice.lawChanges.effective')}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  required
                  value={f.effectiveDate}
                  onChange={(e) => setF({ ...f, effectiveDate: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-tgb" label={t('backoffice.lawChanges.titleGb')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  minLength={3}
                  value={f.titleGb}
                  onChange={(e) => setF({ ...f, titleGb: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-tus" label={t('backoffice.lawChanges.titleUs')}>
              {(p) => (
                <Input {...p} value={f.titleUs} onChange={(e) => setF({ ...f, titleUs: e.target.value })} />
              )}
            </Field>
            <Field id="l-sgb" label={t('backoffice.lawChanges.summaryGb')}>
              {(p) => (
                <Textarea
                  {...p}
                  required
                  minLength={3}
                  value={f.summaryGb}
                  onChange={(e) => setF({ ...f, summaryGb: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-sus" label={t('backoffice.lawChanges.summaryUs')}>
              {(p) => (
                <Textarea
                  {...p}
                  value={f.summaryUs}
                  onChange={(e) => setF({ ...f, summaryUs: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-wgb" label={t('backoffice.lawChanges.whatGb')}>
              {(p) => (
                <Textarea
                  {...p}
                  required
                  minLength={3}
                  value={f.whatGb}
                  onChange={(e) => setF({ ...f, whatGb: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-wus" label={t('backoffice.lawChanges.whatUs')}>
              {(p) => (
                <Textarea {...p} value={f.whatUs} onChange={(e) => setF({ ...f, whatUs: e.target.value })} />
              )}
            </Field>
            <Field id="l-src" label={t('backoffice.rules.sourceUrl')}>
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  pattern="https://.*"
                  value={f.sourceUrl}
                  onChange={(e) => setF({ ...f, sourceUrl: e.target.value })}
                />
              )}
            </Field>
            <Field id="l-status" label={t('common.status')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={f.status}
                  onChange={(e) => setF({ ...f, status: e.target.value })}
                >
                  {['draft', 'published'].map((x) => (
                    <option key={x} value={x}>
                      {t(`backoffice.lawChanges.status.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" loading={busy}>
                {t('backoffice.lawChanges.create')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
