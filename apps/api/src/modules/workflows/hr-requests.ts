import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { createTask, notify, usersWithRole } from '../../lib/notify';
import type { Tx } from '@thapsus/db';

/** The HR admins' queue a request lands in (owners also work from it, see taskRoles). */
export const HR_QUEUE = 'hr_admin';

const HrRequest = Type.Object({
  id: Uuid,
  subject: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
  completedAt: Nullable(Type.String()),
});

/**
 * "Contact HR" (ADR-0163): employees and managers ask their own HR team instead of Thapsus-HR's support.
 * A request is a task in the HR admins' queue about the person who asked (the task's page names them
 * and holds the message); HR is notified, and the person sees the status here and is told when it is
 * done. The message is the person's own words: it is never put in a notification or an e-mail.
 */
/** Files a request in the HR queue and tells HR (the staging seed uses it too). Returns the task id. */
export async function raiseHrRequest(
  tx: Tx,
  employeeId: string,
  subject: string,
  message: string,
  askerUserId: string | null,
): Promise<string> {
  const id = await createTask(tx, {
    source: 'hr_request',
    title: subject.trim(),
    description: message.trim(),
    subjectEmployeeId: employeeId,
    assigneeRole: HR_QUEUE,
  });
  if (!id) throw new ApiError('conflict');
  // small companies often have no HR admin: the owner handles HR, as for absence alerts
  let hr = await usersWithRole(tx, HR_QUEUE);
  if (!hr.length) hr = await usersWithRole(tx, 'owner');
  const name =
    (
      await tx.maybe<{ display_name: string }>('SELECT display_name FROM app.employees WHERE id = $1', [
        employeeId,
      ])
    )?.display_name ?? '';
  await notify(tx, {
    userIds: hr.filter((u) => u !== askerUserId),
    kind: 'task.hr_request',
    titleKey: 'actionable.notify.hrRequest',
    params: { name },
    target: { type: 'task', id },
    dedupeKey: `hr-request:${id}`,
  });
  return id;
}

const HrRequestDetail = Type.Object({
  ...HrRequest.properties,
  message: Type.String(),
  completedByName: Nullable(Type.String()),
});

export async function hrRequestRoutes(app: FastifyInstance) {
  app.post(
    '/v1/hr-requests',
    {
      config: { selfAudited: true, capability: 'help.contactHr.ask' },
      schema: {
        tags: ['tasks'],
        summary: 'Ask the HR team a question or make a request (lands in their task inbox)',
        body: Type.Object(
          {
            subject: Type.String({ minLength: 1, maxLength: 120 }),
            message: Type.String({ minLength: 1, maxLength: 4000 }),
          },
          { additionalProperties: false },
        ),
        response: { 201: HrRequest, 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'hr.contact');
      const me = auth.principal.employeeId;
      if (!me) throw new ApiError('unprocessable', 'Only people with an employee record can contact HR');
      const b = req.body as { subject: string; message: string };
      const out = await app.tenantTx(req, async (tx) => {
        const id = await raiseHrRequest(tx, me, b.subject, b.message, auth.userId);
        await app.audit(tx, req, {
          action: 'hr_request.created',
          targetType: 'task',
          targetId: id,
          diff: { employeeId: me },
        });
        const row = await tx.one<{ created_at: string }>('SELECT created_at FROM app.tasks WHERE id = $1', [
          id,
        ]);
        return {
          id,
          subject: b.subject.trim(),
          status: 'open',
          createdAt: row.created_at,
          completedAt: null,
        };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/hr-requests',
    {
      schema: {
        tags: ['tasks'],
        summary: 'The questions and requests I sent to HR, newest first, with their status',
        response: { 200: Type.Array(HrRequest), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'hr.contact');
      const me = auth.principal.employeeId;
      if (!me) return [];
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            id: string;
            title: string;
            status: string;
            created_at: string;
            completed_at: string | null;
          }>(
            `SELECT id, title, status, created_at, completed_at FROM app.tasks
              WHERE source = 'hr_request' AND subject_employee_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [me],
          ),
        { readOnly: true },
      );
      return rows.map((r) => ({
        id: r.id,
        subject: r.title,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      }));
    },
  );

  app.get(
    '/v1/hr-requests/:id',
    {
      schema: {
        tags: ['tasks'],
        summary: 'One of my questions or requests to HR: what I asked, its status and when it was done',
        params: Type.Object({ id: Uuid }),
        response: { 200: HrRequestDetail, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'hr.contact');
      const me = auth.principal.employeeId;
      const { id } = req.params as { id: string };
      // only the person who asked: anyone else's request reads as missing
      if (!me) throw new ApiError('notFound');
      const r = await app.tenantTx(
        req,
        (tx) =>
          tx.maybe<{
            id: string;
            title: string;
            description: string | null;
            status: string;
            created_at: string;
            completed_at: string | null;
            completed_by_name: string | null;
          }>(
            `SELECT k.id, k.title, k.description, k.status, k.created_at, k.completed_at, c.display_name AS completed_by_name
               FROM app.tasks k
               LEFT JOIN app.users c ON c.tenant_id = k.tenant_id AND c.id = k.completed_by
              WHERE k.id = $1 AND k.source = 'hr_request' AND k.subject_employee_id = $2`,
            [id, me],
          ),
        { readOnly: true },
      );
      if (!r) throw new ApiError('notFound');
      return {
        id: r.id,
        subject: r.title,
        message: r.description ?? '',
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        completedByName: r.completed_by_name,
      };
    },
  );
}
