import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Type-only: brings the req.cookies / reply.setCookie augmentation into every consumer (e.g. the worker).
import type {} from '@fastify/cookie';
import fp from 'fastify-plugin';
import { resolveLocale, isLocale, type Locale } from '@thapsus/core/i18n';
import { can, canSome, type Target } from '@thapsus/core/permissions';
import { withTenant, writeAudit, type AuditEntry, type Tx } from '@thapsus/db';
import type { Deps } from '../deps';
import { ApiError } from './errors';
import { mfaGate, resolveSession, SESSION_COOKIE, type AuthContext } from '../modules/auth/sessions';
import { apiClientMayCall } from '@thapsus/core/api-scopes';
import { isApiCredential, resolveApiCredential } from '../modules/platform/api-auth';

export interface RequestCtx {
  locale: Locale;
  ip: string;
  userAgent: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestCtx;
    auth?: AuthContext;
    auditWritten?: boolean;
  }
  interface FastifyInstance {
    deps: Deps;
    /** Runs fn in the caller's tenant context; throws 401 when not signed in. */
    tenantTx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, opts?: { readOnly?: boolean }): Promise<T>;
    audit(tx: Tx, req: FastifyRequest, entry: Omit<AuditEntry, 'actorType' | 'actorId' | 'ip' | 'userAgent' | 'requestId'> & Partial<AuditEntry>): Promise<void>;
  }
  interface FastifyContextConfig {
    /** 'public' skips session resolution; 'mfa-setup' is reachable by admins before MFA; default 'user'. */
    auth?: 'public' | 'user' | 'mfa-setup';
    /** Skip the fallback audit write (route records its own audit inside its transaction). */
    selfAudited?: boolean;
    /**
     * Public, unauthenticated and free of personal data, so the route may set its own shared
     * Cache-Control (edge-cacheable). Only GET /v1/status uses this (ADR-0105).
     */
    edgeCacheable?: boolean;
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError('unauthorised');
  return req.auth;
}

export function authorize(req: FastifyRequest, action: string, target?: Target): AuthContext {
  const auth = requireAuth(req);
  if (!can(auth.principal, action, target)) throw new ApiError('forbidden');
  return auth;
}

/** Audit actor type for the caller: a person, Thapsus support (granted access) or an API client. */
export function actorTypeOf(auth: AuthContext | undefined): AuditEntry['actorType'] {
  if (!auth) return 'system';
  if (auth.method === 'support') return 'support';
  return auth.apiClient ? 'api_client' : 'user';
}

export function authorizeSome(req: FastifyRequest, action: string): AuthContext {
  const auth = requireAuth(req);
  if (!canSome(auth.principal, action)) throw new ApiError('forbidden');
  return auth;
}

export const contextPlugin = fp(async (app: FastifyInstance, opts: { deps: Deps }) => {
  app.decorate('deps', opts.deps);
  app.decorateRequest('ctx', null as unknown as RequestCtx);
  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const queryLocale = (req.query as Record<string, string> | undefined)?.locale;
    req.ctx = {
      locale: isLocale(queryLocale) ? queryLocale : resolveLocale(req.headers['accept-language']),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const mode = req.routeOptions.config?.auth ?? 'user';
    if (mode === 'public' || !req.routeOptions.url) return; // unknown routes fall through to the 404 handler
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    let auth: AuthContext | undefined;
    if (isApiCredential(bearer)) {
      // Public API: scoped API key or OAuth access token → api_client principal (modules/platform).
      auth = await resolveApiCredential(opts.deps, bearer!);
      if (auth && !apiClientMayCall(req.routeOptions.url)) throw new ApiError('forbidden', 'apiClientNotAllowed');
    } else {
      const token = req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith('Session ') ? header.slice(8) : undefined);
      auth = await resolveSession(opts.deps.router, token, opts.deps.now());
    }
    if (!auth) throw new ApiError('unauthorised');
    req.auth = auth;
    if (auth.user.locale && isLocale(auth.user.locale) && !req.headers['accept-language']) req.ctx.locale = auth.user.locale;
    if (mode !== 'mfa-setup') {
      const gate = mfaGate(auth);
      if (gate !== 'ok') throw new ApiError(gate);
    }
  });

  // Authenticated responses are never cacheable anywhere (no CDN/edge caching).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.config?.edgeCacheable && req.routeOptions.config.auth === 'public' && reply.statusCode < 400 && reply.getHeader('cache-control')) return payload;
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    return payload;
  });

  // Safety net: every successful mutating call is audited even if the route forgot to. It runs before
  // the response is sent, so a client never sees success for a change that has no audit entry yet.
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return payload;
    if (req.auditWritten || req.routeOptions.config?.selfAudited || reply.statusCode >= 400 || !req.auth) return payload;
    req.auditWritten = true;
    await withTenant(opts.deps.router, req.auth.tenantId, (tx) =>
      writeAudit(tx, {
        actorType: actorTypeOf(req.auth),
        actorId: req.auth!.userId,
        action: `http.${req.method.toLowerCase()} ${req.routeOptions.url}`,
        ip: req.ctx.ip,
        userAgent: req.ctx.userAgent,
        requestId: req.id,
      }),
    ).catch((err) => req.log.error({ err }, 'fallback audit failed'));
    return payload;
  });

  app.decorate('tenantTx', function <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, o: { readOnly?: boolean } = {}) {
    const auth = requireAuth(req);
    return withTenant(opts.deps.router, auth.tenantId, fn, { actorId: auth.userId, readOnly: o.readOnly });
  });

  app.decorate('audit', async function (tx: Tx, req: FastifyRequest, entry: Partial<AuditEntry> & { action: string }) {
    req.auditWritten = true;
    await writeAudit(tx, {
      actorType: entry.actorType ?? actorTypeOf(req.auth),
      actorId: entry.actorId ?? req.auth?.userId ?? null,
      ip: req.ctx.ip,
      userAgent: req.ctx.userAgent,
      requestId: req.id,
      ...entry,
    });
  });
});
