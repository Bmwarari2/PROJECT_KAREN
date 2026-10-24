import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { uncoveredPermissions } from '@thapsus/core/access';
import { newDocumentHref, type PlacedField, type SigningOrder } from '@thapsus/core/documents';
import type { Tx } from '@thapsus/db';
import { authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { loadTarget } from '../employees/service';
import { requireRecentAuth } from '../auth/session-routes';
import {
  loadRequest,
  remindRequest,
  resendRequest,
  sendExistingDocument,
  sendFromTemplate,
  signatoryEntries,
  signatoryUserIds,
  voidRequest,
} from './signing';

/**
 * Sending for signature and following up (16.11, 16.12, ADR-0195, ADR-0196): send a template or a filed PDF to a
 * person; remind whoever's turn it is; void (and replace) or send a voided request again; and the authorised
 * signatories list. Everything here needs documents.manage for the person; every change is audited.
 */
const ORDER = Type.Union(['employee_first', 'company_first', 'any'].map((v) => Type.Literal(v)));
const POSITION = Type.Union(
  [
    'top_left',
    'top_centre',
    'top_right',
    'middle_left',
    'middle_centre',
    'middle_right',
    'bottom_left',
    'bottom_centre',
    'bottom_right',
  ].map((v) => Type.Literal(v)),
);

async function manageFor(tx: Tx, req: FastifyRequest, employeeId: string) {
  const auth = requireAuth(req);
  if (!can(auth.principal, 'documents.manage', await loadTarget(tx, employeeId)))
    throw new ApiError('forbidden');
  return auth;
}

export async function signingRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.post(
    '/v1/signature-requests',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'Sends a document for signature: a template filled for the person (blocked while values are missing) or a PDF filed for them (with placed boxes, or a signature page added)',
        body: Type.Object({
          employeeId: Uuid,
          templateId: Type.Optional(Uuid),
          documentId: Type.Optional(Uuid),
          values: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 500 }))),
          title: Type.Optional(Type.String({ maxLength: 200 })),
          employeeSigns: Type.Boolean(),
          companySigns: Type.Boolean(),
          signingOrder: ORDER,
          dueOn: Type.Optional(CivilDate),
          message: Type.Optional(Type.String({ maxLength: 1000 })),
          /** The task this send completes (for example an onboarding step); it closes when the document is complete. */
          taskId: Type.Optional(Uuid),
          /** Boxes on an uploaded PDF (1-based page). Without a signature box a signature page is added. */
          fields: Type.Optional(
            Type.Array(
              Type.Object({
                party: Type.Union([Type.Literal('employee'), Type.Literal('company')]),
                kind: Type.Union([Type.Literal('signature'), Type.Literal('date')]),
                page: Type.Integer({ minimum: 1, maximum: 2000 }),
                position: POSITION,
              }),
              { maxItems: 20 },
            ),
          ),
        }),
        response: {
          201: Type.Object({ documentId: Uuid, signatureRequestId: Nullable(Uuid) }),
          400: Problem,
          403: Problem,
          404: Problem,
          409: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        employeeId: string;
        templateId?: string;
        documentId?: string;
        values?: Record<string, string>;
        title?: string;
        employeeSigns: boolean;
        companySigns: boolean;
        signingOrder: SigningOrder;
        dueOn?: string;
        message?: string;
        taskId?: string;
        fields?: PlacedField[];
      };
      if (!!b.templateId === !!b.documentId) throw new ApiError('validation', 'templateOrDocument');
      if (!b.employeeSigns && !b.companySigns) throw new ApiError('validation', 'nobodySigns');
      const out = await app.tenantTx(req, async (tx) => {
        const auth = await manageFor(tx, req, b.employeeId);
        const opts = {
          employeeId: b.employeeId,
          actor: auth.userId,
          employeeSigns: b.employeeSigns,
          companySigns: b.companySigns,
          order: b.signingOrder,
          dueOn: b.dueOn ?? null,
          message: b.message ?? null,
          taskId: b.taskId ?? null,
        };
        const r = b.templateId
          ? await sendFromTemplate(deps, tx, {
              ...opts,
              templateId: b.templateId,
              typed: b.values,
              title: b.title,
            })
          : await sendExistingDocument(deps, tx, {
              ...opts,
              documentId: b.documentId!,
              placed: b.fields ?? [],
            });
        await app.audit(tx, req, {
          action: 'document.sent',
          targetType: 'signature_request',
          targetId: r.signatureRequestId ?? r.documentId,
          diff: {
            documentId: r.documentId,
            templateId: b.templateId ?? null,
            templateVersion: 'version' in r ? r.version.version : null,
            employeeId: b.employeeId,
            employeeSigns: b.employeeSigns,
            companySigns: b.companySigns,
            order: b.signingOrder,
            dueOn: b.dueOn ?? null,
            taskId: b.taskId ?? null,
            placedFields: b.fields?.length ?? 0,
          },
        });
        return { documentId: r.documentId, signatureRequestId: r.signatureRequestId };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/signature-requests/:id/remind',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary: 'Reminds whoever has to sign next (the employee, the company’s signatories, or both)',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ told: Type.Array(Type.String()) }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const sr = await loadRequest(tx, id, true);
        if (!sr) throw new ApiError('notFound');
        const auth = await manageFor(tx, req, sr.signer_employee_id);
        const out = await remindRequest(tx, sr, auth.userId, deps.now().toISOString());
        await app.audit(tx, req, {
          action: 'document.reminded',
          targetType: 'signature_request',
          targetId: id,
          diff: { told: out.told },
        });
        return out;
      });
    },
  );

  app.post(
    '/v1/signature-requests/:id/void',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'Voids a signature request that is not complete; with replace, the answer links to sending a new one',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          reason: Type.String({ minLength: 3, maxLength: 1000 }),
          replace: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({ id: Uuid, status: Type.String(), replaceHref: Nullable(Type.String()) }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as { reason: string; replace?: boolean };
      return app.tenantTx(req, async (tx) => {
        const sr = await loadRequest(tx, id, true);
        if (!sr) throw new ApiError('notFound');
        const auth = await manageFor(tx, req, sr.signer_employee_id);
        await voidRequest(tx, sr, auth.userId, b.reason.trim(), deps.now().toISOString());
        await app.audit(tx, req, {
          action: 'document.voided',
          targetType: 'signature_request',
          targetId: id,
          diff: { reason: b.reason.trim(), replace: !!b.replace, documentId: sr.document_id },
        });
        // replacing it sends the template again (with the task, if any), from the send page
        const replaceHref =
          b.replace && sr.template_id
            ? newDocumentHref({
                employeeId: sr.signer_employee_id,
                templateId: sr.template_id,
                taskId: sr.task_id,
              })
            : b.replace
              ? newDocumentHref({
                  employeeId: sr.signer_employee_id,
                  documentId: sr.document_id,
                  taskId: sr.task_id,
                })
              : null;
        return { id, status: 'voided', replaceHref };
      });
    },
  );

  app.post(
    '/v1/signature-requests/:id/resend',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary: 'Sends a voided request again: a new request for the same document, with the same options',
        params: Type.Object({ id: Uuid }),
        response: {
          201: Type.Object({ signatureRequestId: Uuid }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await app.tenantTx(req, async (tx) => {
        const sr = await loadRequest(tx, id, true);
        if (!sr) throw new ApiError('notFound');
        const auth = await manageFor(tx, req, sr.signer_employee_id);
        const next = await resendRequest(tx, sr, auth.userId, deps.now().toISOString());
        await app.audit(tx, req, {
          action: 'document.resent',
          targetType: 'signature_request',
          targetId: next,
          diff: { previous: id, documentId: sr.document_id },
        });
        return { signatureRequestId: next };
      });
      return reply.status(201).send(out);
    },
  );

  // ---- authorised signatories (Settings → Documents) ---------------------------------------------------------
  const Entry = Type.Object({
    kind: Type.Union([Type.Literal('role'), Type.Literal('user')]),
    roleKey: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{1,60}$' })),
    userId: Type.Optional(Uuid),
  });
  const SignatoriesOut = Type.Object({
    /** No list saved yet: HR admins and owners sign (ADR-0187). */
    isDefault: Type.Boolean(),
    entries: Type.Array(
      Type.Object({
        kind: Type.String(),
        roleKey: Nullable(Type.String()),
        userId: Nullable(Uuid),
        name: Nullable(Type.String()),
      }),
    ),
    /** Everyone who may sign for the company now. */
    people: Type.Array(Type.Object({ userId: Uuid, name: Type.String() })),
  });
  const signatories = async (tx: Tx) => {
    const { isDefault, entries } = await signatoryEntries(tx);
    const ids = await signatoryUserIds(tx);
    const names = await tx.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM app.users WHERE id = ANY($1::uuid[]) ORDER BY display_name',
      [[...new Set([...ids, ...entries.map((e) => e.user_id).filter(Boolean)])]],
    );
    const name = (id: string | null) => names.find((n) => n.id === id)?.display_name ?? null;
    return {
      isDefault,
      entries: entries.map((e) => ({
        kind: e.kind,
        roleKey: e.role_key,
        userId: e.user_id,
        name: name(e.user_id),
      })),
      people: names.filter((n) => ids.includes(n.id)).map((n) => ({ userId: n.id, name: n.display_name })),
    };
  };

  app.get(
    '/v1/document-signatories',
    { schema: { tags: ['documents'], response: { 200: SignatoriesOut, 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'documents.manage');
      return app.tenantTx(req, signatories, { readOnly: true });
    },
  );

  app.put(
    '/v1/document-signatories',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'Sets who may sign documents for the company (roles or people); changing it needs a recent sign-in',
        body: Type.Object({ entries: Type.Array(Entry, { minItems: 1, maxItems: 50 }) }),
        response: { 200: SignatoriesOut, 400: Problem, 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'documents.manage');
      // company-wide document rights: a signatory signs for the whole company
      const companyWide = auth.principal.grants.filter((g) => g.scope.type === 'all');
      if (uncoveredPermissions(companyWide, ['documents.manage']).length)
        throw new ApiError('forbidden', 'companyWideRequired');
      requireRecentAuth(auth, deps.now());
      const b = req.body as { entries: Array<{ kind: 'role' | 'user'; roleKey?: string; userId?: string }> };
      for (const e of b.entries)
        if ((e.kind === 'role') !== !!e.roleKey || (e.kind === 'user') !== !!e.userId)
          throw new ApiError('validation', 'signatoryEntry');
      return app.tenantTx(req, async (tx) => {
        await tx.exec('DELETE FROM app.document_signatories');
        for (const e of b.entries)
          await tx.exec(
            `INSERT INTO app.document_signatories (tenant_id, kind, role_key, user_id, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [e.kind, e.kind === 'role' ? e.roleKey : null, e.kind === 'user' ? e.userId : null, auth.userId],
          );
        const out = await signatories(tx);
        await app.audit(tx, req, {
          action: 'document_signatories.updated',
          targetType: 'document_signatories',
          diff: {
            roles: b.entries.filter((e) => e.kind === 'role').map((e) => e.roleKey),
            users: b.entries.filter((e) => e.kind === 'user').length,
            people: out.people.length,
          },
        });
        return out;
      });
    },
  );
}
