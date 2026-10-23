import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Type, type Static } from 'typebox';
import { addMinutes, compareInstants } from '@thapsus/core/time';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { throttle } from '../auth/common';
import { backofficePool, requireStaff, staffAudit } from '../backoffice/auth';
import { COMPONENTS, computeStatus, type Component, type IncidentInput } from './service';

/** History window shown on the public page. */
export const STATUS_HISTORY_DAYS = 30;
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed'] as const;

const IncidentT = Type.Object({
  id: Uuid,
  kind: Type.String(),
  impact: Type.String(),
  title: Type.String(),
  components: Type.Array(Type.String()),
  status: Type.String(),
  scheduledStart: Nullable(Type.String()),
  scheduledEnd: Nullable(Type.String()),
  startedAt: Type.String(),
  resolvedAt: Nullable(Type.String()),
  updates: Type.Array(Type.Object({ status: Type.String(), body: Type.String(), createdAt: Type.String() })),
});
export const StatusT = Type.Object({
  region: Type.String(),
  generatedAt: Type.String(),
  overall: Type.String(),
  components: Type.Array(Type.Object({ id: Type.String(), state: Type.String() })),
  active: Type.Array(IncidentT),
  upcoming: Type.Array(IncidentT),
  history: Type.Array(IncidentT),
});

