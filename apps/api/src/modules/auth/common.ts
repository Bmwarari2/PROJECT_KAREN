import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { createSession, loadSecurity, SESSION_COOKIE, type AuthMethod } from './sessions';

/** Fixed-window throttles. Throws 429 with Retry-After when any key is over its limit. */
export async function throttle(deps: Deps, rules: Array<[key: string, limit: number, windowSeconds: number]>) {
  for (const [key, limit, windowSeconds] of rules) {
    const { count, resetSeconds } = await deps.limiter.hit(key, windowSeconds);
    if (count > limit) throw new ApiError('rateLimited', undefined, { retryAfter: resetSeconds });
  }
}

/**
 * Resolves a workspace slug to a tenant in THIS cell. If the tenant lives in another region the
 * request is refused with the correct regional URL, without touching that tenant's data.
 */
export async function resolveTenantSlug(deps: Deps, slug: string): Promise<string> {
  const local = await deps.router.lookupSlug(slug.toLowerCase());
  if (local) {
    if (local.status !== 'active') throw new ApiError('tenantUnavailable');
    return local.tenant_id;
  }
  const remote = await deps.directory.bySlug(slug.toLowerCase());
  if (remote && remote.homeRegion !== deps.config.cell) {
    throw new ApiError('wrongRegion', undefined, { region: remote.homeRegion, appUrl: deps.regionalAppUrls[remote.homeRegion] });
  }
  throw new ApiError('notFound');
}

export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  const secure = deps.config.apiBaseUrl.startsWith('https');
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    // Absolute session lifetime is enforced server-side; the cookie itself is a browser-session cookie.
  });
}

export async function startSession(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  tx: Tx,
  opts: { tenantId: string; userId: string; method: AuthMethod; mfaVerified: boolean },
) {
  const token = await createSession(tx, { ...opts, ip: req.ctx.ip, userAgent: req.ctx.userAgent, now: deps.now() });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: opts.userId,
    action: 'auth.login',
    targetType: 'user',
    targetId: opts.userId,
    diff: { method: opts.method },
    ip: req.ctx.ip,
    userAgent: req.ctx.userAgent,
    requestId: req.id,
  });
  req.auditWritten = true;
  setSessionCookie(deps, reply, token);
  return token;
}

export async function assertPasswordlessAllowed(tx: Tx) {
  const security = await loadSecurity(tx);
  if (security.ssoEnforced) throw new ApiError('ssoRequired');
  return security;
}

export async function recordFailure(deps: Deps, req: FastifyRequest, tenantId: string, userId: string | undefined, reason: string) {
  await withTenant(deps.router, tenantId, async (tx) => {
    if (userId) {
      const security = await loadSecurity(tx);
      await tx.exec(
        `UPDATE app.users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
         WHERE id = $1`,
        [userId, security.lockoutThreshold, new Date(deps.now().getTime() + security.lockoutMinutes * 60_000)],
      );
    }
    await writeAudit(tx, {
      actorType: 'user',
      actorId: userId ?? null,
      action: 'auth.login_failed',
      diff: { reason },
      ip: req.ctx.ip,
      userAgent: req.ctx.userAgent,
      requestId: req.id,
    });
  });
}
