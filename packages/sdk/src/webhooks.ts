import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Thapsus-HR webhook or audit-stream signature.
 *
 *   Thapsus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]
 *
 * Pass the RAW request body (the exact bytes received, before JSON parsing). During a secret rotation
 * the header carries one v1 per active secret; pass every secret you accept. Timestamps outside the
 * tolerance (default 5 minutes) are rejected to stop replays.
 */
export interface VerifyOptions {
  payload: string | Uint8Array;
  header: string | null | undefined;
  secrets: string[];
  toleranceSeconds?: number;
  /** Current time in seconds (for tests). */
  now?: number;
}

export function verifyWebhookSignature(o: VerifyOptions): boolean {
  if (!o.header || !o.secrets.length) return false;
  const parts = o.header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  });
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(t) || Math.abs(now - t) > (o.toleranceSeconds ?? 300)) return false;
  const body = typeof o.payload === 'string' ? Buffer.from(o.payload, 'utf8') : Buffer.from(o.payload);
  const given = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v, 'hex'));
  return o.secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
    return given.some((g) => timingSafeEqual(g, expected));
  });
}
