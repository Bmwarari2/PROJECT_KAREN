import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatDate, formatDateTime, formatMoney, numberFormat, t as translate, type Locale } from '@thapsus/core/i18n';
import { currencyExponent, money, toDecimalString } from '@thapsus/core/money';
import { winAnsiSafe } from '../documents/pdf';
import { formatScaled, roundDiv } from './fixed';
import type { Cell, Column, MoneyCell, ReportResult, Row } from './types';

/**
 * Report output: CSV and JSON Lines (machine-readable: ISO dates, '.' decimals, money as a decimal amount
 * plus its ISO 4217 code), Excel (typed cells) and PDF (title, parameters, generated-at with time zone and a
 * fully localised table). Spreadsheet formula injection is neutralised in CSV and Excel text cells.
 */
export type Format = 'csv' | 'xlsx' | 'pdf' | 'jsonl' | 'json';

export interface RenderMeta {
  title: string;
  /** Already-localised "Label: value" lines describing the parameters. */
  parameters: string[];
  locale: Locale;
  timeZone: string;
  generatedAt: string;
}

const isMoney = (v: Cell): v is MoneyCell => !!v && typeof v === 'object' && 'amountMinor' in v;
const hoursOf = (minutes: number) => formatScaled(roundDiv(BigInt(minutes) * 100n, 60n), 2, 2);
const moneyDecimal = (m: MoneyCell) => toDecimalString(money(BigInt(m.amountMinor), m.currency));

function enumLabel(locale: Locale, c: Column, v: string): string {
  if (!c.enumKey) return v;
  const key = `${c.enumKey}.${v}`;
  const out = translate(locale, key);
  return out === key ? v : out;
}

/** Localised display text for a cell (PDF, web). */
export function displayCell(locale: Locale, c: Column, v: Cell): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (c.type) {
    case 'integer':
      return numberFormat(locale).format(Number(v));
    case 'decimal':
      return numberFormat(locale, { minimumFractionDigits: c.scale ?? 2, maximumFractionDigits: c.scale ?? 2 }).format(String(v) as unknown as number);
    case 'percent':
      return `${numberFormat(locale, { minimumFractionDigits: c.scale ?? 2, maximumFractionDigits: c.scale ?? 2 }).format(String(v) as unknown as number)}%`;
    case 'money':
      return isMoney(v) ? formatMoney(money(BigInt(v.amountMinor), v.currency), locale) : String(v);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? formatDate(String(v), locale) : String(v);
    case 'minutes':
      return `${numberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(hoursOf(Number(v)) as unknown as number)} ${translate(locale, 'reports.hoursSuffix')}`;
    case 'boolean':
      return translate(locale, v ? 'common.yes' : 'common.no');
    case 'enum':
      return enumLabel(locale, c, String(v));
    default:
      return String(v);
  }
}

/** Header labels: money columns get a companion currency column and minutes are exported as hours. */
/** Header text: "label – sub-label" when a column has a second part (e.g. race/ethnicity – sex). */
export function headerOf(locale: Locale, c: Column): string {
  const label = translate(locale, c.labelKey);
  return c.subLabelKey ? `${label} – ${translate(locale, c.subLabelKey)}` : label;
}

function machineHeaders(locale: Locale, cols: Column[]): string[] {
  return cols.flatMap((c) => {
    const label = headerOf(locale, c);
    if (c.type === 'money') return [label, `${label} (${translate(locale, 'reports.col.currency')})`];
    if (c.type === 'minutes') return [`${label} (${translate(locale, 'reports.hoursUnit')})`];
    return [label];
  });
}

function machineValues(cols: Column[], r: Row): Array<string | number | boolean | null> {
  return cols.flatMap((c) => {
    const v = r[c.key] ?? null;
    if (c.type === 'money') return isMoney(v) ? [moneyDecimal(v), v.currency] : [null, null];
    if (c.type === 'minutes') return [v === null ? null : hoursOf(Number(v))];
    return [isMoney(v) ? moneyDecimal(v) : (v as string | number | boolean | null)];
  });
}

