import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** Opaque bearer tokens carry the tenant id so the tenant context can be set before lookup (under RLS). */
/** Prefix of one-time sign-in (magic link and invitation) tokens. */
export const MAGIC_PREFIX = 'm_';

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
export function composeToken(prefix: string, tenantId: string, secret: string): string {
  return `${prefix}${tenantId}.${secret}`;
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function parseToken(prefix: string, value: string | undefined): { tenantId: string; secret: string } | undefined {
  if (!value) return undefined;
  const m = new RegExp(`^${prefix}(${UUID})\\.([A-Za-z0-9_-]{20,})$`, 'i').exec(value.trim());
  return m ? { tenantId: m[1]!.toLowerCase(), secret: m[2]! } : undefined;
}
export function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => argonHash(pw, ARGON);
export const verifyPassword = (stored: string, pw: string) => argonVerify(stored, pw).catch(() => false);

/** Hash used when the user does not exist, so timing does not reveal account existence. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(pw: string) {
  dummyHash ??= hashPassword('not-a-real-password-for-timing');
  await verifyPassword(await dummyHash, pw);
}

/** Minimal password policy (ASVS 2.1): 12+ chars, not trivially common. Max 128. */
const COMMON = new Set(['password1234', '123456789012', 'qwertyuiopas', 'passwordpassword', 'letmein12345']);
export function passwordProblems(pw: string): string[] {
  const problems: string[] = [];
  if (pw.length < 12) problems.push('tooShort');
  if (pw.length > 128) problems.push('tooLong');
  if (COMMON.has(pw.toLowerCase())) problems.push('tooCommon');
  return problems;
}
