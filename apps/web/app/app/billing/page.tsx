'use client';
import * as React from 'react';
import { CreditCard, FileText, Receipt } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
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
import { formatDate, formatDateTime, formatMoney, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageIntro, useInModule } from '@/components/module-page';
import { useSession } from '../shell';

interface MoneyT {
  amountMinor: number;
  currency: string;
}
interface Sub {
  id: string;
  planId: string;
  term: string;
  currency: string;
  status: string;
  source: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  quantity: number;
  bandId: string | null;
  intervalAmount: MoneyT;
  pendingChange: { kind: string; planId: string; term: string; effectiveAt: string } | null;
  cancelEffectiveAt: string | null;
  hasProviderSubscription: boolean;
}
interface Account {
  id: string;
  name: string;
  isDefault: boolean;
  currency: string;
  address: Record<string, string | null | undefined>;
  companyTaxId: string | null;
  companyTaxIdType: string | null;
  poNumber: string | null;
  collection: string;
  paymentTermsDays: number | null;
  hasPaymentMethod: boolean;
  detailsComplete: boolean;
  headcount: number;
  contacts: Array<{ id: string; name: string; email: string; isPrimary: boolean }>;
  subscription: Sub | null;
}
interface Billing {
  region: string;
  accounts: Account[];
  contract: {
    reference: string;
    planId: string;
    term: string;
    currency: string;
    startsOn: string;
    endsOn: string;
    renewal: string;
    collection: string;
    paymentTermsDays: number;
  } | null;
  selfServe: boolean;
}
interface Plans {
  currencies: string[];
  trialDays: number;
  terms: Record<string, { cancellationNoticeDays: number; discountBasisPoints: number }>;
  plans: Array<{ id: string; selfServe: boolean }>;
}
interface Preview {
  kind: string;
  effectiveAt: string;
  quote: {
    quantity: number;
    bandId: string | null;
    unitAmount: MoneyT;
    totalAmount: MoneyT;
    discountAmount: MoneyT;
    interval: string;
  };
  proration: { net: MoneyT } | null;
}
interface Invoice {
  id: string;
  number: string | null;
  status: string;
  total: MoneyT;
  amountDue: MoneyT;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  hostedUrl: string | null;
  poNumber: string | null;
}

const selectClass =
  'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

