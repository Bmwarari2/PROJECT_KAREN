import { createHmac, timingSafeEqual } from 'node:crypto';
import { newToken } from '../modules/auth/tokens';

/**
 * HMAC-SHA256 signatures for webhooks and HTTPS audit streams (docs/api.md#verifying-signatures).
 *
 *   Thapsus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=<…>]
 *
 * During a secret rotation the header carries one v1 per active secret, so receivers can switch to
 * the new secret at any point in the overlap window. Receivers reject timestamps older than 5 minutes.
 */
export const SIGNATURE_HEADER = 'thapsus-signature';
export const SIGNING_SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function newSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${newToken(32)}`;
}

function hmac(secret: string, timestamp: number, body: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function signatureHeader(secrets: string[], body: string | Buffer, timestamp: number): string {
  if (!secrets.length) throw new Error('no signing secret');
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${hmac(s, timestamp, body)}`)].join(',');
}

/** Reference verification (the SDK ships the same algorithm as verifyWebhookSignature). */
export function verifySignature(header: string | undefined, body: string | Buffer, secret: string, nowSeconds: number, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=', 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, t, body), 'hex');
  return parts.some(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v) && timingSafeEqual(Buffer.from(v, 'hex'), expected));
}
