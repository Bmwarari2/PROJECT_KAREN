import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Standard PDF fonts only cover WinAnsi: map smart punctuation, replace anything else with "?". */
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x00a3]);
const winAnsiSafe = (s: string) =>
  [...s]
    .map((ch) => {
      if (ch === '\u2018' || ch === '\u2019') return "'";
      if (ch === '\u201c' || ch === '\u201d') return '"';
      if (ch === '\u2013' || ch === '\u2014') return '-';
      const c = ch.codePointAt(0)!;
      return c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c) ? ch : '?';
    })
    .join('');

/** Replaces {{path.to.value}} merge fields. Unknown fields render empty (and are reported). */
export function mergeFields(body: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in values)) missing.push(key);
    return values[key] ?? '';
  });
  return { text, missing };
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function writeLines(doc: PDFDocument, lines: string[], font: PDFFont, bold: PDFFont, startPage?: PDFPage) {
  let page = startPage ?? doc.addPage([595.28, 841.89]); // A4
  let y = 790;
  for (const raw of lines) {
    const heading = raw.startsWith('# ');
    const line = heading ? raw.slice(2) : raw;
    const size = heading ? 16 : 11;
    if (y < 60) {
      page = doc.addPage([595.28, 841.89]);
      y = 790;
    }
    page.drawText(winAnsiSafe(line), { x: 56, y, size, font: heading ? bold : font, color: rgb(0.11, 0.11, 0.12) });
    y -= heading ? 26 : 16;
  }
  return page;
}

export async function renderTextPdf(title: string, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(title));
  doc.setProducer('Thapsus-HR');
  doc.setCreationDate(new Date(0)); // deterministic output for identical inputs
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const lines = [`# ${title}`, '', ...wrap(text, font, 11, 595.28 - 112)];
  writeLines(doc, lines, font, bold);
  return doc.save({ useObjectStreams: false });
}

export interface SignatureEvidence {
  signerName: string;
  signerEmail: string;
  signedAtUtc: string;
  ip: string;
  userAgent: string;
  documentSha256: string;
  requestId: string;
  labels: Record<string, string>;
}

/** Appends a signature certificate page to the exact document that was signed. */
export async function appendCertificate(original: Uint8Array, ev: SignatureEvidence): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const L = ev.labels;
  const lines = [
    `# ${L.title}`,
    '',
    `${L.signer}: ${ev.signerName} <${ev.signerEmail}>`,
    `${L.signedAt}: ${ev.signedAtUtc}`,
    `${L.ip}: ${ev.ip}`,
    `${L.userAgent}: ${ev.userAgent.slice(0, 90)}`,
    `${L.hash}:`,
    ev.documentSha256,
    `${L.reference}: ${ev.requestId}`,
    '',
    ...wrap(L.statement ?? "", font, 11, 595.28 - 112),
  ];
  writeLines(doc, lines, font, bold);
  return doc.save({ useObjectStreams: false });
}
