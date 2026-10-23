import JSZip from 'jszip';

/**
 * Zip archives from untrusted uploads (ASVS V5.2.3, ADR-0133). Before anything is inflated, the
 * number of entries is read from the end-of-central-directory record (ZIP64 included), so an archive
 * listing too many files is refused without building its directory. Entries are then inflated one at
 * a time with a running byte budget per entry and for the whole archive (or a shared budget across
 * several archives); the sizes an archive declares are never trusted.
 */
export interface ZipLimits {
  /** Most entries (files, folders and metadata) the archive may list. */
  maxEntries: number;
  /** Most bytes one entry may inflate to. */
  maxEntryBytes: number;
  /** Most bytes all entries together may inflate to. */
  maxTotalBytes: number;
}

export type ZipProblem = 'badArchive' | 'tooManyEntries' | 'tooLarge';

export const isZipArchive = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

/** Entry count from the end-of-central-directory record, or undefined when the archive is malformed. */
export function declaredEntryCount(buf: Buffer): number | undefined {
  // EOCD is 22 bytes plus a comment of up to 65,535 bytes, at the very end of the file.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const total = buf.readUInt16LE(i + 10);
    const size = buf.readUInt32LE(i + 12);
    if (total !== 0xffff && size !== 0xffffffff) return total;
    // ZIP64: the locator sits just before the EOCD record and points at the ZIP64 EOCD record.
    const loc = i - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== ZIP64_LOCATOR) return undefined;
    const at = Number(buf.readBigUInt64LE(loc + 8));
    if (!Number.isSafeInteger(at) || at < 0 || at + 56 > buf.length || buf.readUInt32LE(at) !== ZIP64_EOCD) return undefined;
    const total64 = buf.readBigUInt64LE(at + 32);
    return total64 > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total64);
  }
  return undefined;
}

/** A shared inflation budget (bytes still allowed), for several archives in one request. */
export class InflateBudget {
  constructor(public remaining: number) {}
}

/**
 * Inflates one entry, stopping as soon as it exceeds `limit` bytes or the budget runs out. With
 * `keep` false the bytes are counted and dropped (a bounds check holds no more than one chunk).
 */
function inflateBounded(entry: JSZip.JSZipObject, limit: number, budget: InflateBudget, keep: boolean): Promise<Buffer | 'tooLarge' | 'badArchive'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      budget.remaining -= c.length;
      if (size > limit || budget.remaining < 0) {
        done = true;
        (stream as unknown as { pause(): void }).pause();
        resolve('tooLarge');
        return;
      }
      if (keep) chunks.push(c);
    });
    stream.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    stream.on('error', () => {
      if (!done) resolve('badArchive');
      done = true;
    });
  });
}

export interface OpenedZip {
  /** File entries (folders excluded), in archive order. */
  entries: JSZip.JSZipObject[];
  /** Inflates one entry within the limits; 'tooLarge' when it would exceed them. */
  inflate(entry: JSZip.JSZipObject, opts?: { keep?: boolean }): Promise<Buffer | 'tooLarge' | 'badArchive'>;
}

/** Opens an archive after checking its entry count; nothing is inflated yet. */
export async function openZip(buf: Buffer, limits: ZipLimits, budget = new InflateBudget(limits.maxTotalBytes)): Promise<OpenedZip | ZipProblem> {
  const count = declaredEntryCount(buf);
  if (count === undefined) return 'badArchive';
  if (count > limits.maxEntries) return 'tooManyEntries';
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return 'badArchive';
  }
  const all = Object.values(zip.files);
  // the directory JSZip read must agree with the record we checked
  if (all.length > limits.maxEntries) return 'tooManyEntries';
  return {
    entries: all.filter((e) => !e.dir),
    inflate: (entry, opts) => inflateBounded(entry, limits.maxEntryBytes, budget, opts?.keep ?? true),
  };
}

/**
 * For formats that are zip containers (xlsx, docx): proves the whole archive inflates within the
 * limits before a parser that inflates everything at once is allowed to open it.
 */
export async function checkZipBounds(buf: Buffer, limits: ZipLimits): Promise<ZipProblem | undefined> {
  const zip = await openZip(buf, limits);
  if (typeof zip === 'string') return zip;
  for (const e of zip.entries) {
    const body = await zip.inflate(e, { keep: false });
    if (typeof body === 'string') return body;
  }
  return undefined;
}
