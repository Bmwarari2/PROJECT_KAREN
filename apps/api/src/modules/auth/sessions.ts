import { withTenant, type TenantRouter, type Tx } from '@thapsus/db';
import type { Principal } from '@thapsus/core/permissions';
import { isAdmin } from '@thapsus/core/permissions';
import { composeToken, hashToken, newToken, parseToken } from './tokens';
import { loadPrincipal } from '../authz/principal';

export const SESSION_PREFIX = 's_';
/**
 * Sensitive account changes (second factors, a first password, ending sessions) need an
 * authentication no older than this: the sign-in itself or POST /v1/auth/reauth (ASVS V7.5.1).
 */
export const REAUTH_WINDOW_MINUTES = 10;

export interface TenantSecurity {
  ssoEnforced: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  trustIdpMfa: boolean;
  geofenceAllowedCountries?: string[];
}

export const DEFAULT_SECURITY: TenantSecurity = {
  ssoEnforced: false,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 12,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
  trustIdpMfa: true,
};

export async function loadSecurity(tx: Tx): Promise<TenantSecurity> {
  const row = await tx.maybe<{ security: Partial<TenantSecurity> }>('SELECT security FROM app.tenants');
  return { ...DEFAULT_SECURITY, ...(row?.security ?? {}) };
}

export type AuthMethod =
  'password' | 'passkey' | 'magic_link' | 'oidc' | 'saml' | 'support' | 'api_key' | 'oauth_client';

/** Set for machine callers (scoped API key or OAuth 2.0 client credentials token); see modules/platform/api-auth.ts. */
export interface ApiClientInfo {
  /** API key id or OAuth client id (stable; used as the audit actor id and idempotency scope). */
  id: string;
  kind: 'api_key' | 'oauth_client';
  name: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  method: AuthMethod;
  mfaVerified: boolean;
  hasMfaFactor: boolean;
  /** When this session last proved the user's identity (sign-in or re-authentication). */
  authenticatedAt: Date;
  principal: Principal;
  user: {
    email: string;
    displayName: string;
    locale: string | null;
    timeZone: string | null;
    employeeId: string | null;
  };
  apiClient?: ApiClientInfo;
}

export async function createSession(
  tx: Tx,
  opts: {
    userId: string;
    tenantId: string;
    method: AuthMethod;
    mfaVerified: boolean;
    ip?: string;
    userAgent?: string;
    now: Date;
  },
): Promise<string> {
  const security = await loadSecurity(tx);
  const secret = newToken();
  const idle = new Date(opts.now.getTime() + security.sessionIdleMinutes * 60_000);
  const absolute = new Date(opts.now.getTime() + security.sessionAbsoluteHours * 3_600_000);
  await tx.exec(
    `INSERT INTO app.sessions (tenant_id, user_id, token_hash, auth_method, mfa_verified_at, created_at, last_seen_at,
       idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
    [
      opts.userId,
      hashToken(secret),
      opts.method,
      opts.mfaVerified ? opts.now : null,
      opts.now,
      idle < absolute ? idle : absolute,
      absolute,
      opts.ip ?? null,
      opts.userAgent?.slice(0, 512) ?? null,
    ],
  );
  await tx.exec(
    'UPDATE app.users SET last_login_at = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [opts.userId, opts.now],
  );
  return composeToken(SESSION_PREFIX, opts.tenantId, secret);
}

/**
 * Resolves and slides a session. Returns undefined when missing, revoked, idle-expired or past its
 * absolute lifetime. Idle expiry slides at most once a minute to keep writes low.
 */
export async function resolveSession(
  router: TenantRouter,
  token: string | undefined,
  now: Date,
): Promise<AuthContext | undefined> {
  const parsed = parseToken(SESSION_PREFIX, token);
  if (!parsed) return undefined;
  try {
    return await withTenant(router, parsed.tenantId, async (tx) => {
      const s = await tx.maybe<{
        id: string;
        user_id: string;
        auth_method: AuthMethod;
        mfa_verified_at: string | null;
        last_seen_at: string;
        idle_expires_at: string;
        absolute_expires_at: string;
        revoked_at: string | null;
        created_at: string;
        reauthenticated_at: string | null;
        email: string;
        display_name: string;
        locale: string | null;
        time_zone: string | null;
        employee_id: string | null;
        status: string;
      }>(
        `SELECT s.id, s.user_id, s.auth_method, s.mfa_verified_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
                s.revoked_at, s.created_at, s.reauthenticated_at, u.email, u.display_name, u.locale, u.time_zone, u.employee_id, u.status
           FROM app.sessions s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
          WHERE s.token_hash = $1`,
        [hashToken(parsed.secret)],
      );
      if (!s || s.revoked_at || s.status !== 'active') return undefined;
      if (now >= new Date(s.idle_expires_at) || now >= new Date(s.absolute_expires_at)) return undefined;
      if (now.getTime() - new Date(s.last_seen_at).getTime() > 60_000) {
        const security = await loadSecurity(tx);
        const idle = new Date(
          Math.min(
            now.getTime() + security.sessionIdleMinutes * 60_000,
            new Date(s.absolute_expires_at).getTime(),
          ),
        );
        await tx.exec('UPDATE app.sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [
          s.id,
          now,
          idle,
        ]);
      }
      const factor = await tx.maybe(
        `SELECT 1 FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NOT NULL
         UNION ALL SELECT 1 FROM app.passkeys WHERE user_id = $1 LIMIT 1`,
        [s.user_id],
      );
      const principal = await loadPrincipal(tx, s.user_id);
      return {
        tenantId: parsed.tenantId,
        userId: s.user_id,
        sessionId: s.id,
        method: s.auth_method,
        mfaVerified: !!s.mfa_verified_at,
        hasMfaFactor: !!factor,
        authenticatedAt: new Date(
          Math.max(
            new Date(s.created_at).getTime(),
            s.reauthenticated_at ? new Date(s.reauthenticated_at).getTime() : 0,
          ),
        ),
        principal,
        user: {
          email: s.email,
          displayName: s.display_name,
          locale: s.locale,
          timeZone: s.time_zone,
          employeeId: s.employee_id,
        },
      } satisfies AuthContext;
    });
  } catch {
    return undefined;
  }
}

/** Ends a user's sessions (all of them, or all but `exceptSessionId`); returns how many were ended. */
export async function revokeUserSessions(tx: Tx, userId: string, exceptSessionId?: string): Promise<number> {
  return tx.exec(
    'UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [userId, exceptSessionId ?? null],
  );
}

/** True when the session proved the user's identity within REAUTH_WINDOW_MINUTES. */
export function recentlyAuthenticated(auth: AuthContext, now: Date): boolean {
  return now.getTime() - auth.authenticatedAt.getTime() <= REAUTH_WINDOW_MINUTES * 60_000;
}

/**
 * The second-factor gate, applied to every route except MFA setup (ASVS V6.3.3, V6.4.3):
 *  - anyone with a verified second factor must use it in this session, whatever the sign-in path
 *    (password, magic link or SSO without trusted IdP MFA), so no path skips an enabled factor;
 *  - admins without a factor must enrol one first.
 */
export function mfaGate(auth: AuthContext): 'ok' | 'mfaRequired' | 'mfaEnrollmentRequired' {
  if (auth.mfaVerified) return 'ok';
  if (auth.hasMfaFactor) return 'mfaRequired';
  return isAdmin(auth.principal) ? 'mfaEnrollmentRequired' : 'ok';
}
