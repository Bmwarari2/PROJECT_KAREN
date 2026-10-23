import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { API_SCOPE_KEYS, isApiScope, scopedPermissions } from '@thapsus/core/api-scopes';
import { canSome } from '@thapsus/core/permissions';
import type { Tx } from '@thapsus/db';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { decodeCursor, encodeCursor, Nullable, Page, Problem, Uuid } from '../../http/schemas';
import { requireFeature } from '../../lib/features';
import { composeToken, hashToken, newToken } from '../auth/tokens';
import { API_KEY_PREFIX, CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX } from './api-auth';

/**
 * Settings → API access: scoped API keys and OAuth 2.0 clients. Secrets are shown exactly once in the
 * create (or rotate) response; only SHA-256 hashes are stored. Company admins only (settings.manage),
 * and nobody can mint a credential with permissions they do not hold themselves.
 */
const ScopeList = Type.Array(Type.Union(API_SCOPE_KEYS.map((s) => Type.Literal(s))), {
  minItems: 1,
  maxItems: API_SCOPE_KEYS.length,
  uniqueItems: true,
});
const ScopeType = Type.Union(
  ['all', 'entity', 'country', 'department', 'location'].map((s) => Type.Literal(s)),
);

const CredentialBase = {
  id: Uuid,
  name: Type.String(),
  scopes: Type.Array(Type.String()),
  roleId: Uuid,
  roleKey: Type.String(),
  scopeType: Type.String(),
  scopeValues: Type.Array(Type.String()),
  createdAt: Type.String(),
  revokedAt: Nullable(Type.String()),
  lastUsedAt: Nullable(Type.String()),
};
export const ApiKeyOut = Type.Object({
  ...CredentialBase,
  prefix: Type.String({ description: 'Shown as thr_sk_…<prefix> to identify the key' }),
  expiresAt: Nullable(Type.String()),
});
export const OAuthClientOut = Type.Object({
  ...CredentialBase,
  clientId: Type.String(),
  tokenTtlSeconds: Type.Integer(),
  secretRotatedAt: Nullable(Type.String()),
  previousSecretExpiresAt: Nullable(Type.String()),
});

const CreateBase = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  scopes: ScopeList,
  roleId: Type.Optional(Uuid),
  roleKey: Type.Optional(Type.String({ maxLength: 60 })),
  scopeType: Type.Optional(ScopeType),
  scopeValues: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 })),
};

