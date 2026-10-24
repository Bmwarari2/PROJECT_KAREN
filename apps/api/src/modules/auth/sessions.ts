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
  /** Count an SSO sign-in as two-step only when the identity provider asserts it (amr/acr). */
  trustIdpMfa: boolean;
  /** Everyone, not only admins, must set up and use a second factor (plan 2.1.2, ASVS V6.3.3). */
  requireMfaForEveryone: boolean;
  geofenceAllowedCountries?: string[];
}

/**
 * Sign-in policy defaults by `app.tenants.security_defaults_version` (migration 0024, ADR-0170). A tenant's
 * `security` JSON holds only what its admins chose; everything else comes from its version's defaults.
 * Version 1 is every workspace created before 2026-10-23 and keeps its behaviour until then; version 2 is
 * every workspace created since, with two-step verification for everyone and "Trust IdP MFA" off.
 */
export const SECURITY_DEFAULTS: Record<1 | 2, TenantSecurity> = {
  1: {
    ssoEnforced: false,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 12,
    lockoutThreshold: 5,
    lockoutMinutes: 15,
    trustIdpMfa: true,
    requireMfaForEveryone: false,
  },
  2: {
    ssoEnforced: false,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 12,
    lockoutThreshold: 5,
    lockoutMinutes: 15,
    trustIdpMfa: false,
    requireMfaForEveryone: true,
  },
};
/** The defaults new workspaces get. */
export const DEFAULT_SECURITY: TenantSecurity = SECURITY_DEFAULTS[2];
export const CURRENT_SECURITY_DEFAULTS_VERSION = 2;
/** Written explicitly by every path that creates a workspace (sign-up, the provisioning CLI, the staging seed). */
export const NEW_WORKSPACE_SECURITY: Partial<TenantSecurity> = {
  requireMfaForEveryone: true,
  trustIdpMfa: false,
};

export function securityFrom(
  security: Partial<TenantSecurity> | null | undefined,
  version: number | null | undefined,
): TenantSecurity {
  const defaults = SECURITY_DEFAULTS[version === 1 ? 1 : 2];
  return { ...defaults, ...(security ?? {}) };
}

export async function loadSecurity(tx: Tx): Promise<TenantSecurity> {
  const row = await tx.maybe<{ security: Partial<TenantSecurity>; security_defaults_version: number }>(
    'SELECT security, security_defaults_version FROM app.tenants',
  );
  return securityFrom(row?.security, row?.security_defaults_version);
}

/**
 * Admin sessions are shorter than the workspace's (plan 2.1.5, ADR-0173): at most 15 idle minutes and 8
 * hours in all, whatever the sign-in policy allows, because an admin session can change everyone's data.
 */
export const ADMIN_IDLE_MINUTES = 15;
export const ADMIN_ABSOLUTE_HOURS = 8;

