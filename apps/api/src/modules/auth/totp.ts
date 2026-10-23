import * as OTPAuth from 'otpauth';
import { withTenant } from '@thapsus/db';
import { t } from '@thapsus/core/i18n';
import type { Deps } from '../../deps';
import { open, type Envelope } from '../../lib/kms';

/** RFC 6238 TOTP: SHA-1, 6 digits, 30-second steps, ±1 step of clock drift. */
export const totpFor = (secret: string, label: string) =>
  new OTPAuth.TOTP({ issuer: t('en-GB', 'common.appName'), label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });

/** KMS encryption context binding a TOTP seed to its tenant and user. */
export const totpContext = (tenantId: string, userId: string) => ({ tenant: tenantId, purpose: 'totp', user: userId });

/**
 * Checks a code against the user's verified (or pending) factors. Each time step is accepted once:
 * the last used step is stored, so a code cannot be replayed (ASVS V6.5.1).
 */
export async function checkTotp(deps: Deps, tenantId: string, userId: string, code: string, factorFilter: 'verified' | 'pending'): Promise<boolean> {
  return withTenant(deps.router, tenantId, async (tx) => {
    const factors = await tx.query<{ id: string; secret_enc: Envelope; last_used_step: string | null }>(
      `SELECT id, secret_enc, last_used_step FROM app.totp_factors WHERE user_id = $1 AND verified_at IS ${factorFilter === 'verified' ? 'NOT ' : ''}NULL`,
      [userId],
    );
    for (const f of factors) {
      const secret = await open(deps.keys, f.secret_enc, totpContext(tenantId, userId));
      const delta = totpFor(secret, 'x').validate({ token: code, timestamp: deps.now().getTime(), window: 1 });
      if (delta === null) continue;
      const step = Math.floor(deps.now().getTime() / 30_000) + delta;
      if (f.last_used_step && step <= Number(f.last_used_step)) continue; // replay
      await tx.exec('UPDATE app.totp_factors SET last_used_step = $2, verified_at = coalesce(verified_at, now()) WHERE id = $1', [f.id, step]);
      return true;
    }
    return false;
  });
}
