import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { t } from '@thapsus/core/i18n';
import { daysBetween, maxDate, today } from '@thapsus/core/time';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { assignRole } from '../authz/principal';
import { assertPasswordlessAllowed } from '../auth/common';
import { composeToken, hashToken, MAGIC_PREFIX, newToken } from '../auth/tokens';
import { contactsAsOf, employeeAsOf, filterFields, loadTarget } from '../employees/service';
import { claimPersonTasks } from '../workflows/service';

/**
 * Invitation links stay valid for 3 days (a new joiner may open the email days later; HR can send a new
 * one). Shortened from a week by the security hardening plan (2.3.1, ADR-0171): an emailed credential
 * should live no longer than it needs to.
 */
export const INVITE_TTL_MS = 3 * 24 * 3_600_000;
/** Non-admin roles an invitation may grant; admin roles are assigned in role settings with MFA. */
const INVITABLE_ROLES = ['manager'] as const;
const zoneOf = (req: FastifyRequest) => req.auth?.user.timeZone ?? 'Europe/London';

const Onboarding = Type.Object({
  employee: Type.Object({
    id: Uuid,
    displayName: Type.String(),
    jobTitle: Nullable(Type.String()),
    department: Nullable(Type.String()),
    location: Nullable(Type.String()),
    manager: Nullable(Type.String()),
    company: Type.String(),
    startDate: Type.String(),
    status: Type.String(),
    daysUntilStart: Type.Integer(),
  }),
  /** Date from which the joiner's form answers apply (their start date while they are pre-start). */
  formsEffectiveDate: Type.String(),
  documents: Type.Array(
    Type.Object({
      id: Uuid,
      documentId: Uuid,
      title: Type.String(),
      status: Type.String(),
      requestedAt: Type.String(),
      signedAt: Nullable(Type.String()),
    }),
  ),
  forms: Type.Object({
    personalDetails: Type.Object({
      complete: Type.Boolean(),
      values: Type.Record(Type.String(), Type.Any()),
    }),
    emergencyContacts: Type.Object({ complete: Type.Boolean(), contacts: Type.Array(Type.Any()) }),
  }),
  tasks: Type.Array(
    Type.Object({
      id: Uuid,
      title: Type.String(),
      description: Nullable(Type.String()),
      dueOn: Nullable(Type.String()),
      status: Type.String(),
    }),
  ),
  progress: Type.Object({ done: Type.Integer(), total: Type.Integer() }),
});

const PERSONAL_FIELDS = ['preferredName', 'pronouns', 'personalEmail', 'personalPhone', 'address'] as const;