export async function statusRoutes(app: FastifyInstance) {
  const deps = app.deps;

  async function loadIncidents(pool: pg.Pool, now: string): Promise<IncidentInput[]> {
    const since = addMinutes(now, -STATUS_HISTORY_DAYS * 24 * 60);
    const { rows } = (await pool.query(
      `SELECT id, kind, impact, title, components, status, scheduled_start, scheduled_end, started_at, resolved_at FROM backoffice.status_incidents
        WHERE resolved_at IS NULL OR resolved_at >= $1 ORDER BY started_at DESC LIMIT 200`,
      [since],
    )) as {
      rows: Array<{
        id: string;
        kind: IncidentInput['kind'];
        impact: IncidentInput['impact'];
        title: string;
        components: Component[];
        status: string;
        scheduled_start: string | null;
        scheduled_end: string | null;
        started_at: string;
        resolved_at: string | null;
      }>;
    };
    const ids = rows.map((r) => r.id);
    const updates = ids.length
      ? (
          (await pool.query(
            'SELECT incident_id, status, body, created_at FROM backoffice.status_updates WHERE incident_id = ANY($1::uuid[]) ORDER BY created_at DESC',
            [ids],
          )) as { rows: Array<{ incident_id: string; status: string; body: string; created_at: string }> }
        ).rows
      : [];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      impact: r.impact,
      title: r.title,
      components: r.components,
      status: r.status,
      scheduledStart: r.scheduled_start,
      scheduledEnd: r.scheduled_end,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
      updates: updates
        .filter((u) => u.incident_id === r.id)
        .map((u) => ({ status: u.status, body: u.body, createdAt: u.created_at })),
    }));
  }

  // Public, unauthenticated, personal-data-free: edge-cacheable for 30 s (ADR-0105).
  app.get(
    '/v1/status',
    {
      config: { auth: 'public', edgeCacheable: true },
      schema: {
        tags: ['status'],
        summary: "This region's service status: components, active incidents, maintenance and recent history",
        security: [],
        response: { 200: StatusT, 429: Problem },
      },
    },
    async (req, reply) => {
      await throttle(deps, [[`status:ip:${req.ctx.ip}`, 300, 60]]);
      const now = deps.now().toISOString();
      const pool = deps.router.registryPool();
      const started = performance.now();
      let ok = true;
      try {
        await pool.query('SELECT 1');
      } catch {
        ok = false;
      }
      const latencyMs = Math.round(performance.now() - started);
      let beats: Array<{
        service: string;
        beat_at: string;
        last_success_at: string | null;
        last_failure_at: string | null;
        recent_failures: number;
      }> = [];
      let incidents: IncidentInput[] = [];
      if (ok) {
        beats = (
          await pool.query(
            'SELECT service, beat_at, last_success_at, last_failure_at, recent_failures FROM backoffice.service_heartbeats',
          )
        ).rows;
        incidents = await loadIncidents(pool, now);
      }
      const email = beats.find((b) => b.service === 'email');
      const status = computeStatus({
        region: deps.config.cell,
        now,
        database: { ok, latencyMs },
        worker: { beatAt: beats.find((b) => b.service === 'worker')?.beat_at ?? null },
        email: email
          ? {
              lastSuccessAt: email.last_success_at,
              lastFailureAt: email.last_failure_at,
              recentFailures: email.recent_failures,
            }
          : null,
        incidents,
      });
      reply.header('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
      return status;
    },
  );

  // ---- staff: incidents and maintenance for this cell's region ---------------------------------------
  app.get(
    '/v1/backoffice/status/incidents',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['support']),
      schema: { tags: ['backoffice'], response: { 200: Type.Array(IncidentT), 401: Problem, 403: Problem } },
    },
    async () => loadIncidents(backofficePool(app), deps.now().toISOString()),
  );

  const NewIncident = Type.Object({
    kind: Type.Union([Type.Literal('incident'), Type.Literal('maintenance')]),
    impact: Type.Union([
      Type.Literal('minor'),
      Type.Literal('major'),
      Type.Literal('critical'),
      Type.Literal('maintenance'),
    ]),
    title: Type.String({ minLength: 3, maxLength: 160 }),
    components: Type.Array(Type.Union(COMPONENTS.map((c) => Type.Literal(c))), {
      minItems: 1,
      uniqueItems: true,
    }),
    body: Type.String({ minLength: 1, maxLength: 4000 }),
    scheduledStart: Type.Optional(Type.String({ format: 'date-time' })),
    scheduledEnd: Type.Optional(Type.String({ format: 'date-time' })),
  });
  app.post(
    '/v1/backoffice/status/incidents',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, ['support']),
      schema: {
        tags: ['backoffice'],
        summary:
          "Post an incident or scheduled maintenance for this cell's region (shown on the public status page)",
        body: NewIncident,
        response: { 201: Type.Object({ id: Uuid }), 400: Problem, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as Static<typeof NewIncident>;
      const now = deps.now().toISOString();
      if (b.kind === 'maintenance') {
        if (
          b.impact !== 'maintenance' ||
          !b.scheduledStart ||
          !b.scheduledEnd ||
          compareInstants(b.scheduledEnd, b.scheduledStart) <= 0
        )
          throw new ApiError('validation', 'Maintenance needs impact "maintenance" and a scheduled window');
      } else if (b.impact === 'maintenance')
        throw new ApiError('validation', 'Incidents need a minor, major or critical impact');
      const status = b.kind === 'maintenance' ? 'scheduled' : 'investigating';
      const pool = backofficePool(app);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO backoffice.status_incidents (kind, impact, title, components, status, scheduled_start, scheduled_end, started_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          b.kind,
          b.impact,
          b.title,
          b.components,
          status,
          b.scheduledStart ?? null,
          b.scheduledEnd ?? null,
          b.kind === 'maintenance' ? b.scheduledStart : now,
          req.staff!.staffId,
        ],
      );
      await pool.query(
        'INSERT INTO backoffice.status_updates (incident_id, status, body, created_by) VALUES ($1, $2, $3, $4)',
        [rows[0]!.id, status, b.body, req.staff!.staffId],
      );
      await staffAudit(app, req, 'status.incident_posted', {
        id: rows[0]!.id,
        kind: b.kind,
        impact: b.impact,
        components: b.components,
        region: deps.config.cell,
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.post(
    '/v1/backoffice/status/incidents/:id/updates',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, ['support']),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          status: Type.Union([...INCIDENT_STATUSES, ...MAINTENANCE_STATUSES].map((s) => Type.Literal(s))),
          body: Type.String({ minLength: 1, maxLength: 4000 }),
        }),
        response: { 201: Type.Null(), 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { status: string; body: string };
      const pool = backofficePool(app);
      const cur = (
        await pool.query<{ kind: string; resolved_at: string | null }>(
          'SELECT kind, resolved_at FROM backoffice.status_incidents WHERE id = $1',
          [id],
        )
      ).rows[0];
      if (!cur) throw new ApiError('notFound');
      const allowed: readonly string[] =
        cur.kind === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES;
      if (!allowed.includes(b.status))
        throw new ApiError('validation', 'Status does not fit this kind of post');
      const done = b.status === 'resolved' || b.status === 'completed';
      const now = deps.now().toISOString();
      await pool.query(
        `UPDATE backoffice.status_incidents SET status = $2, resolved_at = CASE WHEN $3 THEN coalesce(resolved_at, $4::timestamptz) ELSE NULL END, updated_at = now() WHERE id = $1`,
        [id, b.status, done, now],
      );
      await pool.query(
        'INSERT INTO backoffice.status_updates (incident_id, status, body, created_by) VALUES ($1, $2, $3, $4)',
        [id, b.status, b.body, req.staff!.staffId],
      );
      await staffAudit(app, req, 'status.incident_updated', {
        id,
        status: b.status,
        region: deps.config.cell,
      });
      return reply.status(201).send(null);
    },
  );
}
