import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './kms';

/**
 * Field-level encryption for sensitive files (ADR-0166): the same envelope scheme as vault values (lib/kms
 * seal/open) applied to a file's bytes before they reach the object store. A fresh 256-bit data key per file is
 * wrapped by the cell's regional KMS key with the file's context (tenant, subject, category, field) as the
 * encryption context, and the bytes are sealed with AES-256-GCM bound to the same context as AAD. The stored
 * object is self-describing so the company export can open it:
 *
 *   THRSEAL1\n{"v":1,"kid":…,"wdek":…,"iv":…,"tag":…,"ctx":{…}}\n<ciphertext>
 *
 * The header holds no personal data: ids and the category only.
 */
const MAGIC = Buffer.from('THRSEAL1\n', 'latin1');

export type SealedFileContext = { tenant: string; subject: string; category: string; field: string };
interface Header {
  v: 1;
  kid: string;
  wdek: string;
  iv: string;
  tag: string;
  ctx: SealedFileContext;
}

const aad = (ctx: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(ctx).sort()));

export const isSealedFile = (b: Buffer) =>
  b.length > MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC);

export async function sealFile(kp: KeyProvider, bytes: Buffer, ctx: SealedFileContext): Promise<Buffer> {
  const { plaintext: dek, wrapped } = await kp.generateDataKey(ctx);
  try {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    c.setAAD(aad(ctx));
    const ct = Buffer.concat([c.update(bytes), c.final()]);
    const header: Header = {
      v: 1,
      kid: kp.keyId,
      wdek: wrapped.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      ctx,
    };
    return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(header) + '\n', 'utf8'), ct]);
  } finally {
    dek.fill(0);
  }
}

function parse(sealed: Buffer): { header: Header; ct: Buffer } {
  if (!isSealedFile(sealed)) throw new Error('not a sealed file');
  const end = sealed.indexOf(0x0a, MAGIC.length);
  if (end < 0) throw new Error('sealed file header is incomplete');
  const header = JSON.parse(sealed.subarray(MAGIC.length, end).toString('utf8')) as Header;
  if (header.v !== 1) throw new Error('unknown sealed file version');
  return { header, ct: sealed.subarray(end + 1) };
}

/** The context a sealed file was sealed under (for the company export, which opens every file it finds). */
export const sealedFileContext = (sealed: Buffer): SealedFileContext => parse(sealed).header.ctx;

/**
 * Opens a sealed file. With `expected`, the file must have been sealed under exactly that context, so a sealed
 * object cannot be swapped for another person's or another field's (the AAD and the KMS context enforce the same).
 */
export async function openFile(
  kp: KeyProvider,
  sealed: Buffer,
  expected?: SealedFileContext,
): Promise<Buffer> {
  const { header, ct } = parse(sealed);
  const ctx = expected ?? header.ctx;
  if (expected && JSON.stringify(aad(expected)) !== JSON.stringify(aad(header.ctx)))
    throw new Error('sealed file context does not match');
  const dek = await kp.decryptDataKey(Buffer.from(header.wdek, 'base64'), ctx);
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(header.iv, 'base64'));
    d.setAAD(aad(ctx));
    d.setAuthTag(Buffer.from(header.tag, 'base64'));
    return Buffer.concat([d.update(ct), d.final()]);
  } finally {
    dek.fill(0);
  }
}