export async function onboardingRoutes(app: FastifyInstance) {
  const deps = app.deps;

  // ---- invite a person (e.g. a new joiner before their start date) to sign in ---------------------
  app.post(
    '/v1/employees/:id/invite',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['employees'],
        summary:
          'Give a person a sign-in (employee self-service, optionally manager) and email them a one-time invitation link',
        params: Type.Object({ id: Uuid }),
        body: Type.Object(
          {
            email: Type.Optional(Type.String({ format: 'email', maxLength: 254 })),
            roles: Type.Optional(
              Type.Array(Type.Union(INVITABLE_ROLES.map((r) => Type.Literal(r))), { maxItems: 1 }),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ userId: Uuid, created: Type.Boolean(), tasksAssigned: Type.Integer() }),
          400: Problem,
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { email?: string; roles?: Array<(typeof INVITABLE_ROLES)[number]> };
      const out = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, id);
        if (!can(auth.principal, 'users.invite', target)) throw new ApiError('forbidden');
        const emp = await tx.one<{
          display_name: string;
          work_email: string | null;
          personal_email: string | null;
          company: string;
          slug: string;
        }>(
          `SELECT e.display_name, e.work_email, p.personal_email, t.name AS company, t.slug FROM app.employees e JOIN app.tenants t ON t.tenant_id = e.tenant_id
             LEFT JOIN LATERAL (SELECT personal_email FROM app.employee_personal x WHERE x.employee_id = e.id ORDER BY valid_from DESC LIMIT 1) p ON true
            WHERE e.id = $1`,
          [id],
        );
        const email = b.email ?? emp.work_email ?? emp.personal_email;
        if (!email) throw new ApiError('validation', 'The person has no email address to invite');
        let user = await tx.maybe<{ id: string; email: string }>(
          `SELECT id, email FROM app.users WHERE employee_id = $1`,
          [id],
        );
        const created = !user;
        if (!user) {
          const taken = await tx.maybe(`SELECT 1 FROM app.users WHERE email = $1`, [email]);
          if (taken) throw new ApiError('conflict', 'That email address already has a sign-in');
          user = await tx.one<{ id: string; email: string }>(
            `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id, email`,
            [email, emp.display_name, id],
          );
        }
        await assignRole(tx, user.id, 'employee', { type: 'self' });
        for (const role of b.roles ?? []) await assignRole(tx, user.id, role, { type: 'own_team' });
        // checklist tasks created before the person had a sign-in are now theirs
        const tasksAssigned = await claimPersonTasks(tx, id, user.id);
        const passwordless = await assertPasswordlessAllowed(tx).then(
          () => true,
          () => false,
        );
        let link = `${deps.config.appBaseUrl}/signin?workspace=${encodeURIComponent(emp.slug)}`;
        if (passwordless) {
          const secret = newToken();
          await tx.exec(
            `INSERT INTO app.magic_links (tenant_id, user_id, token_hash, expires_at, purpose) VALUES (app.current_tenant(), $1, $2, $3, 'invitation')`,
            [user.id, hashToken(secret), new Date(deps.now().getTime() + INVITE_TTL_MS)],
          );
          link = `${deps.config.appBaseUrl}/auth/magic?token=${encodeURIComponent(composeToken(MAGIC_PREFIX, auth.tenantId, secret))}`;
        }
        await app.audit(tx, req, {
          action: 'user.invited',
          targetType: 'employee',
          targetId: id,
          diff: { userId: user.id, created, roles: ['employee', ...(b.roles ?? [])], tasksAssigned },
        });
        return { userId: user.id, email: user.email, created, tasksAssigned, link, company: emp.company };
      });
      const locale = req.ctx.locale;
      await deps.mailer.send({
        to: out.email,
        subject: t(locale, 'onboarding.inviteSubject', { company: out.company }),
        text: t(locale, 'onboarding.inviteBody', { company: out.company, link: out.link }),
      });
      return reply
        .status(201)
        .send({ userId: out.userId, created: out.created, tasksAssigned: out.tasksAssigned });
    },
  );

  // ---- the joiner's pre-start portal: documents to sign, forms and their checklist -----------------
  app.get(
    '/v1/me/onboarding',
    {
      schema: {
        tags: ['me'],
        summary:
          'My onboarding: documents to sign, forms to complete and checklist tasks (works before the start date)',
        response: { 200: Onboarding, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const employeeId = auth.principal.employeeId;
      if (!employeeId) throw new ApiError('notFound');
      return app.tenantTx(
        req,
        async (tx) => {
          const target = await loadTarget(tx, employeeId);
          if (!can(auth.principal, 'self.read', target)) throw new ApiError('forbidden');
          const now = today(zoneOf(req));
          const e = await tx.one<{ start_date: string; company: string }>(
            `SELECT e.start_date, t.name AS company FROM app.employees e JOIN app.tenants t ON t.tenant_id = e.tenant_id WHERE e.id = $1`,
            [employeeId],
          );
          // before the start date, answers apply from the start date (the records begin then)
          const formsDate = maxDate(now, e.start_date);
          const view = filterFields(auth.principal, await employeeAsOf(tx, employeeId, formsDate), target);
          const live = await employeeAsOf(tx, employeeId, now);
          const documents = (
            await tx.query<{
              id: string;
              document_id: string;
              title: string;
              status: string;
              requested_at: string;
              signed_at: string | null;
            }>(
              `SELECT s.id, s.document_id, d.title, s.status, s.requested_at, s.signed_at FROM app.signature_requests s
                 JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
                WHERE s.signer_employee_id = $1 AND s.status IN ('pending', 'signed') ORDER BY s.requested_at`,
              [employeeId],
            )
          ).map((r) => ({
            id: r.id,
            documentId: r.document_id,
            title: r.title,
            status: r.status,
            requestedAt: r.requested_at,
            signedAt: r.signed_at,
          }));
          const contacts = await contactsAsOf(tx, employeeId, formsDate);
          const values = Object.fromEntries(PERSONAL_FIELDS.map((f) => [f, view[f] ?? null]));
          const tasks = (
            await tx.query<{
              id: string;
              title: string;
              description: string | null;
              due_on: string | null;
              status: string;
            }>(
              `SELECT id, title, description, due_on, status FROM app.tasks
                WHERE subject_employee_id = $2 AND source = 'workflow' AND status <> 'cancelled'
                  AND (assignee_user_id = $1 OR (assignee_user_id IS NULL AND assignee_employee_id = $2))
                ORDER BY due_on NULLS LAST, title`,
              [auth.userId, employeeId],
            )
          ).map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            dueOn: r.due_on,
            status: r.status,
          }));
          const personalComplete = !!values.personalPhone && !!values.address;
          const items = [
            ...documents.map((d) => d.status === 'signed'),
            personalComplete,
            contacts.length > 0,
            ...tasks.map((k) => k.status === 'done'),
          ];
          return {
            employee: {
              id: employeeId,
              displayName: String(view.displayName ?? ''),
              jobTitle: (view.jobTitle as string | null) ?? null,
              department: (view.department as string | null) ?? null,
              location: (view.location as string | null) ?? null,
              manager: (view.manager as { displayName: string } | null)?.displayName ?? null,
              company: e.company,
              startDate: e.start_date,
              status: String(live.status),
              daysUntilStart: Math.max(0, daysBetween(now, e.start_date)),
            },
            formsEffectiveDate: formsDate,
            documents,
            forms: {
              personalDetails: { complete: personalComplete, values },
              emergencyContacts: { complete: contacts.length > 0, contacts },
            },
            tasks,
            progress: { done: items.filter(Boolean).length, total: items.length },
          };
        },
        { readOnly: true },
      );
    },
  );
}
