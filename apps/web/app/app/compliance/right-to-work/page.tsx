'use client';
import * as React from 'react';
import { BadgeCheck } from 'lucide-react';
import {
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
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro } from '@/components/module-page';
import { selectClass, SourceLink, StatusBadge } from '../ui';

interface Row {
  employeeId: string;
  employeeName: string;
  status: string;
  checkMethod: string | null;
  listType: string | null;
  checkedOn: string | null;
  followUpDueOn: string | null;
  retainUntil: string | null;
}
interface Rules {
  rules: {
    methods: Array<{ id: string }>;
    listTypes: string[];
    documentCatalogue: Record<string, string[]>;
    followUp: Record<string, null | { dueBy?: string; excusePeriod?: string }>;
  };
  source: { url: string; title: string };
  verifiedOn: string;
}

export default function RightToWorkPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const rows = useApi<Row[]>('/v1/compliance/right-to-work');
  const rules = useApi<Rules>('/v1/compliance/right-to-work/rules');
  const [open, setOpen] = React.useState<Row | null>(null);
  const [form, setForm] = React.useState({
    checkMethod: 'manual_document_check',
    listType: 'list_a',
    checkedOn: '',
    permissionExpiresOn: '',
    pvnDate: '',
    documentType: '',
    documentReference: '',
    shareCode: '',
  });
  const [busy, setBusy] = React.useState(false);
  const spec = rules.data?.rules.followUp[form.listType];
  const needsExpiry = !!spec && 'dueBy' in spec && spec.dueBy === 'permission_expiry_date';
  const needsPvn = !!spec && 'excusePeriod' in spec;
  const d = (v: string | null) => (v ? formatDate(v, locale) : '—');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    try {
      const r = await api<{ followUpDueOn: string | null }>('/v1/compliance/right-to-work/checks', {
        method: 'POST',
        json: {
          employeeId: open.employeeId,
          checkMethod: form.checkMethod,
          listType: form.listType,
          checkedOn: form.checkedOn,
          permissionExpiresOn: needsExpiry ? form.permissionExpiresOn : undefined,
          pvnDate: needsPvn ? form.pvnDate : undefined,
          documentType: form.documentType || undefined,
          documentReference: form.documentReference || undefined,
          shareCode: form.shareCode || undefined,
        },
      });
      toast({
        title: r.followUpDueOn
          ? t('compliance.rtw.saved', { date: formatDate(r.followUpDueOn, locale) })
          : t('compliance.rtw.savedNoFollowUp'),
        tone: 'success',
      });
      setOpen(null);
      rows.reload();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageIntro title={t('compliance.rtw.title')} titleIsTab lead={t('compliance.rtw.intro')}>
        {rules.data ? <SourceLink source={rules.data.source} verifiedOn={rules.data.verifiedOn} /> : null}
      </PageIntro>
      {!rows.data ? (
        rows.error ? (
          <EmptyState title={t('compliance.noAccess')} />
        ) : (
          <Skeleton className="h-40 w-full" />
        )
      ) : rows.data.length === 0 ? (
        <EmptyState icon={<BadgeCheck aria-hidden />} title={t('compliance.rtw.empty')} />
      ) : (
        <Card className="p-0">
          <Table dense>
            <THead>
              <tr>
                <TH>{t('compliance.col.person')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>{t('compliance.rtw.checked')}</TH>
                <TH>{t('compliance.rtw.followUp')}</TH>
                <TH>{t('compliance.rtw.retainUntil')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {rows.data.map((r) => (
                <TR key={r.employeeId}>
                  <TD className="font-semibold">{r.employeeName}</TD>
                  <TD>
                    <StatusBadge status={r.status} />
                  </TD>
                  <TD>
                    {r.checkedOn ? `${d(r.checkedOn)} · ${t(`compliance.rtw.list.${r.listType}`)}` : '—'}
                  </TD>
                  <TD>{d(r.followUpDueOn)}</TD>
                  <TD>{d(r.retainUntil)}</TD>
                  <TD className="text-right">
                    {r.status !== 'retention' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setOpen(r)}
                        aria-label={t('compliance.rtw.recordFor', { name: r.employeeName })}
                      >
                        {t('compliance.rtw.record')}
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && rules.data ? (
          <DialogContent
            title={t('compliance.rtw.recordTitle', { name: open.employeeName })}
            description={t('compliance.rtw.recordBody')}
            closeLabel={t('common.close')}
          >
            <form onSubmit={save} className="flex flex-col gap-3">
              <Field id="rtw-method" label={t('compliance.rtw.method')}>
                {(p) => (
                  <select
                    {...p}
                    className={selectClass}
                    value={form.checkMethod}
                    onChange={(e) => setForm({ ...form, checkMethod: e.target.value })}
                  >
                    {rules.data!.rules.methods.map((m) => (
                      <option key={m.id} value={m.id}>
                        {t(`compliance.rtw.methodName.${m.id}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="rtw-list" label={t('compliance.rtw.listType')}>
                {(p) => (
                  <select
                    {...p}
                    className={selectClass}
                    value={form.listType}
                    onChange={(e) => setForm({ ...form, listType: e.target.value, documentType: '' })}
                  >
                    {rules.data!.rules.listTypes.map((l) => (
                      <option key={l} value={l}>
                        {t(`compliance.rtw.list.${l}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {(rules.data.rules.documentCatalogue[form.listType] ?? []).length ? (
                <Field id="rtw-doc" label={t('compliance.rtw.documentType')}>
                  {(p) => (
                    <select
                      {...p}
                      className={selectClass}
                      value={form.documentType}
                      onChange={(e) => setForm({ ...form, documentType: e.target.value })}
                    >
                      <option value="">{t('compliance.rtw.documentNone')}</option>
                      {rules.data!.rules.documentCatalogue[form.listType]!.map((doc) => (
                        <option key={doc} value={doc}>
                          {t(`compliance.rtw.document.${doc}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              <Field id="rtw-date" label={t('compliance.rtw.checkedOn')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    value={form.checkedOn}
                    onChange={(e) => setForm({ ...form, checkedOn: e.target.value })}
                  />
                )}
              </Field>
              {needsExpiry ? (
                <Field id="rtw-exp" label={t('compliance.rtw.permissionExpiresOn')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      required
                      value={form.permissionExpiresOn}
                      onChange={(e) => setForm({ ...form, permissionExpiresOn: e.target.value })}
                    />
                  )}
                </Field>
              ) : null}
              {needsPvn ? (
                <Field id="rtw-pvn" label={t('compliance.rtw.pvnDate')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      required
                      value={form.pvnDate}
                      onChange={(e) => setForm({ ...form, pvnDate: e.target.value })}
                    />
                  )}
                </Field>
              ) : null}
              <Field
                id="rtw-ref"
                label={t('compliance.rtw.documentReference')}
                hint={t('compliance.rtw.vaultHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={form.documentReference}
                    autoComplete="off"
                    onChange={(e) => setForm({ ...form, documentReference: e.target.value })}
                  />
                )}
              </Field>
              {form.checkMethod === 'home_office_online_check' ? (
                <Field id="rtw-share" label={t('compliance.rtw.shareCode')}>
                  {(p) => (
                    <Input
                      {...p}
                      value={form.shareCode}
                      autoComplete="off"
                      onChange={(e) => setForm({ ...form, shareCode: e.target.value })}
                    />
                  )}
                </Field>
              ) : null}
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
