import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { can, type Principal, type Target } from '@thapsus/core/permissions';
import { instantToDate } from '@thapsus/core/time';
import { t } from '@thapsus/core/i18n';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { contentDisposition } from '../../http/security';
import { sanitiseFileName, sniffType, VIEWABLE_TYPES, type SniffedType } from '../../lib/file-sniff';
import { notify, userForEmployee } from '../../lib/notify';
import { objectKey, type ObjectStore } from '../../lib/object-store';
import { openFile, sealFile, type SealedFileContext } from '../../lib/sealed-file';
import { scanUpload, type ScanVerdict } from '../../lib/upload-scan';
import type { KeyProvider } from '../../lib/kms';
import { loadTarget } from '../employees/service';
import { tenantLocale, vaultActor, withSelfDisclosure } from '../compliance/service';
import { expiryStatus, expiryWindows } from './expiry';
import { Vault, type VaultActor } from '../vault/service';
import { canReadDoc, Doc, mapDoc, type DocRow } from './routes';
import { pendingCountersignFor } from './countersign';

/**
 * Documents HR attaches to a person (ADR-0165) and the in-app document viewer (ADR-0168).
 *
 *  - POST /v1/employees/:id/documents: one file (multipart) with its type, dates, note and visibility. The type is
 *    sniffed from the bytes, never taken from the name or the declared type; the name is sanitised; the scan
 *    hook runs before anything is stored.
 *  - Right-to-work evidence (passport, BRP or eVisa, share-code result, birth certificate…) is immigration and
 *    work-authorisation data, special category under CLAUDE.md (ADR-0166): its file is sealed with the regional
 *    key, its details live in the vault (category immigration), and every view and download is audited there.
 *    Everything else goes to the normal documents store under the person's prefix with the chosen visibility.
 *  - GET /v1/documents/:id and /content: what the viewer shows. The content is streamed by the API (never a
 *    presigned link), so a sealed file is opened server side and every view and download is audited.
 */
