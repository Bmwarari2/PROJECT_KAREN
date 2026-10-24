import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatDate, formatMoney, t, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { winAnsiSafe } from '../documents/pdf';
import type { PayslipStatement } from './statement';

/**
 * A printable PDF of a provider's payslip statement, for payslips that arrived without the provider's own PDF
 * (ADR-0167). It lays out exactly the provider's figures (nothing is calculated) and names the issuing provider;
 * fictional sample statements carry the "Sample data" marker on every page.
 */
const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.11, 0.11, 0.12);
const MUTED = rgb(0.4, 0.4, 0.43);
const RULE = rgb(0.85, 0.85, 0.87);

export interface PayslipPdfInput {
  statement: PayslipStatement;
  provider: string | null;
  sample: boolean;
  locale: Locale;
}

export async function renderPayslipPdf(input: PayslipPdfInput): Promise<Uint8Array> {
  const { statement: s, locale } = input;
  const L = (k: string, v: Record<string, string | number> = {}) => t(locale, `payslipView.${k}`, v);
  const amount = (minor: number) => formatMoney(money(BigInt(minor), s.currency), locale);
  const date = (d: string) => formatDate(d, locale, 'long');
  const safe = (v: string) => winAnsiSafe(v.replace(/\u2022/g, '*').replace(/[\u202f\u00a0]/g, ' '));

  const doc = await PDFDocument.create();
  doc.setTitle(safe(L('pdfTitle', { employer: s.employer.name, date: date(s.period.payDate) })));
  doc.setProducer('Thapsus-HR');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - 2 * M;

  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - M;
  const footer = (p: PDFPage) => {
    const parts = [
      input.provider ? L('issuedBy', { provider: input.provider }) : '',
      L('notCalculated'),
      input.sample ? L('sampleMarker') : '',
    ].filter(Boolean);
    p.drawText(safe(parts.join('  ·  ')).slice(0, 150), { x: M, y: 28, size: 8, font, color: MUTED });
  };
  footer(page);
  const ensure = (h: number) => {
    if (y - h < 56) {
      page = doc.addPage(A4);
      footer(page);
      y = A4[1] - M;
    }
  };
  const text = (v: string, x: number, size: number, f: PDFFont = font, color = INK) =>
    page.drawText(safe(v), { x, y, size, font: f, color });
  const right = (v: string, xRight: number, size: number, f: PDFFont = font) =>
    page.drawText(safe(v), { x: xRight - f.widthOfTextAtSize(safe(v), size), y, size, font: f, color: INK });

  if (input.sample) {
    page.drawRectangle({ x: M, y: y - 6, width, height: 22, color: rgb(1, 0.95, 0.82) });
    text(L('sampleBanner'), M + 8, 10, bold);
    y -= 34;
  }
  text(s.employer.name, M, 18, bold);
  right(L('payslip'), M + width, 18, bold);
  y -= 18;
  for (const a of s.employer.address ?? []) {
    text(a, M, 9, font, MUTED);
    y -= 12;
  }
  if (s.employer.taxReference) {
    text(`${L('employerReference')}: ${s.employer.taxReference}`, M, 9, font, MUTED);
    y -= 12;
  }
  y -= 10;

  // two columns of details: the employee, and the period and payment
  const left: Array<[string, string]> = [
    [L('employee'), s.employee.name],
    [L('employeeNumber'), s.employeeNumber],
    ...(s.employee.jobTitle ? [[L('jobTitle'), s.employee.jobTitle] as [string, string]] : []),
    ...(s.employee.department ? [[L('department'), s.employee.department] as [string, string]] : []),
    ...(s.employee.taxCode ? [[L('taxCode'), s.employee.taxCode] as [string, string]] : []),
    ...(s.employee.nationalId ? [[L('nationalId'), s.employee.nationalId] as [string, string]] : []),
  ];
  const rightCol: Array<[string, string]> = [
    [L('payDate'), date(s.period.payDate)],
    [L('period'), `${date(s.period.start)} - ${date(s.period.end)}`],
    ...(s.period.number ? [[L('periodNumber'), s.period.number] as [string, string]] : []),
    [L('frequency'), L(`frequencies.${s.period.frequency}`)],
    [
      L('paymentMethod'),
      `${L(`methods.${s.payment.method}`)}${s.payment.account ? ` ${s.payment.account}` : ''}`,
    ],
  ];
  const rows = Math.max(left.length, rightCol.length);
  for (let i = 0; i < rows; i++) {
    ensure(26);
    const a = left[i];
    const b = rightCol[i];
    if (a) {
      text(a[0], M, 8, font, MUTED);
    }
    if (b) text(b[0], M + width / 2, 8, font, MUTED);
    y -= 11;
    if (a) text(a[1], M, 10, bold);
    if (b) text(b[1], M + width / 2, 10, bold);
    y -= 16;
  }
  y -= 6;

  const table = (
    title: string,
    lines: Array<{ label: string; quantity?: string; rateMinor?: number; amountMinor: number }>,
    total?: [string, number],
  ) => {
    if (!lines.length) return;
    ensure(40);
    text(title, M, 11, bold);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: RULE });
    y -= 14;
    for (const l of lines) {
      ensure(16);
      text(l.label, M, 10);
      if (l.quantity) right(l.quantity, M + width * 0.62, 10);
      if (l.rateMinor !== undefined) right(amount(l.rateMinor), M + width * 0.8, 10);
      right(amount(l.amountMinor), M + width, 10);
      y -= 15;
    }
    if (total) {
      page.drawLine({
        start: { x: M, y: y + 10 },
        end: { x: M + width, y: y + 10 },
        thickness: 0.6,
        color: RULE,
      });
      text(total[0], M, 10, bold);
      right(amount(total[1]), M + width, 10, bold);
      y -= 15;
    }
    y -= 10;
  };
  table(L('payments'), s.payments, [L('grossPay'), s.totals.grossMinor]);
  table(L('deductions'), s.deductions, [L('totalDeductions'), s.totals.deductionsMinor]);

  ensure(40);
  page.drawRectangle({ x: M, y: y - 10, width, height: 30, color: rgb(0.95, 0.95, 0.97) });
  text(L('netPay'), M + 10, 13, bold);
  right(amount(s.totals.netMinor), M + width - 10, 13, bold);
  y -= 44;

  table(L('employerContributions'), s.employerContributions ?? []);
  table(
    s.period.taxYear ? L('ytdFor', { year: s.period.taxYear }) : L('ytd'),
    (s.ytd ?? []).map((i) => ({ label: i.label, amountMinor: i.amountMinor })),
  );
  for (const n of s.notes ?? []) {
    ensure(14);
    text(n, M, 9, font, MUTED);
    y -= 13;
  }
  return doc.save({ useObjectStreams: false });
}
