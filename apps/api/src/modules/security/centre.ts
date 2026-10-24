import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { authorize } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';

/**
 * The customer's Security centre (Settings, ADR-0178): the workspace's own security alerts (copies of the
 * detections about it), recent failed sign-ins, admin changes from its audit log, two-step verification
 * adoption and who receives its security alert emails. Everything is read under the workspace's own row
 * level security; nothing from other workspaces or from Thapsus's own stores is shown.
 */
export const ADMIN_CHANGE_ACTIONS = [
  'role.assigned',
  'role.revoked',
  'role.created',
  'role.updated',
  'role.deleted',
  'user.invited',
  'auth.mfa_reset',
  'sso.connection_created',
  'sso.connection_updated',
  'sso.connection_deleted',
  'settings.security_updated',
  'api_key.created',
  'api_key.revoked',
  'oauth_client.created',
  'scim.token_created',
  'support.grant_created',
  'security.sessions_ended',
  'security.api_key_suspended',
  'security.api_key_restored',
];
export const MAX_RECIPIENTS = 20;

const Person = Nullable(Type.Object({ userId: Uuid, displayName: Type.String() }));
const CentreT = Type.Object({
  alerts: Type.Array(
    Type.Object({
      id: Uuid,
      ruleId: Type.String(),
      severity: Type.String(),
      firstSeenAt: Type.String(),
      lastSeenAt: Type.String(),
      eventCount: Type.Integer(),
      subject: Person,
      acknowledgedAt: Nullable(Type.String()),
    }),
  ),
  signIns: Type.Object({
    succeeded7d: Type.Integer(),
    failed7d: Type.Integer(),
    lockedNow: Type.Integer(),
  }),
  recentFailures: Type.Array(
    Type.Object({
      at: Type.String(),
      person: Person,
      network: Nullable(Type.String()),
      reason: Nullable(Type.String()),
    }),
  ),
  adminChanges: Type.Array(
    Type.Object({
      at: Type.String(),
      action: Type.String(),
      actor: Person,
      targetType: Nullable(Type.String()),
      target: Person,
    }),
  ),
  mfa: Type.Object({
    users: Type.Integer(),
    withMfa: Type.Integer(),
    admins: Type.Integer(),
    adminsWithoutMfa: Type.Integer(),
  }),
  recipients: Type.Array(Type.Object({ userId: Uuid, displayName: Type.String(), email: Type.String() })),
  recipientsAreDefault: Type.Boolean(),
  candidates: Type.Array(Type.Object({ userId: Uuid, displayName: Type.String(), email: Type.String() })),
});

