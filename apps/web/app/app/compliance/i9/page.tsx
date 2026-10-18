'use client';
import * as React from 'react';
import { FileWarning } from 'lucide-react';
import { Button, Card, Dialog, DialogContent, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { StatusBadge } from '../ui';

interface Row {
  employeeId: string;
  employeeName: string;
  recordId: string | null;
  status: string;
  firstDayOfEmployment: string | null;
  section1CompletedOn: string | null;
  section2CompletedOn: string | null;
  section2DueOn: string | null;
  reverificationDueOn: string | null;
  retainUntil: string | null;
  retainAtLeastUntil: string | null;
}

export default function I9Page() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const rows = useApi<Row[]>('/v1/compliance/i9');
  const [open, setOpen] = React.useState<Row | null>(null);
  const [form, setForm] = React.useState({ firstDayOfEmployment: '', section1CompletedOn: '', section2CompletedOn: '', workAuthorizationExpiresOn: '', supplementBCompletedOn: '' });
  const [busy, setBusy] = React.useState(false);
  const d = (v: string | null) => (v ? formatDate(v, locale) : '—');

  function edit(r: Row) {
    setForm({ firstDayOfEmployment: r.firstDayOfEmployment ?? '', section1CompletedOn: r.section1CompletedOn ?? '', section2CompletedOn: r.section2CompletedOn ?? '', workAuthorizationExpiresOn: r.reverificationDueOn ?? '', supplementBCompletedOn: '' });
    setOpen(r);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    const v = (s: string) => s || undefined;
    try {
      const body = { section1CompletedOn: v(form.section1CompletedOn), section2CompletedOn: v(form.section2CompletedOn), workAuthorizationExpiresOn: form.workAuthorizationExpiresOn !== (open.reverificationDueOn ?? '') ? v(form.workAuthorizationExpiresOn) : undefined, supplementBCompletedOn: v(form.supplementBCompletedOn) };
      const r = open.recordId
        ? await api<{ section2DueOn: string }>(`/v1/compliance/i9/${open.recordId}`, { method: 'PATCH', json: body })
        : await api<{ section2DueOn: string }>('/v1/compliance/i9', { method: 'POST', json: { employeeId: open.employeeId, firstDayOfEmployment: v(form.firstDayOfEmployment), ...body } });
      toast({ title: t('compliance.i9.saved', { date: formatDate(r.section2DueOn, locale) }), tone: 'success' });
      setOpen(null);
      rows.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-2">{t('compliance.i9.title')}</h1>
      <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('compliance.i9.intro')}</p>
      {!rows.data ? (
        rows.error ? <EmptyState title={t('compliance.noAccess')} /> : <Skeleton className="h-40 w-full" />
      ) : rows.data.length === 0 ? (
        <EmptyState icon={<FileWarning aria-hidden />} title={t('compliance.i9.empty')} />
      ) : (
        <Card className="p-0">
          <Table dense>
            <THead>
              <tr>
                <TH>{t('compliance.col.person')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>{t('compliance.i9.firstDay')}</TH>
                <TH>{t('compliance.i9.section2Due')}</TH>
                <TH>{t('compliance.i9.reverificationDue')}</TH>
                <TH>{t('compliance.i9.retainUntil')}</TH>
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
                  <TD>{d(r.firstDayOfEmployment)}</TD>
                  <TD>{d(r.section2DueOn)}</TD>
                  <TD>{d(r.reverificationDueOn)}</TD>
                  <TD>{r.retainUntil ? d(r.retainUntil) : r.retainAtLeastUntil ? t('compliance.i9.atLeast', { date: d(r.retainAtLeastUntil) }) : '—'}</TD>
                  <TD className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => edit(r)} aria-label={t('compliance.i9.updateFor', { name: r.employeeName })}>
                      {t('compliance.i9.update')}
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <DialogContent title={t('compliance.i9.recordTitle', { name: open.employeeName })} description={t('compliance.i9.recordBody')} closeLabel={t('common.close')}>
            <form onSubmit={save} className="flex flex-col gap-3">
              {!open.recordId ? <Field id="i9-first" label={t('compliance.i9.firstDay')}>{(p) => <Input {...p} type="date" value={form.firstDayOfEmployment} onChange={(e) => setForm({ ...form, firstDayOfEmployment: e.target.value })} />}</Field> : null}
              <Field id="i9-s1" label={t('compliance.i9.section1')}>{(p) => <Input {...p} type="date" value={form.section1CompletedOn} onChange={(e) => setForm({ ...form, section1CompletedOn: e.target.value })} />}</Field>
              <Field id="i9-s2" label={t('compliance.i9.section2')}>{(p) => <Input {...p} type="date" value={form.section2CompletedOn} onChange={(e) => setForm({ ...form, section2CompletedOn: e.target.value })} />}</Field>
              <Field id="i9-auth" label={t('compliance.i9.workAuth')} hint={t('compliance.i9.workAuthHint')}>{(p) => <Input {...p} type="date" value={form.workAuthorizationExpiresOn} onChange={(e) => setForm({ ...form, workAuthorizationExpiresOn: e.target.value })} />}</Field>
              {open.reverificationDueOn ? <Field id="i9-supb" label={t('compliance.i9.supplementB')}>{(p) => <Input {...p} type="date" value={form.supplementBCompletedOn} onChange={(e) => setForm({ ...form, supplementBCompletedOn: e.target.value })} />}</Field> : null}
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
