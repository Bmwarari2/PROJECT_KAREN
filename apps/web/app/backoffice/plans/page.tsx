'use client';
import * as React from 'react';
import { Badge, Button, Card, CardTitle, Field, Input, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { formatDate, formatMoney, numberFormat, type Locale } from '@thapsus/core/i18n';
import { money, parseDecimal } from '@thapsus/core/money';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, selectClass } from '../ui';

interface PlansResp {
  location: string;
  version: number;
  effectiveFrom: string;
  trialDays: number;
  plans: Array<{ id: string; selfServe: boolean; minimumEmployees: number; bands: Array<{ id: string; minEmployees: number; maxEmployees: number; monthlyUnit: Record<string, number> }> }>;
  discounts: { terms: Record<string, number>; codes: Array<{ code: string; basisPoints: number }> };
}
interface Contract {
  id: string;
  tenantId: string;
  slug: string | null;
  reference: string;
  status: string;
  planId: string;
  currency: string;
  term: string;
  startsOn: string;
  endsOn: string;
  renewal: string;
  renewalDue: boolean;
  collection: string;
  paymentTermsDays: number;
  pricing: { unitAmountMinor?: number | null; flatAmountMinor?: number | null; discountBasisPoints?: number | null; minimumEmployees?: number | null };
}
interface TenantRow {
  tenantId: string;
  slug: string;
}

