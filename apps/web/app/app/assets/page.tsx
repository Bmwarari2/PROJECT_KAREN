'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Laptop, PackageCheck, Plus, UserPlus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
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
import { formatDate, formatDateTime, formatMoney } from '@thapsus/core/i18n';
import { money, parseDecimal } from '@thapsus/core/money';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';

interface Assignment {
  id: string;
  assetId: string;
  assetTag: string;
  assetName: string;
  assetType: string;
  serialNumber: string | null;
  employeeName: string | null;
  status: string;
  assignedOn: string;
  acknowledgedAt: string | null;
  returnChecklist: Array<{ key: string; label?: string }>;
}
interface Asset {
  id: string;
  assetTag: string;
  type: string;
  name: string;
  serialNumber: string | null;
  costMinor: number | null;
  currency: string | null;
  status: string;
  holder: {
    assignmentId: string;
    employeeId: string;
    employeeName: string;
    acknowledgedAt: string | null;
  } | null;
  returnChecklist: Array<{ key: string; label?: string }>;
}
interface Employee {
  id: string;
  displayName: string;
  employeeNumber?: string;
}

const TYPES = [
  'laptop',
  'desktop',
  'phone',
  'tablet',
  'monitor',
  'headset',
  'peripheral',
  'vehicle',
  'access_card',
  'other',
];
const select = 'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';
const statusTone = {
  in_stock: 'success',
  assigned: 'accent',
  in_repair: 'warning',
  retired: 'neutral',
  lost: 'danger',
} as const;
const todayIso = () => new Date().toISOString().slice(0, 10);

