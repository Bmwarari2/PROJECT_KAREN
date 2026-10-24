'use client';
import * as React from 'react';
import { FileText, Receipt } from 'lucide-react';
import { EmptyState, ListItem, ListSection, ListValue, Skeleton } from '@thapsus/ui';
import { formatDate, formatMoney, formatMonthYear } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';

export interface MyPayslip {
  id: string;
  kind: 'payslip' | 'year_end';
  docType: string;
  label: string;
  payDate: string | null;
  taxYear: string | null;
  publishedAt: string;
  viewed: boolean;
  hasStatement: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  grossMinor: string | null;
  netMinor: string | null;
  providerName: string | null;
  sample: boolean;
  ytd: Array<{ key: string; label: string; amountMinor: string }> | null;
  ytdTaxYear: string | null;
}

type T = (k: string, v?: Record<string, string | number>) => string;

/** A payslip's name: the month for a monthly statement, its dates otherwise, or the label payroll gave it. */
export function payslipName(
  p: Pick<MyPayslip, 'periodStart' | 'periodEnd' | 'label'>,
  locale: 'en-GB' | 'en-US',
) {
  if (!p.periodStart || !p.periodEnd) return p.label;
  const whole =
    p.periodStart.slice(8) === '01' &&
    p.periodEnd.slice(0, 7) === p.periodStart.slice(0, 7) &&
    Number(p.periodEnd.slice(8)) >= 28;
  return whole
    ? formatMonthYear(p.periodStart, locale)
    : `${formatDate(p.periodStart, locale)} – ${formatDate(p.periodEnd, locale)}`;
}
export const amount = (minor: string | number, currency: string, locale: 'en-GB' | 'en-US') =>
  formatMoney(money(BigInt(minor), currency), locale);
export const yearOf = (p: Pick<MyPayslip, 'payDate' | 'publishedAt'>) =>
  (p.payDate ?? p.publishedAt).slice(0, 4);

/**
 * The employee's payslips (ADR-0167): one year at a time, newest first, each row opening the payslip, with the
 * year-to-date figures as the payroll provider printed them on the latest payslip of that year.
 */
export function MyPayslips() {
  const t = useT() as T;
  const locale = useLocale();
  const mine = useApi<MyPayslip[]>('/v1/me/payslips');
  const years = [...new Set((mine.data ?? []).map(yearOf))].sort().reverse();
  const [year, setYear] = React.useState<string>('');
  const shownYear = year || years[0] || '';
  if (!mine.data) return <Skeleton className="h-48 w-full" />;
  if (!mine.data.length)
    return (
      <EmptyState
        level={3}
        icon={<FileText aria-hidden />}
        title={t('payslips.none')}
        body={t('payslips.noneBody')}
      />
    );
  const inYear = mine.data.filter((p) => yearOf(p) === shownYear);
  const slips = inYear.filter((p) => p.kind === 'payslip');
  const yearEnd = mine.data.filter((p) => p.kind === 'year_end');
  const latest = slips.find((p) => p.ytd?.length && p.currency);
  const yearPicker =
    years.length > 1 ? (
      <label className="flex items-center gap-2 text-callout text-text-secondary">
        {t('payslipView.year')}
        <select
          value={shownYear}
          onChange={(e) => setYear(e.target.value)}
          className="h-11 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <ListSection title={shownYear} action={yearPicker} headingLevel={2} id="payslips-year">
        {slips.map((p) => (
          <ListItem
            key={p.id}
            href={`/app/payslips/${p.id}`}
            linkAs={IntentLink}
            leading={<Receipt />}
            unread={!p.viewed}
            unreadLabel={t('payslips.new')}
            title={payslipName(p, locale)}
            subtitle={[
              p.payDate ? t('payslipView.paidOn', { date: formatDate(p.payDate, locale) }) : null,
              p.sample ? t('payslipView.sampleMarker') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            meta={
              p.netMinor && p.currency ? (
                <span className="text-callout font-semibold text-text">
                  {amount(p.netMinor, p.currency, locale)}
                </span>
              ) : undefined
            }
          />
        ))}
      </ListSection>
      {latest ? (
        <ListSection
          title={t('payslipView.ytdTitle')}
          description={t('payslipView.ytdAsOf', {
            date: formatDate(latest.payDate ?? latest.publishedAt.slice(0, 10), locale),
            year: latest.ytdTaxYear ?? shownYear,
            provider: latest.providerName ?? '',
          })}
          headingLevel={2}
          id="payslips-ytd"
        >
          {latest.ytd!.map((y) => (
            <ListItem
              key={y.key + y.label}
              title={y.label}
              accessory={<ListValue>{amount(y.amountMinor, latest.currency!, locale)}</ListValue>}
            />
          ))}
        </ListSection>
      ) : null}
      {yearEnd.length ? (
        <ListSection title={t('payslipView.yearEnd')} headingLevel={2} id="payslips-year-end">
          {yearEnd.map((p) => (
            <ListItem
              key={p.id}
              href={`/app/payslips/${p.id}`}
              linkAs={IntentLink}
              leading={<FileText />}
              unread={!p.viewed}
              unreadLabel={t('payslips.new')}
              title={`${t(`payslips.docTypes.${p.docType}`)}${p.taxYear ? ` ${p.taxYear}` : ''}`}
              subtitle={t('payslipView.publishedOn', {
                date: formatDate(p.publishedAt.slice(0, 10), locale),
              })}
            />
          ))}
        </ListSection>
      ) : null}
    </div>
  );
}
