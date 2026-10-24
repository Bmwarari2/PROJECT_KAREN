import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import {
  CATALOGUE_VERSION,
  DETECTION_RULES,
  SEVERITIES,
  rulesInForce,
  type ContainmentKind,
} from '@thapsus/core/security';
import { instantToDate } from '@thapsus/core/time';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { backofficePool, requireStaff, staffAudit, type StaffGuard } from '../backoffice/auth';
import { applyContainment, reverseContainment } from './containment';
import { sha256Hex } from './http';
import { testRules } from './fixtures';
import { runDetectionPipeline } from './pipeline';
import { staffAlertRecipients } from './alert-config';

/**
 * The back office's Security module (ADR-0177, ADR-0178): the overview, incidents with their timeline,
 * containment, the rule catalogue and the honeytoken registry. For security analysts and super admins.
 * Everything here is pseudonymous: workspaces and people by id, addresses by keyed hash and truncated
 * network. Reads need no elevation; containment needs a fresh key proof (and a super admin's elevation).
 */
const STATUSES = ['open', 'acknowledged', 'contained', 'resolved', 'false_positive'] as const;
const DEADMAN_MINUTES = 10;
const OFFENDING = [
  'authn.failed',
  'authz.denied',
  'input.rejected',
  'antiautomation.limited',
  'antiautomation.locked',
  'http.not_found',
  'route.not_found',
  'ip.blocked',
  'honeytoken.api_key',
  'honeytoken.endpoint',
  'auth.login_failed',
];

const IncidentRowT = Type.Object({
  id: Uuid,
  reference: Type.String(),
  ruleId: Type.String(),
  area: Type.String(),
  severity: Type.String(),
  status: Type.String(),
  firstSeenAt: Type.String(),
  lastSeenAt: Type.String(),
  detectionCount: Type.Integer(),
  eventCount: Type.Integer(),
  tenantCount: Type.Integer(),
  ipNet: Nullable(Type.String()),
  assignedTo: Nullable(Type.Object({ id: Uuid, displayName: Type.String() })),
  createdAt: Type.String(),
});

interface IncidentRow {
  id: string;
  reference: string;
  rule_id: string;
  area: string;
  severity: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  detection_count: number;
  event_count: number;
  tenant_ids: string[];
  ip_key: string | null;
  ip_net: string | null;
  assigned_to: string | null;
  assignee: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
}
const incidentJson = (r: IncidentRow) => ({
  id: r.id,
  reference: r.reference,
  ruleId: r.rule_id,
  area: r.area,
  severity: r.severity,
  status: r.status,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  detectionCount: r.detection_count,
  eventCount: r.event_count,
  tenantCount: r.tenant_ids.length,
  ipNet: r.ip_net,
  assignedTo: r.assigned_to ? { id: r.assigned_to, displayName: r.assignee ?? '' } : null,
  createdAt: r.created_at,
});
const INCIDENT_SELECT = `SELECT i.*, i.ip_net::text AS ip_net, u.display_name AS assignee FROM security.incidents i LEFT JOIN backoffice.staff_users u ON u.id = i.assigned_to`;

