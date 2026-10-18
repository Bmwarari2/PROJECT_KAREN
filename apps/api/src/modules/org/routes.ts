import type { FastifyInstance } from 'fastify';
import { Type, type TSchema } from 'typebox';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { isValidTimeZone } from '@thapsus/core/time';

/** Organisation reference data: generic, audited CRUD per resource. */
interface Resource {
  path: string;
  table: string;
  columns: Record<string, string>; // apiField → column
  body: TSchema;
  validate?: (b: Record<string, unknown>) => void;
}

const country = Type.String({ pattern: '^[A-Z]{2}$' });
const tz = (b: Record<string, unknown>) => {
  if (b.timeZone !== undefined && !isValidTimeZone(String(b.timeZone))) throw new ApiError('validation', 'Invalid time zone');
};

const RESOURCES: Resource[] = [
  {
    path: 'legal-entities',
    table: 'app.legal_entities',
    columns: { name: 'name', country: 'country', regionCode: 'region_code', registrationNumber: 'registration_number', currency: 'currency', timeZone: 'time_zone', address: 'address' },
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), country, regionCode: Type.Optional(Nullable(Type.String({ maxLength: 10 }))), registrationNumber: Type.Optional(Nullable(Type.String({ maxLength: 60 }))), currency: Type.String({ pattern: '^[A-Z]{3}$' }), timeZone: Type.String(), address: Type.Optional(Type.Record(Type.String(), Type.String())) }),
    validate: tz,
  },
  {
    path: 'locations',
    table: 'app.locations',
    columns: { name: 'name', entityId: 'entity_id', country: 'country', regionCode: 'region_code', timeZone: 'time_zone', address: 'address', geofence: 'geofence' },
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), entityId: Type.Optional(Nullable(Uuid)), country, regionCode: Type.Optional(Nullable(Type.String({ maxLength: 10 }))), timeZone: Type.String(), address: Type.Optional(Type.Record(Type.String(), Type.String())), geofence: Type.Optional(Nullable(Type.Object({ lat: Type.Number(), lng: Type.Number(), radiusMetres: Type.Integer({ minimum: 25, maximum: 5000 }) }))) }),
    validate: tz,
  },
  {
    path: 'departments',
    table: 'app.departments',
    columns: { name: 'name', code: 'code', parentId: 'parent_id' },
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), code: Type.Optional(Nullable(Type.String({ maxLength: 40 }))), parentId: Type.Optional(Nullable(Uuid)) }),
  },
  {
    path: 'cost-centres',
    table: 'app.cost_centres',
    columns: { code: 'code', name: 'name', entityId: 'entity_id' },
    body: Type.Object({ code: Type.String({ minLength: 1, maxLength: 40 }), name: Type.String({ minLength: 1, maxLength: 200 }), entityId: Type.Optional(Nullable(Uuid)) }),
  },
  {
    path: 'grades',
    table: 'app.grades',
    columns: { code: 'code', name: 'name', currency: 'currency', minMinor: 'min_minor', maxMinor: 'max_minor' },
    body: Type.Object({ code: Type.String({ minLength: 1, maxLength: 40 }), name: Type.String({ minLength: 1, maxLength: 200 }), currency: Type.Optional(Nullable(Type.String({ pattern: '^[A-Z]{3}$' }))), minMinor: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))), maxMinor: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))) }),
  },
  {
    path: 'positions',
    table: 'app.positions',
    columns: { title: 'title', departmentId: 'department_id', gradeId: 'grade_id', entityId: 'entity_id', locationId: 'location_id', headcount: 'headcount', status: 'status' },
    body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), departmentId: Type.Optional(Nullable(Uuid)), gradeId: Type.Optional(Nullable(Uuid)), entityId: Type.Optional(Nullable(Uuid)), locationId: Type.Optional(Nullable(Uuid)), headcount: Type.Optional(Type.Integer({ minimum: 1 })), status: Type.Optional(Type.Union(['open', 'filled', 'frozen', 'closed'].map((s) => Type.Literal(s)))) }),
  },
];

