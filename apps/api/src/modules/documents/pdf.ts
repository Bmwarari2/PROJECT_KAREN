import { createHash } from 'node:crypto';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Block, PlacedField, Run, SigningParty } from '@thapsus/core/documents';
import { signatureFont } from './signature-font';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Standard PDF fonts only cover WinAnsi: map smart punctuation, replace anything else with "?". */
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x00a3]);
export const winAnsiSafe = (s: string) =>
  [...s]
    .map((ch) => {
      if (ch === '‘' || ch === '’') return "'";
      if (ch === '“' || ch === '”') return '"';
      if (ch === '–' || ch === '—') return '-';
      if (ch === '•') return '-';
      const c = ch.codePointAt(0)!;
      return c === 9 ||
        c === 10 ||
        c === 13 ||
        (c >= 0x20 && c <= 0x7e) ||
        (c >= 0xa0 && c <= 0xff) ||
        WIN_ANSI_EXTRA.has(c)
        ? ch
        : '?';
    })
    .join('');

/** Replaces {{path.to.value}} merge fields. Unknown fields render empty (and are reported). */
export function mergeFields(
  body: string,
  values: Record<string, string>,
): { text: string; missing: string[] } {
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
    page.drawText(winAnsiSafe(line), {
      x: 56,
      y,
      size,
      font: heading ? bold : font,
      color: rgb(0.11, 0.11, 0.12),
    });
    y -= heading ? 26 : 16;
  }
  return page;
}

/** A plain-text PDF (company documents of the staging seed, licence checks). Templates use renderTemplatePdf. */
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

// ---- template documents (ADR-0194, ADR-0197) -----------------------------------------------------------------

const A4: [number, number] = [595.28, 841.89];
const MARGIN_X = 56;
const TOP = 785;
const BOTTOM = 72;
const WIDTH = A4[0] - 2 * MARGIN_X;
const INK = rgb(0.11, 0.11, 0.12);
const MUTED = rgb(0.43, 0.43, 0.45);
const RULE = rgb(0.82, 0.82, 0.84);

/**
 * Where a signature goes on the document, in PDF points (origin bottom left), page 0-based. Each signing party
 * has a signature box and lines for the printed name, the date and the reference; the company also has "for and
 * on behalf of". Placed boxes on an uploaded PDF have a signature box with a caption under it, and date boxes.
 */
