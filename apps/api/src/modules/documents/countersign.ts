import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { t, type Locale } from '@thapsus/core/i18n';
import { writeAudit, type Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { type ObjectStore } from '../../lib/object-store';
import {
  approvalHandlers,
  decide,
  rejectionHandlers,
  requestApproval,
  stepUpSubjects,
} from '../approvals/service';
import { requireRecentAuth } from '../auth/session-routes';
import { tenantLocale } from '../compliance/service';
import { sha256 } from './pdf';
import {
  addEvent,
  askEmployee,
  companySignature,
  completeRequest,
  decodeDrawing,
  isSignatory,
  loadRequest,
  signatoryUserIds,
  signCopy,
  SR_SELECT,
  storeDrawing,
  voidRequest,
  type SrRow,
} from './signing';

/**
 * The company's signature (ADR-0169, ADR-0196). A document that needs it goes to the company's signatories through
 * the approvals service (subject `document.countersign`), so it shows in their inbox and on the Approvals page.
 * Who may sign is the authorised signatories list (Settings → Documents; default HR admins and owners): the
 * approval step's approvers are set to them, and nobody signs for the company on their own document. The
 * approval chain still sets the timing and the escalation (to the owner after 72 hours by default).
 *
 * The signatory reviews the document in the same viewer and signs with the same e-signature method as the
 * employee (consent, a typed name in the handwriting font or a drawn signature, with time, IP address, device and
 * the SHA-256 of what they signed), after a step-up re-authentication. Their signature is stamped into the
 * company's signature block and the countersignature certificate is appended. When the employee signs first, the
 * company signs into the copy the employee signed and the document is complete; when the company signs first, the
 * employee is asked next. Every step is audited.
 */
export const COUNTERSIGN_SUBJECT = 'document.countersign';
const CERT_KEYS = ['title', 'signer', 'signedAt', 'ip', 'userAgent', 'hash', 'reference', 'statement'];
// approving it on the Approvals page needs a recent sign-in too (ASVS V7.5.1)
stepUpSubjects.add(COUNTERSIGN_SUBJECT);

export const certificateLabels = (locale: Locale, ns: 'certificate' | 'countersignCertificate') =>
  Object.fromEntries(CERT_KEYS.map((k) => [k, t(locale, `documents.${ns}.${k}`)]));

/** The default chain, created on first use: HR admins countersign (the owner in a company without HR admins). */
export async function ensureCountersignPolicy(tx: Tx) {
  const has = await tx.maybe(`SELECT 1 FROM app.approval_policies WHERE subject = $1 AND enabled LIMIT 1`, [
    COUNTERSIGN_SUBJECT,
  ]);
  if (has) return;
  const role = (await usersWithRole(tx, 'hr_admin')).length ? 'hr_admin' : 'owner';
  await tx.exec(
    `INSERT INTO app.approval_policies (tenant_id, subject, name, steps) VALUES (app.current_tenant(), $1, $2, $3)`,
    [
      COUNTERSIGN_SUBJECT,
      t(await tenantLocale(tx), 'docSign.policyName'),
      // nobody approves their own request: an HR admin's own document goes to the owner after three days
      JSON.stringify([
        {
          approver: { type: 'role', value: role },
          timeoutHours: 72,
          escalateTo: { type: 'role', value: 'owner' },
        },
      ]),
    ],
  );
}

/**
 * The open step's approvers become the authorised signatories, less the person the document is about: tasks are
 * added for signatories the chain did not name, and withdrawn from anyone else.
 */
async function syncSignatories(
  tx: Tx,
  approvalId: string,
  title: string,
  subjectEmployeeId: string,
  link: string,
) {
  const step = await tx.maybe<{ id: string; step_index: number; approver_user_ids: string[] }>(
    `SELECT st.id, st.step_index, st.approver_user_ids FROM app.approval_steps st JOIN app.approval_requests r ON r.tenant_id = st.tenant_id AND r.id = st.request_id
      WHERE r.id = $1 AND st.step_index = r.current_step`,
    [approvalId],
  );
  if (!step) return;
  const own = await userForEmployee(tx, subjectEmployeeId);
  const signers = (await signatoryUserIds(tx)).filter((u) => u !== own);
  if (!signers.length) throw new ApiError('unprocessable', 'noSignatory');
  await tx.exec('UPDATE app.approval_steps SET approver_user_ids = $2 WHERE id = $1', [step.id, signers]);
  await tx.exec(
    `UPDATE app.tasks SET status = 'cancelled' WHERE source = 'approval' AND source_id = $1 AND status = 'open' AND NOT (assignee_user_id = ANY($2::uuid[]))`,
    [approvalId, signers],
  );
  await tx.exec(
    `DELETE FROM app.notifications WHERE dedupe_key = $1 AND read_at IS NULL AND NOT (user_id = ANY($2::uuid[]))`,
    [`appr:${approvalId}:${step.step_index}`, signers],
  );
  const added = signers.filter((u) => !step.approver_user_ids.includes(u));
  for (const user of added)
    await createTask(tx, {
      source: 'approval',
      sourceId: approvalId,
      title,
      subjectEmployeeId,
      assigneeUserId: user,
      link,
      dedupeKey: `appr:${approvalId}:${step.step_index}:${user}`,
    });
  if (added.length)
    await notify(tx, {
      userIds: added,
      kind: 'approval.requested',
      titleKey: 'notify.approvalRequested',
      params: { title },
      target: { type: 'approval_request', id: approvalId },
      link,
      dedupeKey: `appr:${approvalId}:${step.step_index}`,
    });
}

/** Asks the company to sign; the tasks and the notification open the viewer. */
export async function requestCountersign(
  tx: Tx,
  sr: { id: string; document_id: string; title: string; signer_employee_id: string },
  requestedBy: string | null,
) {
  await ensureCountersignPolicy(tx);
  const link = `/app/documents/${sr.document_id}`;
  const state = await tx.maybe<{ status: string }>(
    'SELECT status FROM app.signature_requests WHERE id = $1',
    [sr.id],
  );
  const approvalId = await requestApproval(tx, COUNTERSIGN_SUBJECT, sr.signer_employee_id, requestedBy, {
    signatureRequestId: sr.id,
    documentId: sr.document_id,
    documentTitle: sr.title,
    link,
    // the company signs before the employee has (company first, or either order)
    companyFirst: state?.status === 'pending',
  });
  if (!approvalId) throw new ApiError('unprocessable', 'No approval chain for countersignatures is in use');
  await tx.exec(
    `UPDATE app.signature_requests SET approval_status = 'pending', approval_request_id = $2, returned_reason = NULL WHERE id = $1`,
    [sr.id, approvalId],
  );
  const policy = await tx.one<{ name: string }>(
    `SELECT p.name FROM app.approval_requests r JOIN app.approval_policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id WHERE r.id = $1`,
    [approvalId],
  );
  await syncSignatories(tx, approvalId, policy.name, sr.signer_employee_id, link);
  // the approval's tasks and notification lead straight to the document
  await tx.exec(`UPDATE app.tasks SET link = $2 WHERE source = 'approval' AND source_id = $1`, [
    approvalId,
    link,
  ]);
  await tx.exec(`UPDATE app.notifications SET link = $2 WHERE dedupe_key LIKE $1`, [
    `appr:${approvalId}:%`,
    link,
  ]);
  return approvalId;
}
companySignature.request = requestCountersign;

type CsRow = SrRow & {
  countersigner_user_id: string | null;
  countersigner_ip: string | null;
  countersigner_user_agent: string | null;
  countersignature_drawing_key: string | null;
};

/**
 * The company has signed (the approval is approved). The signatory's evidence was recorded by the countersign
 * route; an approval decided on the Approvals page records who and when from the approval step, with no IP address
 * or device, and the signatory's name as a typed signature. Only an authorised signatory may decide it, and never
 * on their own document.
 */
export async function completeCountersign(
  deps: { objects: ObjectStore; now: () => Date },
  tx: Tx,
  approvalRequestId: string,
) {
  const sr = await tx.maybe<CsRow>(`${SR_SELECT} WHERE s.approval_request_id = $1 FOR UPDATE OF s`, [
    approvalRequestId,
  ]);
  if (!sr || sr.approval_status !== 'pending') return;
  const employeeSigned = sr.status === 'signed';
  if (employeeSigned && !sr.signed_file_key) return;
  const step = await tx.one<{
    decided_by: string;
    decided_at: string;
    display_name: string;
    email: string;
    time_zone: string | null;
  }>(
    `SELECT s.decided_by, s.decided_at, u.display_name, u.email, u.time_zone FROM app.approval_steps s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.id = s.decided_by
      WHERE s.request_id = $1 AND s.status = 'approved' ORDER BY s.step_index DESC LIMIT 1`,
    [approvalRequestId],
  );
  if (!(await isSignatory(tx, step.decided_by))) throw new ApiError('forbidden', 'notAuthorisedSignatory');
  if (step.decided_by === (await userForEmployee(tx, sr.signer_employee_id)))
    throw new ApiError('forbidden', 'ownDocument');
  const viaRoute =
    sr.countersigner_user_id === step.decided_by && !!sr.countersigner_name && !!sr.countersigned_at;
  const name = viaRoute ? sr.countersigner_name! : step.display_name;
  const at = viaRoute
    ? new Date(sr.countersigned_at!).toISOString()
    : new Date(step.decided_at).toISOString();
  const locale = await tenantLocale(tx);
  if (employeeSigned && sr.signed_sha256) {
    const current = await deps.objects.get(sr.employee_signed_file_key ?? sr.signed_file_key!);
    if (sha256(current) !== sr.signed_sha256)
      throw new ApiError('internal', 'The signed copy changed while it waited for the countersignature');
  }
  const drawingKey = viaRoute ? sr.countersignature_drawing_key : null;
  const drawing = drawingKey ? new Uint8Array(await deps.objects.get(drawingKey)) : undefined;
  const method = drawing ? 'drawn' : 'typed';
  const copy = await signCopy(
    deps,
    tx,
    sr,
    'company',
    {
      userId: step.decided_by,
      email: step.email,
      typedName: name,
      method,
      drawing,
      ip:
        (viaRoute ? sr.countersigner_ip : null) ?? t(locale, 'documents.countersignCertificate.notRecorded'),
      userAgent:
        (viaRoute ? sr.countersigner_user_agent : null) ??
        t(locale, 'documents.countersignCertificate.viaApprovals'),
      at,
      zone: step.time_zone ?? 'UTC',
    },
    certificateLabels(locale, 'countersignCertificate'),
  );
  await tx.exec(
    `UPDATE app.signature_requests SET approval_status = 'approved', countersigner_user_id = $2, countersigner_name = $3, countersigned_at = $4,
            countersigner_ip = $5, countersigner_user_agent = $6, company_signed_file_key = $7, company_signed_sha256 = $8,
            countersignature_method = $9, employee_signed_sha256 = CASE WHEN status = 'signed' THEN $10 ELSE employee_signed_sha256 END
      WHERE id = $1`,
    [
      sr.id,
      step.decided_by,
      name,
      at,
      viaRoute ? sr.countersigner_ip : null,
      viaRoute ? sr.countersigner_user_agent : null,
      copy.key,
      copy.sha,
      method,
      copy.inputSha,
    ],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'company_signed',
    actorUserId: step.decided_by,
    actorName: name,
    fileKey: copy.key,
    sha256: copy.sha,
    detail: { method, documentSha256: copy.inputSha, viaApprovals: !viaRoute },
    at,
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: step.decided_by,
    action: 'document.countersigned',
    targetType: 'signature_request',
    targetId: sr.id,
    diff: {
      approvalRequestId,
      employeeSignedSha256: employeeSigned ? copy.inputSha : null,
      inputSha256: copy.inputSha,
      signedSha256: copy.sha,
      companyFirst: !employeeSigned,
      method,
    },
  });
  const fresh = (await loadRequest(tx, sr.id))!;
  if (employeeSigned || !sr.requires_employee_signature)
    return completeRequest(tx, fresh, {
      key: copy.key,
      sha: copy.sha,
      size: copy.bytes.length,
      actor: step.decided_by,
      at: deps.now().toISOString(),
    });
  // the company signed first: now it is the employee's turn (in "either order" they were asked already)
  if (sr.signing_order === 'company_first') await askEmployee(tx, sr);
  return undefined;
}

