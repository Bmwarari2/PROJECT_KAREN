import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { diffObjects } from '@thapsus/db';
import { EMPLOYEE_FIELD_GROUPS, EMPLOYEE_FIELDS, PERMISSION_CATALOGUE, SCOPE_TYPES, type RoleDefinition } from '@thapsus/core/access';
import type { FieldAccess, Scope, ScopeType } from '@thapsus/core/permissions';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { decodeCursor, encodeCursor, Nullable, Problem, Uuid } from '../../http/schemas';
import {
  activeOwnerAssignments,
  additions,
  assertWithinCaller,
  assigneeFacts,
  customKeys,
  effectiveIsAdmin,
  exceeds,
  mayHandOut,
  normaliseScope,
  ROLE_SELECT,
  roleSnapshot,
  scopeLabels,
  toRole,
  validateDefinition,
  type AssigneeRow,
  type RoleRow,
} from './service';

/**
 * Role and access management: custom roles (built-in roles are read-only, defined in code) and scoped
 * role assignments. Every change is guarded against privilege escalation and audited with a
 * before/after diff (ADR-0120, ADR-0121). The principal is loaded from the database on every request,
 * so a change applies to the person's very next request (there is no principal cache to invalidate).
 */
const TAGS = ['roles'];
const FieldLevel = Type.Union([Type.Literal('none'), Type.Literal('read'), Type.Literal('write')]);
const FieldMap = Type.Record(Type.String({ maxLength: 120 }), FieldLevel, { maxProperties: 300 });
const ScopeSchema = Type.Object(
  {
    type: Type.Union(SCOPE_TYPES.map((s) => Type.Literal(s))),
    values: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 200 })),
  },
  { additionalProperties: false },
);
const RoleOut = Type.Object({
  id: Uuid,
  key: Type.String(),
  name: Type.String(),
  description: Nullable(Type.String()),
  builtIn: Type.Boolean(),
  isAdmin: Type.Boolean(),
  permissions: Type.Array(Type.String()),
  fieldAccess: Type.Record(Type.String(), FieldLevel),
  assignmentCount: Type.Integer(),
  updatedAt: Type.String({ format: 'date-time' }),
});
const Permissions = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 300, uniqueItems: true });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Description = Nullable(Type.String({ maxLength: 500 }));
const CreateRole = Type.Object(
  {
    key: Type.String({ pattern: '^[a-z][a-z0-9_]{1,40}$', description: 'Stable identifier, unique in the workspace; built-in keys are reserved' }),
    name: Name,
    description: Type.Optional(Description),
    permissions: Permissions,
    fieldAccess: Type.Optional(FieldMap),
    isAdmin: Type.Optional(Type.Boolean({ description: 'Forced on when the role holds an admin-grade permission' })),
  },
  { additionalProperties: false },
);
const UpdateRole = Type.Object(
  { name: Type.Optional(Name), description: Type.Optional(Description), permissions: Type.Optional(Permissions), fieldAccess: Type.Optional(FieldMap), isAdmin: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
);
const Assignment = Type.Object({
  id: Uuid,
  roleId: Uuid,
  roleKey: Type.String(),
  roleName: Type.String(),
  builtIn: Type.Boolean(),
  isAdmin: Type.Boolean(),
  scope: Type.Object({ type: Type.String(), values: Type.Array(Type.String()) }),
  scopeLabels: Type.Array(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
  createdBy: Nullable(Uuid),
  canRevoke: Type.Boolean(),
});
const UserSummary = Type.Object({
  id: Uuid,
  displayName: Type.String(),
  email: Type.String(),
  employeeId: Nullable(Uuid),
  status: Type.String(),
  hasMfa: Type.Boolean(),
  roles: Type.Array(Type.String()),
});

const BUILT_IN_REFUSED = () => new ApiError('conflict', 'Built-in roles are defined by Thapsus-HR and cannot be changed; copy one instead', { reason: 'builtInRole' });
const HAS_MFA = `EXISTS (SELECT 1 FROM app.totp_factors f WHERE f.tenant_id = u.tenant_id AND f.user_id = u.id AND f.verified_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM app.passkeys k WHERE k.tenant_id = u.tenant_id AND k.user_id = u.id)`;

interface AssignmentRow {
  id: string;
  role_id: string;
  key: string;
  name: string;
  built_in: boolean;
  is_admin: boolean;
  permissions: string[];
  field_access: Record<string, FieldAccess>;
  scope_type: ScopeType;
  scope_values: string[];
  created_at: string;
  created_by: string | null;
}
const ASSIGNMENT_SELECT = `SELECT a.id, a.role_id, r.key, r.name, r.built_in, r.is_admin, r.permissions, r.field_access, a.scope_type, a.scope_values, a.created_at, a.created_by
  FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id`;

export async function roleRoutes(app: FastifyInstance) {
  // ---- catalogue -----------------------------------------------------------------------------------
  app.get(
    '/v1/roles/catalogue',
    {
      schema: {
        tags: TAGS,
        summary: 'Permissions (grouped by area) and employee fields a custom role may grant',
        response: {
          200: Type.Object({
            areas: Type.Array(Type.Object({ area: Type.String(), permissions: Type.Array(Type.Object({ key: Type.String(), admin: Type.Boolean() })) })),
            fields: Type.Array(Type.Object({ key: Type.String(), section: Type.String() })),
            fieldGroups: Type.Array(Type.String()),
            customFields: Type.Array(Type.Object({ key: Type.String(), label: Type.Record(Type.String(), Type.String()) })),
            scopeTypes: Type.Array(Type.String()),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'roles.read');
      const custom = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{ key: string; label: Record<string, string> }>(
            `SELECT key, label FROM app.custom_field_definitions WHERE entity_type = 'employee' AND NOT archived
             UNION ALL SELECT key, label FROM app.custom_object_types ORDER BY 1`,
          ),
        { readOnly: true },
      );
      return {
        areas: PERMISSION_CATALOGUE.filter((a) => a.permissions.length).map((a) => ({ area: a.area, permissions: a.permissions.map((x) => ({ key: x.key, admin: !!x.admin })) })),
        fields: EMPLOYEE_FIELDS.map((x) => ({ key: x.key, section: x.section })),
        fieldGroups: [...EMPLOYEE_FIELD_GROUPS],
        customFields: custom,
        scopeTypes: [...SCOPE_TYPES],
      };
    },
  );

  // ---- roles ---------------------------------------------------------------------------------------
  app.get('/v1/roles', { schema: { tags: TAGS, summary: 'Built-in and custom roles with their permissions and field access', response: { 200: Type.Array(RoleOut), 403: Problem } } }, async (req) => {
    authorizeSome(req, 'roles.read');
    const rows = await app.tenantTx(req, (tx) => tx.query<RoleRow>(`${ROLE_SELECT} ORDER BY r.built_in DESC, r.name, r.id`), { readOnly: true });
    return rows.map(toRole);
  });

  app.get('/v1/roles/:id', { schema: { tags: TAGS, params: Type.Object({ id: Uuid }), response: { 200: RoleOut, 403: Problem, 404: Problem } } }, async (req) => {
    authorizeSome(req, 'roles.read');
    const { id } = req.params as { id: string };
    const row = await app.tenantTx(req, (tx) => tx.maybe<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id]), { readOnly: true });
    if (!row) throw new ApiError('notFound');
    return toRole(row);
  });

  app.post(
    '/v1/roles',
    { config: { selfAudited: true }, schema: { tags: TAGS, summary: 'Create a custom role (no more than you hold yourself)', body: CreateRole, response: { 201: RoleOut, 400: Problem, 403: Problem, 409: Problem } } },
    async (req, reply) => {
      const auth = authorizeSome(req, 'roles.manage');
      const b = req.body as { key: string; name: string; description?: string | null; permissions: string[]; fieldAccess?: Record<string, FieldAccess>; isAdmin?: boolean };
      const def: RoleDefinition = { permissions: b.permissions, fieldAccess: b.fieldAccess ?? {} };
      const row = await app.tenantTx(req, async (tx) => {
        const custom = await customKeys(tx);
        validateDefinition(def, custom);
        assertWithinCaller(auth.principal, def, custom);
        const taken = await tx.maybe(`SELECT 1 FROM app.roles WHERE key = $1`, [b.key]);
        if (taken) throw new ApiError('conflict', 'A role with that key already exists', { reason: 'keyTaken' });
        const isAdmin = effectiveIsAdmin(b.isAdmin, def.permissions);
        const r = await tx.one<RoleRow>(
          `INSERT INTO app.roles (tenant_id, key, name, description, built_in, is_admin, permissions, field_access)
           VALUES (app.current_tenant(), $1, $2, $3, false, $4, $5, $6) RETURNING *, 0 AS assignment_count`,
          [b.key, b.name, b.description ?? null, isAdmin, def.permissions, JSON.stringify(def.fieldAccess)],
        );
        await app.audit(tx, req, { action: 'role.created', targetType: 'role', targetId: r.id, diff: diffObjects(null, roleSnapshot(toRole(r))) });
        return r;
      });
      return reply.status(201).send(toRole(row));
    },
  );

  app.patch(
    '/v1/roles/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: TAGS,
        summary: 'Change a custom role; takes effect on its holders’ next request',
        params: Type.Object({ id: Uuid }),
        body: UpdateRole,
        response: { 200: RoleOut, 400: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'roles.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { name?: string; description?: string | null; permissions?: string[]; fieldAccess?: Record<string, FieldAccess>; isAdmin?: boolean };
      const row = await app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<RoleRow>(`SELECT * FROM app.roles WHERE id = $1 FOR UPDATE`, [id]);
        if (!before) throw new ApiError('notFound');
        if (before.built_in) throw BUILT_IN_REFUSED();
        const custom = await customKeys(tx);
        const prev: RoleDefinition = { permissions: before.permissions, fieldAccess: before.field_access };
        const next: RoleDefinition = { permissions: b.permissions ?? prev.permissions, fieldAccess: b.fieldAccess ?? prev.fieldAccess };
        validateDefinition(next, custom);
        // You can only edit a role that is within your own access, and only into one that still is.
        assertWithinCaller(auth.principal, prev, custom);
        assertWithinCaller(auth.principal, next, custom);
        // Anything the change adds reaches every holder at their assignment's scope: you must hold it there.
        const added = additions(prev, next, custom);
        if (added.permissions.size || added.fields.size) {
          const holders = await tx.query<{ scope_type: ScopeType; scope_values: string[] } & AssigneeRow>(
            `SELECT a.scope_type, a.scope_values, u.id, u.display_name, u.email, u.employee_id, u.status
               FROM app.role_assignments a JOIN app.users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id WHERE a.role_id = $1`,
            [id],
          );
          for (const h of holders) {
            const check = mayHandOut(auth.principal, next, { type: h.scope_type, values: h.scope_values }, await assigneeFacts(tx, auth.principal, h), custom);
            const permissions = check.permissions.filter((x) => added.permissions.has(x));
            const fields = check.fields.filter((x) => added.fields.has(x));
            if (permissions.length || fields.length) throw exceeds(permissions, fields);
          }
        }
        const isAdmin = effectiveIsAdmin(b.isAdmin ?? before.is_admin, next.permissions);
        const r = await tx.one<RoleRow>(
          `UPDATE app.roles SET name = $2, description = $3, is_admin = $4, permissions = $5, field_access = $6 WHERE id = $1
           RETURNING *, (SELECT count(*) FROM app.role_assignments a WHERE a.role_id = $1) AS assignment_count`,
          [id, b.name ?? before.name, b.description === undefined ? before.description : b.description, isAdmin, next.permissions, JSON.stringify(next.fieldAccess)],
        );
        await app.audit(tx, req, { action: 'role.updated', targetType: 'role', targetId: id, diff: diffObjects(roleSnapshot(toRole(before)), roleSnapshot(toRole(r))) });
        return r;
      });
      return toRole(row);
    },
  );

  app.delete(
    '/v1/roles/:id',
    { config: { selfAudited: true }, schema: { tags: TAGS, summary: 'Delete a custom role that nobody holds', params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 403: Problem, 404: Problem, 409: Problem } } },
    async (req, reply) => {
      const auth = authorizeSome(req, 'roles.manage');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<RoleRow>(`SELECT * FROM app.roles WHERE id = $1 FOR UPDATE`, [id]);
        if (!before) throw new ApiError('notFound');
        if (before.built_in) throw BUILT_IN_REFUSED();
        assertWithinCaller(auth.principal, { permissions: before.permissions, fieldAccess: before.field_access }, await customKeys(tx));
        const used = await tx.one<{ n: string }>(`SELECT count(*) AS n FROM app.role_assignments WHERE role_id = $1`, [id]);
        if (Number(used.n) > 0) throw new ApiError('conflict', 'The role is still assigned; revoke its assignments first', { reason: 'roleInUse', assignments: Number(used.n) });
        await tx.exec(`DELETE FROM app.roles WHERE id = $1`, [id]);
        await app.audit(tx, req, { action: 'role.deleted', targetType: 'role', targetId: id, diff: diffObjects(roleSnapshot(toRole(before)), null) });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- users and their assignments -----------------------------------------------------------------
  app.get(
    '/v1/users',
    {
      schema: {
        tags: TAGS,
        summary: 'People with a sign-in and the roles they hold (for access management)',
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })), cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }),
        response: { 200: Type.Object({ data: Type.Array(UserSummary), nextCursor: Nullable(Type.String()) }), 403: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'roles.read');
      const q = req.query as { q?: string; cursor?: string; limit?: number };
      const params: unknown[] = [];
      const where: string[] = ['true'];
      const add = (v: unknown) => (params.push(v), `$${params.length}`);
      if (q.q) {
        const like = add(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(u.display_name ILIKE ${like} OR u.email::text ILIKE ${like})`);
      }
      const after = decodeCursor<[string, string]>(q.cursor);
      if (after) where.push(`(u.display_name, u.id) > (${add(after[0])}, ${add(after[1])}::uuid)`);
      const limit = q.limit ?? 50;
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{ id: string; display_name: string; email: string; employee_id: string | null; status: string; has_mfa: boolean; roles: string[] | null }>(
            `SELECT u.id, u.display_name, u.email, u.employee_id, u.status, (${HAS_MFA}) AS has_mfa,
                    (SELECT array_agg(DISTINCT r.key ORDER BY r.key) FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id WHERE a.user_id = u.id) AS roles
               FROM app.users u WHERE ${where.join(' AND ')} ORDER BY u.display_name, u.id LIMIT ${limit + 1}`,
            params,
          ),
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      return {
        data: page.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, employeeId: r.employee_id, status: r.status, hasMfa: r.has_mfa, roles: r.roles ?? [] })),
        nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.display_name, page.at(-1)!.id]) : null,
      };
    },
  );

  app.get(
    '/v1/users/:userId/role-assignments',
    {
      schema: {
        tags: TAGS,
        summary: 'A person’s role assignments, with whether the caller may revoke each one',
        params: Type.Object({ userId: Uuid }),
        response: { 200: Type.Object({ user: UserSummary, assignments: Type.Array(Assignment) }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'roles.read');
      const { userId } = req.params as { userId: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const user = await tx.maybe<AssigneeRow & { has_mfa: boolean }>(`SELECT u.id, u.display_name, u.email, u.employee_id, u.status, (${HAS_MFA}) AS has_mfa FROM app.users u WHERE u.id = $1`, [userId]);
          if (!user) throw new ApiError('notFound');
          const rows = await tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE a.user_id = $1 ORDER BY r.built_in DESC, r.name, a.created_at`, [userId]);
          const facts = await assigneeFacts(tx, auth.principal, user);
          const custom = await customKeys(tx);
          const assignments = [];
          for (const r of rows) {
            const scope: Scope = { type: r.scope_type, values: r.scope_values };
            assignments.push({
              id: r.id,
              roleId: r.role_id,
              roleKey: r.key,
              roleName: r.name,
              builtIn: r.built_in,
              isAdmin: r.is_admin,
              scope: { type: r.scope_type, values: r.scope_values },
              scopeLabels: await scopeLabels(tx, scope),
              createdAt: new Date(r.created_at).toISOString(),
              createdBy: r.created_by,
              canRevoke: mayHandOut(auth.principal, { permissions: r.permissions, fieldAccess: r.field_access }, scope, facts, custom).ok,
            });
          }
          return {
            user: { id: user.id, displayName: user.display_name, email: user.email, employeeId: user.employee_id, status: user.status, hasMfa: user.has_mfa, roles: [...new Set(rows.map((r) => r.key))].sort() },
            assignments,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/users/:userId/role-assignments',
    {
      config: { selfAudited: true },
      schema: {
        tags: TAGS,
        summary: 'Give a person a role at a scope (no wider than your own); applies from their next request',
        description: 'Admin roles may be assigned to people without two-step verification; they must then set it up before using the app.',
        params: Type.Object({ userId: Uuid }),
        body: Type.Object({ roleId: Uuid, scope: ScopeSchema }, { additionalProperties: false }),
        response: { 201: Assignment, 400: Problem, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'roles.assign');
      const { userId } = req.params as { userId: string };
      const b = req.body as { roleId: string; scope: Scope };
      const out = await app.tenantTx(req, async (tx) => {
        const user = await tx.maybe<AssigneeRow>(`SELECT id, display_name, email, employee_id, status FROM app.users WHERE id = $1`, [userId]);
        if (!user) throw new ApiError('notFound');
        const role = await tx.maybe<RoleRow>(`SELECT * FROM app.roles WHERE id = $1`, [b.roleId]);
        if (!role) throw new ApiError('notFound');
        const scope = await normaliseScope(tx, b.scope);
        if (role.built_in && role.key === 'owner' && scope.type !== 'all') {
          throw new ApiError('validation', undefined, { errors: [{ path: '/scope/type', message: 'ownerScopeAll' }] });
        }
        const custom = await customKeys(tx);
        const check = mayHandOut(auth.principal, { permissions: role.permissions, fieldAccess: role.field_access }, scope, await assigneeFacts(tx, auth.principal, user), custom);
        if (!check.mayAssign) throw new ApiError('forbidden', 'You cannot assign roles at that scope', { reason: 'scopeTooWide', permissions: [], fields: [] });
        if (!check.ok) throw exceeds(check.permissions, check.fields);
        const dup = await tx.maybe(`SELECT 1 FROM app.role_assignments WHERE user_id = $1 AND role_id = $2 AND scope_type = $3 AND scope_values = $4`, [userId, role.id, scope.type, scope.values]);
        if (dup) throw new ApiError('conflict', 'The person already holds this role at this scope', { reason: 'duplicateAssignment' });
        const a = await tx.one<{ id: string; created_at: string }>(
          `INSERT INTO app.role_assignments (tenant_id, user_id, role_id, scope_type, scope_values, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id, created_at`,
          [userId, role.id, scope.type, scope.values, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'role.assigned',
          targetType: 'user',
          targetId: userId,
          diff: { assignmentId: a.id, ...diffObjects(null, { role: role.key, scopeType: scope.type, scopeValues: scope.values, isAdmin: role.is_admin }) },
        });
        return {
          id: a.id,
          roleId: role.id,
          roleKey: role.key,
          roleName: role.name,
          builtIn: role.built_in,
          isAdmin: role.is_admin,
          scope: { type: scope.type, values: scope.values ?? [] },
          scopeLabels: await scopeLabels(tx, scope),
          createdAt: new Date(a.created_at).toISOString(),
          createdBy: auth.userId,
          canRevoke: true,
        };
      });
      return reply.status(201).send(out);
    },
  );

  app.delete(
    '/v1/users/:userId/role-assignments/:assignmentId',
    {
      config: { selfAudited: true },
      schema: {
        tags: TAGS,
        summary: 'Revoke an assignment you could have made; the last owner cannot be removed',
        params: Type.Object({ userId: Uuid, assignmentId: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'roles.assign');
      const { userId, assignmentId } = req.params as { userId: string; assignmentId: string };
      await app.tenantTx(req, async (tx) => {
        const owners = await activeOwnerAssignments(tx);
        const a = await tx.maybe<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE a.id = $1 AND a.user_id = $2 FOR UPDATE OF a`, [assignmentId, userId]);
        if (!a) throw new ApiError('notFound');
        const user = await tx.one<AssigneeRow>(`SELECT id, display_name, email, employee_id, status FROM app.users WHERE id = $1`, [userId]);
        const scope: Scope = { type: a.scope_type, values: a.scope_values };
        const check = mayHandOut(auth.principal, { permissions: a.permissions, fieldAccess: a.field_access }, scope, await assigneeFacts(tx, auth.principal, user), await customKeys(tx));
        if (!check.mayAssign) throw new ApiError('forbidden', 'You cannot manage roles at that scope', { reason: 'scopeTooWide', permissions: [], fields: [] });
        if (!check.ok) throw exceeds(check.permissions, check.fields);
        if (owners.includes(a.id) && owners.length <= 1) throw new ApiError('conflict', 'A workspace always keeps at least one owner', { reason: 'lastOwner' });
        await tx.exec(`DELETE FROM app.role_assignments WHERE id = $1`, [assignmentId]);
        await app.audit(tx, req, {
          action: 'role.revoked',
          targetType: 'user',
          targetId: userId,
          diff: { assignmentId, ...diffObjects({ role: a.key, scopeType: a.scope_type, scopeValues: a.scope_values, isAdmin: a.is_admin }, null) },
        });
      });
      return reply.status(204).send(null);
    },
  );
}