export function sessionLimits(security: TenantSecurity, admin: boolean) {
  return {
    idleMinutes: admin
      ? Math.min(ADMIN_IDLE_MINUTES, security.sessionIdleMinutes)
      : security.sessionIdleMinutes,
    absoluteHours: admin
      ? Math.min(ADMIN_ABSOLUTE_HOURS, security.sessionAbsoluteHours)
      : security.sessionAbsoluteHours,
  };
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
  /** The workspace requires everyone to use a second factor (not only admins). */
  requireMfaForEveryone?: boolean;
  /**
   * An admin session whose network (autonomous system) differs from the one it last authenticated
   * from; it must re-authenticate before anything else (ADR-0173). Only set when the cell has the signal.
   */
  networkChanged?: boolean;
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
    /** The client's network (autonomous system), when the cell has that signal. */
    network?: string;
    now: Date;
  },
): Promise<string> {
  const security = await loadSecurity(tx);
  const limits = sessionLimits(security, isAdmin(await loadPrincipal(tx, opts.userId)));
  const secret = newToken();
  const idle = new Date(opts.now.getTime() + limits.idleMinutes * 60_000);
  const absolute = new Date(opts.now.getTime() + limits.absoluteHours * 3_600_000);
  await tx.exec(
    `INSERT INTO app.sessions (tenant_id, user_id, token_hash, auth_method, mfa_verified_at, created_at, last_seen_at,
       idle_expires_at, absolute_expires_at, ip, user_agent, network)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10)`,
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
      opts.network ?? null,
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
  client: { network?: string } = {},
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
        network: string | null;
        security: Partial<TenantSecurity> | null;
        security_defaults_version: number;
      }>(
        `SELECT s.id, s.user_id, s.auth_method, s.mfa_verified_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
                s.revoked_at, s.created_at, s.reauthenticated_at, s.network, u.email, u.display_name, u.locale, u.time_zone,
                u.employee_id, u.status, t.security, t.security_defaults_version
           FROM app.sessions s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
           JOIN app.tenants t ON t.tenant_id = s.tenant_id
          WHERE s.token_hash = $1`,
        [hashToken(parsed.secret)],
      );
      if (!s || s.revoked_at || s.status !== 'active') return undefined;
      if (now >= new Date(s.idle_expires_at) || now >= new Date(s.absolute_expires_at)) return undefined;
      const principal = await loadPrincipal(tx, s.user_id);
      const admin = isAdmin(principal);
      const security = securityFrom(s.security, s.security_defaults_version);
      const limits = sessionLimits(security, admin);
      // Someone who became an admin during the session gets the admin limits from now on.
      const lastSeen = new Date(s.last_seen_at).getTime();
      if (admin) {
        if (now.getTime() - lastSeen >= limits.idleMinutes * 60_000) return undefined;
        if (now.getTime() - new Date(s.created_at).getTime() >= limits.absoluteHours * 3_600_000)
          return undefined;
      }
      if (now.getTime() - lastSeen > 60_000) {
        const absolute = Math.min(
          new Date(s.absolute_expires_at).getTime(),
          new Date(s.created_at).getTime() + limits.absoluteHours * 3_600_000,
        );
        const idle = new Date(Math.min(now.getTime() + limits.idleMinutes * 60_000, absolute));
        await tx.exec(
          'UPDATE app.sessions SET last_seen_at = $2, idle_expires_at = $3, absolute_expires_at = $4 WHERE id = $1',
          [s.id, now, idle, new Date(absolute)],
        );
      }
      // The first request that carries a network signal records it; a later change matters for admins.
      if (client.network && !s.network)
        await tx.exec('UPDATE app.sessions SET network = $2 WHERE id = $1', [s.id, client.network]);
      const networkChanged = admin && !!client.network && !!s.network && client.network !== s.network;
      const factor = await tx.maybe(
        `SELECT 1 FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NOT NULL
         UNION ALL SELECT 1 FROM app.passkeys WHERE user_id = $1 LIMIT 1`,
        [s.user_id],
      );
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
        requireMfaForEveryone: security.requireMfaForEveryone,
        networkChanged: networkChanged || undefined,
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

/** Whether this person must have and use a second factor: every admin, and everyone when the workspace says so. */
export function mustUseMfa(principal: Principal, security: Pick<TenantSecurity, 'requireMfaForEveryone'>) {
  return isAdmin(principal) || security.requireMfaForEveryone;
}

/**
 * The second-factor gate, applied to every route except MFA setup (ASVS V6.3.3, V6.4.3):
 *  - anyone with a verified second factor must use it in this session, whatever the sign-in path
 *    (password, magic link, a password reset, or SSO without IdP-asserted MFA), so no path skips it;
 *  - admins without a factor, and everyone when the workspace requires it, must enrol one first.
 */
export function mfaGate(auth: AuthContext): 'ok' | 'mfaRequired' | 'mfaEnrollmentRequired' {
  if (auth.mfaVerified) return 'ok';
  if (auth.hasMfaFactor) return 'mfaRequired';
  return mustUseMfa(auth.principal, { requireMfaForEveryone: !!auth.requireMfaForEveryone })
    ? 'mfaEnrollmentRequired'
    : 'ok';
}

/** What a fresh sign-in still has to do before the app opens (returned by every sign-in route). */
export async function signInNextStep(
  tx: Tx,
  userId: string,
  mfaVerified = false,
): Promise<{ mfaRequired: boolean; mfaEnrollmentRequired: boolean }> {
  if (mfaVerified) return { mfaRequired: false, mfaEnrollmentRequired: false };
  const factor = await tx.maybe(
    `SELECT 1 FROM app.totp_factors WHERE user_id = $1 AND verified_at IS NOT NULL UNION ALL SELECT 1 FROM app.passkeys WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (factor) return { mfaRequired: true, mfaEnrollmentRequired: false };
  const must = mustUseMfa(await loadPrincipal(tx, userId), await loadSecurity(tx));
  return { mfaRequired: false, mfaEnrollmentRequired: must };
}
