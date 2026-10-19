import { scopedPermissions } from '@thapsus/core/api-scopes';
import type { FieldAccess, Principal, ScopeType } from '@thapsus/core/permissions';
import { featureEnabled, withTenant, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import type { AuthContext } from '../auth/sessions';
import { hashToken, parseToken } from '../auth/tokens';
import { rateLimitFor } from './config';

/**
 * Machine credentials for the public API (ADR-0090):
 *  - scoped API keys     thr_sk_<tenant id>.<secret>
 *  - OAuth access tokens thr_at_<tenant id>.<secret> (POST /v1/oauth/token, client credentials)
 * Both carry the tenant id, so the tenant context is set before the hashed lookup under forced RLS,
 * and both resolve to an `api_client` principal whose permissions are the role ∩ the scopes.
 */
export const API_KEY_PREFIX = 'thr_sk_';
export const ACCESS_TOKEN_PREFIX = 'thr_at_';
export const CLIENT_ID_PREFIX = 'thr_ci_';
export const CLIENT_SECRET_PREFIX = 'thr_cs_';

export function isApiCredential(token: string | undefined): boolean {
  return !!token && (token.startsWith(API_KEY_PREFIX) || token.startsWith(ACCESS_TOKEN_PREFIX));
}

interface RoleRow {
  key: string;
  permissions: string[];
  field_access: Record<string, FieldAccess>;
}

export async function machinePrincipal(tx: Tx, c: { id: string; roleId: string; scopes: string[]; scopeType: ScopeType; scopeValues: string[] }): Promise<Principal> {
  const role = await tx.maybe<RoleRow>('SELECT key, permissions, field_access FROM app.roles WHERE id = $1', [c.roleId]);
  return {
    userId: c.id,
    employeeId: null,
    kind: 'api_client',
    delegatedFromEmployeeIds: [],
    grants: role
      ? [{ roleKey: `api:${role.key}`, isAdmin: false, permissions: scopedPermissions(role.permissions, c.scopes), fieldAccess: role.field_access, scope: { type: c.scopeType, values: c.scopeValues } }]
      : [],
  };
}

async function tenantApiSettings(tx: Tx) {
  const row = await tx.maybe<{ api: { rateLimitPerMinute?: number; plan?: string } | null; plan: string | null }>(`SELECT features->'api' AS api, features->>'plan' AS plan FROM app.tenants`);
  return { rateLimitPerMinute: rateLimitFor({ ...(row?.api ?? {}), plan: row?.api?.plan ?? row?.plan ?? undefined }) };
}

/** Resolves an API key or OAuth access token. Returns undefined when unknown, revoked or expired. */
export async function resolveApiCredential(deps: Deps, token: string): Promise<AuthContext | undefined> {
  const now = deps.now();
  const kind = token.startsWith(API_KEY_PREFIX) ? 'api_key' : 'oauth_client';
  const parsed = parseToken(kind === 'api_key' ? API_KEY_PREFIX : ACCESS_TOKEN_PREFIX, token);
  if (!parsed) return undefined;
  try {
    return await withTenant(deps.router, parsed.tenantId, async (tx) => {
      const hash = hashToken(parsed.secret);
      const cred =
        kind === 'api_key'
          ? await tx.maybe<{ id: string; credential_id: string; name: string; scopes: string[]; role_id: string; scope_type: ScopeType; scope_values: string[]; last_used_at: string | null }>(
              `SELECT id, id AS credential_id, name, scopes, role_id, scope_type, scope_values, last_used_at FROM app.api_keys
                WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
              [hash, now],
            )
          : await tx.maybe<{ id: string; credential_id: string; name: string; scopes: string[]; role_id: string; scope_type: ScopeType; scope_values: string[]; last_used_at: string | null }>(
              `SELECT c.id, t.id AS credential_id, c.name, t.scopes, c.role_id, c.scope_type, c.scope_values, c.last_used_at
                 FROM app.oauth_access_tokens t JOIN app.oauth_clients c ON c.tenant_id = t.tenant_id AND c.id = t.client_id
                WHERE t.token_hash = $1 AND t.expires_at > $2 AND c.revoked_at IS NULL`,
              [hash, now],
            );
      if (!cred) return undefined;
      if (!(await featureEnabled(tx, 'publicApi'))) throw new ApiError('forbidden', 'featureDisabled', { feature: 'publicApi' });
      // last-used is coarse (once a minute) to keep writes off the hot path
      if (!cred.last_used_at || now.getTime() - new Date(cred.last_used_at).getTime() > 60_000) {
        await tx.exec(`UPDATE ${kind === 'api_key' ? 'app.api_keys' : 'app.oauth_clients'} SET last_used_at = $2 WHERE id = $1`, [cred.id, now]);
      }
      const principal = await machinePrincipal(tx, { id: cred.id, roleId: cred.role_id, scopes: cred.scopes, scopeType: cred.scope_type, scopeValues: cred.scope_values });
      const settings = await tenantApiSettings(tx);
      return {
        tenantId: parsed.tenantId,
        userId: cred.id,
        sessionId: cred.credential_id,
        method: kind,
        mfaVerified: true,
        hasMfaFactor: false,
        principal,
        user: { email: '', displayName: cred.name, locale: null, timeZone: null, employeeId: null },
        apiClient: { id: cred.id, kind, name: cred.name, scopes: cred.scopes, rateLimitPerMinute: settings.rateLimitPerMinute },
      } satisfies AuthContext;
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return undefined;
  }
}
