/**
 * Upload type detection from the bytes (ASVS V5.2.2), for uploads where the declared type and the file name
 * are not trusted at all: the type is whatever the content is, and only allow-listed types are accepted.
 * Text formats are never sniffed as acceptable here (anything is "text"); documents people attach are PDFs,
 * images or Word files.
 */
export const SNIFFABLE_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
} as const;
export type SniffedType = keyof typeof SNIFFABLE_TYPES;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

/** The type of the content, or null when it is none of the types above. */
export function sniffType(b: Buffer): SniffedType | null {
  if (b.length < 8) return null;
  // PDF: the header may follow a little leading junk (PDF 32000-1 §7.5.2 readers look in the first 1024 bytes).
  if (ascii(b, 0, 1024).includes('%PDF-')) return 'application/pdf';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  // DOCX is a zip whose parts include [Content_Types].xml and word/…; any other zip (xlsx, apk, jar) is refused.
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const names = ascii(b, 0, Math.min(b.length, 2 * 1024 * 1024));
    if (names.includes('[Content_Types].xml') && names.includes('word/')) return DOCX;
  }
  return null;
}

/** Types a browser can show inline in the document viewer (everything else shows details and a download). */
export const VIEWABLE_TYPES = new Set<string>(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/**
 * A safe display and download name for an upload (ASVS V5.3.2): the last path segment only, no control or
 * reserved characters, no leading dots, at most 120 characters, and the extension of the detected type in
 * place of whatever the client sent (so `passport.pdf.exe` that is really a PDF becomes `passport.pdf.pdf`,
 * and nothing is ever saved under an executable extension).
 */
export function sanitiseFileName(name: string, type: SniffedType): string {
  const ext = SNIFFABLE_TYPES[type];
  const last = (name.split(/[\\/]/).pop() ?? '').normalize('NFC');
  const base = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*;]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '') // zero-width and bidi overrides (spoofed names)
    .replace(/\s+/g, ' ')
    .replace(/\.(pdf|png|jpe?g|webp|docx)$/i, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120 - ext.length);
  return `${base || 'document'}${ext}`;
}
