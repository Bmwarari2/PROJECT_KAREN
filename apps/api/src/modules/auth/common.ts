import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { sessionCookie } from '../../http/security';
import { emitSecurityEvent } from '../../lib/security-events';
import { createSession, loadSecurity, SESSION_PREFIX, type AuthMethod } from './sessions';
import { hashToken, parseToken } from './tokens';

/** Which identity a throttle key counts: `…:ip:…`, `…:acct:…` or `…:tenant:…` (else the account). */
export function throttleScope(key: string): 'ip' | 'account' | 'tenant' {
  if (key.includes(':ip:')) return 'ip';
  if (key.includes(':tenant:')) return 'tenant';
  return 'account';
}

/**
 * Fixed-window throttles. Throws 429 with Retry-After when any key is over its limit. Per-IP keys
 * (`…:ip:…`) scale with the cell's ipThrottleMultiplier (1 outside the load-test environment). With a
 * request, a refusal is also emitted as an `auth.throttled` security event naming the scope.
 */
export async function throttle(
  deps: Deps,
  rules: Array<[key: string, limit: number, windowSeconds: number]>,
  req?: FastifyRequest,
) {
  const ipFactor = deps.config.ipThrottleMultiplier ?? 1;
  for (const [key, base, windowSeconds] of rules) {
    const limit = key.includes(':ip:') ? base * ipFactor : base;
    const { count, resetSeconds } = await deps.limiter.hit(key, windowSeconds);
    if (count > limit) {
      if (req) throttled(deps, req, key);
      throw new ApiError('rateLimited', undefined, { retryAfter: resetSeconds });
    }
  }
}

function throttled(deps: Deps, req: FastifyRequest, key: string, tenantId?: string) {
  const [name] = key.split(':');
  const scope = throttleScope(key);
  emitSecurityEvent(deps, req, {
    type: 'auth.throttled',
    severity: scope === 'tenant' ? 'high' : 'medium',
    tenantId,
    detail: { scope, limit: name ?? 'auth' },
  });
}

/**
 * Failure budgets: a request is refused while the key's failures in the window are at the limit, and
 * only failures count (so a busy tenant's successful sign-ins never use up its budget). Used for the
 * per-tenant limits that catch credential stuffing spread over many addresses and accounts.
 */
export async function assertFailureBudget(
  deps: Deps,
  req: FastifyRequest,
  key: string,
  limit: number,
  tenantId?: string,
) {
  const { count, resetSeconds } = await deps.limiter.peek(key);
  if (count >= limit) {
    throttled(deps, req, key, tenantId);
    throw new ApiError('rateLimited', undefined, { retryAfter: Math.max(1, resetSeconds) });
  }
}

export const countFailure = (deps: Deps, key: string, windowSeconds: number) =>
  deps.limiter.hit(key, windowSeconds);

/**
 * Routes whose answer must not reveal whether an account exists (magic links, password resets) answer
 * no sooner than this after the request arrived, and send their email without waiting for it, so the
 * response time is the same either way (plan 2.1.7).
 */
export const UNIFORM_RESPONSE_MS = 300;

export async function uniformDelay(startedAt: number, floorMs = UNIFORM_RESPONSE_MS) {
  const wait = floorMs - (performance.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Sends an email without holding up the response; failures are logged without the address. */
export function sendInBackground(
  deps: Deps,
  req: FastifyRequest,
  mail: Parameters<Deps['mailer']['send']>[0],
) {
  void deps.mailer.send(mail).catch((err: Error) => req.log.error({ err: err.name }, 'email not sent'));
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
    throw new ApiError('wrongRegion', undefined, {
      region: remote.homeRegion,
      appUrl: deps.regionalAppUrls[remote.homeRegion],
    });
  }
  throw new ApiError('notFound');
}

/**
 * The session cookie: `__Host-thr_sid` over HTTPS (Secure, Path=/, no Domain), HttpOnly, SameSite=Lax
 * so top-level navigations from an identity provider or an emailed link keep working (cross-site
 * requests are refused by the origin check in http/context.ts). ASVS V3.3.1 to V3.3.4.
 */
export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  const c = sessionCookie(deps.config);
  reply.setCookie(c.name, token, {
    httpOnly: true,
    secure: c.secure,
    sameSite: 'lax',
    path: c.path,
    // Absolute session lifetime is enforced server-side; the cookie itself is a browser-session cookie.
  });
}

export function clearSessionCookie(deps: Deps, reply: FastifyReply) {
  const c = sessionCookie(deps.config);
  reply.clearCookie(c.name, { path: c.path, secure: c.secure, httpOnly: true, sameSite: 'lax' });
}

export async function startSession(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  tx: Tx,
  opts: { tenantId: string; userId: string; method: AuthMethod; mfaVerified: boolean },
) {
  // A sign-in always gets a new token, and the session this browser held before ends (ASVS V7.2.4).
  const previous = parseToken(SESSION_PREFIX, req.cookies?.[sessionCookie(deps.config).name]);
  if (previous) {
    const end = (t: Tx) =>
      t.exec('UPDATE app.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
        hashToken(previous.secret),
      ]);
    if (previous.tenantId === opts.tenantId) await end(tx);
    else await withTenant(deps.router, previous.tenantId, end).catch(() => undefined);
  }
  const token = await createSession(tx, {
    ...opts,
    ip: req.ctx.ip,
    userAgent: req.ctx.userAgent,
    network: req.ctx.network,
    now: deps.now(),
  });
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

export async function recordFailure(
  deps: Deps,
  req: FastifyRequest,
  tenantId: string,
  userId: string | undefined,
  reason: string,
  account?: { tenant: string; email: string },
) {
  await withTenant(deps.router, tenantId, async (tx) => {
    if (userId) {
      const security = await loadSecurity(tx);
      const locked = await tx.maybe<{ locked: boolean }>(
        `UPDATE app.users SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
         WHERE id = $1 RETURNING (failed_attempts = $2) AS locked`,
        [
          userId,
          security.lockoutThreshold,
          new Date(deps.now().getTime() + security.lockoutMinutes * 60_000),
        ],
      );
      if (locked?.locked)
        emitSecurityEvent(deps, req, {
          type: 'auth.lockout',
          severity: 'medium',
          tenantId,
          userId,
          detail: { minutes: security.lockoutMinutes },
        });
    }
    emitSecurityEvent(deps, req, {
      type: 'auth.login_failed',
      severity: 'low',
      tenantId,
      userId,
      account: userId ? undefined : account,
      detail: { reason, method: 'password' },
    });
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

/**
 * Consumes a one-time challenge in its OWN committed transaction, so a failed verification later
 * in the request can never roll the consumption back and allow a retry.
 */
export async function consumeChallenge<T = Record<string, unknown>>(
  deps: Deps,
  tenantId: string,
  id: string,
  kind: string,
  userId?: string,
): Promise<{ challenge: string; data: T } | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(tenantId)) return undefined;
  return withTenant(deps.router, tenantId, (tx) =>
    tx.maybe<{ challenge: string; data: T }>(
      `UPDATE app.auth_challenges SET used_at = now()
        WHERE id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3 AND ($4::uuid IS NULL OR user_id = $4::uuid)
        RETURNING challenge, data`,
      [id, kind, deps.now(), userId ?? null],
    ),
  );
}
