'use client';
import * as React from 'react';
import { Database, Play, Plus, PlugZap, Server, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Table,
  TableToolbar,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDateTime, formatTimeOfDay, numberFormat } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageTitle, useSession } from '../../shell';
import type { Catalogue } from '../page';
import { NoReportsAccess, problemText, selectClass, weekdayName, zones } from '../ui';

interface Destination {
  id: string;
  name: string;
  kind: 's3' | 'sftp';
  lastTestedAt: string | null;
  credentialFields: string[];
  s3: { bucket: string; region: string; prefix: string; roleArn: string; externalId: string } | null;
  sftp: {
    host: string;
    port: number;
    username: string;
    directory: string;
    hostKeySha256: string;
    auth: string;
  } | null;
}
interface Destinations {
  data: Destination[];
  homeRegion: string;
  rolePrefix: string;
}
interface DataExport {
  id: string;
  name: string;
  destinationId: string;
  datasets: Array<{ dataset: string; fields: string[] }>;
  format: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  timeOfDay: string;
  weekday: number | null;
  dayOfMonth: number | null;
  timeZone: string;
  enabled: boolean;
}
interface Delivery {
  id: string;
  periodKey: string;
  trigger: string;
  status: string;
  files: number | null;
  rows: number | null;
  bytes: number | null;
  durationMs: number | null;
  errorCode: string | null;
  attempts: number;
  createdAt: string;
}
const deliveryTone = {
  succeeded: 'success',
  failed: 'danger',
  queued: 'neutral',
  running: 'accent',
} as const;

/** Destination failures carry a stable code; show its translated explanation, else the API's text. */
function useDestinationError() {
  const t = useT();
  return (err: unknown) => {
    if (err instanceof ApiProblem && typeof err.body.code === 'string') {
      const key = `reports.exports.error.${err.body.code}`;
      const text = t(key);
      if (text !== key) return text;
    }
    return problemText(t, err);
  };
}