export async function securityCentreRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.get(
    '/v1/settings/security-centre',
    {
      schema: {
        tags: ['settings'],
        summary:
          "This workspace's security alerts, failed sign-ins, admin changes, two-step verification adoption and alert recipients",
        response: { 200: CentreT, 401: Problem, 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'audit.read');
      const now = deps.now();
      const week = new Date(now.getTime() - 7 * 86_400_000);
      const month = new Date(now.getTime() - 30 * 86_400_000);
      return app.tenantTx(
        req,
        async (tx) => {
          const person = (id: string | null, name: string | null) =>
            id ? { userId: id, displayName: name ?? '' } : null;
          const alerts = await tx.query<{
            id: string;
            rule_id: string;
            severity: string;
            first_seen_at: string;
            last_seen_at: string;
            event_count: number;
            subject_user_id: string | null;
            name: string | null;
            acknowledged_at: string | null;
          }>(
            `SELECT a.*, u.display_name AS name FROM app.security_alerts a LEFT JOIN app.users u ON u.tenant_id = a.tenant_id AND u.id = a.subject_user_id
              ORDER BY a.acknowledged_at IS NOT NULL, a.last_seen_at DESC LIMIT 50`,
          );
          const counts = await tx.one<{ ok: number; failed: number; locked: number }>(
            `SELECT (SELECT count(*)::int FROM audit.events WHERE action = 'auth.login' AND at >= $1) AS ok,
                    (SELECT count(*)::int FROM audit.events WHERE action = 'auth.login_failed' AND at >= $1) AS failed,
                    (SELECT count(*)::int FROM app.users WHERE locked_until > $2) AS locked`,
            [week, now],
          );
          const failures = await tx.query<{
            at: string;
            actor_id: string | null;
            name: string | null;
            net: string | null;
            reason: string | null;
          }>(
            `SELECT e.at, e.actor_id, u.display_name AS name, network(set_masklen(e.ip, CASE WHEN family(e.ip) = 4 THEN 24 ELSE 48 END))::text AS net,
                    e.diff->>'reason' AS reason
               FROM audit.events e LEFT JOIN app.users u ON u.tenant_id = e.tenant_id AND u.id = e.actor_id
              WHERE e.action = 'auth.login_failed' AND e.at >= $1 ORDER BY e.at DESC LIMIT 20`,
            [week],
          );
          const changes = await tx.query<{
            at: string;
            action: string;
            actor_id: string | null;
            actor: string | null;
            target_type: string | null;
            target_id: string | null;
            target: string | null;
          }>(
            `SELECT e.at, e.action, e.actor_id, a.display_name AS actor, e.target_type, e.target_id, t.display_name AS target
               FROM audit.events e
               LEFT JOIN app.users a ON a.tenant_id = e.tenant_id AND a.id = e.actor_id
               LEFT JOIN app.users t ON e.target_type = 'user' AND t.tenant_id = e.tenant_id AND t.id::text = e.target_id
              WHERE e.action = ANY($1) AND e.at >= $2 ORDER BY e.at DESC LIMIT 30`,
            [ADMIN_CHANGE_ACTIONS, month],
          );
          const mfa = await tx.one<{
            users: number;
            with_mfa: number;
            admins: number;
            admins_without: number;
          }>(
            `WITH u AS (
               SELECT u.id,
                 (EXISTS (SELECT 1 FROM app.totp_factors f WHERE f.tenant_id = u.tenant_id AND f.user_id = u.id AND f.verified_at IS NOT NULL)
                  OR EXISTS (SELECT 1 FROM app.passkeys k WHERE k.tenant_id = u.tenant_id AND k.user_id = u.id)) AS mfa,
                 EXISTS (SELECT 1 FROM app.role_assignments ra JOIN app.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                          WHERE ra.tenant_id = u.tenant_id AND ra.user_id = u.id AND r.is_admin) AS admin
                 FROM app.users u WHERE u.status = 'active')
             SELECT count(*)::int AS users, count(*) FILTER (WHERE mfa)::int AS with_mfa,
                    count(*) FILTER (WHERE admin)::int AS admins, count(*) FILTER (WHERE admin AND NOT mfa)::int AS admins_without FROM u`,
          );
          const chosen = await tx.query<{ user_id: string; display_name: string; email: string }>(
            `SELECT r.user_id, u.display_name, u.email::text FROM app.security_alert_recipients r JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
              WHERE u.status = 'active' ORDER BY u.display_name`,
          );
          const candidates = await tx.query<{ user_id: string; display_name: string; email: string }>(
            `SELECT DISTINCT u.id AS user_id, u.display_name, u.email::text FROM app.users u JOIN app.role_assignments ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id
               JOIN app.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
              WHERE u.status = 'active' AND r.is_admin ORDER BY u.display_name`,
          );
          const owners = await tx.query<{ user_id: string; display_name: string; email: string }>(
            `SELECT DISTINCT u.id AS user_id, u.display_name, u.email::text FROM app.users u JOIN app.role_assignments ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id
               JOIN app.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id WHERE u.status = 'active' AND r.key = 'owner' ORDER BY u.display_name`,
          );
          const list = chosen.length ? chosen : owners;
          return {
            alerts: alerts.map((a) => ({
              id: a.id,
              ruleId: a.rule_id,
              severity: a.severity,
              firstSeenAt: a.first_seen_at,
              lastSeenAt: a.last_seen_at,
              eventCount: a.event_count,
              subject: person(a.subject_user_id, a.name),
              acknowledgedAt: a.acknowledged_at,
            })),
            signIns: { succeeded7d: counts.ok, failed7d: counts.failed, lockedNow: counts.locked },
            recentFailures: failures.map((f) => ({
              at: f.at,
              person: person(f.actor_id, f.name),
              network: f.net,
              reason: f.reason && /^[a-z_]{1,40}$/i.test(f.reason) ? f.reason : null,
            })),
            adminChanges: changes.map((c) => ({
              at: c.at,
              action: c.action,
              actor: person(c.actor_id, c.actor),
              targetType: c.target_type,
              target: c.target_type === 'user' && c.target_id ? person(c.target_id, c.target) : null,
            })),
            mfa: {
              users: mfa.users,
              withMfa: mfa.with_mfa,
              admins: mfa.admins,
              adminsWithoutMfa: mfa.admins_without,
            },
            recipients: list.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email })),
            recipientsAreDefault: !chosen.length,
            candidates: candidates.map((r) => ({
              userId: r.user_id,
              displayName: r.display_name,
              email: r.email,
            })),
          };
        },
        { readOnly: true },
      );
    },
  );

  app.put(
    '/v1/settings/security-centre/recipients',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary:
          "Choose who receives this workspace's security alert emails (admins only; empty means the owners)",
        body: Type.Object({ userIds: Type.Array(Uuid, { maxItems: MAX_RECIPIENTS, uniqueItems: true }) }),
        response: { 204: Type.Null(), 400: Problem, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const { userIds } = req.body as { userIds: string[] };
      await app.tenantTx(req, async (tx) => {
        const ok = await tx.query<{ id: string }>(
          `SELECT DISTINCT u.id FROM app.users u JOIN app.role_assignments ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id
             JOIN app.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id WHERE u.id = ANY($1::uuid[]) AND u.status = 'active' AND r.is_admin`,
          [userIds],
        );
        if (ok.length !== userIds.length) throw new ApiError('validation', 'recipientsMustBeAdmins');
        await tx.exec('DELETE FROM app.security_alert_recipients');
        for (const id of userIds)
          await tx.exec(
            'INSERT INTO app.security_alert_recipients (tenant_id, user_id, created_by) VALUES (app.current_tenant(), $1, $2)',
            [id, auth.userId],
          );
        await app.audit(tx, req, {
          action: 'settings.security_alert_recipients_updated',
          targetType: 'tenant',
          targetId: auth.tenantId,
          diff: { recipients: userIds.length },
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/settings/security-centre/alerts/:id/acknowledge',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorize(req, 'settings.manage');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const n = await tx.exec(
          'UPDATE app.security_alerts SET acknowledged_at = coalesce(acknowledged_at, $2), acknowledged_by = coalesce(acknowledged_by, $3) WHERE id = $1',
          [id, deps.now(), auth.userId],
        );
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'security.alert_acknowledged',
          targetType: 'security_alert',
          targetId: id,
        });
      });
      return reply.status(204).send(null);
    },
  );
}