export async function securityRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const analyst = (guard: StaffGuard = {}) => ({
    config: { auth: 'public' as const, selfAudited: true },
    preHandler: requireStaff(app, ['security_analyst'], guard),
  });
  const read = analyst({ noElevation: true });
  const act = analyst({ reauth: true });
  const pool = () => backofficePool(app);

  // ---- overview ---------------------------------------------------------------------------------------------
  app.get(
    '/v1/backoffice/security/overview',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        summary:
          'Detections, open incidents (MTTA, MTTR), sign-in health, top offending addresses, the staff elevation log and the pipeline',
        response: {
          200: Type.Object({
            cell: Type.String(),
            generatedAt: Type.String(),
            detections24h: Type.Array(Type.Object({ severity: Type.String(), count: Type.Integer() })),
            openIncidents: Type.Array(Type.Object({ severity: Type.String(), count: Type.Integer() })),
            mttaMinutes: Nullable(Type.Integer()),
            mttrMinutes: Nullable(Type.Integer()),
            auth: Type.Object({
              signIns: Type.Integer(),
              failures: Type.Integer(),
              failureRateBasisPoints: Nullable(Type.Integer()),
              lockouts: Type.Integer(),
              users: Type.Integer(),
              usersWithMfa: Type.Integer(),
            }),
            topIps: Type.Array(
              Type.Object({
                ipKey: Type.String(),
                ipNet: Nullable(Type.String()),
                events: Type.Integer(),
                lastSeenAt: Type.String(),
                blocked: Type.Boolean(),
              }),
            ),
            elevations: Type.Array(
              Type.Object({
                at: Type.String(),
                action: Type.String(),
                staff: Nullable(Type.String()),
                scope: Nullable(Type.String()),
              }),
            ),
            pipeline: Type.Object({
              ranAt: Nullable(Type.String()),
              stale: Type.Boolean(),
              waitingEvents: Type.Integer(),
              staffRecipients: Type.Integer(),
            }),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const now = deps.now();
      const day = new Date(now.getTime() - 86_400_000);
      const month = new Date(now.getTime() - 30 * 86_400_000);
      const p = pool();
      const [det, open, times, auth, mfa, top, elev, pipe] = await Promise.all([
        p.query<{ severity: string; count: number }>(
          `SELECT severity, count(*)::int AS count FROM security.detections WHERE created_at >= $1 GROUP BY 1`,
          [day],
        ),
        p.query<{ severity: string; count: number }>(
          `SELECT severity, count(*)::int AS count FROM security.incidents WHERE status NOT IN ('resolved', 'false_positive') GROUP BY 1`,
        ),
        p.query<{ mtta: number | null; mttr: number | null }>(
          `SELECT round(avg(extract(epoch FROM acknowledged_at - created_at)) / 60)::int AS mtta,
                  round(avg(extract(epoch FROM resolved_at - created_at)) / 60)::int AS mttr
             FROM security.incidents WHERE created_at >= $1`,
          [month],
        ),
        p.query<{ ok: number; failed: number; locked: number }>(
          `SELECT count(*) FILTER (WHERE type = 'audit.auth.login')::int AS ok,
                  count(*) FILTER (WHERE type = 'audit.auth.login_failed')::int AS failed,
                  count(*) FILTER (WHERE type IN ('antiautomation.locked', 'auth.lockout'))::int AS locked
             FROM security.events WHERE at >= $1 AND type IN ('audit.auth.login', 'audit.auth.login_failed', 'antiautomation.locked', 'auth.lockout')`,
          [day],
        ),
        p.query<{ users: number; mfa: number }>(
          `SELECT coalesce(sum(u.active_users), 0)::int AS users, coalesce(sum(u.users_with_mfa), 0)::int AS mfa
             FROM backoffice.tenant_usage u JOIN registry.tenants r ON r.tenant_id = u.subject_tenant_id WHERE r.home_region = $1 AND r.status <> 'deleted'`,
          [deps.config.cell],
        ),
        p.query<{ ip_key: string; ip_net: string | null; events: number; last: string; blocked: boolean }>(
          `SELECT e.ip_key, (array_agg(e.ip_net::text ORDER BY e.id DESC) FILTER (WHERE e.ip_net IS NOT NULL))[1] AS ip_net, count(*)::int AS events, max(e.at)::text AS last,
                  EXISTS (SELECT 1 FROM security.containment_actions c WHERE c.kind = 'block_ip' AND c.ip_key = e.ip_key AND c.reversed_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > $3)) AS blocked
             FROM security.events e WHERE e.at >= $1 AND e.ip_key IS NOT NULL AND e.type = ANY($2) GROUP BY e.ip_key ORDER BY count(*) DESC LIMIT 10`,
          [day, OFFENDING, now],
        ),
        p.query<{ at: string; action: string; staff: string | null; scope: string | null }>(
          `SELECT a.at, a.action, u.display_name AS staff, a.detail->>'scope' AS scope FROM backoffice.staff_audit a LEFT JOIN backoffice.staff_users u ON u.id = a.staff_id
            WHERE a.action LIKE 'staff.elevation%' AND a.at >= $1 ORDER BY a.id DESC LIMIT 20`,
          [month],
        ),
        p.query<{ ran_at: string | null; cursor_id: string; waiting: number }>(
          `SELECT s.ran_at, s.cursor_id::text, (SELECT count(*)::int FROM security.events e WHERE e.id > s.cursor_id) AS waiting FROM security.pipeline_state s WHERE s.name = 'detections'`,
        ),
      ]);
      const a = auth.rows[0]!;
      const ranAt = pipe.rows[0]?.ran_at ?? null;
      return {
        cell: deps.config.cell,
        generatedAt: now.toISOString(),
        detections24h: SEVERITIES.map((s) => ({
          severity: s,
          count: det.rows.find((r) => r.severity === s)?.count ?? 0,
        })),
        openIncidents: SEVERITIES.map((s) => ({
          severity: s,
          count: open.rows.find((r) => r.severity === s)?.count ?? 0,
        })),
        mttaMinutes: times.rows[0]?.mtta ?? null,
        mttrMinutes: times.rows[0]?.mttr ?? null,
        auth: {
          signIns: a.ok,
          failures: a.failed,
          failureRateBasisPoints: a.ok + a.failed ? Math.round((a.failed * 10000) / (a.ok + a.failed)) : null,
          lockouts: a.locked,
          users: mfa.rows[0]!.users,
          usersWithMfa: mfa.rows[0]!.mfa,
        },
        topIps: top.rows.map((r) => ({
          ipKey: r.ip_key,
          ipNet: r.ip_net,
          events: r.events,
          lastSeenAt: new Date(r.last).toISOString(),
          blocked: r.blocked,
        })),
        elevations: elev.rows,
        pipeline: {
          ranAt,
          stale: !ranAt || now.getTime() - new Date(ranAt).getTime() > DEADMAN_MINUTES * 60_000,
          waitingEvents: pipe.rows[0]?.waiting ?? 0,
          staffRecipients: staffAlertRecipients().length,
        },
      };
    },
  );

  // ---- incidents ----------------------------------------------------------------------------------------------
  app.get(
    '/v1/backoffice/security/incidents',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('all')])),
          severity: Type.Optional(Type.Union(SEVERITIES.map((s) => Type.Literal(s)))),
        }),
        response: { 200: Type.Array(IncidentRowT), 401: Problem, 403: Problem },
      },
    },
    async (req) => {
      const q = req.query as { status?: string; severity?: string };
      const { rows } = await pool().query<IncidentRow>(
        `${INCIDENT_SELECT} WHERE ($1 OR i.status NOT IN ('resolved', 'false_positive')) AND ($2::text IS NULL OR i.severity = $2)
          ORDER BY (i.status IN ('resolved', 'false_positive')), array_position(ARRAY['critical', 'high', 'medium', 'low'], i.severity), i.last_seen_at DESC LIMIT 200`,
        [q.status === 'all', q.severity ?? null],
      );
      return rows.map(incidentJson);
    },
  );

  const loadIncident = async (id: string) => {
    const r = (await pool().query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [id])).rows[0];
    if (!r) throw new ApiError('notFound');
    return r;
  };

  app.get(
    '/v1/backoffice/security/incidents/:id',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        summary: 'An incident with its detections, timeline, containment and affected workspaces',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            incident: IncidentRowT,
            acknowledgedAt: Nullable(Type.String()),
            resolvedAt: Nullable(Type.String()),
            tenants: Type.Array(Type.Object({ tenantId: Uuid, slug: Nullable(Type.String()) })),
            detections: Type.Array(
              Type.Object({
                id: Uuid,
                ruleId: Type.String(),
                severity: Type.String(),
                firstSeenAt: Type.String(),
                lastSeenAt: Type.String(),
                eventCount: Type.Integer(),
                tenantId: Nullable(Uuid),
                actorId: Nullable(Uuid),
                actorType: Nullable(Type.String()),
                staffId: Nullable(Uuid),
                ipNet: Nullable(Type.String()),
              }),
            ),
            timeline: Type.Array(
              Type.Object({
                id: Type.String(),
                at: Type.String(),
                kind: Type.String(),
                staff: Nullable(Type.String()),
                body: Nullable(Type.String()),
                detail: Type.Any(),
              }),
            ),
            containment: Type.Array(
              Type.Object({
                id: Uuid,
                kind: Type.String(),
                automated: Type.Boolean(),
                createdAt: Type.String(),
                expiresAt: Nullable(Type.String()),
                reversedAt: Nullable(Type.String()),
                reversalRequested: Type.Boolean(),
                active: Type.Boolean(),
              }),
            ),
            actions: Type.Array(Type.String()),
          }),
          401: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const r = await loadIncident(id);
      const p = pool();
      const now = deps.now();
      const [det, tl, cont, tenants] = await Promise.all([
        p.query<{
          id: string;
          rule_id: string;
          severity: string;
          first_seen_at: string;
          last_seen_at: string;
          event_count: number;
          subject_tenant_id: string | null;
          actor_id: string | null;
          staff_id: string | null;
          ip_net: string | null;
          actor_type: string | null;
        }>(
          `SELECT d.*, d.ip_net::text AS ip_net, d.detail->>'actorType' AS actor_type FROM security.detections d WHERE d.incident_id = $1 ORDER BY d.created_at`,
          [id],
        ),
        p.query<{
          id: string;
          at: string;
          kind: string;
          staff: string | null;
          body: string | null;
          detail: unknown;
        }>(
          `SELECT e.id::text, e.at, e.kind, u.display_name AS staff, e.body, e.detail FROM security.incident_events e LEFT JOIN backoffice.staff_users u ON u.id = e.staff_id WHERE e.incident_id = $1 ORDER BY e.id`,
          [id],
        ),
        p.query<{
          id: string;
          kind: string;
          automated: boolean;
          created_at: string;
          expires_at: string | null;
          reversed_at: string | null;
          reversal_requested_by: string | null;
        }>('SELECT * FROM security.containment_actions WHERE incident_id = $1 ORDER BY created_at', [id]),
        p.query<{ tenant_id: string; slug: string }>(
          'SELECT tenant_id, slug FROM registry.tenants WHERE tenant_id = ANY($1::uuid[])',
          [r.tenant_ids],
        ),
      ]);
      const actions: ContainmentKind[] = [];
      if (r.ip_key) actions.push('block_ip');
      if (det.rows.some((d) => d.subject_tenant_id && d.actor_id && d.actor_type !== 'api_client'))
        actions.push('end_sessions');
      if (det.rows.some((d) => d.subject_tenant_id && d.actor_id && d.actor_type === 'api_client'))
        actions.push('suspend_api_key');
      if (det.rows.some((d) => d.staff_id)) actions.push('freeze_staff');
      await staffAudit(app, req, 'security.incident_viewed', { id, reference: r.reference });
      return {
        incident: incidentJson(r),
        acknowledgedAt: r.acknowledged_at,
        resolvedAt: r.resolved_at,
        tenants: r.tenant_ids.map((t) => ({
          tenantId: t,
          slug: tenants.rows.find((x) => x.tenant_id === t)?.slug ?? null,
        })),
        detections: det.rows.map((d) => ({
          id: d.id,
          ruleId: d.rule_id,
          severity: d.severity,
          firstSeenAt: d.first_seen_at,
          lastSeenAt: d.last_seen_at,
          eventCount: d.event_count,
          tenantId: d.subject_tenant_id,
          actorId: d.actor_id,
          actorType: d.actor_type,
          staffId: d.staff_id,
          ipNet: d.ip_net,
        })),
        timeline: tl.rows.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
        containment: cont.rows.map((c) => ({
          id: c.id,
          kind: c.kind,
          automated: c.automated,
          createdAt: c.created_at,
          expiresAt: c.expires_at,
          reversedAt: c.reversed_at,
          reversalRequested: !!c.reversal_requested_by,
          active:
            !c.reversed_at &&
            c.kind !== 'end_sessions' &&
            (!c.expires_at || new Date(c.expires_at).getTime() > now.getTime()),
        })),
        actions,
      };
    },
  );

  const PatchBody = Type.Object(
    {
      status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
      assignedTo: Type.Optional(Nullable(Uuid)),
    },
    { minProperties: 1 },
  );
  app.patch(
    '/v1/backoffice/security/incidents/:id',
    {
      ...analyst(),
      schema: {
        tags: ['backoffice'],
        summary: 'Acknowledge, contain, resolve or assign an incident (each change is on its timeline)',
        params: Type.Object({ id: Uuid }),
        body: PatchBody,
        response: { 200: IncidentRowT, 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as Static<typeof PatchBody>;
      const cur = await loadIncident(id);
      const now = deps.now();
      const p = pool();
      if (b.assignedTo) {
        const ok = (
          await p.query(
            `SELECT 1 FROM backoffice.staff_users WHERE id = $1 AND active AND role IN ('security_analyst', 'super_admin')`,
            [b.assignedTo],
          )
        ).rowCount;
        if (!ok) throw new ApiError('validation', 'assigneeMustBeAnalyst');
      }
      const status = b.status ?? cur.status;
      await p.query(
        `UPDATE security.incidents SET status = $2, assigned_to = CASE WHEN $3 THEN $4::uuid ELSE assigned_to END,
           acknowledged_at = CASE WHEN $2 <> 'open' THEN coalesce(acknowledged_at, $5) ELSE acknowledged_at END,
           resolved_at = CASE WHEN $2 IN ('resolved', 'false_positive') THEN coalesce(resolved_at, $5) ELSE NULL END, updated_at = $5 WHERE id = $1`,
        [id, status, 'assignedTo' in b, b.assignedTo ?? null, now],
      );
      if (b.status && b.status !== cur.status)
        await p.query(
          `INSERT INTO security.incident_events (incident_id, kind, staff_id, detail) VALUES ($1, 'status', $2, $3)`,
          [id, req.staff!.staffId, JSON.stringify({ from: cur.status, to: b.status })],
        );
      if ('assignedTo' in b && b.assignedTo !== cur.assigned_to)
        await p.query(
          `INSERT INTO security.incident_events (incident_id, kind, staff_id, detail) VALUES ($1, 'assignment', $2, $3)`,
          [id, req.staff!.staffId, JSON.stringify({ to: b.assignedTo })],
        );
      await staffAudit(app, req, 'security.incident_updated', { id, reference: cur.reference, ...b });
      return incidentJson(await loadIncident(id));
    },
  );

  app.post(
    '/v1/backoffice/security/incidents/:id/notes',
    {
      ...analyst(),
      schema: {
        tags: ['backoffice'],
        summary: 'Add a note to the timeline (no personal data: refer to people by id)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 2000 }) }),
        response: { 201: Type.Object({ id: Type.String() }), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cur = await loadIncident(id);
      const { rows } = await pool().query<{ id: string }>(
        `INSERT INTO security.incident_events (incident_id, kind, staff_id, body) VALUES ($1, 'note', $2, $3) RETURNING id::text`,
        [id, req.staff!.staffId, (req.body as { body: string }).body],
      );
      await staffAudit(app, req, 'security.incident_noted', { id, reference: cur.reference });
      return reply.status(201).send(rows[0]);
    },
  );

  const ContainBody = Type.Object({
    kind: Type.Union(
      (['block_ip', 'end_sessions', 'suspend_api_key', 'freeze_staff'] as const).map((k) => Type.Literal(k)),
    ),
    minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
  });
  app.post(
    '/v1/backoffice/security/incidents/:id/containment',
    {
      ...act,
      schema: {
        tags: ['backoffice'],
        summary:
          "Contain an incident's subject: block the address, end the person's sessions, suspend the API key or freeze the staff account",
        params: Type.Object({ id: Uuid }),
        body: ContainBody,
        response: {
          201: Type.Object({ id: Nullable(Uuid), skipped: Nullable(Type.String()) }),
          400: Problem,
          401: Problem,
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as Static<typeof ContainBody>;
      const inc = await loadIncident(id);
      const det = (
        await pool().query<{
          subject_tenant_id: string | null;
          actor_id: string | null;
          staff_id: string | null;
          actor_type: string | null;
        }>(
          `SELECT subject_tenant_id, actor_id, staff_id, detail->>'actorType' AS actor_type FROM security.detections WHERE incident_id = $1 ORDER BY created_at DESC`,
          [id],
        )
      ).rows;
      const person = det.find((d) => d.subject_tenant_id && d.actor_id && d.actor_type !== 'api_client');
      const key = det.find((d) => d.subject_tenant_id && d.actor_id && d.actor_type === 'api_client');
      const staff = det.find((d) => d.staff_id);
      const target =
        b.kind === 'block_ip'
          ? { ipKey: inc.ip_key, ipNet: inc.ip_net }
          : b.kind === 'end_sessions'
            ? { tenantId: person?.subject_tenant_id, targetId: person?.actor_id }
            : b.kind === 'suspend_api_key'
              ? { tenantId: key?.subject_tenant_id, targetId: key?.actor_id }
              : { targetId: staff?.staff_id };
      if (b.kind === 'freeze_staff' && target.targetId === req.staff!.staffId)
        throw new ApiError('forbidden', 'notOwnFreeze');
      const client = await pool().connect();
      let out: { id: string } | { skipped: string };
      try {
        await client.query('BEGIN');
        out = await applyContainment(deps, client, {
          kind: b.kind,
          incidentId: id,
          automated: false,
          staffId: req.staff!.staffId,
          reason: `incident ${inc.reference}`,
          minutes: b.minutes,
          ...target,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (b.kind === 'block_ip') await app.securityCaches?.refreshBlocks().catch(() => undefined);
      await staffAudit(
        app,
        req,
        'security.containment_applied',
        { id, reference: inc.reference, kind: b.kind, ...('skipped' in out ? { skipped: out.skipped } : {}) },
        target.tenantId ?? null,
      );
      return reply
        .status(201)
        .send('skipped' in out ? { id: null, skipped: out.skipped } : { id: out.id, skipped: null });
    },
  );

  app.post(
    '/v1/backoffice/security/containment/:id/reverse',
    {
      ...act,
      schema: {
        tags: ['backoffice'],
        summary: 'Lift a block, restore a key, or (with a second staff member) unfreeze a staff account',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ state: Type.String() }),
          401: Problem,
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const client = await pool().connect();
      let out: { state: string };
      try {
        await client.query('BEGIN');
        out = await reverseContainment(deps, client, id, req.staff!.staffId);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      await app.securityCaches?.refreshBlocks().catch(() => undefined);
      await staffAudit(app, req, 'security.containment_reversed', { actionId: id, state: out.state });
      return out;
    },
  );

  // ---- rules and honeytokens ---------------------------------------------------------------------------------------
  app.get(
    '/v1/backoffice/security/rules',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        summary:
          'The detection rule catalogue in force, with this cell’s on/off setting and last fixture test',
        response: {
          200: Type.Object({
            catalogueVersion: Type.Integer(),
            rules: Type.Array(
              Type.Object({
                id: Type.String(),
                version: Type.Integer(),
                effectiveFrom: Type.String(),
                status: Type.String(),
                area: Type.String(),
                severity: Type.String(),
                mitre: Type.Object({ id: Type.String(), name: Type.String() }),
                windowMinutes: Nullable(Type.Integer()),
                threshold: Nullable(Type.Integer()),
                dedupeMinutes: Type.Integer(),
                containment: Type.Array(Type.String()),
                customerVisible: Type.Boolean(),
                needs: Nullable(Type.String()),
                tuning: Type.Array(Type.Object({ on: Type.String(), note: Type.String() })),
                enabled: Type.Boolean(),
                lastTest: Nullable(Type.Object({ passed: Type.Boolean(), ranAt: Type.String() })),
                detections30d: Type.Integer(),
              }),
            ),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const now = deps.now();
      const p = pool();
      const [settings, tests, counts] = await Promise.all([
        p.query<{ rule_id: string; enabled: boolean }>('SELECT rule_id, enabled FROM security.rule_settings'),
        p.query<{ rule_id: string; rule_version: number; passed: boolean; ran_at: string }>(
          'SELECT rule_id, rule_version, passed, ran_at FROM security.rule_tests',
        ),
        p.query<{ rule_id: string; n: number }>(
          'SELECT rule_id, count(*)::int AS n FROM security.detections WHERE created_at >= $1 GROUP BY 1',
          [new Date(now.getTime() - 30 * 86_400_000)],
        ),
      ]);
      return {
        catalogueVersion: CATALOGUE_VERSION,
        rules: rulesInForce(instantToDate(now.toISOString(), 'UTC')).map((r) => {
          const test = tests.rows.find((t) => t.rule_id === r.id && t.rule_version === r.version);
          const l = r.logic;
          return {
            id: r.id,
            version: r.version,
            effectiveFrom: r.effectiveFrom,
            status: r.status,
            area: r.area,
            severity: r.severity,
            mitre: r.mitre,
            windowMinutes: l?.windowMinutes ?? null,
            threshold: !l
              ? null
              : l.kind === 'threshold'
                ? l.minEvents
                : l.kind === 'sequence'
                  ? l.before.minEvents
                  : l.minFailures,
            dedupeMinutes: r.dedupeMinutes,
            containment: (r.containment ?? []).map((c) => c.kind),
            customerVisible: r.customerVisible,
            needs: r.needs ?? null,
            tuning: r.tuning,
            enabled:
              r.status === 'active' && (settings.rows.find((s) => s.rule_id === r.id)?.enabled ?? true),
            lastTest: test ? { passed: test.passed, ranAt: test.ran_at } : null,
            detections30d: counts.rows.find((c) => c.rule_id === r.id)?.n ?? 0,
          };
        }),
      };
    },
  );

  app.patch(
    '/v1/backoffice/security/rules/:ruleId',
    {
      ...analyst({ reauth: true }),
      schema: {
        tags: ['backoffice'],
        summary:
          'Turn an active rule off or on in this cell (the catalogue itself changes only in the repository)',
        params: Type.Object({ ruleId: Type.String({ pattern: '^THR-[A-Z]+-[0-9]{3}$' }) }),
        body: Type.Object({ enabled: Type.Boolean() }),
        response: { 204: Type.Null(), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const { ruleId } = req.params as { ruleId: string };
      const { enabled } = req.body as { enabled: boolean };
      if (!DETECTION_RULES.some((r) => r.id === ruleId && r.status === 'active'))
        throw new ApiError('notFound');
      await pool().query(
        `INSERT INTO security.rule_settings (rule_id, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (rule_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [ruleId, enabled, req.staff!.staffId, deps.now()],
      );
      await staffAudit(app, req, 'security.rule_toggled', { ruleId, enabled });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/backoffice/security/rules/test',
    {
      ...analyst(),
      schema: {
        tags: ['backoffice'],
        summary: "Run every active rule's fixture against this cell's engine (in rolled-back transactions)",
        response: {
          200: Type.Array(
            Type.Object({
              ruleId: Type.String(),
              version: Type.Integer(),
              passed: Type.Boolean(),
              fires: Type.Integer(),
              nearMiss: Type.Integer(),
            }),
          ),
          401: Problem,
          403: Problem,
        },
      },
    },
    async (req) => {
      const now = deps.now();
      const results = await testRules(
        () => deps.router.registryPool().connect(),
        rulesInForce(instantToDate(now.toISOString(), 'UTC')),
        now,
      );
      for (const r of results)
        await pool().query(
          `INSERT INTO security.rule_tests (rule_id, rule_version, passed, detections, ran_at, ran_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (rule_id, rule_version) DO UPDATE SET passed = EXCLUDED.passed, detections = EXCLUDED.detections, ran_at = EXCLUDED.ran_at, ran_by = EXCLUDED.ran_by`,
          [r.ruleId, r.version, r.passed, r.fires, now, req.staff!.staffId],
        );
      await staffAudit(app, req, 'security.rules_tested', {
        rules: results.length,
        failed: results.filter((r) => !r.passed).length,
      });
      return results;
    },
  );

  app.get(
    '/v1/backoffice/security/honeytokens',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        summary: 'The honeytoken registry (fingerprints only) and when each was last touched',
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              kind: Type.String(),
              label: Type.String(),
              plantedIn: Type.String(),
              createdAt: Type.String(),
              retiredAt: Nullable(Type.String()),
              touches30d: Type.Integer(),
              lastTouchedAt: Nullable(Type.String()),
            }),
          ),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () => {
      const since = new Date(deps.now().getTime() - 30 * 86_400_000);
      const { rows } = await pool().query<{
        id: string;
        kind: string;
        label: string;
        fingerprint: string;
        planted_in: string;
        created_at: string;
        retired_at: string | null;
      }>('SELECT * FROM security.honeytokens ORDER BY kind, label');
      const touches = await pool().query<{ type: string; route: string | null; n: number; last: string }>(
        `SELECT type, route, count(*)::int AS n, max(at)::text AS last FROM security.events WHERE type LIKE 'honeytoken.%' AND at >= $1 GROUP BY 1, 2`,
        [since],
      );
      const forToken = (r: (typeof rows)[number]) =>
        touches.rows.filter((t) =>
          r.kind === 'endpoint'
            ? t.type === 'honeytoken.endpoint' && !!t.route && sha256Hex(t.route) === r.fingerprint
            : t.type === (r.kind === 'api_key' ? 'honeytoken.api_key' : 'honeytoken.object'),
        );
      return rows.map((r) => {
        const t = forToken(r);
        const last = t.map((x) => new Date(x.last).getTime()).sort((a, b) => b - a)[0];
        return {
          id: r.id,
          kind: r.kind,
          label: r.label,
          plantedIn: r.planted_in,
          createdAt: r.created_at,
          retiredAt: r.retired_at,
          touches30d: t.reduce((n, x) => n + x.n, 0),
          lastTouchedAt: last ? new Date(last).toISOString() : null,
        };
      });
    },
  );

  app.post(
    '/v1/backoffice/security/run',
    {
      ...analyst(),
      schema: {
        tags: ['backoffice'],
        summary: 'Run the detection pipeline now (the worker runs it every minute)',
        response: {
          200: Type.Object({
            skipped: Type.Boolean(),
            processed: Type.Integer(),
            detections: Type.Integer(),
          }),
          401: Problem,
          403: Problem,
        },
      },
    },
    async (req: FastifyRequest) => {
      await app.securitySignals?.flush().catch(() => undefined);
      const r = await runDetectionPipeline(deps);
      await staffAudit(app, req, 'security.pipeline_run', {
        processed: r.processed,
        detections: r.outcomes.length,
      });
      return {
        skipped: !!r.skipped,
        processed: r.processed,
        detections: r.outcomes.filter((o) => o.isNew).length,
      };
    },
  );

  app.get(
    '/v1/backoffice/security/analysts',
    {
      ...read,
      schema: {
        tags: ['backoffice'],
        summary: 'Staff an incident can be assigned to',
        response: {
          200: Type.Array(Type.Object({ id: Uuid, displayName: Type.String(), role: Type.String() })),
          401: Problem,
          403: Problem,
        },
      },
    },
    async () =>
      (
        await pool().query<{ id: string; display_name: string; role: string }>(
          `SELECT id, display_name, role FROM backoffice.staff_users WHERE active AND role IN ('security_analyst', 'super_admin') ORDER BY display_name`,
        )
      ).rows.map((r) => ({ id: r.id, displayName: r.display_name, role: r.role })),
  );
}
