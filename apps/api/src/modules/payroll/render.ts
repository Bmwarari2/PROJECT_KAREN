import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { FieldMapping, SectionTable } from './mapping';

/**
 * Deterministic file writers. Same inputs + same mapping ⇒ same bytes: no current timestamps anywhere
 * (zip entry dates and workbook properties are pinned to the period end), stable ordering, CRLF lines.
 */
const SECTION_FILE: Record<string, string> = { hours: 'hours', absences: 'absences', sickPay: 'sick_pay', payChanges: 'pay_changes', starters: 'starters', leavers: 'leavers' };

/** CSV/Excel formula injection guard for text cells (OWASP): a leading = + - @ tab or CR is neutralised. */
export function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvField(s: string, delimiter: string): string {
  return s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(table: SectionTable, m: FieldMapping): string {
  const lines: string[] = [];
  if (m.includeHeader) lines.push(table.headers.map((h) => csvField(h, m.delimiter)).join(m.delimiter));
  for (const row of table.rows) lines.push(row.map((c) => csvField(c.kind === 'text' ? safeText(c.text) : c.text, m.delimiter)).join(m.delimiter));
  return lines.join('\r\n') + '\r\n';
}

/** Re-packs a zip with fixed entry dates and a fixed entry order so its bytes are reproducible. */
export async function normaliseZip(buf: Buffer | Uint8Array, date: Date): Promise<Buffer> {
  const src = await JSZip.loadAsync(buf);
  const out = new JSZip();
  const names = Object.keys(src.files).filter((n) => !src.files[n]!.dir).sort();
  for (const n of names) out.file(n, await src.files[n]!.async('uint8array'), { date, createFolders: false });
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}

/** A fixed timestamp for archive metadata: the period end at 00:00 UTC. */
export const archiveDate = (periodEnd: string) => new Date(`${periodEnd}T00:00:00Z`);

export async function renderCsvBundle(tables: SectionTable[], m: FieldMapping, baseName: string, periodEnd: string): Promise<{ body: Buffer; fileName: string; contentType: string }> {
  if (tables.length === 1) {
    return { body: Buffer.from(renderCsv(tables[0]!, m), 'utf8'), fileName: `${baseName}-${SECTION_FILE[tables[0]!.section]}.csv`, contentType: 'text/csv; charset=utf-8' };
  }
  const zip = new JSZip();
  const date = archiveDate(periodEnd);
  for (const t of tables) zip.file(`${SECTION_FILE[t.section]}.csv`, renderCsv(t, m), { date, createFolders: false });
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  return { body: await normaliseZip(body, date), fileName: `${baseName}.zip`, contentType: 'application/zip' };
}

export async function renderXlsx(tables: SectionTable[], baseName: string, periodEnd: string, sheetNames: Record<string, string>): Promise<{ body: Buffer; fileName: string; contentType: string }> {
  const date = archiveDate(periodEnd);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Thapsus-HR';
  wb.lastModifiedBy = 'Thapsus-HR';
  wb.created = date;
  wb.modified = date;
  for (const t of tables) {
    const ws = wb.addWorksheet((sheetNames[t.section] ?? t.section).slice(0, 31));
    ws.addRow(t.headers).font = { bold: true };
    for (const row of t.rows) ws.addRow(row.map((c) => (c.kind === 'number' && c.number !== undefined && Number.isFinite(c.number) ? c.number : safeText(c.text))));
    ws.columns.forEach((col, i) => (col.width = Math.min(40, Math.max(10, (t.headers[i]?.length ?? 8) + 2))));
  }
  const raw = await wb.xlsx.writeBuffer();
  return { body: await normaliseZip(Buffer.from(raw as ArrayBuffer), date), fileName: `${baseName}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

export function fileBaseName(connectorName: string, start: string, end: string) {
  const slug = connectorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'payroll';
  return `${slug}-${start}_${end}`;
}
