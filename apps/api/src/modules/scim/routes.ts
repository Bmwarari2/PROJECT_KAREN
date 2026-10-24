import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { composeToken, hashToken, newToken, parseToken } from '../auth/tokens';
import { assignRole } from '../authz/principal';
import { revokeUserSessions } from '../auth/sessions';

/**
 * SCIM 2.0 inbound provisioning (RFC 7643/7644): /Users and /Groups with create, get, list + filter,
 * PUT, PATCH and deactivate. Bearer tokens are scoped to one tenant.
 */
const SCIM_PREFIX = 'scim_';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  external_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
interface ScimUserInput {
  userName?: string;
  externalId?: string;
  displayName?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: Array<{ value: string; primary?: boolean }>;
  active?: boolean;
}

export async function scimRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const base = `${deps.config.apiBaseUrl}/scim/v2`;

  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const userOut = (u: UserRow) => {
    const [givenName, ...rest] = u.display_name.split(' ');
    return {
      schemas: [USER_SCHEMA],
      id: u.id,
      externalId: u.external_id ?? undefined,
      userName: u.email,
      displayName: u.display_name,
      name: { formatted: u.display_name, givenName, familyName: rest.join(' ') || undefined },
      emails: [{ value: u.email, primary: true, type: 'work' }],
      active: u.status === 'active',
      meta: {
        resourceType: 'User',
        created: u.created_at,
        lastModified: u.updated_at,
        location: `${base}/Users/${u.id}`,
      },
    };
  };

  async function groupOut(
    tx: Tx,
    g: {
      id: string;
      display_name: string;
      external_id: string | null;
      created_at: string;
      updated_at: string;
    },
  ) {
    const members = await tx.query<{ user_id: string; email: string }>(
      'SELECT m.user_id, u.email FROM app.group_members m JOIN app.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id WHERE m.group_id = $1 ORDER BY u.email',
      [g.id],
    );
    return {
      schemas: [GROUP_SCHEMA],
      id: g.id,
      externalId: g.external_id ?? undefined,
      displayName: g.display_name,
      members: members.map((m) => ({
        value: m.user_id,
        display: m.email,
        $ref: `${base}/Users/${m.user_id}`,
      })),
      meta: {
        resourceType: 'Group',
        created: g.created_at,
        lastModified: g.updated_at,
        location: `${base}/Groups/${g.id}`,
      },
    };
  }

  function send(reply: FastifyReply, status: number, body: unknown) {
    return reply.status(status).type('application/scim+json').send(body);
  }

  /** Authenticates the bearer token and runs fn inside that tenant's context. */
  async function scim(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (tx: Tx, tenantId: string) => Promise<{ status: number; body?: unknown }>,
  ) {
    const auth = req.headers.authorization;
    const parsed = parseToken(SCIM_PREFIX, auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    if (!parsed) return send(reply, 401, { schemas: [ERROR_SCHEMA], status: '401', detail: 'Invalid token' });
    try {
      const out = await withTenant(deps.router, parsed.tenantId, async (tx) => {
        const tok = await tx.maybe<{ id: string }>(
          'UPDATE app.scim_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id',
          [hashToken(parsed.secret)],
        );
        if (!tok) throw new ScimError(401, 'Invalid token');
        return fn(tx, parsed.tenantId);
      });
      return out.status === 204 ? reply.status(204).send() : send(reply, out.status, out.body);
    } catch (err) {
      if (err instanceof ScimError)
        return send(reply, err.status, {
          schemas: [ERROR_SCHEMA],
          status: String(err.status),
          scimType: err.scimType,
          detail: err.detail,
        });
      if ((err as { code?: string }).code === '23505')
        return send(reply, 409, {
          schemas: [ERROR_SCHEMA],
          status: '409',
          scimType: 'uniqueness',
          detail: 'Already exists',
        });
      if ((err as { code?: string }).code === '22P02')
        return send(reply, 404, { schemas: [ERROR_SCHEMA], status: '404', detail: 'Not found' });
      throw err;
    }
  }

  const audit = (
    tx: Tx,
    req: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string,
    diff?: unknown,
  ) =>
    writeAudit(tx, { actorType: 'scim', action, targetType, targetId, diff, ip: req.ip, requestId: req.id });

  /** Supports `attr eq "value"` (the subset every major IdP uses). */
  function parseFilter(
    filter: string | undefined,
    allowed: Record<string, string>,
  ): { column: string; value: string } | undefined {
    if (!filter) return undefined;
    const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(filter);
    const column = m && allowed[m[1]!.toLowerCase()];
    if (!m || !column) throw new ScimError(400, 'Unsupported filter', 'invalidFilter');
    return { column, value: m[2]!.replace(/\\"/g, '"') };
  }

  const userFields = (b: ScimUserInput) => {
    const email = (
      b.userName ??
      b.emails?.find((e) => e.primary)?.value ??
      b.emails?.[0]?.value
    )?.toLowerCase();
    const display =
      b.displayName ?? b.name?.formatted ?? [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ');
    return { email, display: display || email, active: b.active ?? true, externalId: b.externalId ?? null };
  };

  const scimOpts = { config: { auth: 'public' as const, selfAudited: true }, schema: { hide: true } };

  app.get('/scim/v2/ServiceProviderConfig', scimOpts, async (_req, reply) =>
    send(reply, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Tenant-scoped SCIM token',
          primary: true,
        },
      ],
    }),
  );
  app.get('/scim/v2/ResourceTypes', scimOpts, async (_req, reply) =>
    send(reply, 200, {
      schemas: [LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: GROUP_SCHEMA,
        },
      ],
    }),
  );

  // ---- Users ----
  app.get('/scim/v2/Users', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const q = req.query as { filter?: string; startIndex?: string; count?: string };
      const f = parseFilter(q.filter, {
        username: 'email',
        externalid: 'external_id',
        'emails.value': 'email',
      });
      const start = Math.max(1, Number(q.startIndex ?? 1) || 1);
      const count = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0));
      const where = f ? `WHERE ${f.column} = $1` : '';
      const params = f ? [f.value] : [];
      const total = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.users ${where}`, params);
      const rows = await tx.query<UserRow>(
        `SELECT * FROM app.users ${where} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`,
        params,
      );
      return {
        status: 200,
        body: {
          schemas: [LIST_SCHEMA],
          totalResults: total.n,
          startIndex: start,
          itemsPerPage: rows.length,
          Resources: rows.map(userOut),
        },
      };
    }),
  );

  app.get('/scim/v2/Users/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const u = await tx.maybe<UserRow>('SELECT * FROM app.users WHERE id = $1', [
        (req.params as { id: string }).id,
      ]);
      if (!u) throw new ScimError(404, 'User not found');
      return { status: 200, body: userOut(u) };
    }),
  );

  app.post('/scim/v2/Users', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const f = userFields(req.body as ScimUserInput);
      if (!f.email) throw new ScimError(400, 'userName is required', 'invalidValue');
      const u = await tx.one<UserRow>(
        `INSERT INTO app.users (tenant_id, email, display_name, external_id, status, scim_managed) VALUES (app.current_tenant(), $1, $2, $3, $4, true) RETURNING *`,
        [f.email, f.display, f.externalId, f.active ? 'active' : 'deactivated'],
      );
      await assignRole(tx, u.id, 'employee');
      await audit(tx, req, 'scim.user_created', 'user', u.id, { active: f.active });
      return { status: 201, body: userOut(u) };
    }),
  );

  app.put('/scim/v2/Users/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      const f = userFields(req.body as ScimUserInput);
      const u = await tx.maybe<UserRow>(
        `UPDATE app.users SET email = coalesce($2, email), display_name = $3, external_id = $4, status = $5, scim_managed = true WHERE id = $1 RETURNING *`,
        [id, f.email ?? null, f.display, f.externalId, f.active ? 'active' : 'deactivated'],
      );
      if (!u) throw new ScimError(404, 'User not found');
      if (!f.active) await revokeUserSessions(tx, id);
      await audit(tx, req, 'scim.user_replaced', 'user', id, { active: f.active });
      return { status: 200, body: userOut(u) };
    }),
  );

  app.patch('/scim/v2/Users/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as {
        schemas?: string[];
        Operations?: Array<{ op: string; path?: string; value?: unknown }>;
      };
      if (!body.schemas?.includes(PATCH_SCHEMA) || !Array.isArray(body.Operations))
        throw new ScimError(400, 'Invalid PatchOp', 'invalidSyntax');
      const current = await tx.maybe<UserRow>('SELECT * FROM app.users WHERE id = $1', [id]);
      if (!current) throw new ScimError(404, 'User not found');
      const next = {
        email: current.email,
        display: current.display_name,
        externalId: current.external_id,
        active: current.status === 'active',
      };
      const apply = (path: string, value: unknown) => {
        const p = path.toLowerCase();
        if (p === 'active') next.active = value === true || value === 'true' || value === 'True';
        else if (p === 'username' || p === 'emails[type eq "work"].value' || p === 'emails.value')
          next.email = String(value).toLowerCase();
        else if (p === 'displayname' || p === 'name.formatted') next.display = String(value);
        else if (p === 'externalid') next.externalId = String(value);
        else if (p === 'name.givenname')
          next.display = `${value} ${next.display.split(' ').slice(1).join(' ')}`.trim();
        else if (p === 'name.familyname') next.display = `${next.display.split(' ')[0]} ${value}`.trim();
      };
      for (const op of body.Operations) {
        const kind = op.op.toLowerCase();
        if (!['add', 'replace', 'remove'].includes(kind))
          throw new ScimError(400, `Unsupported op ${op.op}`, 'invalidSyntax');
        if (kind === 'remove') continue;
        if (op.path) apply(op.path, op.value);
        else if (op.value && typeof op.value === 'object')
          for (const [k, v] of Object.entries(op.value)) apply(k, v);
      }
      const u = await tx.one<UserRow>(
        `UPDATE app.users SET email = $2, display_name = $3, external_id = $4, status = $5 WHERE id = $1 RETURNING *`,
        [id, next.email, next.display, next.externalId, next.active ? 'active' : 'deactivated'],
      );
      if (!next.active) await revokeUserSessions(tx, id);
      await audit(tx, req, 'scim.user_patched', 'user', id, { active: next.active });
      return { status: 200, body: userOut(u) };
    }),
  );

  app.delete('/scim/v2/Users/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      // Deprovisioning deactivates (HR records are retained per the retention engine), never hard-deletes.
      const n = await tx.exec(`UPDATE app.users SET status = 'deactivated' WHERE id = $1`, [id]);
      if (!n) throw new ScimError(404, 'User not found');
      await revokeUserSessions(tx, id);
      await audit(tx, req, 'scim.user_deactivated', 'user', id);
      return { status: 204 };
    }),
  );

  // ---- Groups ----
  type GroupRow = {
    id: string;
    display_name: string;
    external_id: string | null;
    created_at: string;
    updated_at: string;
  };

  app.get('/scim/v2/Groups', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const q = req.query as { filter?: string; startIndex?: string; count?: string };
      const f = parseFilter(q.filter, { displayname: 'display_name', externalid: 'external_id' });
      const start = Math.max(1, Number(q.startIndex ?? 1) || 1);
      const count = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0));
      const where = f ? `WHERE ${f.column} = $1` : '';
      const params = f ? [f.value] : [];
      const total = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.groups ${where}`, params);
      const rows = await tx.query<GroupRow>(
        `SELECT * FROM app.groups ${where} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`,
        params,
      );
      const resources = [];
      for (const g of rows) resources.push(await groupOut(tx, g));
      return {
        status: 200,
        body: {
          schemas: [LIST_SCHEMA],
          totalResults: total.n,
          startIndex: start,
          itemsPerPage: rows.length,
          Resources: resources,
        },
      };
    }),
  );

  app.get('/scim/v2/Groups/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const g = await tx.maybe<GroupRow>('SELECT * FROM app.groups WHERE id = $1', [
        (req.params as { id: string }).id,
      ]);
      if (!g) throw new ScimError(404, 'Group not found');
      return { status: 200, body: await groupOut(tx, g) };
    }),
  );

  async function setMembers(tx: Tx, groupId: string, ids: string[], mode: 'add' | 'remove' | 'replace') {
    if (mode === 'replace') await tx.exec('DELETE FROM app.group_members WHERE group_id = $1', [groupId]);
    for (const userId of ids) {
      if (mode === 'remove')
        await tx.exec('DELETE FROM app.group_members WHERE group_id = $1 AND user_id = $2', [
          groupId,
          userId,
        ]);
      else
        await tx.exec(
          `INSERT INTO app.group_members (tenant_id, group_id, user_id) SELECT app.current_tenant(), $1, id FROM app.users WHERE id = $2 ON CONFLICT DO NOTHING`,
          [groupId, userId],
        );
    }
  }

  app.post('/scim/v2/Groups', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const b = req.body as { displayName?: string; externalId?: string; members?: Array<{ value: string }> };
      if (!b.displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
      const g = await tx.one<GroupRow>(
        `INSERT INTO app.groups (tenant_id, display_name, external_id) VALUES (app.current_tenant(), $1, $2) RETURNING *`,
        [b.displayName, b.externalId ?? null],
      );
      await setMembers(
        tx,
        g.id,
        (b.members ?? []).map((m) => m.value),
        'add',
      );
      await audit(tx, req, 'scim.group_created', 'group', g.id);
      return { status: 201, body: await groupOut(tx, g) };
    }),
  );

  app.put('/scim/v2/Groups/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      const b = req.body as { displayName?: string; externalId?: string; members?: Array<{ value: string }> };
      const g = await tx.maybe<GroupRow>(
        'UPDATE app.groups SET display_name = coalesce($2, display_name), external_id = $3, updated_at = now() WHERE id = $1 RETURNING *',
        [id, b.displayName ?? null, b.externalId ?? null],
      );
      if (!g) throw new ScimError(404, 'Group not found');
      await setMembers(
        tx,
        id,
        (b.members ?? []).map((m) => m.value),
        'replace',
      );
      await audit(tx, req, 'scim.group_replaced', 'group', id);
      return { status: 200, body: await groupOut(tx, g) };
    }),
  );

  app.patch('/scim/v2/Groups/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as {
        schemas?: string[];
        Operations?: Array<{ op: string; path?: string; value?: unknown }>;
      };
      if (!body.schemas?.includes(PATCH_SCHEMA) || !Array.isArray(body.Operations))
        throw new ScimError(400, 'Invalid PatchOp', 'invalidSyntax');
      const exists = await tx.maybe<GroupRow>('SELECT * FROM app.groups WHERE id = $1', [id]);
      if (!exists) throw new ScimError(404, 'Group not found');
      for (const op of body.Operations) {
        const kind = op.op.toLowerCase() as 'add' | 'remove' | 'replace';
        const path = op.path ?? '';
        const filterMember = /^members\[value eq "([^"]+)"\]$/i.exec(path);
        if (filterMember && kind === 'remove') await setMembers(tx, id, [filterMember[1]!], 'remove');
        else if (path.toLowerCase() === 'members') {
          const values = Array.isArray(op.value)
            ? (op.value as Array<{ value: string }>).map((v) => v.value)
            : [];
          await setMembers(tx, id, values, kind);
        } else if (
          path.toLowerCase() === 'displayname' ||
          (!path && op.value && typeof op.value === 'object' && 'displayName' in op.value)
        ) {
          const name = path ? String(op.value) : String((op.value as { displayName: string }).displayName);
          await tx.exec('UPDATE app.groups SET display_name = $2, updated_at = now() WHERE id = $1', [
            id,
            name,
          ]);
        } else throw new ScimError(400, `Unsupported path ${path}`, 'invalidPath');
      }
      await tx.exec('UPDATE app.groups SET updated_at = now() WHERE id = $1', [id]);
      await audit(tx, req, 'scim.group_patched', 'group', id);
      const g = await tx.one<GroupRow>('SELECT * FROM app.groups WHERE id = $1', [id]);
      return { status: 200, body: await groupOut(tx, g) };
    }),
  );

  app.delete('/scim/v2/Groups/:id', scimOpts, async (req, reply) =>
    scim(req, reply, async (tx) => {
      const id = (req.params as { id: string }).id;
      const n = await tx.exec('DELETE FROM app.groups WHERE id = $1', [id]);
      if (!n) throw new ScimError(404, 'Group not found');
      await audit(tx, req, 'scim.group_deleted', 'group', id);
      return { status: 204 };
    }),
  );

  // ---- Token management (admin, regular API) ----
  app.post(
    '/v1/settings/scim-tokens',
    {
      config: { selfAudited: true, capability: 'settings.scim.manage' },
      schema: {
        tags: ['settings'],
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }),
        response: { 201: Type.Object({ id: Type.String(), token: Type.String() }), 403: Problem },
      },
    },
    async (req, reply) => {
      // settings admins and IT admins (the route's capability, ADR-0189)
      const auth = requireAuth(req);
      const secret = newToken();
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          'INSERT INTO app.scim_tokens (tenant_id, name, token_hash) VALUES (app.current_tenant(), $1, $2) RETURNING id',
          [(req.body as { name: string }).name, hashToken(secret)],
        );
        await app.audit(tx, req, { action: 'scim.token_created', targetType: 'scim_token', targetId: r.id });
        return r;
      });
      return reply.status(201).send({ id: row.id, token: composeToken(SCIM_PREFIX, auth.tenantId, secret) });
    },
  );

  // Listing never returns the token or its hash: a token is shown once, when it is created.
  const TokenOut = Type.Object({
    id: Type.String(),
    name: Type.String(),
    createdAt: Type.String(),
    lastUsedAt: Type.Union([Type.String(), Type.Null()]),
    revokedAt: Type.Union([Type.String(), Type.Null()]),
  });
  app.get(
    '/v1/settings/scim-tokens',
    {
      config: { capability: 'settings.scim' },
      schema: { tags: ['settings'], response: { 200: Type.Array(TokenOut), 403: Problem } },
    },
    async (req) => {
      requireAuth(req);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            name: string;
            created_at: string;
            last_used_at: string | null;
            revoked_at: string | null;
          }>(
            'SELECT id, name, created_at, last_used_at, revoked_at FROM app.scim_tokens ORDER BY created_at DESC LIMIT 200',
          ),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
      }));
    },
  );

  app.delete(
    '/v1/settings/scim-tokens/:id',
    {
      config: { selfAudited: true, capability: 'settings.scim.manage' },
      schema: {
        tags: ['settings'],
        summary: 'Revokes a SCIM token (it stops working immediately)',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      requireAuth(req);
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const n = await tx.exec(
          'UPDATE app.scim_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
          [id],
        );
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'scim.token_revoked', targetType: 'scim_token', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );
}