export default function BillingPage() {
  const t = useT();
  const inModule = useInModule();
  const locale = useLocale() as Locale;
  const session = useSession();
  const toast = useToast();
  const billing = useApi<Billing>('/v1/billing');
  const plans = useApi<Plans>('/v1/billing/plans');
  const invoices = useApi<Invoice[]>('/v1/billing/invoices');
  const tz = session?.timeZone ?? 'UTC';
  const fmt = (m: MoneyT) => formatMoney(money(BigInt(m.amountMinor), m.currency), locale);
  const when = (iso: string) => formatDateTime(iso, locale, tz);
  const def = billing.data?.accounts.find((a) => a.isDefault);
  const sub = def?.subscription ?? null;
  const live = !!sub?.hasProviderSubscription;
  const [target, setTarget] = React.useState({
    planId: 'core',
    term: 'monthly',
    currency: '',
    discountCode: '',
  });
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (def && !target.currency)
      setTarget((s) => ({
        ...s,
        currency: sub?.hasProviderSubscription ? sub.currency : def.currency,
        planId: sub?.hasProviderSubscription ? sub.planId : s.planId,
        term: sub?.hasProviderSubscription ? sub.term : s.term,
      }));
  }, [def, sub, target.currency]);
  React.useEffect(() => {
    if (!target.currency || !billing.data?.selfServe) return;
    let cancelled = false;
    api<Preview>('/v1/billing/quote', {
      method: 'POST',
      json: {
        planId: target.planId,
        term: target.term,
        currency: target.currency,
        discountCode: target.discountCode || null,
      },
    })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [target, billing.data?.selfServe, sub?.planId, sub?.term]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      billing.reload();
      invoices.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (billing.error?.status === 403)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<CreditCard aria-hidden />}
        title={t('billing.ownersOnly')}
      />
    );
  if (!billing.data || !plans.data || !def) return <Skeleton className="h-64 w-full" />;
  const b = billing.data;
  const planName = (id: string) => t(`pricing.plans.${id}.name`);

  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('billing.title')}
        titleIsTab
        lead={t('billing.regionNote', { region: t(`regions.${b.region}`) })}
      />

      {b.contract ? (
        <Card>
          <CardTitle>{t('billing.contractTitle')}</CardTitle>
          <p className="mt-2 text-callout">
            {t('billing.contractBody', {
              reference: b.contract.reference,
              plan: planName(b.contract.planId),
              start: formatDate(b.contract.startsOn, locale),
              end: formatDate(b.contract.endsOn, locale),
              days: b.contract.paymentTermsDays,
              count: b.contract.paymentTermsDays,
            })}
          </p>
        </Card>
      ) : null}

      {b.accounts.map((a) => (
        <Card key={a.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              {a.isDefault && b.accounts.length === 1 ? t('billing.subscriptionTitle') : a.name}
            </CardTitle>
            {a.subscription ? (
              <Badge
                tone={
                  a.subscription.status === 'past_due'
                    ? 'danger'
                    : a.subscription.status === 'active' || a.subscription.status === 'trialing'
                      ? 'success'
                      : 'neutral'
                }
              >
                {t(`billing.status.${a.subscription.status}`)}
              </Badge>
            ) : null}
          </div>
          {a.subscription ? (
            <dl
              className="mt-4 grid gap-3 text-callout sm:grid-cols-2 lg:grid-cols-4"
              data-testid={`subscription-${a.isDefault ? 'default' : a.id}`}
            >
              <div>
                <dt className="text-footnote text-text-secondary">{t('billing.plan')}</dt>
                <dd className="font-semibold" data-testid="current-plan">
                  {planName(a.subscription.planId)}
                </dd>
              </div>
              <div>
                <dt className="text-footnote text-text-secondary">{t('billing.term')}</dt>
                <dd>{t(`pricing.term.${a.subscription.term}`)}</dd>
              </div>
              <div>
                <dt className="text-footnote text-text-secondary">{t('billing.headcount')}</dt>
                <dd>
                  {t('billing.headcountValue', { billed: a.subscription.quantity, active: a.headcount })}
                </dd>
              </div>
              <div>
                <dt className="text-footnote text-text-secondary">{t('billing.amount')}</dt>
                <dd>
                  {a.subscription.hasProviderSubscription
                    ? t(`billing.perInterval.${a.subscription.term}`, {
                        amount: fmt(a.subscription.intervalAmount),
                      })
                    : t('billing.free')}
                </dd>
              </div>
              {a.subscription.status === 'trialing' && a.subscription.trialEndsAt ? (
                <div className="sm:col-span-2">
                  <dt className="text-footnote text-text-secondary">{t('billing.trialEnds')}</dt>
                  <dd>{when(a.subscription.trialEndsAt)}</dd>
                </div>
              ) : null}
              {a.subscription.currentPeriodEnd && a.subscription.hasProviderSubscription ? (
                <div className="sm:col-span-2">
                  <dt className="text-footnote text-text-secondary">{t('billing.renews')}</dt>
                  <dd>{when(a.subscription.currentPeriodEnd)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {a.subscription?.pendingChange ? (
            <p className="mt-4 text-callout text-text-secondary" role="status">
              {t('billing.pending', {
                plan: planName(a.subscription.pendingChange.planId),
                term: t(`pricing.term.${a.subscription.pendingChange.term}`),
                date: when(a.subscription.pendingChange.effectiveAt),
              })}
            </p>
          ) : null}
          {a.subscription?.cancelEffectiveAt ? (
            <div className="mt-4 flex flex-wrap items-center gap-3" role="status">
              <p className="text-callout text-warning">
                {t('billing.cancelling', { date: when(a.subscription.cancelEffectiveAt) })}
              </p>
              {b.selfServe ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() =>
                    run(
                      () => api('/v1/billing/subscription/reactivate', { method: 'POST' }),
                      t('billing.reactivated'),
                    )
                  }
                >
                  {t('billing.reactivate')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {a.collection === 'send_invoice' ? (
            <p className="mt-3 text-footnote text-text-secondary">
              {t('billing.invoiceCollection', {
                days: a.paymentTermsDays ?? 0,
                count: a.paymentTermsDays ?? 0,
                po: a.poNumber ?? '—',
              })}
            </p>
          ) : null}
          <BillingDetails account={a} onSaved={() => billing.reload()} />
        </Card>
      ))}

      {b.selfServe ? (
        <Card>
          <CardTitle>{live ? t('billing.changeTitle') : t('billing.chooseTitle')}</CardTitle>
          <p className="mt-1 text-callout text-text-secondary">
            {live
              ? t('billing.changeRules')
              : t('billing.chooseLead', { days: plans.data.trialDays, count: plans.data.trialDays })}
          </p>
          <form
            className="mt-4 grid gap-4 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  live
                    ? api('/v1/billing/subscription/change', {
                        method: 'POST',
                        json: { planId: target.planId, term: target.term },
                      })
                    : api('/v1/billing/subscription', {
                        method: 'POST',
                        json: {
                          planId: target.planId,
                          term: target.term,
                          currency: target.currency,
                          discountCode: target.discountCode || null,
                        },
                      }),
                live ? t('billing.changed') : t('billing.started'),
              );
            }}
          >
            <Field id="b-plan" label={t('billing.plan')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={target.planId}
                  onChange={(e) => setTarget({ ...target, planId: e.target.value })}
                >
                  {plans
                    .data!.plans.filter((x) => x.selfServe)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {planName(x.id)}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field id="b-term" label={t('billing.term')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={target.term}
                  onChange={(e) => setTarget({ ...target, term: e.target.value })}
                >
                  {['monthly', 'annual'].map((x) => (
                    <option key={x} value={x}>
                      {t(`pricing.term.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              id="b-currency"
              label={t('billing.currency')}
              hint={live ? t('billing.currencyLocked') : undefined}
            >
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={target.currency}
                  disabled={live}
                  onChange={(e) => setTarget({ ...target, currency: e.target.value })}
                >
                  {plans.data!.currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {!live ? (
              <Field id="b-code" label={t('billing.discountCode')}>
                {(p) => (
                  <Input
                    {...p}
                    value={target.discountCode}
                    onChange={(e) => setTarget({ ...target, discountCode: e.target.value })}
                  />
                )}
              </Field>
            ) : null}
            <div className="md:col-span-4" aria-live="polite" data-testid="quote">
              {preview ? (
                <div className="rounded-md bg-surface p-4 text-callout">
                  <p className="font-semibold">
                    {t(`billing.perInterval.${target.term}`, { amount: fmt(preview.quote.totalAmount) })}
                  </p>
                  <p className="text-text-secondary">
                    {t('billing.quoteLine', {
                      unit: fmt(preview.quote.unitAmount),
                      quantity: preview.quote.quantity,
                    })}{' '}
                    {t('billing.taxNote')}
                  </p>
                  {live ? (
                    <p className="mt-1">
                      {preview.kind === 'none'
                        ? t('billing.noChange')
                        : ['upgrade', 'term_upgrade'].includes(preview.kind) || sub?.status === 'trialing'
                          ? preview.proration
                            ? t('billing.nowProrated', { amount: fmt(preview.proration.net) })
                            : t('billing.now')
                          : t('billing.atPeriodEnd', { date: when(preview.effectiveAt) })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="md:col-span-4 flex flex-wrap gap-3">
              <Button
                type="submit"
                loading={busy}
                disabled={!def.detailsComplete || (live && preview?.kind === 'none')}
              >
                {live ? t('billing.applyChange') : t('billing.start')}
              </Button>
              {!def.detailsComplete ? (
                <p className="text-footnote text-text-secondary">{t('billing.detailsFirst')}</p>
              ) : null}
            </div>
          </form>
          {live ? (
            <div className="mt-6 flex flex-wrap gap-3 border-t border-border pt-4">
              <Button
                variant="secondary"
                loading={busy}
                onClick={() =>
                  run(async () => {
                    const { url } = await api<{ url: string }>('/v1/billing/payment-method', {
                      method: 'POST',
                      json: {},
                    });
                    window.location.assign(url);
                  }, t('billing.redirecting'))
                }
              >
                <CreditCard aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {def.hasPaymentMethod ? t('billing.updateCard') : t('billing.addCard')}
              </Button>
              {!sub?.cancelEffectiveAt ? (
                <Button
                  variant="ghost"
                  loading={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        t('billing.cancelConfirm', {
                          days: plans.data!.terms[sub?.term ?? 'monthly']?.cancellationNoticeDays ?? 0,
                        }),
                      )
                    )
                      void run(
                        () => api('/v1/billing/subscription/cancel', { method: 'POST' }),
                        t('billing.cancelled'),
                      );
                  }}
                >
                  {t('billing.cancel')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <section aria-labelledby="inv-title" className="flex flex-col gap-3">
        <h2 id="inv-title" className="text-title-3">
          {t('billing.invoices')}
        </h2>
        {invoices.data && invoices.data.length === 0 ? (
          <EmptyState level={3} icon={<Receipt aria-hidden />} title={t('billing.noInvoices')} />
        ) : (
          <Table>
            <caption className="sr-only">{t('billing.invoices')}</caption>
            <THead>
              <tr>
                <TH>{t('billing.invoiceNumber')}</TH>
                <TH>{t('billing.period')}</TH>
                <TH>{t('billing.total')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>{t('billing.po')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {(invoices.data ?? []).map((i) => (
                <TR key={i.id}>
                  <TD>{i.number ?? '—'}</TD>
                  <TD className="text-footnote">
                    {i.periodStart && i.periodEnd ? `${when(i.periodStart)} – ${when(i.periodEnd)}` : '—'}
                  </TD>
                  <TD>{fmt(i.total)}</TD>
                  <TD>{t(`billing.invoiceStatus.${i.status}`)}</TD>
                  <TD>{i.poNumber ?? '—'}</TD>
                  <TD>
                    {i.hostedUrl ? (
                      <a
                        href={i.hostedUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                        className="inline-flex items-center gap-1"
                      >
                        <FileText aria-hidden className="h-4 w-4 stroke-[1.5]" />
                        {t('billing.view')}
                      </a>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

function BillingDetails({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = React.useState(!account.detailsComplete);
  const primary = account.contacts.find((c) => c.isPrimary);
  const second = account.contacts.find((c) => !c.isPrimary);
  const [f, setF] = React.useState({
    name: account.name,
    line1: account.address.line1 ?? '',
    line2: account.address.line2 ?? '',
    city: account.address.city ?? '',
    region: account.address.region ?? '',
    postalCode: account.address.postalCode ?? '',
    country: account.address.country ?? '',
    taxType: account.companyTaxIdType ?? '',
    taxValue: account.companyTaxId ?? '',
    contactName: primary?.name ?? '',
    contactEmail: primary?.email ?? '',
    otherName: second?.name ?? '',
    otherEmail: second?.email ?? '',
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const contacts = [
        { name: f.contactName, email: f.contactEmail, isPrimary: true },
        ...(f.otherName && f.otherEmail
          ? [{ name: f.otherName, email: f.otherEmail, isPrimary: false }]
          : []),
      ];
      await api(`/v1/billing/accounts/${account.id}/details`, {
        method: 'PUT',
        json: {
          name: f.name,
          address: {
            line1: f.line1,
            line2: f.line2 || null,
            city: f.city,
            region: f.region || null,
            postalCode: f.postalCode,
            country: f.country.toUpperCase(),
          },
          companyTaxId: f.taxType && f.taxValue ? { type: f.taxType, value: f.taxValue } : null,
          contacts,
        },
      });
      toast({ title: t('billing.detailsSaved'), tone: 'success' });
      setOpen(false);
      onSaved();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  const id = (k: string) => `${account.id.slice(0, 8)}-${k}`;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <Button variant="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('billing.detailsTitle')}
      </Button>
      {open ? (
        <form onSubmit={save} className="mt-3 grid gap-4 md:grid-cols-2">
          <Field id={id('name')} label={t('billing.companyName')}>
            {(p) => <Input {...p} required value={f.name} onChange={set('name')} />}
          </Field>
          <Field id={id('line1')} label={t('billing.addressLine1')}>
            {(p) => (
              <Input {...p} required value={f.line1} onChange={set('line1')} autoComplete="address-line1" />
            )}
          </Field>
          <Field id={id('line2')} label={t('billing.addressLine2')}>
            {(p) => <Input {...p} value={f.line2} onChange={set('line2')} autoComplete="address-line2" />}
          </Field>
          <Field id={id('city')} label={t('billing.city')}>
            {(p) => (
              <Input {...p} required value={f.city} onChange={set('city')} autoComplete="address-level2" />
            )}
          </Field>
          <Field id={id('region')} label={t('billing.region')}>
            {(p) => <Input {...p} value={f.region} onChange={set('region')} autoComplete="address-level1" />}
          </Field>
          <Field id={id('postal')} label={t('billing.postalCode')}>
            {(p) => (
              <Input
                {...p}
                required
                value={f.postalCode}
                onChange={set('postalCode')}
                autoComplete="postal-code"
              />
            )}
          </Field>
          <Field id={id('country')} label={t('billing.country')} hint={t('billing.countryHint')}>
            {(p) => (
              <Input
                {...p}
                required
                pattern="[A-Za-z]{2}"
                maxLength={2}
                value={f.country}
                onChange={set('country')}
                autoComplete="country"
              />
            )}
          </Field>
          <Field id={id('taxType')} label={t('billing.taxIdType')} hint={t('billing.taxIdTypeHint')}>
            {(p) => <Input {...p} value={f.taxType} onChange={set('taxType')} />}
          </Field>
          <Field id={id('taxValue')} label={t('billing.taxId')}>
            {(p) => <Input {...p} value={f.taxValue} onChange={set('taxValue')} />}
          </Field>
          <Field id={id('cname')} label={t('billing.contactName')}>
            {(p) => (
              <Input
                {...p}
                required
                value={f.contactName}
                onChange={set('contactName')}
                autoComplete="name"
              />
            )}
          </Field>
          <Field id={id('cemail')} label={t('billing.contactEmail')} hint={t('billing.contactHint')}>
            {(p) => (
              <Input
                {...p}
                required
                type="email"
                value={f.contactEmail}
                onChange={set('contactEmail')}
                autoComplete="email"
              />
            )}
          </Field>
          <Field id={id('oname')} label={t('billing.otherContactName')}>
            {(p) => <Input {...p} value={f.otherName} onChange={set('otherName')} />}
          </Field>
          <Field id={id('oemail')} label={t('billing.otherContactEmail')}>
            {(p) => <Input {...p} type="email" value={f.otherEmail} onChange={set('otherEmail')} />}
          </Field>
          <p className="text-footnote text-text-secondary md:col-span-2">{t('billing.stripeNote')}</p>
          <div className="md:col-span-2">
            <Button type="submit" loading={busy}>
              {t('billing.saveDetails')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
