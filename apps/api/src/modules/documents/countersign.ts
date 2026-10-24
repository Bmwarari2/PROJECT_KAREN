import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { t, type Locale } from '@thapsus/core/i18n';
import { writeAudit, type Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { createTask, notify, userForEmployee, usersWithRole } from '../../lib/notify';
import { objectKey, type ObjectStore } from '../../lib/object-store';
import { approvalHandlers, decide, rejectionHandlers, requestApproval } from '../approvals/service';
import { tenantLocale } from '../compliance/service';
import { appendCertificate, sha256 } from './pdf';

/**
 * Countersignature (ADR-0169). A document that needs a company signature is not complete when the person signs:
 * it goes to an approver through the approvals service (subject `document.countersign`), so it shows in the
 * approver's inbox and approvals list. The default chain (created on first use) asks the HR admins, or the owner
 * in a company without one; a customer names an authorised signatory or a countersigner by editing the chain
 * (a role or a specific person, like any other approval chain).
 *
 * The approver reviews the document in the same viewer and either countersigns (same e-signature method as the
 * signer: consent and a typed name, with time, IP address, device and the SHA-256 of what they signed) or returns
 * it with a reason. Countersigning appends a second certificate to the copy the person signed, so the completed
 * copy records both signatures with their timestamps. Every step is audited.
 */
export const COUNTERSIGN_SUBJECT = 'document.countersign';
const CERT_KEYS = ['title', 'signer', 'signedAt', 'ip', 'userAgent', 'hash', 'reference', 'statement'];

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

/** Sends a signed document to its approver; the tasks and the notification open the viewer. */
export async function requestCountersign(
  tx: Tx,
  sr: { id: string; document_id: string; title: string; signer_employee_id: string },
  requestedBy: string | null,
) {
  await ensureCountersignPolicy(tx);
  const link = `/app/documents/${sr.document_id}`;
  const approvalId = await requestApproval(tx, COUNTERSIGN_SUBJECT, sr.signer_employee_id, requestedBy, {
    signatureRequestId: sr.id,
    documentId: sr.document_id,
    documentTitle: sr.title,
    link,
  });
  if (!approvalId) throw new ApiError('unprocessable', 'No approval chain for countersignatures is in use');
  await tx.exec(
    `UPDATE app.signature_requests SET approval_status = 'pending', approval_request_id = $2, returned_reason = NULL WHERE id = $1`,
    [sr.id, approvalId],
  );
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

interface SrRow {
  id: string;
  document_id: string;
  signer_employee_id: string;
  signer_user_id: string | null;
  signer_name: string | null;
  signed_at: string | null;
  signed_file_key: string | null;
  signed_sha256: string | null;
  approval_request_id: string | null;
  approval_status: string | null;
  countersigner_user_id: string | null;
  countersigner_name: string | null;
  countersigner_ip: string | null;
  countersigner_user_agent: string | null;
  countersigned_at: string | null;
  title: string;
  employee_id: string;
}
const SR_SELECT = `SELECT s.*, d.title, d.employee_id FROM app.signature_requests s
  JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id`;

/**
 * Completes a countersigned document: the approver's certificate is appended to the copy the person signed, the
 * result becomes the signed copy (a new document), and the person is told. The approver's evidence was recorded
 * by the countersign route; an approval decided elsewhere (the approvals list) records who and when from the
 * approval step, with no IP address or device.
 */
export async function completeCountersign(
  deps: { objects: ObjectStore; now: () => Date },
  tx: Tx,
  approvalRequestId: string,
) {
  const sr = await tx.maybe<SrRow>(`${SR_SELECT} WHERE s.approval_request_id = $1 FOR UPDATE OF s`, [
    approvalRequestId,
  ]);
  if (!sr || sr.approval_status !== 'pending' || !sr.signed_file_key) return;
  // The evidence the countersign route recorded belongs to the approver of the final step; a decision taken
  // elsewhere (the approvals list) is recorded from the approval step itself, without an IP address or device.
  const step = await tx.one<{ decided_by: string; decided_at: string; display_name: string }>(
    `SELECT s.decided_by, s.decided_at, u.display_name FROM app.approval_steps s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.id = s.decided_by
      WHERE s.request_id = $1 AND s.status = 'approved' ORDER BY s.step_index DESC LIMIT 1`,
    [approvalRequestId],
  );
  const viaRoute =
    sr.countersigner_user_id === step.decided_by && !!sr.countersigner_name && !!sr.countersigned_at;
  const name = viaRoute ? sr.countersigner_name! : step.display_name;
  const userId = step.decided_by;
  const at = viaRoute
    ? new Date(sr.countersigned_at!).toISOString()
    : new Date(step.decided_at).toISOString();
  const ip = viaRoute ? sr.countersigner_ip : null;
  const device = viaRoute ? sr.countersigner_user_agent : null;
  const email =
    (await tx.maybe<{ email: string }>('SELECT email FROM app.users WHERE id = $1', [userId]))?.email ?? '';
  const locale = await tenantLocale(tx);
  const employeeSigned = await deps.objects.get(sr.signed_file_key);
  const employeeSignedSha = sha256(employeeSigned);
  if (sr.signed_sha256 && employeeSignedSha !== sr.signed_sha256)
    throw new ApiError('internal', 'The signed copy changed while it waited for the countersignature');
  const completed = Buffer.from(
    await appendCertificate(employeeSigned, {
      signerName: name,
      signerEmail: email,
      signedAtUtc: at,
      ip: ip ?? t(locale, 'documents.countersignCertificate.notRecorded'),
      userAgent: device ?? t(locale, 'documents.countersignCertificate.viaApprovals'),
      documentSha256: employeeSignedSha,
      requestId: sr.id,
      labels: certificateLabels(locale, 'countersignCertificate'),
    }),
  );
  const tenant = (await tx.one<{ t: string }>('SELECT app.current_tenant()::text AS t')).t;
  const key = objectKey(tenant, `employees/${sr.employee_id}`, '.pdf');
  await deps.objects.put(key, completed, 'application/pdf');
  const completedSha = sha256(completed);
  const doc = await tx.one<{ id: string }>(
    `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, created_by, uploaded_at)
     VALUES (app.current_tenant(), $1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, 'ready', $7, now()) RETURNING id`,
    [
      sr.employee_id,
      t(locale, 'docSign.signedTitle', { title: sr.title }),
      key,
      `${sr.title.replace(/[^\w.-]+/g, '_')}_signed.pdf`,
      completed.length,
      completedSha,
      userId,
    ],
  );
  const now = deps.now().toISOString();
  await tx.exec(
    `UPDATE app.signature_requests SET approval_status = 'approved', countersigner_user_id = $2, countersigner_name = $3, countersigned_at = $4,
            countersigner_ip = $10, countersigner_user_agent = $11,
            employee_signed_sha256 = $5, signed_file_key = $6, signed_sha256 = $7, completed_at = $8, signed_document_id = $9 WHERE id = $1`,
    [sr.id, userId, name, at, employeeSignedSha, key, completedSha, now, doc.id, ip, device],
  );
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: 'document.countersigned',
    targetType: 'signature_request',
    targetId: sr.id,
    diff: { approvalRequestId, employeeSignedSha256: employeeSignedSha, signedSha256: completedSha },
  });
  const signer = sr.signer_user_id ?? (await userForEmployee(tx, sr.signer_employee_id));
  if (signer)
    await notify(tx, {
      userIds: [signer],
      kind: 'document.completed',
      titleKey: 'notify.documentCompleted',
      params: { title: sr.title },
      target: { type: 'document', id: doc.id },
      dedupeKey: `completed:${sr.id}`,
    });
  return doc.id;
}