/**
 * Returns a signed document to the person with the signatory's reason; they can read it and sign again. When the
 * employee has not signed yet (the company was to sign first, or either), declining it voids the request.
 */
export async function returnToSigner(tx: Tx, approvalRequestId: string) {
  const sr = await tx.maybe<SrRow>(`${SR_SELECT} WHERE s.approval_request_id = $1 FOR UPDATE OF s`, [
    approvalRequestId,
  ]);
  if (!sr || sr.approval_status !== 'pending') return;
  const step = await tx.maybe<{ comment: string | null; decided_by: string }>(
    `SELECT comment, decided_by FROM app.approval_steps WHERE request_id = $1 AND status = 'rejected' ORDER BY step_index DESC LIMIT 1`,
    [approvalRequestId],
  );
  const reason = step?.comment ?? null;
  if (sr.status !== 'signed') {
    // the approval is already decided: the void only withdraws the employee's side
    await voidRequest(tx, { ...sr, approval_request_id: null }, step?.decided_by ?? null, reason ?? '');
    return;
  }
  // back to "waiting for your signature": the evidence of the returned signature stays in the audit log
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'pending', approval_status = 'returned', returned_reason = $2, approval_request_id = NULL,
            countersigner_user_id = NULL, countersigner_name = NULL, countersigner_ip = NULL, countersigner_user_agent = NULL, countersigned_at = NULL
      WHERE id = $1`,
    [sr.id, reason],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'returned',
    actorUserId: step?.decided_by ?? null,
    detail: { reason },
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: step?.decided_by ?? null,
    action: 'document.returned',
    targetType: 'signature_request',
    targetId: sr.id,
    diff: { approvalRequestId, reason, returnedSignedSha256: sr.signed_sha256 },
  });
  const signer = sr.signer_user_id ?? (await userForEmployee(tx, sr.signer_employee_id));
  if (signer) {
    const link = `/app/documents/${sr.document_id}`;
    await notify(tx, {
      userIds: [signer],
      kind: 'document.returned',
      titleKey: 'notify.documentReturned',
      params: { title: sr.title },
      target: { type: 'document', id: sr.document_id },
      dedupeKey: `returned:${approvalRequestId}`,
    });
    await createTask(tx, {
      source: 'document',
      sourceId: sr.id,
      title: t(await tenantLocale(tx), 'docSign.taskSignAgain', { title: sr.title }),
      subjectEmployeeId: sr.signer_employee_id,
      assigneeUserId: signer,
      link,
      dedupeKey: `sign:${sr.id}:returned:${approvalRequestId}`,
    });
  }
}

/** Registers the approval effects (the API process registers them with its own object store). */
export function registerCountersignEffects(deps: { objects: ObjectStore; now: () => Date }) {
  approvalHandlers[COUNTERSIGN_SUBJECT] = async (tx, r) => {
    await completeCountersign(deps, tx, r.id);
  };
  rejectionHandlers[COUNTERSIGN_SUBJECT] = (tx, r) => returnToSigner(tx, r.id);
}

/**
 * The pending company signature of a document that `userId` may give, if any: they are an approver of the open
 * step, an authorised signatory, and not the person the document is about.
 */
export async function pendingCountersignFor(tx: Tx, userId: string, documentId: string) {
  const row = await tx.maybe<{
    id: string;
    approval_request_id: string;
    signer_name: string | null;
    signed_at: string | null;
    signed_sha256: string | null;
    document_sha256: string | null;
    original_sha256: string | null;
    status: string;
    signer_employee_id: string;
  }>(
    `SELECT s.id, s.approval_request_id, s.signer_name, s.signed_at, s.signed_sha256, s.document_sha256, s.original_sha256, s.status,
            s.signer_employee_id
       FROM app.signature_requests s
       JOIN app.approval_requests r ON r.tenant_id = s.tenant_id AND r.id = s.approval_request_id AND r.status = 'pending'
       JOIN app.approval_steps st ON st.tenant_id = r.tenant_id AND st.request_id = r.id AND st.step_index = r.current_step AND st.status = 'pending'
      WHERE s.document_id = $1 AND s.approval_status = 'pending' AND $2 = ANY(st.approver_user_ids)
        AND r.requested_by IS DISTINCT FROM $2
      LIMIT 1`,
    [documentId, userId],
  );
  if (!row) return undefined;
  if ((await userForEmployee(tx, row.signer_employee_id)) === userId) return undefined;
  if (!(await isSignatory(tx, userId))) return undefined;
  return row;
}

export async function countersignRoutes(app: FastifyInstance) {
  registerCountersignEffects(app.deps);

  app.post(
    '/v1/signature-requests/:id/countersign',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'An authorised signatory signs for the company (consent, and a typed name or a drawn signature, after a step-up re-authentication) or returns it to the signer with a reason',
        params: Type.Object({ id: Uuid }),
        body: Type.Union([
          Type.Object(
            {
              decision: Type.Literal('approve'),
              consent: Type.Literal(true),
              typedName: Type.String({ minLength: 2, maxLength: 120 }),
              /** typed (default): the name in the handwriting font; drawn: `drawing` is a PNG data URL */
              method: Type.Optional(Type.Union([Type.Literal('typed'), Type.Literal('drawn')])),
              drawing: Type.Optional(Type.String({ maxLength: 420_000 })),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            { decision: Type.Literal('return'), reason: Type.String({ minLength: 3, maxLength: 1000 }) },
            { additionalProperties: false },
          ),
        ]),
        response: {
          /** completed; awaiting_employee (the company signed first); returned; voided (declined before the employee signed) */
          200: Type.Object({ status: Type.String(), signedDocumentId: Nullable(Uuid) }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as
        | { decision: 'approve'; typedName: string; method?: 'typed' | 'drawn'; drawing?: string }
        | { decision: 'return'; reason: string };
      const drawing = b.decision === 'approve' && b.method === 'drawn' ? decodeDrawing(b.drawing) : undefined;
      if (b.decision === 'approve' && b.method === 'drawn' && !drawing)
        throw new ApiError('validation', 'drawingRequired');
      return app.tenantTx(req, async (tx) => {
        const sr = await tx.maybe<{
          document_id: string;
          approval_request_id: string | null;
          approval_status: string | null;
          status: string;
          signer_employee_id: string;
        }>(
          `SELECT document_id, approval_request_id, approval_status, status, signer_employee_id FROM app.signature_requests WHERE id = $1`,
          [id],
        );
        if (!sr) throw new ApiError('notFound');
        if (sr.approval_status !== 'pending' || !sr.approval_request_id) throw new ApiError('conflict');
        const mine = await pendingCountersignFor(tx, auth.userId, sr.document_id);
        if (!mine || mine.id !== id) throw new ApiError('forbidden');
        // signing for the company needs a recent sign-in (step-up, ASVS V7.5.1); returning it does not
        if (b.decision === 'approve') {
          requireRecentAuth(auth, app.deps.now());
          const drawingKey = drawing
            ? await storeDrawing(app.deps, tx, sr.signer_employee_id, drawing)
            : null;
          await tx.exec(
            `UPDATE app.signature_requests SET countersigner_user_id = $2, countersigner_name = $3, countersigner_ip = $4, countersigner_user_agent = $5,
                    countersigned_at = $6, countersignature_drawing_key = $7 WHERE id = $1`,
            [
              id,
              auth.userId,
              b.typedName,
              req.ctx.ip,
              req.ctx.userAgent?.slice(0, 512) ?? null,
              app.deps.now().toISOString(),
              drawingKey,
            ],
          );
        }
        req.auditWritten = true; // decide() and the effects write the audit entries
        const status = await decide(
          tx,
          sr.approval_request_id,
          auth.userId,
          b.decision === 'approve' ? 'approve' : 'reject',
          b.decision === 'return' ? b.reason : undefined,
        );
        const after = await tx.one<{ signed_document_id: string | null; completed_at: string | null }>(
          'SELECT signed_document_id, completed_at FROM app.signature_requests WHERE id = $1',
          [id],
        );
        return {
          status:
            status === 'approved'
              ? after.completed_at
                ? 'completed'
                : 'awaiting_employee'
              : status === 'rejected'
                ? sr.status === 'signed'
                  ? 'returned'
                  : 'voided'
                : 'awaiting_approval',
          signedDocumentId: status === 'approved' ? after.signed_document_id : null,
        };
      });
    },
  );
}