export interface SignatureField {
  party: SigningParty;
  kind: 'signature' | 'name' | 'onBehalf' | 'date' | 'reference' | 'caption';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlockLabels {
  /** "Signatures" */
  heading: string;
  employee: string;
  company: string;
  signature: string;
  name: string;
  date: string;
  reference: string;
  onBehalf: string;
}

export interface TemplatePdf {
  title: string;
  company: string;
  blocks: Block[];
  /** Signature blocks to end with, in this order (left to right). */
  parties: SigningParty[];
  labels: BlockLabels & { page: (n: number, count: number) => string };
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface Segment {
  text: string;
  bold: boolean;
  x: number;
  /** the width drawn so far */
  w: number;
}
/** Lays runs out in lines of at most `width`: words keep their run's weight; a newline in a value breaks the line. */
function layoutRuns(runs: Run[], f: Fonts, size: number, width: number): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let x = 0;
  const push = () => {
    lines.push(line);
    line = [];
    x = 0;
  };
  for (const run of runs) {
    const font = run.bold ? f.bold : f.regular;
    const parts = winAnsiSafe(run.text).split('\n');
    parts.forEach((part, pi) => {
      if (pi > 0) push();
      for (const token of part.split(/(\s+)/)) {
        if (!token) continue;
        const space = /^\s+$/.test(token);
        const w = font.widthOfTextAtSize(space ? ' ' : token, size);
        if (space) {
          if (x > 0) x += w;
          continue;
        }
        if (x > 0 && x + w > width) push();
        // a single word wider than the line is cut into pieces that fit
        let rest = token;
        while (font.widthOfTextAtSize(rest, size) > width) {
          let n = rest.length - 1;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          line.push({
            text: rest.slice(0, n),
            bold: run.bold,
            x,
            w: font.widthOfTextAtSize(rest.slice(0, n), size),
          });
          push();
          rest = rest.slice(n);
        }
        // words of the same weight on a line are one string, so the PDF's text reads (and copies) with spaces
        const last = line.at(-1);
        const gap = font.widthOfTextAtSize(' ', size);
        if (last && last.bold === run.bold && Math.abs(last.x + last.w + gap - x) < 0.01) {
          last.text += ` ${rest}`;
          last.w += gap + font.widthOfTextAtSize(rest, size);
        } else line.push({ text: rest, bold: run.bold, x, w: font.widthOfTextAtSize(rest, size) });
        x += font.widthOfTextAtSize(rest, size);
      }
    });
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

/** A page writer with a cursor that starts new pages as it goes. */
class Writer {
  page: PDFPage;
  y = TOP;
  constructor(
    readonly doc: PDFDocument,
    readonly f: Fonts,
  ) {
    this.page = doc.addPage(A4);
  }
  get pageIndex() {
    return this.doc.getPageCount() - 1;
  }
  ensure(h: number) {
    if (this.y - h < BOTTOM) {
      this.page = this.doc.addPage(A4);
      this.y = TOP;
    }
  }
  runs(
    runs: Run[],
    o: { size: number; leading: number; indent?: number; marker?: string; color?: typeof INK },
  ) {
    const indent = o.indent ?? 0;
    const lines = layoutRuns(runs, this.f, o.size, WIDTH - indent);
    lines.forEach((segs, i) => {
      this.ensure(o.leading);
      const baseline = this.y - o.size;
      if (i === 0 && o.marker)
        this.page.drawText(o.marker, {
          x: MARGIN_X + indent - 16,
          y: baseline,
          size: o.size,
          font: this.f.regular,
          color: o.color ?? INK,
        });
      for (const s of segs)
        if (s.text)
          this.page.drawText(s.text, {
            x: MARGIN_X + indent + s.x,
            y: baseline,
            size: o.size,
            font: s.bold ? this.f.bold : this.f.regular,
            color: o.color ?? INK,
          });
      this.y -= o.leading;
    });
  }
  text(s: string, o: { size: number; bold?: boolean; color?: typeof INK; leading: number }) {
    this.runs([{ text: s, bold: !!o.bold }], o);
  }
  gap(h: number) {
    this.y -= h;
  }
}

/** Draws one party's signature block at (x, top) and returns its fields. */
function drawBlock(
  w: Writer,
  party: SigningParty,
  x: number,
  top: number,
  width: number,
  labels: BlockLabels,
): SignatureField[] {
  const page = w.page;
  const at = w.pageIndex;
  const small = 8.5;
  page.drawText(winAnsiSafe(party === 'company' ? labels.company : labels.employee), {
    x,
    y: top - 11,
    size: 11,
    font: w.f.bold,
    color: INK,
  });
  const sigTop = top - 20;
  const sigH = 46;
  const fields: SignatureField[] = [
    { party, kind: 'signature', page: at, x, y: sigTop - sigH, width, height: sigH },
  ];
  page.drawLine({
    start: { x, y: sigTop - sigH },
    end: { x: x + width, y: sigTop - sigH },
    thickness: 0.75,
    color: RULE,
  });
  page.drawText(winAnsiSafe(labels.signature), {
    x,
    y: sigTop - sigH - 11,
    size: small,
    font: w.f.regular,
    color: MUTED,
  });
  let y = sigTop - sigH - 30;
  const rows: Array<[SignatureField['kind'], string]> = [['name', labels.name]];
  if (party === 'company') rows.push(['onBehalf', labels.onBehalf]);
  rows.push(['date', labels.date], ['reference', labels.reference]);
  for (const [kind, label] of rows) {
    // "For and on behalf of …" is stamped across the whole line, under the printed name
    const labelW = label ? 62 : 0;
    if (label) page.drawText(winAnsiSafe(label), { x, y, size: small, font: w.f.regular, color: MUTED });
    page.drawLine({
      start: { x: x + labelW, y: y - 2 },
      end: { x: x + width, y: y - 2 },
      thickness: 0.5,
      color: RULE,
    });
    fields.push({ party, kind, page: at, x: x + labelW, y: y - 1, width: width - labelW, height: 12 });
    y -= 20;
  }
  return fields;
}

const BLOCK_HEIGHT = 190;

/** Ends the document with a signature block per party, side by side; returns where each signature goes. */
function signatureBlocks(w: Writer, parties: SigningParty[], labels: BlockLabels): SignatureField[] {
  if (!parties.length) return [];
  w.gap(10);
  w.ensure(BLOCK_HEIGHT + 30);
  w.text(labels.heading, { size: 12.5, bold: true, leading: 24 });
  const gutter = 28;
  const colW = parties.length > 1 ? (WIDTH - gutter) / 2 : Math.min(WIDTH, 260);
  const top = w.y;
  const fields = parties.flatMap((p, i) =>
    drawBlock(w, p, MARGIN_X + i * (colW + gutter), top, colW, labels),
  );
  w.y = top - BLOCK_HEIGHT;
  return fields;
}

function footers(doc: PDFDocument, f: Fonts, company: string, label: (n: number, count: number) => string) {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const size = 8.5;
    p.drawLine({
      start: { x: MARGIN_X, y: 50 },
      end: { x: A4[0] - MARGIN_X, y: 50 },
      thickness: 0.5,
      color: RULE,
    });
    if (company)
      p.drawText(winAnsiSafe(company), { x: MARGIN_X, y: 36, size, font: f.regular, color: MUTED });
    const text = winAnsiSafe(label(i + 1, pages.length));
    p.drawText(text, {
      x: A4[0] - MARGIN_X - f.regular.widthOfTextAtSize(text, size),
      y: 36,
      size,
      font: f.regular,
      color: MUTED,
    });
  });
}

/**
 * A template document (16.10): the company name and the title, then the wording with its headings, paragraphs,
 * lists and bold, a signature block per signing party, and the company name and "Page n of m" on every page.
 */
export async function renderTemplatePdf(
  input: TemplatePdf,
): Promise<{ bytes: Uint8Array; fields: SignatureField[] }> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(input.title));
  if (input.company) doc.setAuthor(winAnsiSafe(input.company));
  doc.setProducer('Thapsus-HR');
  doc.setCreationDate(new Date(0)); // deterministic output for identical inputs
  doc.setModificationDate(new Date(0));
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const w = new Writer(doc, f);
  if (input.company) w.text(input.company, { size: 10, color: MUTED, leading: 18 });
  w.runs([{ text: input.title, bold: true }], { size: 20, leading: 26 });
  w.gap(14);
  for (const b of input.blocks) {
    if (b.type === 'heading') {
      const size = b.level === 1 ? 15 : 12.5;
      w.gap(b.level === 1 ? 10 : 6);
      // a heading never ends a page on its own
      w.ensure(size + 40);
      w.runs(
        b.runs.map((r) => ({ ...r, bold: true })),
        { size, leading: size + 7 },
      );
      w.gap(2);
    } else if (b.type === 'paragraph') {
      for (const line of b.lines) w.runs(line, { size: 11, leading: 15.5 });
      w.gap(8);
    } else {
      for (const item of b.items)
        w.runs(item.runs, {
          size: 11,
          leading: 15.5,
          indent: 20,
          marker: item.marker === '•' ? '-' : item.marker,
        });
      w.gap(8);
    }
  }
  const fields = signatureBlocks(w, input.parties, input.labels);
  footers(doc, f, input.company, input.labels.page);
  return { bytes: await doc.save({ useObjectStreams: false }), fields };
}

