'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { ChevronLeft, Download, FileText, Printer } from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  EmptyState,
  ListItem,
  ListSection,
  ListValue,
  Skeleton,
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { IntentLink } from '@/components/intent-link';
import { amount, payslipName, type MyPayslip } from '@/components/payslips/my-payslips';
import { PageTitle } from '../../shell';

const PdfViewer = dynamic(() => import('@/components/documents/pdf-viewer'), {
  ssr: false,
  loading: () => <Skeleton className="aspect-[1/1.414] w-full" />,
});

interface Line {
  kind: string;
  label: string;
  quantity?: string;
  rateMinor?: number;
  amountMinor: number;
}
interface Statement {
  employeeNumber: string;
  currency: string;
  employer: { name: string; address?: string[]; taxReference?: string };
  employee: {
    name: string;
    address?: string[];
    department?: string;
    jobTitle?: string;
    taxCode?: string;
    nationalId?: string;
  };
  period: {
    start: string;
    end: string;
    payDate: string;
    frequency: string;
    number?: string;
    taxYear?: string;
  };
  payment: { method: string; account?: string };
  payments: Line[];
  deductions: Line[];
  employerContributions?: Line[];
  totals: { grossMinor: number; deductionsMinor: number; netMinor: number };
  ytd?: Array<{ key: string; label: string; amountMinor: number }>;
  notes?: string[];
  illustrative?: boolean;
}
interface Detail extends MyPayslip {
  hasFile: boolean;
  fileName: string | null;
  employeeName: string | null;
  statement: Statement | null;
}

/**
 * One payslip (ADR-0167), as the payroll provider supplied it: the net pay first, then payments, deductions,
 * employer contributions and the year to date, every amount the provider's own. Print gives a clean sheet; the
 * download is the provider's PDF when there is one, otherwise a PDF of the same statement. A payslip that came
 * as a PDF only opens in the in-app viewer.
 */
