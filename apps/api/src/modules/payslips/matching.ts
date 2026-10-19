import JSZip from 'jszip';

/**
 * Matching uploaded payslip / year-end files to employees.
 *  - `employee_number`: the file name (without extension) contains an employee number as a whole token,
 *    e.g. "E000123_2026-03.pdf", "payslip-EMP-42-march.pdf". Separators are any non-alphanumeric run.
 *  - `pattern`: a customer regex applied to the file name; the named group `employeeNumber` (or the
 *    first capture group) is the employee number, e.g. "^(?<employeeNumber>\\d{6})_P60".
 * Matching is case-insensitive; more than one distinct employee is "ambiguous" and never guessed.
 */
export type MatchBy = 'employee_number' | 'pattern';

export function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

/** Candidate employee numbers in a file name: every run of 1–4 adjacent tokens with its original separators. */
export function candidates(fileName: string, by: MatchBy, pattern?: string | null): string[] {
  const stem = stemOf(fileName).slice(0, 200);
  if (by === 'pattern') {
    if (!pattern) return [];
    const m = compilePattern(pattern).exec(stem);
    const v = m?.groups?.employeeNumber ?? m?.[1];
    return v ? [v.toLowerCase()] : [];
  }
  const parts = stem.split(/([^A-Za-z0-9]+)/); // tokens at even indexes, separators at odd
  const tokens: Array<{ text: string; index: number }> = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i]) tokens.push({ text: parts[i]!, index: i });
  const out = new Set<string>();
  for (let a = 0; a < tokens.length; a++) {
    for (let b = a; b < Math.min(tokens.length, a + 4); b++) out.add(parts.slice(tokens[a]!.index, tokens[b]!.index + 1).join('').toLowerCase());
  }
  return [...out];
}

export function compilePattern(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error('Pattern too long');
  return new RegExp(pattern, 'i');
}

export interface MatchResult {
  status: 'matched' | 'unmatched' | 'ambiguous';
  employeeId: string | null;
  detail: { employeeNumber?: string; reason?: string; candidates?: number };
}

export function decide(fileName: string, by: MatchBy, pattern: string | null, numbers: Map<string, { id: string; employeeNumber: string }>): MatchResult {
  const found = new Map<string, string>();
  for (const c of candidates(fileName, by, pattern)) {
    const e = numbers.get(c);
    if (e) found.set(e.id, e.employeeNumber);
  }
  if (found.size === 1) {
    const [[employeeId, employeeNumber]] = [...found.entries()] as [[string, string]];
    return { status: 'matched', employeeId, detail: { employeeNumber } };
  }
  if (found.size > 1) return { status: 'ambiguous', employeeId: null, detail: { reason: 'severalEmployees', candidates: found.size } };
  return { status: 'unmatched', employeeId: null, detail: { reason: 'noEmployeeNumber' } };
}

// ---- reading uploads (PDFs, or zip archives of PDFs) ----------------------------------------------------------------------
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL = 200 * 1024 * 1024;
export const MAX_FILES = 1000;

export const isPdf = (b: Buffer) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
export const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export interface UploadedFile {
  name: string;
  body: Buffer;
}
export interface Rejected {
  name: string;
  reason: 'notPdf' | 'tooLarge' | 'tooMany' | 'duplicate' | 'badArchive';
}

/** Inflates one entry, stopping as soon as it exceeds `limit` (header sizes in a zip can lie). */
function readBounded(entry: JSZip.JSZipObject, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        (stream as unknown as { pause(): void }).pause();
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Expands zip archives (guarding against zip bombs by declared sizes) and keeps only real PDFs. */
export async function expandUploads(files: UploadedFile[]): Promise<{ accepted: UploadedFile[]; rejected: Rejected[] }> {
  const accepted: UploadedFile[] = [];
  const rejected: Rejected[] = [];
  const add = (f: UploadedFile) => {
    if (accepted.length >= MAX_FILES) return rejected.push({ name: f.name, reason: 'tooMany' });
    if (f.body.length > MAX_FILE_BYTES) return rejected.push({ name: f.name, reason: 'tooLarge' });
    if (!isPdf(f.body)) return rejected.push({ name: f.name, reason: 'notPdf' });
    accepted.push(f);
  };
  for (const f of files) {
    if (!isZip(f.body)) {
      add(f);
      continue;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(f.body);
    } catch {
      rejected.push({ name: f.name, reason: 'badArchive' });
      continue;
    }
    let total = 0;
    const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith('__MACOSX/') && !(e.name.split('/').pop() ?? '').startsWith('.'));
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const declared = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      total += declared;
      const name = e.name.split('/').pop()!;
      if (declared > MAX_FILE_BYTES || total > MAX_ARCHIVE_TOTAL) {
        rejected.push({ name, reason: 'tooLarge' });
        continue;
      }
      const body = await readBounded(e, MAX_FILE_BYTES);
      if (!body) {
        rejected.push({ name, reason: 'tooLarge' });
        continue;
      }
      add({ name, body });
    }
  }
  return { accepted, rejected };
}