export const ATTACHMENT_TYPES = [
  'right_to_work',
  'driving_licence',
  'contract',
  'qualification',
  'background_check',
  'other',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
/** Right-to-work evidence kinds (kept in the vault with the evidence). */
export const RTW_EVIDENCE_TYPES = [
  'passport',
  'brp_evisa',
  'share_code_result',
  'birth_certificate',
  'other',
] as const;
/** The library category each attachment type is filed under (immigration routes to the vault). */
const CATEGORY: Record<AttachmentType, string> = {
  right_to_work: 'immigration',
  driving_licence: 'licence',
  contract: 'contract',
  qualification: 'qualification',
  background_check: 'background_check',
  other: 'general',
};
/** Types accepted per attachment type: right-to-work evidence is a scan or a check result (PDF or image). */
const ACCEPTED: Record<AttachmentType, SniffedType[]> = {
  right_to_work: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  driving_licence: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  contract: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  qualification: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  background_check: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  other: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const VISIBILITIES = ['hr', 'employee'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The vault field that holds an attached document's details (and points at its sealed file). */
export const vaultField = (documentId: string) => `document:${documentId}`;
export const sealedContext = (
  tenantId: string,
  employeeId: string,
  documentId: string,
): SealedFileContext => ({
  tenant: tenantId,
  subject: employeeId,
  category: 'immigration',
  field: vaultField(documentId),
});

interface VaultDetails {
  evidenceType: string;
  fileName: string;
  note: string | null;
  issuedOn: string | null;
  sha256: string;
}

/** Fields of the multipart upload, checked by hand (the body is multipart, so the route has no JSON schema). */
export function parseFields(f: Record<string, string>) {
  const attachmentType = f.attachmentType as AttachmentType;
  if (!ATTACHMENT_TYPES.includes(attachmentType)) throw new ApiError('validation', 'Unknown attachment type');
  const visibility = (f.visibility || 'hr') as (typeof VISIBILITIES)[number];
  if (!VISIBILITIES.includes(visibility))
    throw new ApiError('validation', 'visibility must be hr or employee');
  const evidenceType = attachmentType === 'right_to_work' ? f.evidenceType || 'other' : null;
  if (evidenceType && !(RTW_EVIDENCE_TYPES as readonly string[]).includes(evidenceType))
    throw new ApiError('validation', 'Unknown right-to-work evidence type');
  for (const k of ['issuedOn', 'expiresOn'] as const)
    if (f[k] && !DATE.test(f[k])) throw new ApiError('validation', `${k} must be YYYY-MM-DD`);
  if (f.issuedOn && f.expiresOn && f.expiresOn < f.issuedOn)
    throw new ApiError('validation', 'The expiry date is before the issue date');
  const note = (f.note ?? '').trim();
  if (note.length > 1000) throw new ApiError('validation', 'The note is longer than 1,000 characters');
  const title = (f.title ?? '').trim();
  if (title.length > 200) throw new ApiError('validation', 'The title is longer than 200 characters');
  if (f.rtwCheckId && !/^[0-9a-f-]{36}$/i.test(f.rtwCheckId))
    throw new ApiError('validation', 'Bad rtwCheckId');
  return {
    attachmentType,
    visibility,
    evidenceType,
    issuedOn: f.issuedOn || null,
    expiresOn: f.expiresOn || null,
    note: note || null,
    title: title || null,
    rtwCheckId: attachmentType === 'right_to_work' ? f.rtwCheckId || null : null,
  };
}

const today = (req: FastifyRequest, now: Date) =>
  instantToDate(now.toISOString(), requireAuth(req).user.timeZone ?? 'UTC');

/** May the principal see HR's note and the attachment details (they manage the person's documents)? */
function managesAttachment(p: Principal, doc: DocRow, target: Parameters<typeof can>[2]) {
  return doc.vault_record_id ? can(p, 'vault.read:immigration', target) : can(p, 'documents.manage', target);
}

export type AttachmentFields = ReturnType<typeof parseFields>;

/**
 * Stores one attached document (the route and the staging seed share it). Right-to-work evidence: the bytes are
 * sealed under the regional key and the details go to the vault; the document row keeps a generic title and
 * name, the content type, size and hash, the expiry date (for reminders) and the visibility. Anything else: the
 * bytes go to the person's prefix in the home-region bucket and the row keeps the details.
 */
export async function storeAttachment(
  deps: { objects: ObjectStore; keys: KeyProvider },
  tx: Tx,
  vault: Vault,
  a: {
    actor: VaultActor;
    tenantId: string;
    userId: string | null;
    target: Target & { employeeId: string };
    fields: AttachmentFields;
    file: { bytes: Buffer; type: SniffedType; fileName: string; sha256: string };
    scan: ScanVerdict;
    /** Staging seed only: a fixed id and upload time, so a re-seeded database is the same. */
    id?: string;
    uploadedAt?: string;
  },
): Promise<DocRow> {
  const { fields: f, file, target } = a;
  const employeeId = target.employeeId;
  const sensitive = f.attachmentType === 'right_to_work';
  const locale = await tenantLocale(tx);
  const id = a.id ?? randomUUID();
  const ext = file.fileName.slice(file.fileName.lastIndexOf('.'));
  let key: string;
  let vaultId: string | null = null;
  if (sensitive) {
    key = objectKey(a.tenantId, `vault/immigration/${employeeId}`, '.sealed');
    const sealed = await sealFile(deps.keys, file.bytes, sealedContext(a.tenantId, employeeId, id));
    await deps.objects.put(key, sealed, 'application/octet-stream');
    const details: VaultDetails = {
      evidenceType: f.evidenceType ?? 'other',
      fileName: file.fileName,
      note: f.note,
      issuedOn: f.issuedOn,
      sha256: file.sha256,
    };
    vaultId = await vault.put(
      tx,
      a.actor,
      a.tenantId,
      target,
      'immigration',
      vaultField(id),
      JSON.stringify(details),
      key,
    );
  } else {
    key = objectKey(a.tenantId, `employees/${employeeId}`, ext);
    await deps.objects.put(key, file.bytes, file.type);
  }
  // For vault-backed evidence the row holds a generic title and name only: no type, name, note or issue date.
  const title = sensitive
    ? t(locale, 'docAttach.type.right_to_work')
    : (f.title ?? t(locale, `docAttach.type.${f.attachmentType}`));
  return tx.one<DocRow>(
    `INSERT INTO app.documents (tenant_id, id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status,
                                expires_on, created_by, uploaded_at, created_at, attachment_type, visibility, issued_on, note, vault_record_id, scan_status, rtw_check_id)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'ready', $10, $11, coalesce($19::timestamptz, now()), coalesce($19::timestamptz, now()),
             $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
    [
      id,
      employeeId,
      title,
      CATEGORY[f.attachmentType],
      key,
      sensitive ? `evidence${ext}` : file.fileName,
      file.type,
      file.bytes.length,
      file.sha256,
      f.expiresOn,
      a.userId,
      f.attachmentType,
      f.visibility,
      sensitive ? null : f.issuedOn,
      sensitive ? null : f.note,
      vaultId,
      a.scan,
      f.rtwCheckId,
      a.uploadedAt ?? null,
    ],
  );
}

export async function attachmentRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);
  await app.register(multipart, {
    limits: { fileSize: ATTACH_MAX_BYTES, files: 1, fields: 12, fieldSize: 2000 },
  });

  app.post(
    '/v1/employees/:id/documents',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'Attach a document to a person (multipart: file + attachmentType, visibility, optional evidenceType, title, issuedOn, expiresOn, note, rtwCheckId). Right-to-work evidence is sealed and kept in the vault.',
        consumes: ['multipart/form-data'],
        params: Type.Object({ id: Uuid }),
        response: { 201: Doc, 400: Problem, 403: Problem, 404: Problem, 413: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id: employeeId } = req.params as { id: string };
      const fields: Record<string, string> = {};
      let file: { name: string; bytes: Buffer } | undefined;
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (file) throw new ApiError('validation', 'Attach one file at a time');
            file = { name: part.filename || 'document', bytes: await part.toBuffer() };
          } else fields[part.fieldname] = String(part.value ?? '');
        }
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
          throw new ApiError('validation', 'The file is larger than the limit', {
            maxBytes: ATTACH_MAX_BYTES,
          });
        throw err;
      }
      if (!file || !file.bytes.length) throw new ApiError('validation', 'Choose a file to attach');
      const f = parseFields(fields);
      const type = sniffType(file.bytes);
      if (!type || !ACCEPTED[f.attachmentType].includes(type))
        throw new ApiError('validation', 'This type of file cannot be attached', {
          accepted: ACCEPTED[f.attachmentType],
        });
      const fileName = sanitiseFileName(file.name, type);
      const sha = createHash('sha256').update(file.bytes).digest('hex');
      const sensitive = f.attachmentType === 'right_to_work';

      const out = await app.tenantTx(req, async (tx) => {
        const target = await loadTarget(tx, employeeId);
        if (!can(auth.principal, 'documents.manage', target)) throw new ApiError('forbidden');
        if (sensitive && !can(auth.principal, 'vault.write:immigration', target))
          throw new ApiError('forbidden');
        if (f.rtwCheckId) {
          const check = await tx.maybe('SELECT 1 FROM app.rtw_checks WHERE id = $1 AND employee_id = $2', [
            f.rtwCheckId,
            employeeId,
          ]);
          if (!check) throw new ApiError('validation', 'That right-to-work check is not this person’s');
        }
        // the scan hook runs before anything is stored; an infected file is refused and nothing is kept
        const scan = await scanUpload({ bytes: file.bytes, contentType: type, tenantId: auth.tenantId });
        if (scan === 'infected') {
          await app.audit(tx, req, {
            action: 'document.upload_blocked',
            targetType: 'employee',
            targetId: employeeId,
            diff: { attachmentType: f.attachmentType, reason: 'malware' },
            sensitive,
          });
          return { blocked: true as const };
        }
        const row = await storeAttachment({ objects: deps.objects, keys: deps.keys }, tx, vault, {
          actor: vaultActor(req),
          tenantId: auth.tenantId,
          userId: auth.userId,
          target,
          fields: f,
          file: { bytes: file.bytes, type, fileName, sha256: sha },
          scan,
        });
        const id = row.id;
        const title = row.title;
        await app.audit(tx, req, {
          action: 'document.attached',
          targetType: 'document',
          targetId: id,
          diff: {
            employeeId,
            attachmentType: f.attachmentType,
            visibility: f.visibility,
            expiresOn: f.expiresOn,
            scan,
            vault: sensitive,
          },
          sensitive,
        });
        if (f.visibility === 'employee') {
          const user = await userForEmployee(tx, employeeId);
          if (user && user !== auth.userId)
            await notify(tx, {
              userIds: [user],
              kind: 'document.shared',
              titleKey: 'notify.documentShared',
              params: { title },
              link: `/app/documents/${id}`,
              dedupeKey: `shared:${id}`,
            });
        }
        const w = await expiryWindows(tx);
        return {
          doc: mapDoc(row, {
            showNote: true,
            expiryStatus: expiryStatus(row.expires_on, today(req, deps.now()), sensitive ? w.rtw : w.other),
          }),
        };
      });
      if ('blocked' in out) throw new ApiError('unprocessable', 'The file did not pass the malware scan');
      return reply.status(201).send(out.doc);
    },
  );

  // ---- the viewer ------------------------------------------------------------------------------------------------
  const Signature = Type.Object({
    id: Uuid,
    status: Type.String(),
    requestedAt: Type.String(),
    signedAt: Nullable(Type.String()),
    signedDocumentId: Nullable(Uuid),
    requiresCountersign: Type.Boolean(),
    approvalStatus: Nullable(Type.String()),
    returnedReason: Nullable(Type.String()),
    completedAt: Nullable(Type.String()),
  });
  app.get(
    '/v1/documents/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'One document for the viewer: its details, whether the browser can show it, and the signature request waiting for the caller',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            document: Doc,
            employeeName: Nullable(Type.String()),
            viewable: Type.Boolean(),
            canManage: Type.Boolean(),
            /** Right-to-work evidence details from the vault (decrypt audited); null for other documents. */
            evidence: Nullable(
              Type.Object({
                evidenceType: Type.String(),
                fileName: Type.String(),
                note: Nullable(Type.String()),
                issuedOn: Nullable(Type.String()),
              }),
            ),
            signature: Nullable(Signature),
            /** A countersignature waiting for the caller's decision (ADR-0169). */
            countersign: Nullable(
              Type.Object({
                signatureRequestId: Uuid,
                signerName: Nullable(Type.String()),
                signedAt: Nullable(Type.String()),
                documentSha256: Nullable(Type.String()),
                signedSha256: Nullable(Type.String()),
              }),
            ),
            /** For a signed copy: the request it records. */
            signedCopyOf: Nullable(
              Type.Object({
                documentId: Uuid,
                signerName: Nullable(Type.String()),
                signedAt: Nullable(Type.String()),
              }),
            ),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const doc = await tx.maybe<DocRow & { employee_name: string | null }>(
          `SELECT d.*, e.display_name AS employee_name FROM app.documents d LEFT JOIN app.employees e ON e.tenant_id = d.tenant_id AND e.id = d.employee_id
            WHERE d.id = $1 AND d.status = 'ready'`,
          [id],
        );
        if (!doc) throw new ApiError('notFound');
        // the approver of a pending countersignature may read the document they are asked to sign
        const pending = await pendingCountersignFor(tx, auth.userId, id);
        if (!pending && !(await canReadDoc(tx, auth.principal, doc))) throw new ApiError('forbidden');
        const target = doc.employee_id ? await loadTarget(tx, doc.employee_id) : null;
        const canManage = target
          ? doc.attachment_type
            ? managesAttachment(auth.principal, doc, target)
            : can(auth.principal, 'documents.manage', target)
          : can(auth.principal, 'documents.manage');
        let evidence = null;
        if (doc.vault_record_id && target) {
          const d = await readEvidence(tx, req, vault, auth.tenantId, doc, target);
          evidence = {
            evidenceType: d.evidenceType,
            fileName: d.fileName,
            note: canManage ? d.note : null,
            issuedOn: d.issuedOn,
          };
        }
        const sig = auth.principal.employeeId
          ? await tx.maybe<{
              id: string;
              status: string;
              requested_at: string;
              signed_at: string | null;
              signed_document_id: string | null;
              requires_countersign: boolean;
              approval_status: string | null;
              returned_reason: string | null;
              completed_at: string | null;
            }>(
              `SELECT s.id, s.status, s.requested_at, s.signed_at, s.signed_document_id, s.requires_countersign, s.approval_status,
                      s.returned_reason, s.completed_at
                 FROM app.signature_requests s WHERE s.document_id = $1 AND s.signer_employee_id = $2 AND s.status IN ('pending', 'signed')
                ORDER BY (s.status = 'pending') DESC, s.requested_at DESC LIMIT 1`,
              [id, auth.principal.employeeId],
            )
          : null;
        const copy =
          doc.category === 'signed'
            ? await tx.maybe<{ document_id: string; signer_name: string | null; signed_at: string | null }>(
                `SELECT document_id, signer_name, signed_at FROM app.signature_requests WHERE signed_file_key = $1 LIMIT 1`,
                [doc.file_key],
              )
            : null;
        if (evidence) req.auditWritten = true; // the vault read wrote the sensitive audit entry
        const w = doc.expires_on ? await expiryWindows(tx) : { rtw: 0, other: 0 };
        return {
          document: mapDoc(doc, {
            showNote: canManage,
            expiryStatus: expiryStatus(
              doc.expires_on,
              today(req, deps.now()),
              doc.vault_record_id ? w.rtw : w.other,
            ),
          }),
          employeeName: doc.employee_name,
          viewable: VIEWABLE_TYPES.has(doc.content_type),
          canManage,
          evidence,
          signature: sig
            ? {
                id: sig.id,
                status: sig.status,
                requestedAt: sig.requested_at,
                signedAt: sig.signed_at,
                signedDocumentId: sig.signed_document_id,
                requiresCountersign: sig.requires_countersign,
                approvalStatus: sig.approval_status,
                returnedReason: sig.returned_reason,
                completedAt: sig.completed_at,
              }
            : null,
          countersign: pending
            ? {
                signatureRequestId: pending.id,
                signerName: pending.signer_name,
                signedAt: pending.signed_at,
                documentSha256: pending.document_sha256,
                signedSha256: pending.signed_sha256,
              }
            : null,
          signedCopyOf: copy
            ? { documentId: copy.document_id, signerName: copy.signer_name, signedAt: copy.signed_at }
            : null,
        };
      });
    },
  );

  app.get(
    '/v1/documents/:id/content',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'The file itself, for the viewer (inline) or as a download (download=true). Every view and download is audited; right-to-work evidence is opened from its sealed copy and audited in the vault.',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ download: Type.Optional(Type.Boolean()) }),
        response: { 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const download = !!(req.query as { download?: boolean }).download;
      const out = await app.tenantTx(req, async (tx) => {
        const doc = await tx.maybe<DocRow>(`SELECT * FROM app.documents WHERE id = $1 AND status = 'ready'`, [
          id,
        ]);
        if (!doc) throw new ApiError('notFound');
        if (
          !(await canReadDoc(tx, auth.principal, doc)) &&
          !(await pendingCountersignFor(tx, auth.userId, id))
        )
          throw new ApiError('forbidden');
        const stored = await deps.objects.get(doc.file_key).catch(() => undefined);
        if (!stored) throw new ApiError('notFound');
        let body = stored;
        let name = doc.file_name;
        if (doc.vault_record_id && doc.employee_id) {
          const target = await loadTarget(tx, doc.employee_id);
          const d = await readEvidence(tx, req, vault, auth.tenantId, doc, target);
          body = await openFile(deps.keys, stored, sealedContext(auth.tenantId, doc.employee_id, doc.id));
          if (createHash('sha256').update(body).digest('hex') !== d.sha256)
            throw new ApiError('internal', 'Integrity check failed');
          name = d.fileName;
        }
        await app.audit(tx, req, {
          action: download ? 'document.downloaded' : 'document.viewed',
          targetType: 'document',
          targetId: id,
          diff: { own: !!doc.employee_id && doc.employee_id === auth.principal.employeeId },
          sensitive: !!doc.vault_record_id || ['payslip', 'immigration', 'health'].includes(doc.category),
        });
        return { body, name, type: doc.content_type };
      });
      return reply
        .header('content-type', out.type)
        .header('content-disposition', contentDisposition(out.name, download ? 'attachment' : 'inline'))
        .header('x-content-type-options', 'nosniff')
        .send(out.body);
    },
  );
}

/**
 * The vault details of a right-to-work evidence document, decrypted with an audited vault read. The person the
 * evidence is about reads it through a self-disclosure grant when HR shared it with them; anyone else needs the
 * immigration vault permission for that person (a refusal is audited by the vault too).
 */
async function readEvidence(
  tx: Tx,
  req: FastifyRequest,
  vault: Vault,
  tenantId: string,
  doc: DocRow,
  target: Awaited<ReturnType<typeof loadTarget>>,
): Promise<VaultDetails> {
  const auth = requireAuth(req);
  const own =
    doc.visibility === 'employee' &&
    auth.principal.employeeId === doc.employee_id &&
    can(auth.principal, 'documents.read_own', { employeeId: doc.employee_id });
  const principal = own ? withSelfDisclosure(auth.principal, ['vault.read:immigration']) : auth.principal;
  const [d] = await vault.read(tx, vaultActor(req, principal), tenantId, target, 'immigration', [
    vaultField(doc.id),
  ]);
  if (!d) throw new ApiError('notFound');
  return JSON.parse(d.value) as VaultDetails;
}
