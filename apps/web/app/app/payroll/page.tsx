'use client';
import * as React from 'react';
import { Download, FileSpreadsheet, Lock, Plus, Send } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { formatDate, formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';

interface Period {
  id: string;
  name: string;
  frequency: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  status: 'open' | 'closed';
  snapshotSha256: string | null;
}
interface Connector {
  id: string;
  name: string;
  kind: string;
  availability: 'available' | 'stub';
  enabled: boolean;
  delivery: { method: 'download' | 'sftp' | 'api' };
  mapping: { sections: Record<string, { enabled: boolean; columns: Array<{ header: string }> } | undefined> };
}
interface ExportRow {
  id: string;
  periodId: string;
  connectorId: string;
  fileName: string;
  sha256: string;
  reproducible: boolean;
  createdAt: string;
}
interface Delivery {
  id: string;
  exportId: string;
  method: string;
  status: string;
  destination: string | null;
  createdAt: string;
  error: string | null;
}
interface Catalogue {
  connectors: Array<{ kind: string; availability: string; regions: string[] }>;
}

const select = 'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';
const statusTone = { succeeded: 'success', queued: 'neutral', running: 'neutral', partial: 'warning', failed: 'danger' } as const;

export default function PayrollPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const has = (p: string) => !!session?.permissions.some((g) => g === '*' || g === p || (g.endsWith('.*') && p.startsWith(g.slice(0, -1))));
  const canManage = has('payroll.manage');
  const canExport = has('payroll.export');
  const periods = useApi<Period[]>('/v1/payroll/periods');
  const connectors = useApi<Connector[]>('/v1/payroll/connectors');
  const exports = useApi<ExportRow[]>('/v1/payroll/exports');
  const deliveries = useApi<Delivery[]>('/v1/payroll/deliveries');
  const catalogue = useApi<Catalogue>('/v1/payroll/catalogue');
  const [period, setPeriod] = React.useState({ name: '', frequency: 'monthly', startDate: '', endDate: '', payDate: '' });
  const [connector, setConnector] = React.useState({ name: '', kind: 'csv' });
  const [chosen, setChosen] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const tz = session?.timeZone ?? 'Europe/London';
  const usable = (connectors.data ?? []).filter((c) => c.enabled && c.availability === 'available');
  const connectorName = (id: string) => connectors.data?.find((c) => c.id === id)?.name ?? '';

  const fail = (err: unknown) => toast({ title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'), tone: 'danger' });
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const createPeriod = (e: React.FormEvent) => {
    e.preventDefault();
    void run('period', async () => {
      await api('/v1/payroll/periods', { method: 'POST', json: { ...period, payDate: period.payDate || null } });
      setPeriod({ name: '', frequency: 'monthly', startDate: '', endDate: '', payDate: '' });
      toast({ title: t('payroll.periodCreated'), tone: 'success' });
      periods.reload();
    });
  };
  const createConnector = (e: React.FormEvent) => {
    e.preventDefault();
    void run('connector', async () => {
      await api('/v1/payroll/connectors', { method: 'POST', json: connector });
      setConnector({ name: '', kind: 'csv' });
      toast({ title: t('payroll.connectorCreated'), tone: 'success' });
      connectors.reload();
    });
  };
  const close = (p: Period) =>
    run(`close:${p.id}`, async () => {
      await api(`/v1/payroll/periods/${p.id}/close`, { method: 'POST' });
      toast({ title: t('payroll.closed', { name: p.name }), tone: 'success' });
      periods.reload();
    });
  const exportPeriod = (p: Period) =>
    run(`export:${p.id}`, async () => {
      const connectorId = chosen[p.id] ?? usable[0]?.id;
      if (!connectorId) return;
      await api(`/v1/payroll/periods/${p.id}/exports`, { method: 'POST', json: { connectorId } });
      toast({ title: t('payroll.exported'), tone: 'success' });
      exports.reload();
    });
  const download = (x: ExportRow) =>
    run(`download:${x.id}`, async () => {
      const r = await api<{ url: string }>(`/v1/payroll/exports/${x.id}/download`);
      deliveries.reload();
      window.location.assign(r.url);
    });
  const deliver = (x: ExportRow) =>
    run(`deliver:${x.id}`, async () => {
      await api(`/v1/payroll/exports/${x.id}/deliver`, { method: 'POST', json: {} });
      toast({ title: t('payroll.deliveryQueued'), tone: 'success' });
      deliveries.reload();
    });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title-2">{t('payroll.title')}</h1>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('payroll.intro')}</p>
      </div>

      <Card>
        <CardTitle>{t('payroll.periods')}</CardTitle>
        {!periods.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : periods.data.length ? (
          <Table dense className="mt-3">
            <THead>
              <tr>
                <TH>{t('payroll.period')}</TH>
                <TH>{t('payroll.dates')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {periods.data.map((p) => (
                <TR key={p.id}>
                  <TD className="font-semibold">{p.name}</TD>
                  <TD>
                    {formatDate(p.startDate, locale)} – {formatDate(p.endDate, locale)}
                  </TD>
                  <TD>
                    <Badge tone={p.status === 'closed' ? 'accent' : 'neutral'}>
                      {p.status === 'closed' ? <Lock aria-hidden className="h-3 w-3" /> : null}
                      {t(`payroll.status.${p.status}`)}
                    </Badge>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {canExport && usable.length ? (
                        <>
                          <label className="sr-only" htmlFor={`connector-${p.id}`}>
                            {t('payroll.connectorFor', { name: p.name })}
                          </label>
                          <select id={`connector-${p.id}`} className={`${select} h-8`} value={chosen[p.id] ?? usable[0]!.id} onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.value })}>
                            {usable.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" variant="secondary" loading={busy === `export:${p.id}`} onClick={() => exportPeriod(p)} aria-label={t('payroll.exportPeriod', { name: p.name })}>
                            <FileSpreadsheet aria-hidden className="h-4 w-4 stroke-[1.5]" />
                            {t('common.export')}
                          </Button>
                        </>
                      ) : null}
                      {canManage && p.status === 'open' ? (
                        <Button size="sm" variant="ghost" loading={busy === `close:${p.id}`} onClick={() => close(p)} aria-label={t('payroll.closePeriod', { name: p.name })}>
                          {t('payroll.close')}
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('payroll.noPeriods')}</p>
        )}
        {canManage ? (
          <form onSubmit={createPeriod} className="mt-4 grid gap-3 md:grid-cols-6 md:items-end">
            <Field id="period-name" label={t('payroll.periodName')} className="md:col-span-2">
              {(p) => <Input {...p} required maxLength={120} value={period.name} onChange={(e) => setPeriod({ ...period, name: e.target.value })} />}
            </Field>
            <Field id="period-frequency" label={t('payroll.frequency')}>
              {(p) => (
                <select {...p} className={select} value={period.frequency} onChange={(e) => setPeriod({ ...period, frequency: e.target.value })}>
                  {['weekly', 'fortnightly', 'four_weekly', 'semi_monthly', 'monthly'].map((f) => (
                    <option key={f} value={f}>
                      {t(`payroll.frequencies.${f}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="period-start" label={t('payroll.start')}>
              {(p) => <Input {...p} type="date" required value={period.startDate} onChange={(e) => setPeriod({ ...period, startDate: e.target.value })} />}
            </Field>
            <Field id="period-end" label={t('payroll.end')}>
              {(p) => <Input {...p} type="date" required min={period.startDate} value={period.endDate} onChange={(e) => setPeriod({ ...period, endDate: e.target.value })} />}
            </Field>
            <Button type="submit" loading={busy === 'period'}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('payroll.addPeriod')}
            </Button>
          </form>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('payroll.connectors')}</CardTitle>
        {connectors.data?.length ? (
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {connectors.data.map((c) => (
              <li key={c.id} className="rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  <Badge>{t(`payroll.kinds.${c.kind}`)}</Badge>
                  <Badge tone={c.availability === 'stub' ? 'warning' : c.enabled ? 'success' : 'neutral'}>{t(c.availability === 'stub' ? 'payroll.comingSoon' : c.enabled ? 'payroll.enabled' : 'payroll.disabled')}</Badge>
                </div>
                <p className="mt-1 text-footnote text-text-secondary">
                  {t(`payroll.delivery.${c.delivery.method}`)} ·{' '}
                  {Object.entries(c.mapping.sections)
                    .filter(([, s]) => s?.enabled)
                    .map(([k]) => t(`payroll.sections.${k}`))
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('payroll.noConnectors')}</p>
        )}
        {canManage ? (
          <form onSubmit={createConnector} className="mt-4 grid gap-3 md:grid-cols-4 md:items-end">
            <Field id="connector-name" label={t('payroll.connectorName')} className="md:col-span-2">
              {(p) => <Input {...p} required maxLength={120} value={connector.name} onChange={(e) => setConnector({ ...connector, name: e.target.value })} />}
            </Field>
            <Field id="connector-kind" label={t('payroll.kind')}>
              {(p) => (
                <select {...p} className={select} value={connector.kind} onChange={(e) => setConnector({ ...connector, kind: e.target.value })}>
                  {(catalogue.data?.connectors ?? []).map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {t(`payroll.kinds.${k.kind}`)}
                      {k.availability === 'stub' ? ` (${t('payroll.comingSoon')})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Button type="submit" loading={busy === 'connector'}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('payroll.addConnector')}
            </Button>
          </form>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('payroll.exports')}</CardTitle>
        {exports.data?.length ? (
          <Table dense className="mt-3">
            <THead>
              <tr>
                <TH>{t('payroll.file')}</TH>
                <TH>{t('payroll.connector')}</TH>
                <TH>{t('payroll.created')}</TH>
                <TH>{t('payroll.reproducible')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {exports.data.map((x) => {
                const conn = connectors.data?.find((c) => c.id === x.connectorId);
                return (
                  <TR key={x.id}>
                    <TD>
                      <span className="font-semibold">{x.fileName}</span>
                      <span className="block font-mono text-footnote text-text-secondary" title={x.sha256}>
                        {t('payroll.checksum', { sha: x.sha256.slice(0, 12) })}
                      </span>
                    </TD>
                    <TD>{connectorName(x.connectorId)}</TD>
                    <TD>{formatDateTime(x.createdAt, locale, tz)}</TD>
                    <TD>{x.reproducible ? <Badge tone="accent">{t('payroll.fromSnapshot')}</Badge> : <Badge>{t('payroll.livePreview')}</Badge>}</TD>
                    <TD>
                      <div className="flex justify-end gap-2">
                        {canExport ? (
                          <Button size="sm" variant="secondary" loading={busy === `download:${x.id}`} onClick={() => download(x)} aria-label={t('payroll.downloadFile', { file: x.fileName })}>
                            <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
                            {t('payroll.download')}
                          </Button>
                        ) : null}
                        {canExport && conn && conn.delivery.method !== 'download' ? (
                          <Button size="sm" variant="ghost" loading={busy === `deliver:${x.id}`} onClick={() => deliver(x)} aria-label={t('payroll.deliverFile', { file: x.fileName })}>
                            <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                            {t(`payroll.deliverBy.${conn.delivery.method}`)}
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={<FileSpreadsheet aria-hidden />} title={t('payroll.noExports')} body={t('payroll.noExportsBody')} />
        )}
      </Card>

      <Card>
        <CardTitle>{t('payroll.deliveryLog')}</CardTitle>
        {deliveries.data?.length ? (
          <Table dense className="mt-3">
            <THead>
              <tr>
                <TH>{t('payroll.when')}</TH>
                <TH>{t('payroll.method')}</TH>
                <TH>{t('payroll.destination')}</TH>
                <TH>{t('common.status')}</TH>
              </tr>
            </THead>
            <tbody>
              {deliveries.data.map((d) => (
                <TR key={d.id}>
                  <TD>{formatDateTime(d.createdAt, locale, tz)}</TD>
                  <TD>{t(`payroll.delivery.${d.method}`)}</TD>
                  <TD className="max-w-[24ch] truncate font-mono text-footnote" title={d.destination ?? ''}>
                    {d.destination ?? ''}
                  </TD>
                  <TD>
                    <Badge tone={statusTone[d.status as keyof typeof statusTone] ?? 'neutral'}>{t(`payroll.deliveryStatus.${d.status}`)}</Badge>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('payroll.noDeliveries')}</p>
        )}
      </Card>
    </div>
  );
}