const FORMULA = /^[=+\-@\t\r]/;
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  const safe = typeof v === 'string' && FORMULA.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function renderCsv(result: ReportResult, locale: Locale): Buffer {
  const lines = [machineHeaders(locale, result.columns).map(csvCell).join(',')];
  for (const r of [...result.rows, ...(result.totals ?? [])]) lines.push(machineValues(result.columns, r).map(csvCell).join(','));
  return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
}

/** One JSON object per row with stable keys (column keys), money as {amountMinor, currency}. */
export function renderJsonl(result: Pick<ReportResult, 'rows'>): Buffer {
  return Buffer.from(result.rows.map((r) => JSON.stringify(r)).join('\n') + (result.rows.length ? '\n' : ''), 'utf8');
}

export async function renderXlsx(result: ReportResult, meta: RenderMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Thapsus-HR';
  wb.created = new Date(meta.generatedAt);
  const ws = wb.addWorksheet(winAnsiSafe(meta.title).slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Report');
  ws.addRow([meta.title]).font = { bold: true, size: 14 };
  for (const p of meta.parameters) ws.addRow([p]);
  ws.addRow([translate(meta.locale, 'reports.generatedAt', { when: formatDateTime(meta.generatedAt, meta.locale, meta.timeZone), zone: meta.timeZone })]);
  ws.addRow([]);
  const header = ws.addRow(machineHeaders(meta.locale, result.columns));
  header.font = { bold: true };
  for (const r of [...result.rows, ...(result.totals ?? [])]) {
    const values: unknown[] = [];
    for (const c of result.columns) {
      const v = r[c.key] ?? null;
      if (c.type === 'money') {
        values.push(isMoney(v) ? Number(moneyDecimal(v)) : null, isMoney(v) ? v.currency : null);
      } else if (c.type === 'minutes') values.push(v === null ? null : Number(hoursOf(Number(v))));
      else if (c.type === 'decimal' || c.type === 'percent') values.push(v === null ? null : Number(v));
      else if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) values.push(new Date(`${v}T00:00:00Z`));
      else if (c.type === 'enum' && typeof v === 'string') values.push(enumLabel(meta.locale, c, v));
      else if (typeof v === 'string' && FORMULA.test(v)) values.push(`'${v}`);
      else values.push(v);
    }
    const row = ws.addRow(values);
    let i = 1;
    for (const c of result.columns) {
      if (c.type === 'money') {
        const ccy = (r[c.key] as MoneyCell | null)?.currency;
        if (ccy) row.getCell(i).numFmt = `#,##0${currencyExponent(ccy) ? '.' + '0'.repeat(currencyExponent(ccy)) : ''}`;
        i += 2;
        continue;
      }
      if (c.type === 'date') row.getCell(i).numFmt = 'yyyy-mm-dd';
      if (c.type === 'decimal' || c.type === 'percent' || c.type === 'minutes') row.getCell(i).numFmt = '#,##0.00';
      i++;
    }
  }
  ws.columns.forEach((col) => (col.width = 18));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- PDF ---------------------------------------------------------------------------------------------------
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 40;

function fit(text: string, font: PDFFont, size: number, width: number): string {
  const s = winAnsiSafe(text);
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${s.slice(0, mid)}...`, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}...`;
}

export async function renderPdf(result: ReportResult, meta: RenderMeta): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(meta.title));
  doc.setProducer('Thapsus-HR');
  doc.setCreationDate(new Date(meta.generatedAt));
  doc.setModificationDate(new Date(meta.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.11, 0.12);
  const muted = rgb(0.37, 0.37, 0.4);
  const rule = rgb(0.82, 0.82, 0.84);
  const width = A4_LANDSCAPE[0] - MARGIN * 2;
  const size = 8.5;
  const rowH = 14;
  const cols = result.columns;
  const rows = [...result.rows, ...(result.totals ?? [])];
  const text = rows.map((r) => cols.map((c) => displayCell(meta.locale, c, r[c.key] ?? null)));
  const headers = cols.map((c) => headerOf(meta.locale, c));
  // column widths proportional to content (header and up to 200 rows sampled), within the page width
  const natural = cols.map((_, i) => Math.min(220, Math.max(40, bold.widthOfTextAtSize(winAnsiSafe(headers[i]!), size), ...text.slice(0, 200).map((r) => font.widthOfTextAtSize(winAnsiSafe(r[i]!), size))) + 8));
  const scale = Math.min(1, width / natural.reduce((a, b) => a + b, 0));
  const widths = natural.map((w) => w * scale);
  const numeric = cols.map((c) => ['integer', 'decimal', 'percent', 'money', 'minutes'].includes(c.type));

  let page: PDFPage = doc.addPage(A4_LANDSCAPE);
  let y = A4_LANDSCAPE[1] - MARGIN;
  page.drawText(winAnsiSafe(meta.title), { x: MARGIN, y: y - 16, size: 16, font: bold, color: ink });
  y -= 30;
  for (const line of [...meta.parameters, translate(meta.locale, 'reports.generatedAt', { when: formatDateTime(meta.generatedAt, meta.locale, meta.timeZone), zone: meta.timeZone })]) {
    page.drawText(fit(line, font, 9.5, width), { x: MARGIN, y, size: 9.5, font, color: muted });
    y -= 13;
  }
  for (const note of result.notes) {
    page.drawText(fit(translate(meta.locale, note), font, 8, width), { x: MARGIN, y, size: 8, font, color: muted });
    y -= 11;
  }
  y -= 6;
  const drawHeader = () => {
    let x = MARGIN;
    headers.forEach((h, i) => {
      const s = fit(h, bold, size, widths[i]! - 6);
      const tx = numeric[i] ? x + widths[i]! - 3 - bold.widthOfTextAtSize(s, size) : x + 3;
      page.drawText(s, { x: tx, y: y - 10, size, font: bold, color: ink });
      x += widths[i]!;
    });
    page.drawLine({ start: { x: MARGIN, y: y - rowH + 1 }, end: { x: MARGIN + width, y: y - rowH + 1 }, thickness: 0.6, color: rule });
    y -= rowH;
  };
  drawHeader();
  if (!rows.length) page.drawText(winAnsiSafe(translate(meta.locale, 'reports.noRows')), { x: MARGIN + 3, y: y - 10, size, font, color: muted });
  text.forEach((r, ri) => {
    if (y - rowH < MARGIN + 14) {
      page = doc.addPage(A4_LANDSCAPE);
      y = A4_LANDSCAPE[1] - MARGIN;
      drawHeader();
    }
    const total = ri >= result.rows.length;
    let x = MARGIN;
    r.forEach((cell, i) => {
      const f = total ? bold : font;
      const s = fit(cell, f, size, widths[i]! - 6);
      const tx = numeric[i] ? x + widths[i]! - 3 - f.widthOfTextAtSize(s, size) : x + 3;
      page.drawText(s, { x: tx, y: y - 10, size, font: f, color: ink });
      x += widths[i]!;
    });
    y -= rowH;
  });
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = winAnsiSafe(translate(meta.locale, 'reports.pageOf', { page: i + 1, pages: pages.length }));
    p.drawText(label, { x: A4_LANDSCAPE[0] - MARGIN - font.widthOfTextAtSize(label, 8), y: MARGIN - 18, size: 8, font, color: muted });
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export const CONTENT_TYPES: Record<Exclude<Format, 'json'>, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  jsonl: 'application/x-ndjson',
};

export async function renderReport(result: ReportResult, format: Exclude<Format, 'json'>, meta: RenderMeta): Promise<Buffer> {
  switch (format) {
    case 'csv':
      return renderCsv(result, meta.locale);
    case 'jsonl':
      return renderJsonl(result);
    case 'xlsx':
      return renderXlsx(result, meta);
    case 'pdf':
      return renderPdf(result, meta);
  }
}

/** Safe download file name: report title slug + date (no personal data). */
export function fileNameFor(title: string, date: string, format: string): string {
  const slug = winAnsiSafe(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
  return `${slug}-${date}.${format}`;
}
