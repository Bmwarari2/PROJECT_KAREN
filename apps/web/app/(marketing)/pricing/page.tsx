import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import {
  BILLING_CURRENCIES,
  isBillingCurrency,
  loadBillingConfig,
  quote,
  type BillingCurrency,
  type Plan,
  type Term,
} from '@thapsus/core/billing';
import { formatMoney, numberFormat } from '@thapsus/core/i18n';
import { multiplyRatio } from '@thapsus/core/money';
import { Badge, buttonVariants, Card, Section, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

/**
 * Public price list, rendered from the versioned billing configuration (ADR-0100): plans, headcount
 * bands, per-currency prices, terms, discounts, trial and notice periods. No price lives in this file.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('pricing.meta.title'), description: t('pricing.meta.description') };
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ term?: string; currency?: string }>;
}) {
  const { t, locale } = await serverContext();
  const cfg = loadBillingConfig(process.env.BILLING_CONFIG_LOCATION ?? 'builtin:billing-config-v1');
  const q = await searchParams;
  const term: Term = q.term === 'annual' ? 'annual' : 'monthly';
  const currency: BillingCurrency = isBillingCurrency(q.currency)
    ? q.currency
    : locale === 'en-US'
      ? 'USD'
      : 'GBP';
  const selfServe = cfg.plans.filter((p) => p.selfServe);
  const enterprise = cfg.plans.filter((p) => !p.selfServe);
  const percent = (bp: number) =>
    numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10_000);
  const months = cfg.terms[term].months;
  /** Price per employee per month (the monthly equivalent for annual terms), from config. */
  const perEmployeeMonth = (plan: Plan, minEmployees: number) => {
    const qq = quote(cfg, { planId: plan.id, term, currency, headcount: minEmployees });
    return formatMoney(multiplyRatio(qq.unitAmount, 1, months), locale);
  };
  const href = (o: { term?: Term; currency?: BillingCurrency }) =>
    `/pricing?term=${o.term ?? term}&currency=${o.currency ?? currency}`;
  const domain = process.env.THAPSUS_HR_DOMAIN ?? 'thapsus-hr.localhost';
  const toggle = 'rounded-pill px-4 py-1.5 text-callout font-semibold no-underline';

  return (
    <>
      <Section tone="bg" className="pt-16 md:pt-24" labelledBy="pricing-title">
        <div className="flex flex-col items-center text-center">
          <Badge tone="accent">
            {t('pricing.trialBadge', { days: cfg.trial.days, count: cfg.trial.days })}
          </Badge>
          <h1 id="pricing-title" className="mt-5 max-w-[18ch] text-title-1 md:text-headline">
            {t('pricing.title')}
          </h1>
          <p className="mt-5 max-w-[var(--prose-width)] text-body-lg text-text-secondary">
            {t('pricing.lead')}
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row">
            <nav aria-label={t('pricing.termLabel')} className="inline-flex rounded-pill bg-surface p-1">
              {(['monthly', 'annual'] as const).map((tm) => (
                <Link
                  key={tm}
                  href={href({ term: tm })}
                  aria-current={tm === term ? 'true' : undefined}
                  className={`${toggle} ${tm === term ? 'bg-surface-raised text-text shadow-sm' : 'text-text-secondary'}`}
                >
                  {tm === 'annual' && cfg.discounts.terms.annual > 0
                    ? t('pricing.term.annualSave', { percent: percent(cfg.discounts.terms.annual) })
                    : t(`pricing.term.${tm}`)}
                </Link>
              ))}
            </nav>
            <nav aria-label={t('pricing.currencyLabel')} className="inline-flex rounded-pill bg-surface p-1">
              {BILLING_CURRENCIES.filter((c) => cfg.currencies.includes(c)).map((c) => (
                <Link
                  key={c}
                  href={href({ currency: c })}
                  aria-current={c === currency ? 'true' : undefined}
                  className={`${toggle} ${c === currency ? 'bg-surface-raised text-text shadow-sm' : 'text-text-secondary'}`}
                >
                  {c}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        <ul className="mt-12 grid gap-6 md:grid-cols-3" aria-label={t('pricing.plansLabel')}>
          {selfServe.map((plan) => (
            <li key={plan.id}>
              <Card size="marketing" className="flex h-full flex-col">
                <h2 className="text-title-2">{t(`pricing.plans.${plan.id}.name`)}</h2>
                <p className="mt-2 text-callout text-text-secondary">
                  {t(`pricing.plans.${plan.id}.summary`)}
                </p>
                <p className="mt-6">
                  <span className="text-footnote text-text-secondary">{t('pricing.from')} </span>
                  <span className="text-title-1 tabular-nums">
                    {perEmployeeMonth(plan, plan.bands[0]!.minEmployees)}
                  </span>
                </p>
                <p className="text-footnote text-text-secondary">
                  {t('pricing.perEmployeeMonth')} · {t(`pricing.billed.${term}`)}
                </p>
                <p className="mt-1 text-footnote text-text-secondary">
                  {t('pricing.minimum', { count: plan.minimumEmployees })}
                </p>
                <ul className="mt-6 flex flex-1 flex-col gap-2 text-callout">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5] text-accent" />
                      {t(`pricing.features.${f}`)}
                    </li>
                  ))}
                </ul>
                <Link href="/signup" className={`${buttonVariants({ size: 'lg' })} mt-8 no-underline`}>
                  {t('pricing.cta', { days: cfg.trial.days })}
                </Link>
              </Card>
            </li>
          ))}
          {enterprise.map((plan) => (
            <li key={plan.id}>
              <Card size="marketing" className="flex h-full flex-col bg-surface-inverse text-text-inverse">
                <h2 className="text-title-2">{t(`pricing.plans.${plan.id}.name`)}</h2>
                <p className="mt-2 text-callout opacity-80">{t(`pricing.plans.${plan.id}.summary`)}</p>
                <p className="mt-6 text-title-1">{t('pricing.custom')}</p>
                <p className="text-footnote opacity-80">{t('pricing.enterpriseTerms')}</p>
                <ul className="mt-6 flex flex-1 flex-col gap-2 text-callout">
                  {['sso', 'scim', 'api', 'dedicatedDatabase', 'multiEntityBilling']
                    .filter((f) => plan.features.includes(f))
                    .map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
                        {t(`pricing.features.${f}`)}
                      </li>
                    ))}
                </ul>
                <a
                  href={`mailto:sales@${domain}`}
                  className={`${buttonVariants({ size: 'lg', variant: 'secondary' })} mt-8 no-underline`}
                >
                  {t('pricing.contactSales')}
                </a>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="surface" labelledBy="bands-title">
        <h2 id="bands-title" className="text-title-1">
          {t('pricing.bands.title')}
        </h2>
        <p className="mt-3 max-w-[var(--prose-width)] text-body text-text-secondary">
          {t('pricing.bands.lead', { term: t(`pricing.billed.${term}`) })}
        </p>
        <div className="mt-8">
          <Table>
            <caption className="sr-only">{t('pricing.bands.caption', { currency })}</caption>
            <THead>
              <tr>
                <TH>{t('pricing.bands.employees')}</TH>
                {selfServe.map((p) => (
                  <TH key={p.id}>{t(`pricing.plans.${p.id}.name`)}</TH>
                ))}
              </tr>
            </THead>
            <tbody>
              {selfServe[0]!.bands.map((b) => (
                <TR key={b.id}>
                  <TD>
                    {t('pricing.bands.range', {
                      min: numberFormat(locale).format(b.minEmployees),
                      max: numberFormat(locale).format(b.maxEmployees),
                    })}
                  </TD>
                  {selfServe.map((p) => (
                    <TD key={p.id}>{perEmployeeMonth(p, b.minEmployees)}</TD>
                  ))}
                </TR>
              ))}
              <TR>
                <TD>
                  {t('pricing.bands.more', {
                    min: numberFormat(locale).format(selfServe[0]!.bands.at(-1)!.maxEmployees + 1),
                  })}
                </TD>
                <TD colSpan={selfServe.length}>{t('pricing.custom')}</TD>
              </TR>
            </tbody>
          </Table>
        </div>
      </Section>

      <Section tone="bg" labelledBy="terms-title">
        <h2 id="terms-title" className="text-title-1">
          {t('pricing.terms.title')}
        </h2>
        <dl className="mt-8 grid gap-6 md:grid-cols-2">
          {[
            ['trial', { days: cfg.trial.days, count: cfg.trial.days }],
            [
              'monthly',
              {
                days: cfg.terms.monthly.cancellationNoticeDays,
                count: cfg.terms.monthly.cancellationNoticeDays,
              },
            ],
            [
              'annual',
              {
                days: cfg.terms.annual.cancellationNoticeDays,
                count: cfg.terms.annual.cancellationNoticeDays,
                percent: percent(cfg.discounts.terms.annual),
              },
            ],
            ['changes', {}],
            ['tax', {}],
            ['currency', {}],
          ].map(([k, vars]) => (
            <div key={k as string}>
              <dt className="text-title-3">{t(`pricing.terms.${k}.title`)}</dt>
              <dd className="mt-2 text-body text-text-secondary">
                {t(`pricing.terms.${k}.body`, vars as Record<string, string | number>)}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