/** Returns a signed document to the person with the approver's reason; they can read it and sign again. */
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
  // back to "waiting for your signature": the evidence of the returned signature stays in the audit log
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'pending', approval_status = 'returned', returned_reason = $2, approval_request_id = NULL,
            countersigner_user_id = NULL, countersigner_name = NULL, countersigner_ip = NULL, countersigner_user_agent = NULL, countersigned_at = NULL
      WHERE id = $1`,
    [sr.id, reason],
  );
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

/** The pending countersignature of a document that `userId` may decide, if any. */
export async function pendingCountersignFor(tx: Tx, userId: string, documentId: string) {
  return tx.maybe<{
    id: string;
    approval_request_id: string;
    signer_name: string | null;
    signed_at: string | null;
    signed_sha256: string | null;
    document_sha256: string | null;
  }>(
    `SELECT s.id, s.approval_request_id, s.signer_name, s.signed_at, s.signed_sha256, s.document_sha256
       FROM app.signature_requests s
       JOIN app.approval_requests r ON r.tenant_id = s.tenant_id AND r.id = s.approval_request_id AND r.status = 'pending'
       JOIN app.approval_steps st ON st.tenant_id = r.tenant_id AND st.request_id = r.id AND st.step_index = r.current_step AND st.status = 'pending'
      WHERE s.document_id = $1 AND s.approval_status = 'pending' AND $2 = ANY(st.approver_user_ids)
        AND r.requested_by IS DISTINCT FROM $2
      LIMIT 1`,
    [documentId, userId],
  );
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
          'The approver countersigns a signed document (consent and typed name, like the signer) or returns it to the signer with a reason',
        params: Type.Object({ id: Uuid }),
        body: Type.Union([
          Type.Object(
            {
              decision: Type.Literal('approve'),
              consent: Type.Literal(true),
              typedName: Type.String({ minLength: 2, maxLength: 120 }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            { decision: Type.Literal('return'), reason: Type.String({ minLength: 3, maxLength: 1000 }) },
            { additionalProperties: false },
          ),
        ]),
        response: {
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
        { decision: 'approve'; typedName: string } | { decision: 'return'; reason: string };
      return app.tenantTx(req, async (tx) => {
        const sr = await tx.maybe<{
          document_id: string;
          approval_request_id: string | null;
          approval_status: string | null;
        }>(
          `SELECT document_id, approval_request_id, approval_status FROM app.signature_requests WHERE id = $1`,
          [id],
        );
        if (!sr) throw new ApiError('notFound');
        if (sr.approval_status !== 'pending' || !sr.approval_request_id) throw new ApiError('conflict');
        const mine = await pendingCountersignFor(tx, auth.userId, sr.document_id);
        if (!mine || mine.id !== id) throw new ApiError('forbidden');
        if (b.decision === 'approve')
          await tx.exec(
            `UPDATE app.signature_requests SET countersigner_user_id = $2, countersigner_name = $3, countersigner_ip = $4, countersigner_user_agent = $5, countersigned_at = $6 WHERE id = $1`,
            [
              id,
              auth.userId,
              b.typedName,
              req.ctx.ip,
              req.ctx.userAgent?.slice(0, 512) ?? null,
              app.deps.now().toISOString(),
            ],
          );
        req.auditWritten = true; // decide() and the effects write the audit entries
        const status = await decide(
          tx,
          sr.approval_request_id,
          auth.userId,
          b.decision === 'approve' ? 'approve' : 'reject',
          b.decision === 'return' ? b.reason : undefined,
        );
        const after = await tx.one<{ signed_document_id: string | null }>(
          'SELECT signed_document_id FROM app.signature_requests WHERE id = $1',
          [id],
        );
        return {
          status:
            status === 'approved' ? 'completed' : status === 'rejected' ? 'returned' : 'awaiting_approval',
          signedDocumentId: status === 'approved' ? after.signed_document_id : null,
        };
      });
    },
  );
}