/**
 * An uploaded PDF without placed boxes gets a signature page at the end (16.13), with the same blocks as a
 * template document; it returns the new copy and where the signatures go.
 */
export async function addSignaturePage(
  original: Uint8Array,
  o: { title: string; parties: SigningParty[]; labels: BlockLabels },
): Promise<{ bytes: Uint8Array; fields: SignatureField[] }> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const w = new Writer(doc, f);
  w.runs([{ text: o.title, bold: true }], { size: 15, leading: 22 });
  const fields = signatureBlocks(w, o.parties, o.labels);
  return { bytes: await doc.save({ useObjectStreams: false }), fields };
}

/** Where boxes HR placed on an uploaded PDF go (a 3 × 3 grid on the page, 36 points from the edges). */
export async function placedFieldRects(pdf: Uint8Array, placed: PlacedField[]): Promise<SignatureField[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const count = doc.getPageCount();
  const out: SignatureField[] = [];
  for (const p of placed) {
    if (p.page < 1 || p.page > count) throw new RangeError(`page ${p.page} of ${count}`);
    const page = doc.getPage(p.page - 1);
    const { width: pw, height: ph } = page.getSize();
    const [row, col] = p.position.split('_') as [string, string];
    const boxW = p.kind === 'signature' ? 190 : 120;
    const boxH = p.kind === 'signature' ? 64 : 16;
    const edge = 36;
    const x = col === 'left' ? edge : col === 'right' ? pw - edge - boxW : (pw - boxW) / 2;
    const y = row === 'top' ? ph - edge - boxH : row === 'bottom' ? edge : (ph - boxH) / 2;
    if (p.kind === 'date')
      out.push({ party: p.party, kind: 'date', page: p.page - 1, x, y, width: boxW, height: boxH });
    else {
      // the signature over a two-line caption: the printed name (and for whom), the date and the reference
      out.push({
        party: p.party,
        kind: 'signature',
        page: p.page - 1,
        x,
        y: y + 20,
        width: boxW,
        height: boxH - 20,
      });
      out.push({ party: p.party, kind: 'caption', page: p.page - 1, x, y, width: boxW, height: 18 });
    }
  }
  return out;
}