function DestinationForm({
  homeRegion,
  rolePrefix,
  onDone,
}: {
  homeRegion: string;
  rolePrefix: string;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const errorText = useDestinationError();
  const [kind, setKind] = React.useState<'s3' | 'sftp'>('s3');
  const [name, setName] = React.useState('');
  const [s3, setS3] = React.useState({ bucket: '', region: homeRegion, prefix: '', roleArn: '' });
  const [sftp, setSftp] = React.useState({
    host: '',
    port: 22,
    username: '',
    directory: '',
    hostKeySha256: '',
    auth: 'key' as 'key' | 'password',
    password: '',
    privateKey: '',
    passphrase: '',
  });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body =
      kind === 's3'
        ? {
            name,
            kind,
            s3: {
              bucket: s3.bucket,
              region: s3.region,
              roleArn: s3.roleArn,
              ...(s3.prefix ? { prefix: s3.prefix } : {}),
            },
          }
        : {
            name,
            kind,
            sftp: {
              host: sftp.host,
              port: sftp.port,
              username: sftp.username,
              hostKeySha256: sftp.hostKeySha256,
              ...(sftp.directory ? { directory: sftp.directory } : {}),
              ...(sftp.auth === 'password'
                ? { password: sftp.password }
                : {
                    privateKey: sftp.privateKey,
                    ...(sftp.passphrase ? { passphrase: sftp.passphrase } : {}),
                  }),
            },
          };
    try {
      await api('/v1/data-exports/destinations', { method: 'POST', json: body });
      toast({ title: t('reports.exports.destinationAdded'), tone: 'success' });
      onDone();
    } catch (err) {
      toast({ title: errorText(err), tone: 'danger' });
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id="d-name" label={t('reports.exports.name')}>
        {(a) => (
          <Input {...a} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-2 text-callout font-semibold">{t('reports.exports.kind')}</legend>
        {(['s3', 'sftp'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-callout">
            <input
              type="radio"
              name="kind"
              className="h-5 w-5 accent-[var(--color-accent)]"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {t(`reports.exports.kind_${k}`)}
          </label>
        ))}
      </fieldset>
      {kind === 's3' ? (
        <>
          <Field id="d-bucket" label={t('reports.exports.bucket')}>
            {(a) => (
              <Input
                {...a}
                required
                minLength={3}
                maxLength={63}
                value={s3.bucket}
                onChange={(e) => setS3({ ...s3, bucket: e.target.value })}
              />
            )}
          </Field>
          <Field
            id="d-region"
            label={t('reports.exports.region')}
            hint={t('reports.exports.regionHint', { region: homeRegion })}
          >
            {(a) => (
              <Input
                {...a}
                required
                value={s3.region}
                onChange={(e) => setS3({ ...s3, region: e.target.value })}
              />
            )}
          </Field>
          <Field id="d-prefix" label={t('reports.exports.prefix')}>
            {(a) => (
              <Input
                {...a}
                maxLength={200}
                value={s3.prefix}
                onChange={(e) => setS3({ ...s3, prefix: e.target.value })}
              />
            )}
          </Field>
          <Field
            id="d-role"
            label={t('reports.exports.roleArn')}
            hint={t('reports.exports.roleArnHint', { prefix: rolePrefix })}
          >
            {(a) => (
              <Input
                {...a}
                required
                maxLength={120}
                value={s3.roleArn}
                onChange={(e) => setS3({ ...s3, roleArn: e.target.value })}
              />
            )}
          </Field>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field id="d-host" label={t('reports.exports.host')}>
              {(a) => (
                <Input
                  {...a}
                  required
                  maxLength={253}
                  value={sftp.host}
                  onChange={(e) => setSftp({ ...sftp, host: e.target.value })}
                />
              )}
            </Field>
            <Field id="d-port" label={t('reports.exports.port')}>
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  value={sftp.port}
                  onChange={(e) => setSftp({ ...sftp, port: Number(e.target.value) })}
                />
              )}
            </Field>
          </div>
          <Field id="d-user" label={t('reports.exports.username')}>
            {(a) => (
              <Input
                {...a}
                required
                maxLength={100}
                autoComplete="off"
                value={sftp.username}
                onChange={(e) => setSftp({ ...sftp, username: e.target.value })}
              />
            )}
          </Field>
          <Field id="d-dir" label={t('reports.exports.directory')}>
            {(a) => (
              <Input
                {...a}
                maxLength={200}
                value={sftp.directory}
                onChange={(e) => setSftp({ ...sftp, directory: e.target.value })}
              />
            )}
          </Field>
          <Field id="d-hostkey" label={t('reports.exports.hostKey')} hint={t('reports.exports.hostKeyHint')}>
            {(a) => (
              <Input
                {...a}
                required
                maxLength={60}
                spellCheck={false}
                value={sftp.hostKeySha256}
                onChange={(e) => setSftp({ ...sftp, hostKeySha256: e.target.value.trim() })}
              />
            )}
          </Field>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 text-callout font-semibold">{t('reports.exports.auth')}</legend>
            {(['key', 'password'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-callout">
                <input
                  type="radio"
                  name="auth"
                  className="h-5 w-5 accent-[var(--color-accent)]"
                  checked={sftp.auth === k}
                  onChange={() => setSftp({ ...sftp, auth: k })}
                />
                {t(`reports.exports.auth_${k}`)}
              </label>
            ))}
          </fieldset>
          {sftp.auth === 'password' ? (
            <Field id="d-pass" label={t('reports.exports.password')}>
              {(a) => (
                <Input
                  {...a}
                  type="password"
                  required
                  autoComplete="new-password"
                  value={sftp.password}
                  onChange={(e) => setSftp({ ...sftp, password: e.target.value })}
                />
              )}
            </Field>
          ) : (
            <>
              <Field id="d-key" label={t('reports.exports.privateKey')}>
                {(a) => (
                  <Textarea
                    {...a}
                    required
                    rows={4}
                    spellCheck={false}
                    className="font-mono text-footnote"
                    value={sftp.privateKey}
                    onChange={(e) => setSftp({ ...sftp, privateKey: e.target.value })}
                  />
                )}
              </Field>
              <Field id="d-passphrase" label={t('reports.exports.passphrase')}>
                {(a) => (
                  <Input
                    {...a}
                    type="password"
                    autoComplete="new-password"
                    value={sftp.passphrase}
                    onChange={(e) => setSftp({ ...sftp, passphrase: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
          <p className="text-footnote text-text-secondary">{t('reports.exports.secretsEncrypted')}</p>
        </>
      )}
      <Button type="submit">{t('common.save')}</Button>
    </form>
  );
}

function ExportForm({
  catalogue,
  destinations,
  onDone,
}: {
  catalogue: Catalogue;
  destinations: Destination[];
  onDone: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const tzList = React.useMemo(zones, []);
  const [form, setForm] = React.useState({
    name: '',
    destinationId: destinations[0]?.id ?? '',
    format: 'csv',
    frequency: 'daily' as DataExport['frequency'],
    timeOfDay: '02:00',
    weekday: 1,
    dayOfMonth: 1,
    timeZone: session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [fields, setFields] = React.useState<Record<string, string[]>>({});
  const datasets = catalogue.datasets.map((d) => ({ ...d, fields: d.fields.filter((f) => !f.vault) }));
  const selected = Object.entries(fields).filter(([, f]) => f.length);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/v1/data-exports', {
        method: 'POST',
        json: {
          name: form.name,
          destinationId: form.destinationId,
          format: form.format,
          frequency: form.frequency,
          timeOfDay: form.timeOfDay,
          timeZone: form.timeZone,
          ...(form.frequency === 'weekly' ? { weekday: form.weekday } : {}),
          ...(form.frequency === 'monthly' ? { dayOfMonth: form.dayOfMonth } : {}),
          datasets: selected.map(([dataset, f]) => ({ dataset, fields: f })),
        },
      });
      toast({ title: t('reports.exports.exportCreated'), tone: 'success' });
      onDone();
    } catch (err) {
      toast({ title: problemText(t, err), tone: 'danger' });
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id="x-name" label={t('reports.exports.name')}>
        {(a) => (
          <Input
            {...a}
            required
            maxLength={120}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="x-dest" label={t('reports.exports.destination')}>
          {(a) => (
            <select
              {...a}
              required
              className={selectClass}
              value={form.destinationId}
              onChange={(e) => setForm({ ...form, destinationId: e.target.value })}
            >
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="x-format" label={t('reports.schedules.format')}>
          {(a) => (
            <select
              {...a}
              className={selectClass}
              value={form.format}
              onChange={(e) => setForm({ ...form, format: e.target.value })}
            >
              <option value="csv">{t('reports.format.csv')}</option>
              <option value="jsonl">{t('reports.format.jsonl')}</option>
            </select>
          )}
        </Field>
        <Field id="x-frequency" label={t('reports.schedules.frequency')}>
          {(a) => (
            <select
              {...a}
              className={selectClass}
              value={form.frequency}
              onChange={(e) => setForm({ ...form, frequency: e.target.value as DataExport['frequency'] })}
            >
              {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                <option key={f} value={f}>
                  {t(`reports.schedules.freq.${f}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {form.frequency === 'weekly' ? (
          <Field id="x-weekday" label={t('reports.schedules.weekday')}>
            {(a) => (
              <select
                {...a}
                className={selectClass}
                value={form.weekday}
                onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                  <option key={w} value={w}>
                    {weekdayName(locale, w)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : form.frequency === 'monthly' ? (
          <Field
            id="x-dom"
            label={t('reports.schedules.dayOfMonth')}
            hint={t('reports.schedules.dayOfMonthHint')}
          >
            {(a) => (
              <Input
                {...a}
                type="number"
                inputMode="numeric"
                min={1}
                max={28}
                value={form.dayOfMonth}
                onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}
              />
            )}
          </Field>
        ) : (
          <span />
        )}
        <Field id="x-time" label={t('reports.schedules.time')}>
          {(a) => (
            <Input
              {...a}
              type="time"
              required
              value={form.timeOfDay}
              onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}
            />
          )}
        </Field>
        <Field id="x-zone" label={t('reports.schedules.timeZone')}>
          {(a) => (
            <>
              <Input
                {...a}
                required
                list="x-zones"
                value={form.timeZone}
                onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
              />
              <datalist id="x-zones">
                {tzList.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
      {datasets.map((d) => (
        <details key={d.key} className="rounded-sm border border-border p-3">
          <summary className="cursor-pointer text-callout font-semibold">
            {t(d.labelKey)}
            {fields[d.key]?.length ? (
              <span className="ml-2 font-normal text-text-secondary">
                {t('reports.exports.fieldsChosen', { count: fields[d.key]!.length })}
              </span>
            ) : null}
          </summary>
          <fieldset className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-2">
            <legend className="sr-only">{t('reports.exports.fieldsOf', { dataset: t(d.labelKey) })}</legend>
            {d.fields.map((f) => (
              <label key={f.key} className="flex min-h-11 items-center gap-2 text-callout">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--color-accent)]"
                  checked={fields[d.key]?.includes(f.key) ?? false}
                  onChange={(e) =>
                    setFields((s) => ({
                      ...s,
                      [d.key]: e.target.checked
                        ? [...(s[d.key] ?? []), f.key]
                        : (s[d.key] ?? []).filter((x) => x !== f.key),
                    }))
                  }
                />
                {t(f.labelKey)}
              </label>
            ))}
          </fieldset>
        </details>
      ))}
      <p className="text-footnote text-text-secondary">{t('reports.exports.permissionsNote')}</p>
      <Button type="submit" disabled={!selected.length || !form.destinationId}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function DeliveryLog({ exp }: { exp: DataExport }) {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const log = useApi<Delivery[]>(`/v1/data-exports/${exp.id}/deliveries`);
  if (!log.data) return <Skeleton className="h-24 w-full" />;
  if (!log.data.length)
    return <p className="text-callout text-text-secondary">{t('reports.exports.noDeliveries')}</p>;
  const n = (v: number | null) => (v === null ? '—' : numberFormat(locale).format(v));
  return (
    <Table dense scrollLabel={t('reports.exports.deliveries')}>
      <caption className="sr-only">{t('reports.exports.deliveries')}</caption>
      <THead>
        <tr>
          <TH>{t('reports.exports.period')}</TH>
          <TH>{t('common.status')}</TH>
          <TH className="text-right">{t('reports.runs.rows')}</TH>
          <TH className="text-right">{t('reports.exports.bytes')}</TH>
          <TH className="text-right">{t('reports.exports.duration')}</TH>
          <TH>{t('reports.runs.requested')}</TH>
        </tr>
      </THead>
      <tbody>
        {log.data.map((d) => (
          <TR key={d.id}>
            <TD>{d.periodKey}</TD>
            <TD>
              <Badge tone={deliveryTone[d.status as keyof typeof deliveryTone] ?? 'neutral'}>
                {t(`reports.runStatus.${d.status}`)}
              </Badge>
              {d.errorCode ? (
                <span className="ml-2 text-footnote text-danger">
                  {t(`reports.exports.error.${d.errorCode}`)}
                </span>
              ) : null}
            </TD>
            <TD className="text-right tabular-nums" label={t('reports.runs.rows')}>
              {n(d.rows)}
            </TD>
            <TD className="text-right tabular-nums" label={t('reports.exports.bytes')}>
              {n(d.bytes)}
            </TD>
            <TD className="text-right tabular-nums" label={t('reports.exports.duration')}>
              {d.durationMs === null
                ? '—'
                : t('reports.exports.seconds', {
                    n: numberFormat(locale, { maximumFractionDigits: 1 }).format(d.durationMs / 1000),
                  })}
            </TD>
            <TD className="whitespace-nowrap" label={t('reports.runs.requested')}>
              {formatDateTime(d.createdAt, locale, zone)}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

/** Disclosure whose content (and its API call) only mounts once opened. */
function LazyDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-callout">{summary}</summary>
      {open ? <div className="mt-3">{children}</div> : null}
    </details>
  );
}

/** Scheduled data export to the customer's own S3 bucket (home region only) or SFTP server. */
export default function ExportsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const errorText = useDestinationError();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const catalogue = useApi<Catalogue>('/v1/reports/catalogue');
  const dests = useApi<Destinations>('/v1/data-exports/destinations');
  const exports = useApi<DataExport[]>('/v1/data-exports');
  const [destOpen, setDestOpen] = React.useState(false);
  const [expOpen, setExpOpen] = React.useState(false);

  if (dests.error || exports.error) return <NoReportsAccess />;
  if (!dests.data || !exports.data || !catalogue.data) return <Skeleton className="h-96 w-full" />;
  const destName = (id: string) => dests.data!.data.find((d) => d.id === id)?.name ?? '—';

  const act = async (fn: () => Promise<unknown>, done: string, err = problemText.bind(null, t)) => {
    try {
      await fn();
      toast({ title: t(done), tone: 'success' });
      dests.reload();
      exports.reload();
    } catch (e) {
      toast({ title: err(e), tone: 'danger' });
    }
  };
  const when = (x: DataExport) => {
    const time = formatTimeOfDay(x.timeOfDay, locale);
    if (x.frequency === 'daily') return t('reports.schedules.whenDaily', { time, zone: x.timeZone });
    if (x.frequency === 'weekly')
      return t('reports.schedules.whenWeekly', {
        day: weekdayName(locale, x.weekday ?? 1),
        time,
        zone: x.timeZone,
      });
    return t('reports.schedules.whenMonthly', { day: x.dayOfMonth ?? 1, time, zone: x.timeZone });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageTitle>{t('reports.exports.title')}</PageTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('reports.exports.intro', { region: dests.data.homeRegion })}
        </p>
      </div>

      <Card className="overflow-hidden p-0">
        <TableToolbar
          title={t('reports.exports.destinations')}
          count={t('reports.ui.destinationCount', { count: dests.data.data.length })}
          actions={
            <Dialog open={destOpen} onOpenChange={setDestOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('reports.exports.addDestination')}
                </Button>
              </DialogTrigger>
              <DialogContent
                title={t('reports.exports.addDestination')}
                description={t('reports.exports.addDestinationBody', { region: dests.data.homeRegion })}
                closeLabel={t('common.close')}
              >
                <DestinationForm
                  homeRegion={dests.data.homeRegion}
                  rolePrefix={dests.data.rolePrefix}
                  onDone={() => {
                    setDestOpen(false);
                    dests.reload();
                  }}
                />
              </DialogContent>
            </Dialog>
          }
        />
        <div className="px-5">
          {dests.data.data.length ? (
            // rows of the card, divided by hairlines (no boxes inside the card)
            <ul className="flex flex-col divide-y divide-border">
              {dests.data.data.map((d) => (
                <li key={d.id}>
                  <div className="flex h-full flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-center gap-2 [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.5]">
                      {d.kind === 's3' ? (
                        <Database aria-hidden className="text-accent" />
                      ) : (
                        <Server aria-hidden className="text-accent" />
                      )}
                      <CardTitle as="h3" className="mr-auto text-callout font-semibold">
                        {d.name}
                      </CardTitle>
                      <Badge tone={d.lastTestedAt ? 'success' : 'neutral'}>
                        {d.lastTestedAt
                          ? t('reports.exports.tested', {
                              when: formatDateTime(d.lastTestedAt, locale, zone),
                            })
                          : t('reports.exports.untested')}
                      </Badge>
                    </div>
                    <dl className="grid gap-1 text-footnote">
                      {d.s3 ? (
                        <>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.bucket')}</dt>
                            <dd className="break-all">{`s3://${d.s3.bucket}/${d.s3.prefix} (${d.s3.region})`}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.roleArn')}</dt>
                            <dd className="break-all">{d.s3.roleArn}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.externalId')}</dt>
                            <dd className="break-all font-mono">{d.s3.externalId}</dd>
                          </div>
                        </>
                      ) : d.sftp ? (
                        <>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.host')}</dt>
                            <dd className="break-all">{`sftp://${d.sftp.username}@${d.sftp.host}:${d.sftp.port}/${d.sftp.directory}`}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.hostKey')}</dt>
                            <dd className="break-all font-mono">{d.sftp.hostKeySha256}</dd>
                          </div>
                          <div className="flex flex-wrap justify-between gap-2">
                            <dt className="text-text-secondary">{t('reports.exports.auth')}</dt>
                            <dd>{t(`reports.exports.auth_${d.sftp.auth}`)}</dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                    {d.s3 ? (
                      <p className="text-footnote text-text-secondary">{t('reports.exports.trustHint')}</p>
                    ) : null}
                    <div className="mt-auto flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          act(
                            () => api(`/v1/data-exports/destinations/${d.id}/test`, { method: 'POST' }),
                            'reports.exports.testOk',
                            errorText,
                          )
                        }
                      >
                        <PlugZap aria-hidden className="h-4 w-4 stroke-[1.5]" />
                        {t('reports.exports.test')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('reports.exports.deleteNamed', { name: d.name })}
                        onClick={() =>
                          act(
                            () => api(`/v1/data-exports/destinations/${d.id}`, { method: 'DELETE' }),
                            'reports.exports.deleted',
                          )
                        }
                      >
                        <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              level={3}
              icon={<Database aria-hidden />}
              title={t('reports.exports.noDestinations')}
              body={t('reports.exports.noDestinationsBody')}
            />
          )}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <TableToolbar
          title={t('reports.exports.scheduled')}
          count={t('reports.ui.exportCount', { count: exports.data.length })}
          actions={
            <Dialog open={expOpen} onOpenChange={setExpOpen}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={!dests.data.data.length}>
                  <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('reports.exports.newExport')}
                </Button>
              </DialogTrigger>
              <DialogContent
                title={t('reports.exports.newExport')}
                description={t('reports.exports.newExportBody')}
                closeLabel={t('common.close')}
              >
                <ExportForm
                  catalogue={catalogue.data}
                  destinations={dests.data.data}
                  onDone={() => {
                    setExpOpen(false);
                    exports.reload();
                  }}
                />
              </DialogContent>
            </Dialog>
          }
        />
        <div className="px-5">
          {exports.data.length ? (
            <ul className="flex flex-col divide-y divide-border">
              {exports.data.map((x) => (
                <li key={x.id}>
                  <div className="flex flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle as="h3" className="mr-auto text-callout font-semibold">
                        {x.name}
                      </CardTitle>
                      <Badge tone={x.enabled ? 'success' : 'neutral'}>
                        {t(x.enabled ? 'reports.schedules.on' : 'reports.schedules.off')}
                      </Badge>
                    </div>
                    <p className="text-callout text-text-secondary">
                      {when(x)} · {destName(x.destinationId)} · <span className="uppercase">{x.format}</span>{' '}
                      · {x.datasets.map((d) => t(`reports.dataset.${d.dataset}`)).join(', ')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          act(
                            () => api(`/v1/data-exports/${x.id}/run`, { method: 'POST' }),
                            'reports.exports.runQueued',
                          )
                        }
                      >
                        <Play aria-hidden className="h-4 w-4 stroke-[1.5]" />
                        {t('reports.exports.runNow')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          act(
                            () =>
                              api(`/v1/data-exports/${x.id}`, {
                                method: 'PATCH',
                                json: { enabled: !x.enabled },
                              }),
                            x.enabled ? 'reports.schedules.paused' : 'reports.schedules.resumed',
                          )
                        }
                      >
                        {t(x.enabled ? 'reports.schedules.pause' : 'reports.schedules.resume')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('reports.exports.deleteNamed', { name: x.name })}
                        onClick={() =>
                          act(
                            () => api(`/v1/data-exports/${x.id}`, { method: 'DELETE' }),
                            'reports.exports.deleted',
                          )
                        }
                      >
                        <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      </Button>
                    </div>
                    <LazyDetails summary={t('reports.exports.deliveries')}>
                      <DeliveryLog exp={x} />
                    </LazyDetails>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              level={3}
              icon={<Database aria-hidden />}
              title={t('reports.exports.noExports')}
              body={t('reports.exports.noExportsBody')}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
