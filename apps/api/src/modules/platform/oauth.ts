import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import { Type } from 'typebox';
import { featureEnabled, withTenant, writeAudit } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { throttle } from '../auth/common';
import { composeToken, hashToken, newToken, parseToken } from '../auth/tokens';
import { ACCESS_TOKEN_PREFIX, CLIENT_ID_PREFIX } from './api-auth';

/**
 * OAuth 2.0 token endpoint, client credentials grant only (RFC 6749 §4.4). Client authentication by
 * HTTP Basic (client_secret_basic, preferred) or form fields (client_secret_post). Errors follow
 * RFC 6749 §5.2; responses are never cached (Cache-Control: no-store is set on every API response).
 */
const OAuthError = Type.Object(
  {
    error: Type.Union(
      [
        'invalid_request',
        'invalid_client',
        'invalid_grant',
        'unauthorized_client',
        'unsupported_grant_type',
        'invalid_scope',
      ].map((e) => Type.Literal(e)),
    ),
    error_description: Type.Optional(Type.String()),
  },
  { $id: 'OAuthError' },
);
const TokenResponse = Type.Object({
  access_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer(),
  scope: Type.String(),
});

class OAuthFailure extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly error: string,
    readonly description?: string,
  ) {
    super(error);
  }
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return undefined;
  // RFC 6749 §2.3.1: both parts are form-urlencoded before base64
  try {
    return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  } catch {
    return undefined;
  }
}

const eq = (a: Buffer | null, b: Buffer) => !!a && a.length === b.length && timingSafeEqual(a, b);

export async function oauthRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.addSchema(OAuthError);
  // RFC 6749 §4.4.2: token requests are application/x-www-form-urlencoded (parsed only in this scope).
  await app.register(formbody);

  app.post(
    '/v1/oauth/token',
    {
      config: { auth: 'public', selfAudited: true },
      schema: {
        tags: ['oauth'],
        summary: 'OAuth 2.0 token endpoint (client credentials grant, RFC 6749 §4.4)',
        description:
          'Send application/x-www-form-urlencoded with grant_type=client_credentials and an optional space-delimited scope. Authenticate with HTTP Basic (client_id:client_secret).',
        security: [],
        body: Type.Object({
          grant_type: Type.Optional(Type.String({ maxLength: 100 })),
          scope: Type.Optional(Type.String({ maxLength: 1000 })),
          client_id: Type.Optional(Type.String({ maxLength: 200 })),
          client_secret: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: {
          200: TokenResponse,
          400: Type.Ref('OAuthError'),
          401: Type.Ref('OAuthError'),
          429: Type.Ref('Problem'),
        },
      },
    },
    async (req, reply: FastifyReply) => {
      const b = (req.body ?? {}) as {
        grant_type?: string;
        scope?: string;
        client_id?: string;
        client_secret?: string;
      };
      const basic = basicCredentials(req.headers.authorization);
      try {
        if (basic && (b.client_id || b.client_secret))
          throw new OAuthFailure(400, 'invalid_request', 'Use one client authentication method');
        const clientId = basic?.id ?? b.client_id;
        const secret = basic?.secret ?? b.client_secret;
        if (!clientId || !secret) throw new OAuthFailure(401, 'invalid_client');
        await throttle(deps, [
          [`oauth:ip:${req.ctx.ip}`, 120, 60],
          [`oauth:client:${clientId.slice(0, 120)}`, 30, 60],
        ]);
        if (b.grant_type !== 'client_credentials')
          throw new OAuthFailure(400, b.grant_type ? 'unsupported_grant_type' : 'invalid_request');
        const parsed = parseToken(CLIENT_ID_PREFIX, clientId);
        if (!parsed) throw new OAuthFailure(401, 'invalid_client');
        const now = deps.now();
        const issued = await withTenant(deps.router, parsed.tenantId, async (tx) => {
          const c = await tx.maybe<{
            id: string;
            secret_hash: Buffer;
            previous_secret_hash: Buffer | null;
            previous_secret_expires_at: string | null;
            scopes: string[];
            token_ttl_seconds: number;
          }>(
            'SELECT id, secret_hash, previous_secret_hash, previous_secret_expires_at, scopes, token_ttl_seconds FROM app.oauth_clients WHERE client_key = $1 AND revoked_at IS NULL',
            [parsed.secret],
          );
          const presented = hashToken(secret);
          const previousValid = c?.previous_secret_expires_at && new Date(c.previous_secret_expires_at) > now;
          if (
            !c ||
            !(eq(c.secret_hash, presented) || (previousValid && eq(c.previous_secret_hash, presented)))
          ) {
            await writeAudit(tx, {
              actorType: 'api_client',
              actorId: c?.id ?? null,
              action: 'oauth.token_denied',
              diff: { reason: 'invalid_client' },
              ip: req.ctx.ip,
              requestId: req.id,
            });
            return { failure: new OAuthFailure(401, 'invalid_client') };
          }
          if (!(await featureEnabled(tx, 'publicApi')))
            return {
              failure: new OAuthFailure(
                400,
                'unauthorized_client',
                'The public API is turned off for this workspace',
              ),
            };
          const requested = b.scope?.trim() ? [...new Set(b.scope.trim().split(/\s+/))] : c.scopes;
          if (!requested.every((s) => c.scopes.includes(s)))
            return { failure: new OAuthFailure(400, 'invalid_scope') };
          const tokenSecret = newToken(32);
          const expires = new Date(now.getTime() + c.token_ttl_seconds * 1000);
          const t = await tx.one<{ id: string }>(
            'INSERT INTO app.oauth_access_tokens (tenant_id, client_id, token_hash, scopes, created_at, expires_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id',
            [c.id, hashToken(tokenSecret), requested, now, expires],
          );
          await tx.exec('UPDATE app.oauth_clients SET last_used_at = $2 WHERE id = $1', [c.id, now]);
          await writeAudit(tx, {
            actorType: 'api_client',
            actorId: c.id,
            action: 'oauth.token_issued',
            targetType: 'oauth_access_token',
            targetId: t.id,
            diff: { scopes: requested, expiresIn: c.token_ttl_seconds },
            ip: req.ctx.ip,
            requestId: req.id,
          });
          return {
            token: composeToken(ACCESS_TOKEN_PREFIX, parsed.tenantId, tokenSecret),
            ttl: c.token_ttl_seconds,
            scopes: requested,
          };
        });
        if ('failure' in issued) throw issued.failure;
        return reply.status(200).send({
          access_token: issued.token,
          token_type: 'Bearer',
          expires_in: issued.ttl,
          scope: issued.scopes.join(' '),
        });
      } catch (err) {
        if (err instanceof OAuthFailure) {
          if (err.status === 401 && basic) reply.header('WWW-Authenticate', 'Basic realm="thapsus-hr"');
          return reply
            .status(err.status)
            .send({ error: err.error, ...(err.description ? { error_description: err.description } : {}) });
        }
        if (err instanceof ApiError) throw err;
        // unknown tenant id in the client id, or a database error: never reveal which
        if ((err as Error).name === 'TenantNotFoundError')
          return reply.status(401).send({ error: 'invalid_client' });
        throw err;
      }
    },
  );
}