export interface Stamp {
  method: 'typed' | 'drawn';
  /** The printed name (and, for a typed signature, the signature itself in the handwriting font). */
  name: string;
  /** A drawn signature as PNG bytes. */
  drawing?: Uint8Array;
  /** "For and on behalf of …" for the company. */
  onBehalf?: string;
  date: string;
  reference: string;
}

/** The ink of stamped signatures: a dark blue, like a pen. */
const PEN = rgb(0.05, 0.12, 0.35);

/**
 * Stamps one party's signature into its fields (16.13): the signature (the typed name in the open-licence
 * handwriting font, or the drawing), the printed name, "for and on behalf of" for the company, the date and the
 * reference. Characters the handwriting font lacks fall back to an oblique standard font.
 */
export async function stampSignature(
  pdf: Uint8Array,
  fields: SignatureField[],
  party: SigningParty,
  s: Stamp,
): Promise<Uint8Array> {
  const mine = fields.filter((f) => f.party === party);
  if (!mine.length) return pdf;
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);
  const pages = doc.getPages();
  let script: PDFFont | null = null;
  const image = s.method === 'drawn' && s.drawing ? await doc.embedPng(s.drawing) : null;
  if (!image) {
    const font = await doc.embedFont(signatureFont(), { subset: true });
    const covered = new Set(font.getCharacterSet());
    script = [...s.name].every((ch) => ch === ' ' || covered.has(ch.codePointAt(0)!)) ? font : null;
  }
  const fit = (font: PDFFont, text: string, width: number, max: number, min = 6) => {
    let size = max;
    while (size > min && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
    return size;
  };
  for (const f of mine) {
    const page = pages[f.page];
    if (!page) continue;
    if (f.kind === 'signature') {
      if (image) {
        const scale = Math.min(f.width / image.width, (f.height - 2) / image.height);
        page.drawImage(image, {
          x: f.x,
          y: f.y + 2,
          width: image.width * scale,
          height: image.height * scale,
        });
      } else {
        const font = script ?? oblique;
        const text = script ? s.name : winAnsiSafe(s.name);
        const size = fit(font, text, f.width - 4, Math.min(30, f.height - 8), 10);
        page.drawText(text, { x: f.x + 2, y: f.y + 6, size, font, color: PEN });
      }
      continue;
    }
    const text = winAnsiSafe(
      f.kind === 'name'
        ? s.name
        : f.kind === 'onBehalf'
          ? (s.onBehalf ?? '')
          : f.kind === 'date'
            ? s.date
            : f.kind === 'reference'
              ? s.reference
              : [s.name, s.onBehalf, s.date, s.reference].filter(Boolean).join(' - '),
    );
    if (!text) continue;
    if (f.kind === 'caption') {
      wrap(text, regular, 6.5, f.width)
        .slice(0, 2)
        .forEach((l, i) =>
          page.drawText(l, { x: f.x, y: f.y + f.height - 7 - i * 8, size: 6.5, font: regular, color: INK }),
        );
      continue;
    }
    page.drawText(text, {
      x: f.x + 2,
      y: f.y + 2,
      size: fit(regular, text, f.width, 9.5),
      font: regular,
      color: INK,
    });
  }
  return doc.save({ useObjectStreams: false });
}

// ---- the signature certificate (ADR-0168, ADR-0169) ----------------------------------------------------------

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
    // how they signed (typed in the handwriting font, or drawn), when known
    ...(L.method ? [L.method] : []),
    '',
    ...wrap(L.statement ?? '', font, 11, 595.28 - 112),
  ];
  writeLines(doc, lines, font, bold);
  return doc.save({ useObjectStreams: false });
}
