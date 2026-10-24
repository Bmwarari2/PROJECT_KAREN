import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';
import { usersWithRole } from '../../lib/notify';

/**
 * Device and access tasks go to IT admins (ADR-0189): ordering a laptop, phone or site access card for a
 * starter, removing a leaver's system and building access, and recording the return of each asset a
 * leaver holds. A workspace with no one in the IT admin role sends them to a fallback role chosen in
 * Settings → Workflows (by default the company owner, who holds the asset register; HR admins see it
 * read-only). The choice is made when the task is created.
 */
export const IT_ROLE = 'it_admin';
export const DEFAULT_IT_FALLBACK = 'owner';

interface TaskRouting {
  itFallbackRole?: string;
}

async function loadRouting(tx: Tx): Promise<Required<TaskRouting>> {
  const row = await tx.one<{ routing: TaskRouting | null }>(
    `SELECT features->'taskRouting' AS routing FROM app.tenants`,
  );
  return { itFallbackRole: row.routing?.itFallbackRole ?? DEFAULT_IT_FALLBACK };
}

/**
 * The role queue a role task lands in: the IT admin role while someone active holds it, else the
 * workspace's fallback role. Other roles are returned as they are.
 */
export async function taskRoleFor(tx: Tx, role: string): Promise<string> {
  if (role !== IT_ROLE) return role;
  if ((await usersWithRole(tx, IT_ROLE)).length) return IT_ROLE;
  return (await loadRouting(tx)).itFallbackRole;
}

const RoutingOut = Type.Object({
  itFallbackRole: Type.String(),
  /** Active users holding the IT admin role (0: device and access tasks use the fallback role). */
  itAdmins: Type.Integer(),
});

export async function taskRoutingRoutes(app: FastifyInstance) {
  const view = async (tx: Tx) => ({
    itFallbackRole: (await loadRouting(tx)).itFallbackRole,
    itAdmins: (await usersWithRole(tx, IT_ROLE)).length,
  });

  app.get(
    '/v1/settings/task-routing',
    {
      config: { capability: 'settings.workflows' },
      schema: {
        tags: ['workflows'],
        summary: 'Where device and access tasks go when no one holds the IT admin role',
        response: { 200: RoutingOut, 403: Problem },
      },
    },
    async (req) => {
      requireAuth(req);
      return app.tenantTx(req, view, { readOnly: true });
    },
  );

  app.put(
    '/v1/settings/task-routing',
    {
      config: { selfAudited: true, capability: 'settings.workflows.manage' },
      schema: {
        tags: ['workflows'],
        summary: 'Choose the role that receives device and access tasks while no one is an IT admin',
        body: Type.Object(
          { itFallbackRole: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' }) },
          { additionalProperties: false },
        ),
        response: { 200: RoutingOut, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      requireAuth(req);
      const { itFallbackRole } = req.body as { itFallbackRole: string };
      return app.tenantTx(req, async (tx) => {
        // a role of this workspace (built-in or custom); the IT admin role itself is not a fallback
        const exists = await tx.maybe('SELECT 1 FROM app.roles WHERE key = $1', [itFallbackRole]);
        if (!exists || itFallbackRole === IT_ROLE)
          throw new ApiError('unprocessable', 'Choose another role of this workspace', {
            reason: 'unknownRole',
          });
        const before = await loadRouting(tx);
        await tx.exec(
          `UPDATE app.tenants SET features = jsonb_set(features, '{taskRouting}', $1::jsonb)`,
          [JSON.stringify({ itFallbackRole })],
        );
        await app.audit(tx, req, {
          action: 'settings.task_routing_updated',
          targetType: 'tenant',
          diff: { before, after: { itFallbackRole } },
        });
        return view(tx);
      });
    },
  );
}