const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const mapRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'tenant_id').map(([k, v]) => [toCamel(k), v]));

export async function orgRoutes(app: FastifyInstance) {
  for (const res of RESOURCES) {
    const base = `/v1/org/${res.path}`;
    app.get(base, { schema: { tags: ['organisation'], response: { 200: Type.Array(Type.Object({ id: Uuid }, { additionalProperties: true })) } } }, async (req) => {
      requireAuth(req); // reference data is visible to everyone signed in
      const rows = await app.tenantTx(req, (tx) => tx.query<Record<string, unknown>>(`SELECT * FROM ${res.table} ORDER BY 2, id LIMIT 5000`), { readOnly: true });
      return rows.map(mapRow);
    });
    app.post(base, { config: { selfAudited: true }, schema: { tags: ['organisation'], body: res.body, response: { 201: Type.Object({ id: Uuid }, { additionalProperties: true }), 400: Problem, 403: Problem, 409: Problem } } }, async (req, reply) => {
      authorize(req, 'org.manage');
      const b = req.body as Record<string, unknown>;
      res.validate?.(b);
      const cols = Object.keys(b).filter((k) => k in res.columns);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<Record<string, unknown>>(
          `INSERT INTO ${res.table} (tenant_id, ${cols.map((c) => res.columns[c]).join(', ')}) VALUES (app.current_tenant(), ${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          cols.map((c) => (typeof b[c] === 'object' && b[c] !== null ? JSON.stringify(b[c]) : b[c])),
        );
        await app.audit(tx, req, { action: `org.${res.path}.created`, targetType: res.path, targetId: String(r.id), diff: b });
        return r;
      });
      return reply.status(201).send(mapRow(row));
    });
    app.patch(base + '/:id', { config: { selfAudited: true }, schema: { tags: ['organisation'], params: Type.Object({ id: Uuid }), body: Type.Partial(res.body as never), response: { 200: Type.Object({ id: Uuid }, { additionalProperties: true }), 403: Problem, 404: Problem } } }, async (req) => {
      authorize(req, 'org.manage');
      const { id } = req.params as { id: string };
      const b = req.body as Record<string, unknown>;
      res.validate?.(b);
      if (res.path === 'departments' && b.parentId) {
        const cycle = await app.tenantTx(req, (tx) =>
          tx.maybe(`WITH RECURSIVE up AS (SELECT id, parent_id FROM app.departments WHERE id = $1 UNION ALL SELECT d.id, d.parent_id FROM app.departments d JOIN up ON d.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`, [b.parentId, id]),
        );
        if (cycle) throw new ApiError('unprocessable', 'Department hierarchy cycle');
      }
      const cols = Object.keys(b).filter((k) => k in res.columns);
      return app.tenantTx(req, async (tx) => {
        const before = await tx.maybe<Record<string, unknown>>(`SELECT * FROM ${res.table} WHERE id = $1`, [id]);
        if (!before) throw new ApiError('notFound');
        const r = cols.length
          ? await tx.one<Record<string, unknown>>(`UPDATE ${res.table} SET ${cols.map((c, i) => `${res.columns[c]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => (typeof b[c] === 'object' && b[c] !== null ? JSON.stringify(b[c]) : b[c]))])
          : before;
        await app.audit(tx, req, { action: `org.${res.path}.updated`, targetType: res.path, targetId: id, diff: { before: mapRow(before), after: b } });
        return mapRow(r);
      });
    });
  }

  // ---- org chart: lazy subtree loading ---------------------------------------------------------
  const Node = Type.Object({ id: Uuid, displayName: Type.String(), jobTitle: Nullable(Type.String()), department: Nullable(Type.String()), directReports: Type.Integer(), managerId: Nullable(Type.String()) });
  const nodeSql = `SELECT e.id, e.display_name, e.job_title, d.name AS department, e.manager_id,
       (SELECT count(*)::int FROM app.employees c WHERE c.manager_id = e.id AND c.status = 'active') AS direct_reports
     FROM app.employees e LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id`;
  const mapNode = (r: { id: string; display_name: string; job_title: string | null; department: string | null; manager_id: string | null; direct_reports: number }) => ({
    id: r.id,
    displayName: r.display_name,
    jobTitle: r.job_title,
    department: r.department,
    managerId: r.manager_id,
    directReports: r.direct_reports,
  });

  app.get('/v1/org-chart/roots', { schema: { tags: ['organisation'], querystring: Type.Object({ entityId: Type.Optional(Uuid) }), response: { 200: Type.Array(Node) } } }, async (req) => {
    requireAuth(req);
    const { entityId } = req.query as { entityId?: string };
    const rows = await app.tenantTx(req, (tx) => tx.query<Parameters<typeof mapNode>[0]>(`${nodeSql} WHERE e.status = 'active' AND e.manager_id IS NULL ${entityId ? 'AND e.entity_id = $1' : ''} ORDER BY e.display_name LIMIT 500`, entityId ? [entityId] : []), { readOnly: true });
    return rows.map(mapNode);
  });

  app.get(
    '/v1/org-chart/:id/children',
    { schema: { tags: ['organisation'], params: Type.Object({ id: Uuid }), querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })) }), response: { 200: Type.Array(Node) } } },
    async (req) => {
      requireAuth(req);
      const { id } = req.params as { id: string };
      const limit = (req.query as { limit?: number }).limit ?? 200;
      const rows = await app.tenantTx(req, (tx) => tx.query<Parameters<typeof mapNode>[0]>(`${nodeSql} WHERE e.status = 'active' AND e.manager_id = $1 ORDER BY e.display_name LIMIT ${limit}`, [id]), { readOnly: true });
      return rows.map(mapNode);
    },
  );

  /** Focus on a person: their chain up to the root plus their direct reports. */
  app.get('/v1/org-chart/:id/focus', { schema: { tags: ['organisation'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ chain: Type.Array(Node), node: Node, children: Type.Array(Node) }), 404: Problem } } }, async (req) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    return app.tenantTx(
      req,
      async (tx) => {
        const chain = await tx.query<Parameters<typeof mapNode>[0] & { depth: number }>(
          `WITH RECURSIVE up AS (SELECT id, manager_id, 0 AS depth FROM app.employees WHERE id = $1
             UNION ALL SELECT e.id, e.manager_id, up.depth + 1 FROM app.employees e JOIN up ON e.id = up.manager_id WHERE up.depth < 50)
           SELECT n.*, up.depth FROM up JOIN (${nodeSql}) n ON n.id = up.id ORDER BY up.depth DESC`,
          [id],
        );
        const node = chain.find((c) => c.id === id);
        if (!node) throw new ApiError('notFound');
        const children = await tx.query<Parameters<typeof mapNode>[0]>(`${nodeSql} WHERE e.status = 'active' AND e.manager_id = $1 ORDER BY e.display_name LIMIT 200`, [id]);
        return { chain: chain.filter((c) => c.id !== id).map(mapNode), node: mapNode(node), children: children.map(mapNode) };
      },
      { readOnly: true },
    );
  });

  app.get('/v1/org-chart/search', { schema: { tags: ['organisation'], querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 100 }) }), response: { 200: Type.Array(Node) } } }, async (req) => {
    authorizeSome(req, 'self.read');
    const { q } = req.query as { q: string };
    const rows = await app.tenantTx(
      req,
      (tx) => tx.query<Parameters<typeof mapNode>[0]>(`${nodeSql} WHERE e.status = 'active' AND (e.search @@ plainto_tsquery('simple', $1) OR e.display_name ILIKE $2) ORDER BY e.display_name LIMIT 20`, [q, `%${q.replace(/[%_\\]/g, '\\$&')}%`]),
      { readOnly: true },
    );
    return rows.map(mapNode);
  });
}