export default function PayslipPage() {
  const t = useT();
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const { data, error } = useApi<Detail>(`/v1/payslips/${id}`);
  const [showPdf, setShowPdf] = React.useState(false);

  if (error)
    return <EmptyState level={2} icon={<FileText aria-hidden />} title={t('payslipView.notFound')} />;
  if (!data) return <Skeleton className="h-[70vh] w-full" />;
  const s = data.statement;
  const money = (minor: number | string) => amount(minor, s?.currency ?? data.currency ?? 'GBP', locale);
  const date = (d: string) => formatDate(d, locale, 'long');
  const name =
    data.kind === 'payslip'
      ? payslipName(data, locale)
      : `${t(`payslips.docTypes.${data.docType}`)} ${data.taxYear ?? ''}`;
  const downloadHref = data.hasFile ? `/v1/payslips/${id}/file?download=true` : `/v1/payslips/${id}/pdf`;
  // Lines read as a list on every screen: the label (with hours and rate when the provider gives them) and the amount.
  const lines = (title: string, rows: Line[], total?: [string, number]) =>
    rows.length ? (
      <ListSection title={title} headingLevel={3}>
        {rows.map((l, i) => (
          <ListItem
            key={`${l.label}-${i}`}
            title={l.label}
            subtitle={
              l.quantity && l.rateMinor !== undefined
                ? t('payslipView.quantityAtRate', { quantity: l.quantity, rate: money(l.rateMinor) })
                : l.quantity
                  ? t('payslipView.quantityOnly', { quantity: l.quantity })
                  : undefined
            }
            accessory={<ListValue className="text-text">{money(l.amountMinor)}</ListValue>}
          />
        ))}
        {total ? (
          <ListItem
            title={<span className="font-semibold">{total[0]}</span>}
            accessory={<ListValue className="font-semibold text-text">{money(total[1])}</ListValue>}
          />
        ) : null}
      </ListSection>
    ) : null;

  return (
    <div className="flex flex-col gap-5">
      <IntentLink
        href="/app/payslips"
        data-print-hide
        className="inline-flex min-h-11 items-center gap-1 self-start text-callout text-accent no-underline hover:underline"
      >
        <ChevronLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('payslipView.back')}
      </IntentLink>
      <article data-print-sheet className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <PageTitle className="text-title-2 break-words">{t('payslipView.titleFor', { name })}</PageTitle>
            {data.providerName ? (
              <p className="text-callout text-text-secondary">
                {t('payslipView.issuedBy', { provider: data.providerName })}
              </p>
            ) : null}
            {data.sample ? (
              <div>
                <Badge tone="warning">{t('payslipView.sampleMarker')}</Badge>
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2" data-print-hide>
            <a
              href={downloadHref}
              download
              className={buttonVariants({ variant: 'secondary' }) + ' min-h-11 no-underline'}
            >
              <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {data.hasFile ? t('payslipView.downloadProvider') : t('payslipView.downloadPdf')}
            </a>
            {s ? (
              <Button variant="secondary" className="min-h-11" onClick={() => window.print()}>
                <Printer aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('payslipView.print')}
              </Button>
            ) : null}
          </div>
        </div>
        {data.sample ? (
          <p className="rounded-lg border border-border bg-surface-raised p-4 text-callout" role="note">
            {t('payslipView.sampleBanner')}
          </p>
        ) : null}

        {s ? (
          <>
            <section
              aria-labelledby="ps-summary"
              className="flex flex-col gap-4 rounded-lg bg-surface-raised p-5 shadow-sm"
            >
              <h3 id="ps-summary" className="sr-only">
                {t('payslipView.summary')}
              </h3>
              <div className="flex flex-col gap-1">
                <span className="text-callout text-text-secondary">{t('payslipView.netPay')}</span>
                <span className="text-large-title tabular-nums">{money(s.totals.netMinor)}</span>
              </div>
              <dl className="grid gap-x-6 gap-y-3 text-callout sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    [t('payslipView.payDate'), date(s.period.payDate)],
                    [t('payslipView.period'), `${date(s.period.start)} – ${date(s.period.end)}`],
                    [t('payslipView.grossPay'), money(s.totals.grossMinor)],
                    [t('payslipView.totalDeductions'), money(s.totals.deductionsMinor)],
                    [
                      t('payslipView.paymentMethod'),
                      `${t(`payslipView.methods.${s.payment.method}`)}${s.payment.account ? ` ${s.payment.account}` : ''}`,
                    ],
                    ...(s.period.number ? [[t('payslipView.periodNumber'), s.period.number]] : []),
                    ...(s.employee.taxCode ? [[t('payslipView.taxCode'), s.employee.taxCode]] : []),
                    ...(s.employee.nationalId ? [[t('payslipView.nationalId'), s.employee.nationalId]] : []),
                  ] as Array<[string, string]>
                ).map(([k, v]) => (
                  <div key={k} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-footnote text-text-secondary">{k}</dt>
                    <dd className="break-words font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {lines(t('payslipView.payments'), s.payments, [t('payslipView.grossPay'), s.totals.grossMinor])}
            {lines(t('payslipView.deductions'), s.deductions, [
              t('payslipView.totalDeductions'),
              s.totals.deductionsMinor,
            ])}
            {lines(t('payslipView.employerContributions'), s.employerContributions ?? [])}
            {s.ytd?.length
              ? lines(
                  s.period.taxYear
                    ? t('payslipView.ytdFor', { year: s.period.taxYear })
                    : t('payslipView.ytd'),
                  s.ytd.map((y) => ({ kind: y.key, label: y.label, amountMinor: y.amountMinor })),
                )
              : null}
            <section aria-labelledby="ps-parties" className="grid gap-4 md:grid-cols-2">
              <h3 id="ps-parties" className="sr-only">
                {t('payslipView.parties')}
              </h3>
              {(
                [
                  [
                    t('payslipView.employer'),
                    [
                      s.employer.name,
                      ...(s.employer.address ?? []),
                      s.employer.taxReference
                        ? `${t('payslipView.employerReference')}: ${s.employer.taxReference}`
                        : '',
                    ],
                  ],
                  [
                    t('payslipView.employee'),
                    [
                      s.employee.name,
                      `${t('payslipView.employeeNumber')}: ${s.employeeNumber}`,
                      s.employee.jobTitle ?? '',
                      s.employee.department ?? '',
                      ...(s.employee.address ?? []),
                    ],
                  ],
                ] as Array<[string, string[]]>
              ).map(([title, rows]) => (
                <div
                  key={title}
                  className="flex flex-col gap-1 rounded-lg bg-surface-raised p-4 text-callout shadow-sm"
                >
                  <span className="text-footnote font-semibold text-text-secondary">{title}</span>
                  {rows.filter(Boolean).map((r, i) => (
                    <span key={i} className="break-words">
                      {r}
                    </span>
                  ))}
                </div>
              ))}
            </section>
            {s.notes?.length ? (
              <section aria-labelledby="ps-notes" className="flex flex-col gap-1">
                <h3 id="ps-notes" className="px-1 text-title-3">
                  {t('payslipView.notes')}
                </h3>
                {s.notes.map((n, i) => (
                  <p key={i} className="px-1 text-callout text-text-secondary">
                    {n}
                  </p>
                ))}
              </section>
            ) : null}
            <p className="px-1 text-footnote text-text-secondary">{t('payslipView.notCalculated')}</p>
            {data.hasFile ? (
              <section aria-labelledby="ps-provider-pdf" className="flex flex-col gap-3" data-print-hide>
                <h3 id="ps-provider-pdf" className="px-1 text-title-3">
                  {t('payslipView.providerPdf')}
                </h3>
                {showPdf ? (
                  <PdfViewer src={`/v1/payslips/${id}/file`} title={name} />
                ) : (
                  <Button
                    variant="secondary"
                    className="min-h-11 self-start"
                    onClick={() => setShowPdf(true)}
                  >
                    {t('payslipView.showProviderPdf')}
                  </Button>
                )}
              </section>
            ) : null}
          </>
        ) : (
          <PdfViewer
            src={`/v1/payslips/${id}/file`}
            title={name}
            fallback={
              <a
                href={downloadHref}
                download
                className={buttonVariants({ variant: 'secondary' }) + ' min-h-11 no-underline'}
              >
                {t('payslipView.downloadProvider')}
              </a>
            }
          />
        )}
      </article>
    </div>
  );
}