export default function AssetsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const canManage = !!session?.permissions.some(
    (g) => g === '*' || g === 'assets.*' || g === 'assets.manage',
  );
  const mine = useApi<Assignment[]>(session?.employeeId ? '/v1/me/assets' : null);
  const assets = useApi<Asset[]>(canManage ? '/v1/assets' : null);
  const people = useApi<{ data: Employee[] }>(canManage ? '/v1/employees?limit=200' : null);
  const [form, setForm] = React.useState({
    assetTag: '',
    name: '',
    type: 'laptop',
    serialNumber: '',
    cost: '',
    currency: 'GBP',
  });
  const [ack, setAck] = React.useState<Assignment | null>(null);
  const [accepted, setAccepted] = React.useState(false);
  const [assign, setAssign] = React.useState<Asset | null>(null);
  const [assignForm, setAssignForm] = React.useState({ employeeId: '', assignedOn: todayIso() });
  const [ret, setRet] = React.useState<Asset | null>(null);
  const [ticks, setTicks] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const tz = session?.timeZone ?? 'Europe/London';
  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
      tone: 'danger',
    });
  const itemLabel = (i: { key: string; label?: string }) => i.label ?? t(`assets.checklist.${i.key}`);

  // deep links from tasks and notifications: ?ack=<assignment> and ?return=<assignment>
  React.useEffect(() => {
    const a = params.get('ack');
    if (a && mine.data) setAck(mine.data.find((m) => m.id === a && !m.acknowledgedAt) ?? null);
    const r = params.get('return');
    if (r && assets.data) setRet(assets.data.find((x) => x.holder?.assignmentId === r) ?? null);
  }, [params, mine.data, assets.data]);

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
  const clearLink = () =>
    params.get('ack') || params.get('return') ? router.replace('/app/assets') : undefined;

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run('create', async () => {
      let costMinor: number | undefined;
      if (form.cost) costMinor = Number(parseDecimal(form.cost, form.currency).amountMinor);
      await api('/v1/assets', {
        method: 'POST',
        json: {
          assetTag: form.assetTag,
          name: form.name,
          type: form.type,
          serialNumber: form.serialNumber || undefined,
          ...(costMinor !== undefined ? { costMinor, currency: form.currency } : {}),
        },
      });
      setForm({ ...form, assetTag: '', name: '', serialNumber: '', cost: '' });
      toast({ title: t('assets.created'), tone: 'success' });
      assets.reload();
    });
  };
  const confirmAck = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ack) return;
    void run('ack', async () => {
      await api(`/v1/asset-assignments/${ack.id}/acknowledge`, { method: 'POST', json: { confirm: true } });
      toast({ title: t('assets.acknowledged'), tone: 'success' });
      setAck(null);
      setAccepted(false);
      clearLink();
      mine.reload();
    });
  };
  const doAssign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!assign) return;
    void run('assign', async () => {
      await api(`/v1/assets/${assign.id}/assign`, { method: 'POST', json: assignForm });
      toast({ title: t('assets.assigned'), tone: 'success' });
      setAssign(null);
      assets.reload();
      mine.reload();
    });
  };
  const doReturn = (outcome: 'returned' | 'lost') => {
    if (!ret?.holder) return;
    void run('return', async () => {
      await api(`/v1/asset-assignments/${ret.holder!.assignmentId}/return`, {
        method: 'POST',
        json: {
          returnedOn: todayIso(),
          outcome,
          checklist: ret.returnChecklist.map((i) => ({ key: i.key, done: !!ticks[i.key] })),
        },
      });
      toast({ title: t(outcome === 'lost' ? 'assets.markedLost' : 'assets.returned'), tone: 'success' });
      setRet(null);
      setTicks({});
      clearLink();
      assets.reload();
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('assets.title')}</h1>

      {session?.employeeId ? (
        <Card>
          <CardTitle>{t('assets.mine')}</CardTitle>
          {!mine.data ? (
            <Skeleton className="mt-3 h-20" />
          ) : mine.data.length ? (
            <ul className="mt-3 flex flex-col gap-2">
              {mine.data.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
                >
                  <Laptop aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{a.assetName}</p>
                    <p className="text-footnote text-text-secondary">
                      {t('assets.tagLine', { tag: a.assetTag, date: formatDate(a.assignedOn, locale) })}
                      {a.serialNumber ? ` · ${t('assets.serial', { serial: a.serialNumber })}` : ''}
                    </p>
                  </div>
                  {a.acknowledgedAt ? (
                    <Badge tone="success">
                      <CheckCircle2 aria-hidden className="h-3 w-3" />
                      {t('assets.acknowledgedOn', { when: formatDateTime(a.acknowledgedAt, locale, tz) })}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setAck(a)}
                      aria-label={t('assets.confirmReceiptOf', { asset: a.assetName })}
                    >
                      <PackageCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
                      {t('assets.confirmReceipt')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-callout text-text-secondary">{t('assets.noneMine')}</p>
          )}
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          <CardTitle>{t('assets.register')}</CardTitle>
          {!assets.data ? (
            <Skeleton className="mt-3 h-24" />
          ) : assets.data.length ? (
            <Table dense className="mt-3">
              <THead>
                <tr>
                  <TH>{t('assets.tag')}</TH>
                  <TH>{t('assets.name')}</TH>
                  <TH>{t('assets.type')}</TH>
                  <TH className="text-right">{t('assets.cost')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>{t('assets.holder')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {assets.data.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-mono text-footnote">{a.assetTag}</TD>
                    <TD className="font-semibold">{a.name}</TD>
                    <TD>{t(`assets.types.${a.type}`)}</TD>
                    <TD className="text-right">
                      {a.costMinor !== null && a.currency
                        ? formatMoney(money(BigInt(a.costMinor), a.currency), locale)
                        : ''}
                    </TD>
                    <TD>
                      <Badge tone={statusTone[a.status as keyof typeof statusTone] ?? 'neutral'}>
                        {t(`assets.status.${a.status}`)}
                      </Badge>
                    </TD>
                    <TD>
                      {a.holder ? (
                        <span>
                          {a.holder.employeeName}
                          <span className="block text-footnote text-text-secondary">
                            {a.holder.acknowledgedAt ? t('assets.signedFor') : t('assets.awaitingSignOff')}
                          </span>
                        </span>
                      ) : (
                        ''
                      )}
                    </TD>
                    <TD className="text-right">
                      {a.status === 'in_stock' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setAssign(a)}
                          aria-label={t('assets.assignNamed', { asset: a.name })}
                        >
                          <UserPlus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                          {t('assets.assign')}
                        </Button>
                      ) : a.holder ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRet(a)}
                          aria-label={t('assets.recordReturnNamed', { asset: a.name })}
                        >
                          {t('assets.recordReturn')}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState
              icon={<Laptop aria-hidden />}
              title={t('assets.empty')}
              body={t('assets.emptyBody')}
            />
          )}
          <form onSubmit={create} className="mt-4 grid gap-3 md:grid-cols-7 md:items-end">
            <Field id="asset-tag" label={t('assets.tag')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  maxLength={60}
                  value={form.assetTag}
                  onChange={(e) => setForm({ ...form, assetTag: e.target.value })}
                />
              )}
            </Field>
            <Field id="asset-name" label={t('assets.name')} className="md:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  required
                  maxLength={200}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field id="asset-type" label={t('assets.type')}>
              {(p) => (
                <select
                  {...p}
                  className={select}
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`assets.types.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="asset-serial" label={t('assets.serialNumber')}>
              {(p) => (
                <Input
                  {...p}
                  maxLength={120}
                  value={form.serialNumber}
                  onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                />
              )}
            </Field>
            <Field id="asset-cost" label={t('assets.costIn', { currency: form.currency })}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  pattern="^\d+(\.\d{1,2})?$"
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: e.target.value })}
                />
              )}
            </Field>
            <Button type="submit" loading={busy === 'create'}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('assets.add')}
            </Button>
          </form>
        </Card>
      ) : null}

      <Dialog open={!!ack} onOpenChange={(o) => !o && (setAck(null), clearLink())}>
        {ack ? (
          <DialogContent
            title={t('assets.ackTitle', { asset: ack.assetName })}
            description={t('assets.ackBody')}
            closeLabel={t('common.close')}
          >
            <form onSubmit={confirmAck} className="flex flex-col gap-4">
              <dl className="grid grid-cols-2 gap-1 text-callout">
                <dt className="text-text-secondary">{t('assets.tag')}</dt>
                <dd>{ack.assetTag}</dd>
                <dt className="text-text-secondary">{t('assets.serialNumber')}</dt>
                <dd>{ack.serialNumber ?? ''}</dd>
                <dt className="text-text-secondary">{t('assets.issuedOn')}</dt>
                <dd>{formatDate(ack.assignedOn, locale)}</dd>
              </dl>
              <label className="flex items-start gap-3 text-callout">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  className="mt-1 h-5 w-5 accent-[var(--color-accent)]"
                />
                <span>{t('assets.ackStatement.v1')}</span>
              </label>
              <Button type="submit" disabled={!accepted} loading={busy === 'ack'}>
                {t('assets.confirmReceipt')}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={!!assign} onOpenChange={(o) => !o && setAssign(null)}>
        {assign ? (
          <DialogContent
            title={t('assets.assignTitle', { asset: assign.name })}
            closeLabel={t('common.close')}
          >
            <form onSubmit={doAssign} className="flex flex-col gap-4">
              <Field id="assign-employee" label={t('assets.employee')}>
                {(p) => (
                  <select
                    {...p}
                    required
                    className={select}
                    value={assignForm.employeeId}
                    onChange={(e) => setAssignForm({ ...assignForm, employeeId: e.target.value })}
                  >
                    <option value="">{t('assets.chooseEmployee')}</option>
                    {(people.data?.data ?? []).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id="assign-date" label={t('assets.issuedOn')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    required
                    value={assignForm.assignedOn}
                    onChange={(e) => setAssignForm({ ...assignForm, assignedOn: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" loading={busy === 'assign'}>
                {t('assets.assign')}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog open={!!ret} onOpenChange={(o) => !o && (setRet(null), clearLink())}>
        {ret ? (
          <DialogContent
            title={t('assets.returnTitle', { asset: ret.name })}
            description={t('assets.returnBody')}
            closeLabel={t('common.close')}
          >
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-callout font-semibold">{t('assets.checklistTitle')}</legend>
              {ret.returnChecklist.map((i) => (
                <label key={i.key} className="flex items-center gap-3 text-callout">
                  <input
                    type="checkbox"
                    checked={!!ticks[i.key]}
                    onChange={(e) => setTicks({ ...ticks, [i.key]: e.target.checked })}
                    className="h-5 w-5 accent-[var(--color-accent)]"
                  />
                  <span>{itemLabel(i)}</span>
                </label>
              ))}
            </fieldset>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                onClick={() => doReturn('returned')}
                disabled={!ret.returnChecklist.every((i) => ticks[i.key])}
                loading={busy === 'return'}
              >
                {t('assets.markReturned')}
              </Button>
              <Button variant="danger" onClick={() => doReturn('lost')}>
                {t('assets.markLost')}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
