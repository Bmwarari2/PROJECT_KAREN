'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Lock, RefreshCw } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
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
import { formatDateTime, formatNumber, type Locale } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass, staffCan, useStaff } from '../../ui';

interface Detail {
  tenantId: string;
  slug: string;
  name: string;
  region: string;
  status: string;
  createdAt: string;
  usage: { headcount: number; activeUsers: number; storageBytes: number; computedAt: string } | null;
  entities: Array<{ id: string; name: string; country: string }>;
  billingAccounts: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    currency: string;
    collection: string;
    paymentTermsDays: number | null;
    poNumber: string | null;
    entityIds: string[];
    detailsComplete: boolean;
    subscription: { planId: string; status: string; term: string; quantity: number } | null;
  }>;
  contracts: Array<{
    id: string;
    reference: string;
    status: string;
    planId: string;
    endsOn: string;
    renewalDue: boolean;
  }>;
  grant: { id: string; accessLevel: string; expiresAt: string } | null;
}
interface Flag {
  key: string;
  enabled: boolean;
  default: boolean;
  overridden: boolean;
  managedBy: 'tenant' | 'staff';
}

export default function TenantDetail() {
  const t = useT();
  const locale = useLocale() as Locale;
  const staff = useStaff();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const d = useApi<Detail>(`/v1/backoffice/tenants/${id}`);
  const flags = useApi<Flag[]>(staffCan(staff) ? `/v1/backoffice/tenants/${id}/features` : null);
  const [busy, setBusy] = React.useState(false);
  const [employeeId, setEmployeeId] = React.useState('');
  const [record, setRecord] = React.useState<Record<string, unknown> | null>(null);
  const [recordError, setRecordError] = React.useState<string | null>(null);
  const [acct, setAcct] = React.useState({
    name: '',
    currency: 'GBP',
    entityIds: [] as string[],
    collection: 'send_invoice',
    paymentTermsDays: '30',
    poNumber: '',
  });
  const when = (iso: string) => formatDateTime(iso, locale, 'UTC');

  const run = async (fn: () => Promise<unknown>, ok: string, reload: () => void = d.reload) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setRecord(null);
    setRecordError(null);
    try {
      setRecord(
        await api<Record<string, unknown>>(`/v1/backoffice/tenants/${id}/employees/${employeeId.trim()}`),
      );
    } catch (err) {
      setRecordError(
        err instanceof ApiProblem && err.status === 403
          ? t('backoffice.tenant.noGrant')
          : err instanceof ApiProblem
            ? err.title
            : t('common.error'),
      );
    }
  }

  if (!d.data) return <Skeleton className="h-64 w-full" />;
  const x = d.data;
  const entityName = (eid: string) => x.entities.find((e) => e.id === eid)?.name ?? eid;
  const employee = (record as { employee?: Record<string, unknown> } | null)?.employee ?? record;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/backoffice/tenants" className="inline-flex items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('backoffice.tenants.title')}
      </Link>
      <PageTitle
        title={x.name}
        lead={t('backoffice.tenant.lead', {
          slug: x.slug,
          region: t(`regions.${x.region}`),
          created: when(x.createdAt),
        })}
      >
        <Badge>{x.status}</Badge>
      </PageTitle>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('backoffice.tenant.usage')}</CardTitle>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() =>
              run(
                () => api(`/v1/backoffice/tenants/${id}/usage/refresh`, { method: 'POST' }),
                t('backoffice.tenant.usageRefreshed'),
              )
            }
          >
            <RefreshCw aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('backoffice.tenant.refresh')}
          </Button>
        </div>
        {x.usage ? (
          <dl className="mt-3 grid gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-footnote text-text-secondary">{t('backoffice.tenants.headcount')}</dt>
              <dd className="text-title-3 tabular-nums">{formatNumber(x.usage.headcount, locale)}</dd>
            </div>
            <div>
              <dt className="text-footnote text-text-secondary">{t('backoffice.tenants.activeUsers')}</dt>
              <dd className="text-title-3 tabular-nums">{formatNumber(x.usage.activeUsers, locale)}</dd>
            </div>
            <div>
              <dt className="text-footnote text-text-secondary">{t('backoffice.tenants.storage')}</dt>
              <dd className="text-title-3 tabular-nums">
                {t('backoffice.tenants.mb', {
                  value: formatNumber(x.usage.storageBytes / 1_048_576, locale, { maximumFractionDigits: 1 }),
                })}
              </dd>
            </div>
            <div>
              <dt className="text-footnote text-text-secondary">{t('backoffice.tenant.computedAt')}</dt>
              <dd className="text-callout">{when(x.usage.computedAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('backoffice.tenant.noUsage')}</p>
        )}
        <p className="mt-3 text-footnote text-text-secondary">{t('backoffice.tenant.aggregatesOnly')}</p>
      </Card>

      <Card>
        <CardTitle>{t('backoffice.tenant.supportAccess')}</CardTitle>
        <p className="mt-2 flex items-center gap-2 text-callout">
          <Lock aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {x.grant
            ? t('backoffice.tenant.grantActive', {
                level: t(`backoffice.tenant.level.${x.grant.accessLevel}`),
                until: when(x.grant.expiresAt),
              })
            : t('backoffice.tenant.grantNone')}
        </p>
        <form onSubmit={lookup} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="emp-id" label={t('backoffice.tenant.employeeId')} className="flex-1">
            {(p) => (
              <Input
                {...p}
                required
                pattern="[0-9a-fA-F-]{36}"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="secondary">
            {t('backoffice.tenant.viewRecord')}
          </Button>
        </form>
        <p className="mt-2 text-footnote text-text-secondary">{t('backoffice.tenant.accessLogged')}</p>
        {recordError ? (
          <p role="alert" className="mt-3 text-callout text-danger">
            {recordError}
          </p>
        ) : null}
        {employee ? (
          <dl className="mt-3 grid gap-2 rounded-md bg-surface p-4 text-callout sm:grid-cols-2">
            {Object.entries(employee)
              .filter(([, v]) => v !== null && typeof v !== 'object')
              .slice(0, 24)
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="text-footnote text-text-secondary">{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('backoffice.tenant.billingAccounts')}</CardTitle>
        <p className="mt-1 text-callout text-text-secondary">{t('backoffice.tenant.billingLead')}</p>
        <Table className="mt-3" scrollLabel={t('backoffice.tenant.billingAccounts')}>
          <caption className="sr-only">{t('backoffice.tenant.billingAccounts')}</caption>
          <THead>
            <tr>
              <TH>{t('backoffice.tenant.accountName')}</TH>
              <TH>{t('billing.currency')}</TH>
              <TH>{t('backoffice.tenant.collection')}</TH>
              <TH>{t('billing.po')}</TH>
              <TH>{t('backoffice.tenant.entities')}</TH>
              <TH>{t('billing.plan')}</TH>
            </tr>
          </THead>
          <tbody>
            {x.billingAccounts.map((a) => (
              <TR key={a.id}>
                <TD>
                  {a.name} {a.isDefault ? <Badge>{t('backoffice.tenant.default')}</Badge> : null}{' '}
                  {!a.detailsComplete ? (
                    <Badge tone="warning">{t('backoffice.tenant.detailsMissing')}</Badge>
                  ) : null}
                </TD>
                <TD>{a.currency}</TD>
                <TD>
                  {a.collection === 'send_invoice'
                    ? t('backoffice.tenant.byInvoice', {
                        days: a.paymentTermsDays ?? 0,
                        count: a.paymentTermsDays ?? 0,
                      })
                    : t('backoffice.tenant.byCard')}
                </TD>
                <TD>{a.poNumber ?? '—'}</TD>
                <TD>
                  {a.isDefault && !a.entityIds.length
                    ? t('backoffice.tenant.unassigned')
                    : a.entityIds.map(entityName).join(', ')}
                </TD>
                <TD>
                  {a.subscription
                    ? `${t(`pricing.plans.${a.subscription.planId}.name`)} · ${t(`billing.status.${a.subscription.status}`)} · ${a.subscription.quantity}`
                    : '—'}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
        {staffCan(staff, 'billing') ? (
          <form
            className="mt-5 grid gap-4 md:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`/v1/backoffice/tenants/${id}/billing-accounts`, {
                    method: 'POST',
                    json: {
                      name: acct.name,
                      currency: acct.currency,
                      entityIds: acct.entityIds,
                      collection: acct.collection,
                      paymentTermsDays:
                        acct.collection === 'send_invoice' ? Number(acct.paymentTermsDays) : null,
                      poNumber: acct.poNumber || null,
                    },
                  }),
                t('backoffice.tenant.accountCreated'),
              );
            }}
          >
            <Field id="acct-name" label={t('backoffice.tenant.accountName')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  value={acct.name}
                  onChange={(e) => setAcct({ ...acct, name: e.target.value })}
                />
              )}
            </Field>
            <Field id="acct-currency" label={t('billing.currency')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={acct.currency}
                  onChange={(e) => setAcct({ ...acct, currency: e.target.value })}
                >
                  {['GBP', 'EUR', 'USD'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="acct-collection" label={t('backoffice.tenant.collection')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={acct.collection}
                  onChange={(e) => setAcct({ ...acct, collection: e.target.value })}
                >
                  <option value="send_invoice">{t('backoffice.tenant.invoice')}</option>
                  <option value="charge_automatically">{t('backoffice.tenant.card')}</option>
                </select>
              )}
            </Field>
            <Field id="acct-terms" label={t('backoffice.tenant.paymentTerms')}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={120}
                  value={acct.paymentTermsDays}
                  onChange={(e) => setAcct({ ...acct, paymentTermsDays: e.target.value })}
                />
              )}
            </Field>
            <Field id="acct-po" label={t('billing.po')}>
              {(p) => (
                <Input
                  {...p}
                  value={acct.poNumber}
                  onChange={(e) => setAcct({ ...acct, poNumber: e.target.value })}
                />
              )}
            </Field>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-callout font-semibold">{t('backoffice.tenant.entities')}</legend>
              {x.entities.map((e) => (
                <label key={e.id} className="flex items-center gap-2 text-callout">
                  <input
                    type="checkbox"
                    checked={acct.entityIds.includes(e.id)}
                    onChange={(ev) =>
                      setAcct({
                        ...acct,
                        entityIds: ev.target.checked
                          ? [...acct.entityIds, e.id]
                          : acct.entityIds.filter((v) => v !== e.id),
                      })
                    }
                  />
                  {e.name} ({e.country})
                </label>
              ))}
            </fieldset>
            <div className="md:col-span-3">
              <Button type="submit" loading={busy}>
                {t('backoffice.tenant.addAccount')}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('backoffice.tenant.contracts')}</CardTitle>
        {x.contracts.length ? (
          <ul className="mt-2 flex flex-col gap-1 text-callout">
            {x.contracts.map((c) => (
              <li key={c.id}>
                <Link href="/backoffice/plans">{c.reference}</Link> ·{' '}
                {t(`backoffice.contracts.status.${c.status}`)} · {t(`pricing.plans.${c.planId}.name`)} ·{' '}
                {c.endsOn}{' '}
                {c.renewalDue ? <Badge tone="warning">{t('backoffice.contracts.renewalDue')}</Badge> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('backoffice.tenant.noContracts')}</p>
        )}
      </Card>

      {staffCan(staff) ? (
        <Card>
          <CardTitle>{t('backoffice.flags.title')}</CardTitle>
          <p className="mt-1 text-callout text-text-secondary">{t('backoffice.flags.lead')}</p>
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {(flags.data ?? []).map((f) => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-callout font-semibold">{t(`platform.flags.${f.key}.label`)}</p>
                  <p className="text-footnote text-text-secondary">
                    {t(`platform.flags.${f.key}.description`)} ·{' '}
                    {t(`backoffice.flags.managedBy.${f.managedBy}`)}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-callout">
                  <span className="sr-only">{t(`platform.flags.${f.key}.label`)}</span>
                  <select
                    className={`${selectClass} w-auto`}
                    value={f.overridden ? (f.enabled ? 'on' : 'off') : 'default'}
                    onChange={(e) => {
                      const v = e.target.value;
                      void run(
                        () =>
                          api(`/v1/backoffice/tenants/${id}/features/${f.key}`, {
                            method: 'PUT',
                            json: { enabled: v === 'default' ? null : v === 'on' },
                          }),
                        t('backoffice.flags.saved'),
                        flags.reload,
                      );
                    }}
                  >
                    <option value="default">
                      {t('backoffice.flags.default', {
                        value: f.default ? t('backoffice.flags.on') : t('backoffice.flags.off'),
                      })}
                    </option>
                    <option value="on">{t('backoffice.flags.on')}</option>
                    <option value="off">{t('backoffice.flags.off')}</option>
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
