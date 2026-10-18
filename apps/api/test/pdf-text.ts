import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFObject } from 'pdf-lib';

/**
 * Extracts the text drawn on each page of a PDF produced by pdf-lib with standard fonts (content
 * streams are Flate-compressed; strings are hex- or literal-encoded WinAnsi). Test helper only.
 */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: Array<PDFObject | undefined> = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    const lines: string[] = [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(s.contents);
      const ops = (s.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? inflateSync(raw) : raw).toString('latin1');
      for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
        lines.push(m[1] !== undefined ? Buffer.from(m[1], 'hex').toString('latin1') : m[2]!.replace(/\\(.)/g, '$1'));
      }
    }
    return lines.join('\n');
  });
}

/** All page text joined, whitespace collapsed (wrapped lines become single spaces). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  return (await pdfPageTexts(bytes)).join('\n').replace(/\s+/g, ' ').trim();
}