/** Plans (read-only, from the billing config) and enterprise contracts (back-office records; ADR-0107). */
export default function PlansPage() {
  const t = useT();
  const locale = useLocale() as Locale;
  const toast = useToast();
  const plans = useApi<PlansResp>('/v1/backoffice/plans');
  const contracts = useApi<Contract[]>('/v1/backoffice/contracts');
  const tenants = useApi<TenantRow[]>('/v1/backoffice/tenants');
  const [currency, setCurrency] = React.useState('GBP');
  const [busy, setBusy] = React.useState(false);
  const [c, setC] = React.useState({ tenantId: '', reference: '', planId: 'enterprise', currency: 'GBP', term: 'annual', startsOn: '', endsOn: '', renewal: 'manual', renewalNoticeDays: '90', collection: 'send_invoice', paymentTermsDays: '30', mode: 'unit', amount: '', minimumEmployees: '' });
  const pct = (bp: number) => numberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bp / 10_000);
  const fmt = (minor: number, cur: string) => formatMoney(money(BigInt(minor), cur), locale);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      contracts.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const pricing = () => {
    if (c.mode === 'discount') return { discountBasisPoints: Math.round(Number(c.amount) * 100), minimumEmployees: c.minimumEmployees ? Number(c.minimumEmployees) : null };
    const minor = Number(parseDecimal(c.amount || '0', c.currency).amountMinor);
    return { [c.mode === 'flat' ? 'flatAmountMinor' : 'unitAmountMinor']: minor, minimumEmployees: c.minimumEmployees ? Number(c.minimumEmployees) : null };
  };
  const describe = (k: Contract) =>
    k.pricing.flatAmountMinor != null ? t('backoffice.contracts.flat', { amount: fmt(k.pricing.flatAmountMinor, k.currency) }) : k.pricing.unitAmountMinor != null ? t('backoffice.contracts.unit', { amount: fmt(k.pricing.unitAmountMinor, k.currency) }) : t('backoffice.contracts.discount', { percent: pct(k.pricing.discountBasisPoints ?? 0) });

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.plans.title')} lead={plans.data ? t('backoffice.plans.lead', { location: plans.data.location, version: plans.data.version, date: formatDate(plans.data.effectiveFrom, locale) }) : undefined}>
        <label className="flex items-center gap-2 text-callout">
          {t('billing.currency')}
          <select className={`${selectClass} w-auto`} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {['GBP', 'EUR', 'USD'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      </PageTitle>
      {plans.data ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {plans.data.plans.map((p) => (
            <Card key={p.id}>
              <CardTitle>{t(`pricing.plans.${p.id}.name`)}</CardTitle>
              <p className="mt-1 text-footnote text-text-secondary">{p.selfServe ? t('backoffice.plans.selfServe', { min: p.minimumEmployees, count: p.minimumEmployees }) : t('backoffice.plans.contractOnly')}</p>
              {p.bands.length ? (
                <Table dense className="mt-3" scrollLabel={t(`pricing.plans.${p.id}.name`)}>
                  <caption className="sr-only">{t('pricing.bands.caption', { currency })}</caption>
                  <THead>
                    <tr>
                      <TH>{t('pricing.bands.employees')}</TH>
                      <TH>{t('backoffice.plans.monthlyUnit')}</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {p.bands.map((b) => (
                      <TR key={b.id}>
                        <TD>{b.id}</TD>
                        <TD>{fmt(b.monthlyUnit[currency] ?? 0, currency)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              ) : null}
            </Card>
          ))}
        </div>
      ) : null}
      {plans.data ? <p className="text-footnote text-text-secondary">{t('backoffice.plans.discounts', { annual: pct(plans.data.discounts.terms.annual ?? 0), codes: plans.data.discounts.codes.map((d) => `${d.code} (${pct(d.basisPoints)})`).join(', ') || '—', trial: plans.data.trialDays, count: plans.data.trialDays })}</p> : null}

      <section aria-labelledby="contracts-title" className="flex flex-col gap-3">
        <h2 id="contracts-title" className="text-title-3">
          {t('backoffice.contracts.title')}
        </h2>
        <Table scrollLabel={t('admin.tableScroll', { name: t('backoffice.contracts.title') })}>
          <caption className="sr-only">{t('backoffice.contracts.title')}</caption>
          <THead>
            <tr>
              <TH>{t('backoffice.contracts.reference')}</TH>
              <TH>{t('backoffice.tenants.workspace')}</TH>
              <TH>{t('common.status')}</TH>
              <TH>{t('backoffice.contracts.pricing')}</TH>
              <TH>{t('backoffice.contracts.dates')}</TH>
              <TH>{t('backoffice.contracts.invoicing')}</TH>
              <TH>
                <span className="sr-only">{t('common.actions')}</span>
              </TH>
            </tr>
          </THead>
          <tbody>
            {(contracts.data ?? []).map((k) => (
              <TR key={k.id}>
                <TD>{k.reference}</TD>
                <TD>{k.slug ?? k.tenantId}</TD>
                <TD>
                  <Badge tone={k.status === 'active' ? 'success' : 'neutral'}>{t(`backoffice.contracts.status.${k.status}`)}</Badge> {k.renewalDue ? <Badge tone="warning">{t('backoffice.contracts.renewalDue')}</Badge> : null}
                </TD>
                <TD>
                  {t(`pricing.plans.${k.planId}.name`)} · {t(`pricing.term.${k.term}`)} · {describe(k)}
                </TD>
                <TD className="text-footnote">
                  {formatDate(k.startsOn, locale)} – {formatDate(k.endsOn, locale)} · {t(`backoffice.contracts.renewal.${k.renewal}`)}
                </TD>
                <TD className="text-footnote">{k.collection === 'send_invoice' ? t('backoffice.tenant.byInvoice', { days: k.paymentTermsDays, count: k.paymentTermsDays }) : t('backoffice.tenant.byCard')}</TD>
                <TD>
                  {k.status === 'draft' ? (
                    <Button size="sm" loading={busy} onClick={() => run(() => api(`/v1/backoffice/contracts/${k.id}/activate`, { method: 'POST' }), t('backoffice.contracts.activated'))}>
                      {t('backoffice.contracts.activate')}
                    </Button>
                  ) : k.status === 'active' ? (
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => window.confirm(t('backoffice.contracts.endConfirm')) && run(() => api(`/v1/backoffice/contracts/${k.id}/end`, { method: 'POST' }), t('backoffice.contracts.ended'))}>
                      {t('backoffice.contracts.end')}
                    </Button>
                  ) : null}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </section>

      <Card>
        <CardTitle>{t('backoffice.contracts.newTitle')}</CardTitle>
        <p className="mt-1 text-callout text-text-secondary">{t('backoffice.contracts.newLead')}</p>
        <form
          className="mt-4 grid gap-4 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('/v1/backoffice/contracts', { method: 'POST', json: { tenantId: c.tenantId, reference: c.reference, planId: c.planId, currency: c.currency, term: c.term, startsOn: c.startsOn, endsOn: c.endsOn, renewal: c.renewal, renewalNoticeDays: Number(c.renewalNoticeDays), collection: c.collection, paymentTermsDays: Number(c.paymentTermsDays), pricing: pricing() } }),
              t('backoffice.contracts.created'),
            );
          }}
        >
          <Field id="c-tenant" label={t('backoffice.tenants.workspace')}>
            {(p) => (
              <select {...p} required className={selectClass} value={c.tenantId} onChange={(e) => setC({ ...c, tenantId: e.target.value })}>
                <option value="">{t('backoffice.contracts.chooseTenant')}</option>
                {(tenants.data ?? []).map((x) => (
                  <option key={x.tenantId} value={x.tenantId}>
                    {x.slug}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="c-ref" label={t('backoffice.contracts.reference')}>{(p) => <Input {...p} required minLength={3} value={c.reference} onChange={(e) => setC({ ...c, reference: e.target.value })} />}</Field>
          <Field id="c-plan" label={t('billing.plan')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.planId} onChange={(e) => setC({ ...c, planId: e.target.value })}>
                {(plans.data?.plans ?? []).map((x) => <option key={x.id} value={x.id}>{t(`pricing.plans.${x.id}.name`)}</option>)}
              </select>
            )}
          </Field>
          <Field id="c-currency" label={t('billing.currency')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.currency} onChange={(e) => setC({ ...c, currency: e.target.value })}>
                {['GBP', 'EUR', 'USD'].map((x) => <option key={x}>{x}</option>)}
              </select>
            )}
          </Field>
          <Field id="c-term" label={t('billing.term')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.term} onChange={(e) => setC({ ...c, term: e.target.value })}>
                {['annual', 'monthly'].map((x) => <option key={x} value={x}>{t(`pricing.term.${x}`)}</option>)}
              </select>
            )}
          </Field>
          <Field id="c-start" label={t('backoffice.contracts.startsOn')}>{(p) => <Input {...p} type="date" required value={c.startsOn} onChange={(e) => setC({ ...c, startsOn: e.target.value })} />}</Field>
          <Field id="c-end" label={t('backoffice.contracts.endsOn')}>{(p) => <Input {...p} type="date" required value={c.endsOn} onChange={(e) => setC({ ...c, endsOn: e.target.value })} />}</Field>
          <Field id="c-renewal" label={t('backoffice.contracts.renewalLabel')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.renewal} onChange={(e) => setC({ ...c, renewal: e.target.value })}>
                {['manual', 'auto', 'none'].map((x) => <option key={x} value={x}>{t(`backoffice.contracts.renewal.${x}`)}</option>)}
              </select>
            )}
          </Field>
          <Field id="c-notice" label={t('backoffice.contracts.renewalNotice')}>{(p) => <Input {...p} type="number" min={0} max={365} value={c.renewalNoticeDays} onChange={(e) => setC({ ...c, renewalNoticeDays: e.target.value })} />}</Field>
          <Field id="c-collection" label={t('backoffice.tenant.collection')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.collection} onChange={(e) => setC({ ...c, collection: e.target.value })}>
                <option value="send_invoice">{t('backoffice.tenant.invoice')}</option>
                <option value="charge_automatically">{t('backoffice.tenant.card')}</option>
              </select>
            )}
          </Field>
          <Field id="c-terms" label={t('backoffice.tenant.paymentTerms')}>{(p) => <Input {...p} type="number" min={1} max={120} value={c.paymentTermsDays} onChange={(e) => setC({ ...c, paymentTermsDays: e.target.value })} />}</Field>
          <Field id="c-mode" label={t('backoffice.contracts.pricingMode')}>
            {(p) => (
              <select {...p} className={selectClass} value={c.mode} onChange={(e) => setC({ ...c, mode: e.target.value })}>
                {['unit', 'flat', 'discount'].map((x) => <option key={x} value={x}>{t(`backoffice.contracts.mode.${x}`)}</option>)}
              </select>
            )}
          </Field>
          <Field id="c-amount" label={c.mode === 'discount' ? t('backoffice.contracts.percentOff') : t('backoffice.contracts.amount', { currency: c.currency })}>
            {(p) => <Input {...p} required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} />}
          </Field>
          <Field id="c-min" label={t('backoffice.contracts.minimumEmployees')}>{(p) => <Input {...p} type="number" min={0} value={c.minimumEmployees} onChange={(e) => setC({ ...c, minimumEmployees: e.target.value })} />}</Field>
          <div className="md:col-span-3">
            <Button type="submit" loading={busy}>
              {t('backoffice.contracts.create')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
