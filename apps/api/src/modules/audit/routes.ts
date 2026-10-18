import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { authorize } from '../../http/context';
import { Problem, decodeCursor, encodeCursor } from '../../http/schemas';

const AuditEvent = Type.Object({
  id: Type.String(),
  seq: Type.Union([Type.String(), Type.Null()]),
  at: Type.String(),
  actorType: Type.String(),
  actorId: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  targetType: Type.Union([Type.String(), Type.Null()]),
  targetId: Type.Union([Type.String(), Type.Null()]),
  diff: Type.Any(),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  requestId: Type.Union([Type.String(), Type.Null()]),
  sensitive: Type.Boolean(),
  hash: Type.Union([Type.String(), Type.Null()]),
});

interface Row {
  id: string;
  seq: string | null;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  diff: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  sensitive: boolean;
  hash: string | null;
}

const map = (r: Row) => ({
  id: r.id,
  seq: r.seq,
  at: r.at,
  actorType: r.actor_type,
  actorId: r.actor_id,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  diff: r.diff,
  ip: r.ip,
  userAgent: r.user_agent,
  requestId: r.request_id,
  sensitive: r.sensitive,
  hash: r.hash,
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function auditRoutes(app: FastifyInstance) {
  app.get(
    '/v1/audit/events',
    {
      schema: {
        tags: ['audit'],
        summary: 'List or export the audit log (JSON page or full CSV/JSON download for a date range)',
        querystring: Type.Object({
          from: Type.String({ format: 'date-time' }),
          to: Type.String({ format: 'date-time' }),
          format: Type.Optional(Type.Union([Type.Literal('page'), Type.Literal('csv'), Type.Literal('json')])),
          action: Type.Optional(Type.String({ maxLength: 100 })),
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
        response: { 200: Type.Union([Type.Object({ data: Type.Array(AuditEvent), nextCursor: Type.Union([Type.String(), Type.Null()]) }), Type.String(), Type.Array(AuditEvent)]), 403: Problem },
      },
    },
    async (req, reply) => {
      const q = req.query as { from: string; to: string; format?: string; action?: string; cursor?: string; limit?: number };
      authorize(req, q.format && q.format !== 'page' ? 'audit.export' : 'audit.read');
      const params: unknown[] = [q.from, q.to];
      let where = 'at >= $1 AND at < $2';
      if (q.action) {
        params.push(`${q.action}%`);
        where += ` AND action LIKE $${params.length}`;
      }
      if (!q.format || q.format === 'page') {
        const after = decodeCursor<[string]>(q.cursor);
        if (after) {
          params.push(after[0]);
          where += ` AND id > $${params.length}`;
        }
        const limit = q.limit ?? 100;
        const rows = await app.tenantTx(req, (tx) => tx.query<Row>(`SELECT *, encode(hash, 'hex') AS hash FROM audit.events WHERE ${where} ORDER BY id LIMIT ${limit + 1}`, params), { readOnly: true });
        const page = rows.slice(0, limit);
        return { data: page.map(map), nextCursor: rows.length > limit ? encodeCursor([page.at(-1)!.id]) : null };
      }
      const rows = await app.tenantTx(req, async (tx) => {
        const r = await tx.query<Row>(`SELECT *, encode(hash, 'hex') AS hash FROM audit.events WHERE ${where} ORDER BY id LIMIT 200000`, params);
        await app.audit(tx, req, { action: 'audit.exported', diff: { from: q.from, to: q.to, format: q.format, rows: r.length } });
        return r;
      });
      const stamp = q.from.slice(0, 10) + '_' + q.to.slice(0, 10);
      if (q.format === 'json') {
        return reply.header('Content-Disposition', `attachment; filename="audit_${stamp}.json"`).send(rows.map(map));
      }
      const cols = ['id', 'seq', 'at', 'actorType', 'actorId', 'action', 'targetType', 'targetId', 'diff', 'ip', 'userAgent', 'requestId', 'sensitive', 'hash'] as const;
      const lines = [cols.join(','), ...rows.map((r) => { const m = map(r); return cols.map((c) => csvCell(m[c])).join(','); })];
      return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="audit_${stamp}.csv"`).send(lines.join('\r\n'));
    },
  );

  app.post(
    '/v1/audit/verify',
    { config: { selfAudited: true }, schema: { tags: ['audit'], response: { 200: Type.Object({ intact: Type.Boolean(), firstBrokenSeq: Type.Union([Type.String(), Type.Null()]), sealed: Type.Integer() }), 403: Problem } } },
    async (req) => {
      authorize(req, 'audit.read');
      return app.tenantTx(req, async (tx) => {
        const sealed = await tx.one<{ n: number }>('SELECT audit.seal_pending() AS n');
        const v = await tx.one<{ broken: string | null }>('SELECT audit.verify_chain() AS broken');
        await app.audit(tx, req, { action: 'audit.verified', diff: { intact: v.broken === null } });
        return { intact: v.broken === null, firstBrokenSeq: v.broken, sealed: sealed.n };
      });
    },
  );
}
