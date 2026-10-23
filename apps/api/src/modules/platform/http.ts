import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { withTenant } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { platformConfig } from './config';

/**
 * Cross-cutting public-API behaviour (registered right after the context plugin, so req.auth is set):
 *  1. per-tenant rate limits for API clients (RateLimit-* headers; 429 + Retry-After);
 *  2. Idempotency-Key on POST/PATCH: same key + same request → the stored response is replayed,
 *     same key + different request → 422, concurrent duplicate → 409; scoped per tenant + caller;
 *  3. deprecation headers (RFC 9745 Deprecation, RFC 8594 Sunset, Link rel="deprecation") for routes
 *     whose config declares `deprecation`.
 */
export interface DeprecationInfo {
  /** Date the operation was deprecated (YYYY-MM-DD). */
  since: string;
  /** Date after which the operation may be removed (YYYY-MM-DD); at least 6 months after `since`. */
  sunset?: string;
  /** Migration guide. */
  link?: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    deprecation?: DeprecationInfo;
  }
  interface FastifyRequest {
    idempotency?: { principalKey: string; key: string; tenantId: string; replayed?: boolean };
  }
}

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH']);
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Response headers for a deprecated operation. */
export function deprecationHeaders(d: DeprecationInfo): Record<string, string> {
  const at = (date: string) => Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at(d.since)) || (d.sunset && Number.isNaN(at(d.sunset))))
    throw new Error('invalid deprecation date');
  const out: Record<string, string> = { Deprecation: `@${Math.floor(at(d.since) / 1000)}` };
  if (d.sunset) out.Sunset = new Date(at(d.sunset)).toUTCString();
  if (d.link) out.Link = `<${d.link}>; rel="deprecation"; type="text/html"`;
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}

export function requestFingerprint(method: string, url: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(`${method} ${url}\n`)
    .update(JSON.stringify(canonical(body ?? null)))
    .digest();
}

export const platformHttpPlugin = fp(async (app: FastifyInstance, opts: { deps: Deps }) => {
  const deps = opts.deps;

  // 1 + 2: after authentication
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth;
    if (!auth) return;
    if (auth.apiClient) {
      const limit = auth.apiClient.rateLimitPerMinute;
      const { count, resetSeconds } = await deps.limiter.hit(`api:tenant:${auth.tenantId}`, 60);
      reply.header('RateLimit-Limit', String(limit));
      reply.header('RateLimit-Remaining', String(Math.max(0, limit - count)));
      reply.header('RateLimit-Reset', String(resetSeconds));
      reply.header('RateLimit-Policy', `${limit};w=60`);
      if (count > limit) throw new ApiError('rateLimited', undefined, { retryAfter: resetSeconds });
    }

    const raw = req.headers[IDEMPOTENCY_HEADER];
    if (raw === undefined || !IDEMPOTENT_METHODS.has(req.method)) return;
    const key = Array.isArray(raw) ? raw[0]! : raw;
    if (!KEY_RE.test(key))
      throw new ApiError('validation', 'Idempotency-Key must be 1–255 visible ASCII characters');
    const principalKey = auth.apiClient
      ? `${auth.apiClient.kind}:${auth.apiClient.id}`
      : `user:${auth.userId}`;
    const fingerprint = requestFingerprint(req.method, req.url, req.body);
    const now = deps.now();
    const expires = new Date(now.getTime() + platformConfig.idempotencyTtlHours * 3_600_000);
    const outcome = await withTenant(deps.router, auth.tenantId, async (tx) => {
      // Take the key, or reclaim it if the previous use has expired.
      const claimed = await tx.maybe(
        `INSERT INTO app.idempotency_keys (tenant_id, principal_key, key, method, path, request_hash, created_at, expires_at)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, principal_key, key) DO UPDATE SET method = EXCLUDED.method, path = EXCLUDED.path, request_hash = EXCLUDED.request_hash,
           status = 'in_progress', response_status = NULL, response_type = NULL, response_body = NULL, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
         WHERE app.idempotency_keys.expires_at <= $6
         RETURNING 1`,
        [principalKey, key, req.method, req.url, fingerprint, now, expires],
      );
      if (claimed) return { kind: 'new' as const };
      const existing = await tx.one<{
        request_hash: Buffer;
        status: string;
        response_status: number | null;
        response_type: string | null;
        response_body: string | null;
      }>(
        'SELECT request_hash, status, response_status, response_type, response_body FROM app.idempotency_keys WHERE principal_key = $1 AND key = $2',
        [principalKey, key],
      );
      if (!existing.request_hash.equals(fingerprint)) return { kind: 'mismatch' as const };
      if (existing.status !== 'completed') return { kind: 'inProgress' as const };
      return {
        kind: 'replay' as const,
        status: existing.response_status!,
        type: existing.response_type,
        body: existing.response_body,
      };
    });
    if (outcome.kind === 'mismatch') throw new ApiError('unprocessable', 'idempotencyKeyReused');
    if (outcome.kind === 'inProgress') throw new ApiError('conflict', 'idempotencyKeyInProgress');
    req.idempotency = { principalKey, key, tenantId: auth.tenantId, replayed: outcome.kind === 'replay' };
    if (outcome.kind === 'replay') {
      req.auditWritten = true; // a replay changes nothing, so the safety-net audit is skipped
      reply.header('Idempotent-Replayed', 'true');
      if (outcome.type) reply.type(outcome.type);
      reply.status(outcome.status).send(outcome.body ?? undefined);
      return reply;
    }
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const dep = req.routeOptions.config?.deprecation;
    if (dep) for (const [k, v] of Object.entries(deprecationHeaders(dep))) reply.header(k, v);
    const idem = req.idempotency;
    if (!idem || idem.replayed) return payload;
    const storable =
      typeof payload === 'string' || Buffer.isBuffer(payload) || payload === undefined || payload === null;
    await withTenant(deps.router, idem.tenantId, (tx) =>
      reply.statusCode >= 500 || !storable
        ? // server errors and streamed bodies are not stored: the client may retry with the same key
          tx.exec('DELETE FROM app.idempotency_keys WHERE principal_key = $1 AND key = $2', [
            idem.principalKey,
            idem.key,
          ])
        : tx.exec(
            `UPDATE app.idempotency_keys SET status = 'completed', response_status = $3, response_type = $4, response_body = $5 WHERE principal_key = $1 AND key = $2`,
            [
              idem.principalKey,
              idem.key,
              reply.statusCode,
              String(reply.getHeader('content-type') ?? '') || null,
              payload == null ? null : payload.toString(),
            ],
          ),
    ).catch((err) => req.log.warn({ err }, 'idempotency record failed'));
    return payload;
  });
});