interface CredRow {
  id: string;
  name: string;
  scopes: string[];
  role_id: string;
  role_key: string;
  scope_type: string;
  scope_values: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
const base = (r: CredRow) => ({
  id: r.id,
  name: r.name,
  scopes: r.scopes,
  roleId: r.role_id,
  roleKey: r.role_key,
  scopeType: r.scope_type,
  scopeValues: r.scope_values,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
});
const keyOut = (r: CredRow & { prefix: string; expires_at: string | null }) => ({
  ...base(r),
  prefix: r.prefix,
  expiresAt: r.expires_at,
});
const clientOut =
  (tenantId: string) =>
  (
    r: CredRow & {
      client_key: string;
      token_ttl_seconds: number;
      secret_rotated_at: string | null;
      previous_secret_expires_at: string | null;
    },
  ) => ({
    ...base(r),
    clientId: composeToken(CLIENT_ID_PREFIX, tenantId, r.client_key),
    tokenTtlSeconds: r.token_ttl_seconds,
    secretRotatedAt: r.secret_rotated_at,
    previousSecretExpiresAt: r.previous_secret_expires_at,
  });

type CreateBody = {
  name: string;
  scopes: string[];
  roleId?: string;
  roleKey?: string;
  scopeType?: string;
  scopeValues?: string[];
};

export async function apiClientRoutes(app: FastifyInstance) {
  /** Resolves the role and refuses credentials that would exceed the creator's own permissions. */
  async function resolveRole(tx: Tx, req: Parameters<typeof authorize>[0], b: CreateBody) {
    const auth = authorize(req, 'settings.manage');
    if (!b.scopes.every(isApiScope)) throw new ApiError('validation', 'unknownScope');
    const role = await tx.maybe<{ id: string; key: string; permissions: string[] }>(
      b.roleId
        ? 'SELECT id, key, permissions FROM app.roles WHERE id = $1'
        : 'SELECT id, key, permissions FROM app.roles WHERE key = $1',
      [b.roleId ?? b.roleKey ?? 'hr_admin'],
    );
    if (!role) throw new ApiError('validation', 'unknownRole');
    const effective = scopedPermissions(role.permissions, b.scopes);
    if (!effective.length) throw new ApiError('unprocessable', 'noEffectivePermissions');
    const beyond = effective.filter((p) => !canSome(auth.principal, p));
    if (beyond.length) throw new ApiError('forbidden', 'exceedsYourPermissions', { permissions: beyond });
    if ((b.scopeType ?? 'all') !== 'all' && !b.scopeValues?.length)
      throw new ApiError('validation', 'scopeValuesRequired');
    return {
      role,
      effective,
      scopeType: b.scopeType ?? 'all',
      scopeValues: (b.scopeType ?? 'all') === 'all' ? [] : (b.scopeValues ?? []),
    };
  }

  const JOIN = 'JOIN app.roles r ON r.tenant_id = c.tenant_id AND r.id = c.role_id';

  // ---- API keys ---------------------------------------------------------------------------------
  app.get(
    '/v1/settings/api-keys',
    {
      schema: {
        tags: ['api-access'],
        summary: 'List API keys (cursor-paginated, newest first)',
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Page(ApiKeyOut), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const q = req.query as { cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const after = decodeCursor<[string, string]>(q.cursor);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<CredRow & { prefix: string; expires_at: string | null }>(
            `SELECT c.*, r.key AS role_key FROM app.api_keys c ${JOIN}
              ${after ? 'WHERE (c.created_at, c.id) < ($1::timestamptz, $2::uuid)' : ''} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`,
            after ?? [],
          ),
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      return {
        data: page.map(keyOut),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null,
      };
    },
  );

  app.post(
    '/v1/settings/api-keys',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['api-access'],
        summary: 'Create a scoped API key (the key is returned once and never again)',
        body: Type.Object(
          { ...CreateBase, expiresAt: Type.Optional(Type.String({ format: 'date-time' })) },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            ...ApiKeyOut.properties,
            key: Type.String({ description: 'thr_sk_… — store it now; it cannot be shown again' }),
          }),
          400: Problem,
          403: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as CreateBody & { expiresAt?: string };
      const auth = authorize(req, 'settings.manage');
      const secret = newToken(32);
      const out = await app.tenantTx(req, async (tx) => {
        await requireFeature(tx, 'publicApi');
        const { role, effective, scopeType, scopeValues } = await resolveRole(tx, req, b);
        if (b.expiresAt && new Date(b.expiresAt) <= app.deps.now())
          throw new ApiError('validation', 'expiresAt must be in the future');
        const row = await tx.one<CredRow & { prefix: string; expires_at: string | null }>(
          `INSERT INTO app.api_keys (tenant_id, name, prefix, key_hash, scopes, role_id, scope_type, scope_values, created_by, expires_at)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, $10::text AS role_key`,
          [
            b.name,
            secret.slice(0, 8),
            hashToken(secret),
            b.scopes,
            role.id,
            scopeType,
            scopeValues,
            auth.userId,
            b.expiresAt ?? null,
            role.key,
          ],
        );
        await app.audit(tx, req, {
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: row.id,
          diff: {
            name: b.name,
            prefix: row.prefix,
            scopes: b.scopes,
            role: role.key,
            permissions: effective,
            scopeType,
          },
        });
        return row;
      });
      return reply
        .status(201)
        .send({ ...keyOut(out), key: composeToken(API_KEY_PREFIX, auth.tenantId, secret) });
    },
  );

  app.post(
    '/v1/settings/api-keys/:id/revoke',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['api-access'],
        summary: 'Revoke an API key immediately',
        params: Type.Object({ id: Uuid }),
        response: { 200: ApiKeyOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const row = await tx.maybe<CredRow & { prefix: string; expires_at: string | null }>(
          `UPDATE app.api_keys c SET revoked_at = coalesce(c.revoked_at, $2) FROM app.roles r WHERE r.tenant_id = c.tenant_id AND r.id = c.role_id AND c.id = $1 RETURNING c.*, r.key AS role_key`,
          [id, app.deps.now()],
        );
        if (!row) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: id,
          diff: { prefix: row.prefix },
        });
        return keyOut(row);
      });
    },
  );

  // ---- OAuth 2.0 clients ------------------------------------------------------------------------
  app.get(
    '/v1/settings/oauth-clients',
    {
      schema: {
        tags: ['api-access'],
        summary: 'List OAuth 2.0 clients (cursor-paginated, newest first)',
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Page(OAuthClientOut), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const q = req.query as { cursor?: string; limit?: number };
      const limit = q.limit ?? 50;
      const after = decodeCursor<[string, string]>(q.cursor);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<Parameters<ReturnType<typeof clientOut>>[0]>(
            `SELECT c.*, r.key AS role_key FROM app.oauth_clients c ${JOIN}
              ${after ? 'WHERE (c.created_at, c.id) < ($1::timestamptz, $2::uuid)' : ''} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`,
            after ?? [],
          ),
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      return {
        data: page.map(clientOut(auth.tenantId)),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.created_at, page.at(-1)!.id]) : null,
      };
    },
  );

  app.post(
    '/v1/settings/oauth-clients',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['api-access'],
        summary: 'Create an OAuth 2.0 client for the client credentials grant (the secret is returned once)',
        body: Type.Object(
          { ...CreateBase, tokenTtlSeconds: Type.Optional(Type.Integer({ minimum: 300, maximum: 86400 })) },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ ...OAuthClientOut.properties, clientSecret: Type.String() }),
          400: Problem,
          403: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as CreateBody & { tokenTtlSeconds?: number };
      const auth = authorize(req, 'settings.manage');
      const clientKey = newToken(16);
      const secret = `${CLIENT_SECRET_PREFIX}${newToken(32)}`;
      const out = await app.tenantTx(req, async (tx) => {
        await requireFeature(tx, 'publicApi');
        const { role, effective, scopeType, scopeValues } = await resolveRole(tx, req, b);
        const row = await tx.one<Parameters<ReturnType<typeof clientOut>>[0]>(
          `INSERT INTO app.oauth_clients (tenant_id, name, client_key, secret_hash, scopes, role_id, scope_type, scope_values, token_ttl_seconds, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, $10::text AS role_key`,
          [
            b.name,
            clientKey,
            hashToken(secret),
            b.scopes,
            role.id,
            scopeType,
            scopeValues,
            b.tokenTtlSeconds ?? 3600,
            auth.userId,
            role.key,
          ],
        );
        await app.audit(tx, req, {
          action: 'oauth_client.created',
          targetType: 'oauth_client',
          targetId: row.id,
          diff: { name: b.name, scopes: b.scopes, role: role.key, permissions: effective, scopeType },
        });
        return row;
      });
      return reply.status(201).send({ ...clientOut(auth.tenantId)(out), clientSecret: secret });
    },
  );

  app.post(
    '/v1/settings/oauth-clients/:id/rotate-secret',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['api-access'],
        summary: 'Issue a new client secret; the previous one keeps working for graceHours (0 = revoke now)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          graceHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 168, default: 24 })),
        }),
        response: {
          200: Type.Object({ ...OAuthClientOut.properties, clientSecret: Type.String() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      const grace = (req.body as { graceHours?: number } | undefined)?.graceHours ?? 24;
      const secret = `${CLIENT_SECRET_PREFIX}${newToken(32)}`;
      const now = app.deps.now();
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<Parameters<ReturnType<typeof clientOut>>[0]>(
          `UPDATE app.oauth_clients c SET previous_secret_hash = CASE WHEN $3::int > 0 THEN c.secret_hash END,
              previous_secret_expires_at = CASE WHEN $3::int > 0 THEN $4::timestamptz + make_interval(hours => $3::int) END,
              secret_hash = $2, secret_rotated_at = $4
            FROM app.roles r WHERE r.tenant_id = c.tenant_id AND r.id = c.role_id AND c.id = $1 AND c.revoked_at IS NULL
          RETURNING c.*, r.key AS role_key`,
          [id, hashToken(secret), grace, now],
        );
        if (!r) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'oauth_client.secret_rotated',
          targetType: 'oauth_client',
          targetId: id,
          diff: { graceHours: grace },
        });
        return r;
      });
      return { ...clientOut(auth.tenantId)(row), clientSecret: secret };
    },
  );

  app.post(
    '/v1/settings/oauth-clients/:id/revoke',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['api-access'],
        summary: 'Revoke a client and every access token it holds',
        params: Type.Object({ id: Uuid }),
        response: { 200: OAuthClientOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const row = await tx.maybe<Parameters<ReturnType<typeof clientOut>>[0]>(
          `UPDATE app.oauth_clients c SET revoked_at = coalesce(c.revoked_at, $2) FROM app.roles r WHERE r.tenant_id = c.tenant_id AND r.id = c.role_id AND c.id = $1 RETURNING c.*, r.key AS role_key`,
          [id, app.deps.now()],
        );
        if (!row) throw new ApiError('notFound');
        const tokens = await tx.exec('DELETE FROM app.oauth_access_tokens WHERE client_id = $1', [id]);
        await app.audit(tx, req, {
          action: 'oauth_client.revoked',
          targetType: 'oauth_client',
          targetId: id,
          diff: { tokensRevoked: tokens },
        });
        return clientOut(auth.tenantId)(row);
      });
    },
  );

  app.get(
    '/v1/settings/api-access/roles',
    {
      schema: {
        tags: ['api-access'],
        summary: 'Roles that can be attached to an API credential',
        response: {
          200: Type.Array(
            Type.Object({ id: Uuid, key: Type.String(), name: Type.String(), builtIn: Type.Boolean() }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{ id: string; key: string; name: string; built_in: boolean }>(
            'SELECT id, key, name, built_in FROM app.roles ORDER BY built_in DESC, name',
          ),
        { readOnly: true },
      );
      return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, builtIn: r.built_in }));
    },
  );
}
