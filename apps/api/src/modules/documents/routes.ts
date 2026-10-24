import type { FastifyInstance } from 'fastify';
import { matchesMagic } from '../../lib/file-types';
import { Type } from 'typebox';
import { can, canSome, type Target } from '@thapsus/core/permissions';
import { formatDate, formatMoney, isLocale, t, type Locale } from '@thapsus/core/i18n';
import { money } from '@thapsus/core';
import { instantToDate } from '@thapsus/core/time';
import { targetHref } from '@thapsus/core/links';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { createTask, notify, userForEmployee } from '../../lib/notify';
import { loadTarget, scopePredicate } from '../employees/service';
import { appendCertificate, mergeFields, renderTextPdf, sha256 } from './pdf';
import { certificateLabels, requestCountersign } from './countersign';
import { registerJob, periodic } from '../../jobs/registry';
import { complianceSettings } from '../compliance/service';
import { expiryStatus, expiryWindows } from './expiry';
import type { Deps } from '../../deps';

export const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};
export const MAX_BYTES = 25 * 1024 * 1024;
/** File-name extensions accepted for each type (ASVS V5.2.2: the name must match the declared and sniffed type). */
export const EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};
export const extensionMatches = (contentType: string, fileName: string) =>
  (EXTENSIONS[contentType] ?? []).some((ext) => fileName.toLowerCase().endsWith(ext));

export const Doc = Type.Object({
  id: Uuid,
  title: Type.String(),
  category: Type.String(),
  employeeId: Nullable(Type.String()),
  folderId: Nullable(Type.String()),
  fileName: Type.String(),
  contentType: Type.String(),
  sizeBytes: Nullable(Type.String()),
  sha256: Nullable(Type.String()),
  status: Type.String(),
  expiresOn: Nullable(Type.String()),
  createdAt: Type.String(),
  /** Set on documents HR attached to a person (ADR-0165); null for library, template and signed documents. */
  attachmentType: Type.Optional(Nullable(Type.String())),
  /** Who may read an attached document: `hr`, or `employee` (HR and the person). */
  visibility: Type.Optional(Nullable(Type.String())),
  issuedOn: Type.Optional(Nullable(Type.String())),
  /** HR's note; only returned to people who manage the person's documents. */
  note: Type.Optional(Nullable(Type.String())),
  /** Right-to-work evidence kept in the vault (sealed file, every view audited, ADR-0166). */
  sensitive: Type.Optional(Type.Boolean()),
  scanStatus: Type.Optional(Type.String()),
  /** `expired`, or `expiring` within the reminder window from the settings; null otherwise. */
  expiryStatus: Type.Optional(Nullable(Type.String())),
});
export type DocRow = {
  employee_name?: string | null;
  id: string;
  title: string;
  category: string;
  employee_id: string | null;
  folder_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: string | null;
  sha256: string | null;
  status: string;
  expires_on: string | null;
  created_at: string;
  file_key: string;
  attachment_type?: string | null;
  visibility?: string | null;
  issued_on?: string | null;
  note?: string | null;
  vault_record_id?: string | null;
  scan_status?: string;
  rtw_check_id?: string | null;
};
export const mapDoc = (r: DocRow, o: { showNote?: boolean; expiryStatus?: string | null } = {}) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  employeeId: r.employee_id,
  folderId: r.folder_id,
  fileName: r.file_name,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  status: r.status,
  expiresOn: r.expires_on,
  createdAt: r.created_at,
  attachmentType: r.attachment_type ?? null,
  visibility: r.visibility ?? null,
  issuedOn: r.issued_on ?? null,
  note: o.showNote ? (r.note ?? null) : null,
  sensitive: !!r.vault_record_id,
  scanStatus: r.scan_status ?? 'not_scanned',
  expiryStatus: o.expiryStatus ?? null,
});

type Principal = Parameters<typeof can>[0];

/**
 * Folder permissions. For a document about a person:
 *  - no folder / `employee`: the person (documents.read_own) and whoever may read their documents (managers, HR);
 *  - `managers`: whoever may read the person's documents, but not the person (e.g. manager notes);
 *  - `hr`: only HR who manage the person's documents;
 *  - `everyone`: every signed-in user.
 * For a company document: no folder / `hr` → HR; `managers` → managers and HR; `employee` / `everyone` → everyone.
 */
export async function canReadDoc(tx: Tx, principal: Principal, doc: DocRow) {
  if (doc.attachment_type && doc.employee_id)
    return canReadAttachment(principal, doc, await loadTarget(tx, doc.employee_id));
  const visibility = doc.folder_id
    ? ((
        await tx.maybe<{ visibility: string }>('SELECT visibility FROM app.document_folders WHERE id = $1', [
          doc.folder_id,
        ])
      )?.visibility ?? 'hr')
    : null;
  if (visibility === 'everyone') return true;
  if (doc.employee_id) {
    const target = await loadTarget(tx, doc.employee_id);
    const own =
      principal.employeeId === doc.employee_id &&
      can(principal, 'documents.read_own', { employeeId: doc.employee_id });
    if (visibility === 'hr') return can(principal, 'documents.manage', target);
    if (visibility === 'managers') return can(principal, 'documents.read', target);
    return own || can(principal, 'documents.read', target);
  }
  if (visibility === 'employee') return true;
  if (visibility === 'managers')
    return canSome(principal, 'documents.read') || canSome(principal, 'documents.manage');
  return canSome(principal, 'documents.manage');
}

/**
 * Documents HR attached to a person (ADR-0165) follow their own visibility, never folders, and managers never
 * see them: `hr` is for HR who manage the person's documents; `employee` adds the person. Right-to-work evidence
 * kept in the vault (ADR-0166) needs the immigration vault permission instead of documents.manage.
 */
export function canReadAttachment(
  principal: Principal,
  doc: DocRow,
  target: Target & { employeeId: string },
) {
  const own =
    doc.visibility === 'employee' &&
    principal.employeeId === doc.employee_id &&
    can(principal, 'documents.read_own', { employeeId: doc.employee_id });
  if (own) return true;
  return doc.vault_record_id
    ? can(principal, 'vault.read:immigration', target)
    : can(principal, 'documents.manage', target);
}

/** The same rules as canReadDoc, as SQL over documents `d`, folders `f` and the person `e`. */
function docVisibilitySql(principal: Principal, params: unknown[]): string {
  const read = scopePredicate(principal, 'documents.read', params);
  const manage = scopePredicate(principal, 'documents.manage', params);
  const vaultRead = scopePredicate(principal, 'vault.read:immigration', params);
  let own = 'false';
  if (principal.employeeId && can(principal, 'documents.read_own', { employeeId: principal.employeeId })) {
    params.push(principal.employeeId);
    own = `d.employee_id = $${params.length}::uuid`;
  }
  const companyManagers = canSome(principal, 'documents.read') || canSome(principal, 'documents.manage');
  return `(CASE WHEN d.attachment_type IS NOT NULL THEN (
         (d.visibility = 'employee' AND ${own})
      OR (d.vault_record_id IS NOT NULL AND ${vaultRead})
      OR (d.vault_record_id IS NULL AND ${manage}))
    ELSE (f.visibility = 'everyone'
    OR (d.employee_id IS NOT NULL AND (
         (f.visibility = 'hr' AND ${manage})
      OR (f.visibility = 'managers' AND ${read})
      OR (coalesce(f.visibility, 'employee') = 'employee' AND (${own} OR ${read}))))
    OR (d.employee_id IS NULL AND (
         (coalesce(f.visibility, 'hr') = 'hr' AND ${canSome(principal, 'documents.manage')})
      OR (f.visibility = 'managers' AND ${companyManagers})
      OR f.visibility = 'employee'))) END)`;
}

/** Documents the principal may see (folder permissions applied), optionally for one person or folder. */
export async function listDocuments(
  tx: Tx,
  principal: Principal,
  q: { employeeId?: string; folderId?: string },
  limit = 500,
): Promise<DocRow[]> {
  if (q.employeeId) {
    // asking for someone's documents at all needs access to them (403 rather than an empty list)
    const own = principal.employeeId === q.employeeId;
    const ok = own
      ? can(principal, 'documents.read_own', { employeeId: q.employeeId })
      : can(principal, 'documents.read', await loadTarget(tx, q.employeeId));
    if (!ok) throw new ApiError('forbidden');
  }
  const params: unknown[] = [];
  const visible = docVisibilitySql(principal, params);
  params.push(q.folderId ?? null);
  const folder = `$${params.length}::uuid`;
  params.push(q.employeeId ?? null);
  const employee = `$${params.length}::uuid`;
  return tx.query<DocRow>(
    `SELECT d.*, e.display_name AS employee_name FROM app.documents d LEFT JOIN app.employees e ON e.tenant_id = d.tenant_id AND e.id = d.employee_id
       LEFT JOIN app.document_folders f ON f.tenant_id = d.tenant_id AND f.id = d.folder_id
      WHERE d.status = 'ready' AND (${folder} IS NULL OR d.folder_id = ${folder}) AND (${employee} IS NULL OR d.employee_id = ${employee})
        AND ${visible}
      ORDER BY d.created_at DESC LIMIT ${Math.trunc(limit)}`,
    params,
  );
}

export async function mergeValuesFor(
  tx: Tx,
  employeeId: string,
  locale: Locale,
): Promise<Record<string, string>> {
  const e = await tx.one<Record<string, string | null>>(
    `SELECT e.display_name, e.employee_number, e.job_title, e.start_date, e.work_email, p.legal_first_name, p.legal_last_name,
            d.name AS department, l.name AS location, le.name AS entity, pay.amount_minor, pay.currency, pay.frequency, t.name AS company
       FROM app.employees e
       JOIN app.tenants t ON t.tenant_id = e.tenant_id
       LEFT JOIN app.employee_personal p ON p.tenant_id = e.tenant_id AND p.employee_id = e.id AND p.valid_from <= current_date AND (p.valid_to IS NULL OR p.valid_to > current_date)
       LEFT JOIN app.employee_pay pay ON pay.tenant_id = e.tenant_id AND pay.employee_id = e.id AND pay.valid_from <= current_date AND (pay.valid_to IS NULL OR pay.valid_to > current_date)
       LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = e.location_id
       LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.entity_id
      WHERE e.id = $1`,
    [employeeId],
  );
  return {
    'employee.displayName': e.display_name ?? '',
    'employee.firstName': e.legal_first_name ?? '',
    'employee.lastName': e.legal_last_name ?? '',
    'employee.employeeNumber': e.employee_number ?? '',
    'employee.jobTitle': e.job_title ?? '',
    'employee.department': e.department ?? '',
    'employee.location': e.location ?? '',
    'employee.workEmail': e.work_email ?? '',
    'employee.startDate': e.start_date ? formatDate(e.start_date, locale, 'long') : '',
    'employee.salary':
      e.amount_minor && e.currency ? formatMoney(money(BigInt(e.amount_minor), e.currency), locale) : '',
    'employee.payFrequency': e.frequency ?? '',
    'entity.name': e.entity ?? '',
    'company.name': e.company ?? '',
    today: formatDate(new Date().toISOString().slice(0, 10), locale, 'long'),
  };
}

/** Generates a document for one employee from a template (idempotent per template+employee+key). */
export async function generateFromTemplate(
  deps: Deps,
  tx: Tx,
  templateId: string,
  employeeId: string,
  actor: string | null,
  opts: { requireSignature?: boolean; requireCountersign?: boolean; title?: string } = {},
) {
  const tpl = await tx.maybe<{
    name: string;
    body: string;
    locale: string;
    category: string;
    requires_countersign: boolean;
  }>('SELECT name, body, locale, category, requires_countersign FROM app.document_templates WHERE id = $1', [
    templateId,
  ]);
  if (!tpl) throw new ApiError('notFound');
  const locale: Locale = isLocale(tpl.locale) ? tpl.locale : 'en-GB';
  const { text, missing } = mergeFields(tpl.body, await mergeValuesFor(tx, employeeId, locale));
  if (missing.length) throw new ApiError('validation', `Unknown merge fields: ${missing.join(', ')}`);
  const tenant = (await tx.one<{ t: string }>('SELECT app.current_tenant()::text AS t')).t;
  const pdf = await renderTextPdf(opts.title ?? tpl.name, text);
  const key = objectKey(tenant, 'documents', '.pdf');
  await deps.objects.put(key, Buffer.from(pdf), 'application/pdf');
  const doc = await tx.one<{ id: string }>(
    `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, template_id, created_by, uploaded_at)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, 'application/pdf', $6, $7, 'ready', $8, $9, now()) RETURNING id`,
    [
      employeeId,
      opts.title ?? tpl.name,
      tpl.category,
      key,
      `${(opts.title ?? tpl.name).replace(/[^\w.-]+/g, '_')}.pdf`,
      pdf.length,
      sha256(pdf),
      templateId,
      actor,
    ],
  );
  if (opts.requireSignature)
    await requestSignature(
      tx,
      doc.id,
      employeeId,
      actor,
      opts.requireCountersign ?? tpl.requires_countersign,
    );
  return doc.id;
}

/** Documents in these categories need a company signature unless the template says otherwise (ADR-0169). */
export const COUNTERSIGNED_BY_DEFAULT = ['contract', 'offer', 'policy'];

async function requestSignature(
  tx: Tx,
  documentId: string,
  employeeId: string,
  actor: string | null,
  requiresCountersign = false,
) {
  const sr = await tx.one<{ id: string }>(
    `INSERT INTO app.signature_requests (tenant_id, document_id, signer_employee_id, requested_by, requires_countersign) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
    [documentId, employeeId, actor, requiresCountersign],
  );
  const user = await userForEmployee(tx, employeeId);
  if (user) {
    await notify(tx, {
      userIds: [user],
      kind: 'document.signature_requested',
      titleKey: 'notify.signatureRequested',
      // the document's own page, opened at its signature request (ADR-0160)
      target: { type: 'document', id: documentId },
      link: `${targetHref({ type: 'document', id: documentId })}?sign=${sr.id}`,
      dedupeKey: `sign:${sr.id}`,
    });
    await createTask(tx, {
      source: 'document',
      sourceId: sr.id,
      title: 'Sign document',
      subjectEmployeeId: employeeId,
      assigneeUserId: user,
      link: `${targetHref({ type: 'document', id: documentId })}?sign=${sr.id}`,
      dedupeKey: `sign:${sr.id}`,
    });
  }
  return sr.id;
}

export async function documentRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.get(
    '/v1/documents',
    {
      schema: {
        tags: ['documents'],
        querystring: Type.Object({ employeeId: Type.Optional(Uuid), folderId: Type.Optional(Uuid) }),
        response: { 200: Type.Array(Doc), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { employeeId?: string; folderId?: string };
      return app.tenantTx(
        req,
        async (tx) => {
          const rows = await listDocuments(tx, auth.principal, q);
          const w = rows.some((r) => r.expires_on) ? await expiryWindows(tx) : { rtw: 0, other: 0 };
          const day = instantToDate(deps.now().toISOString(), auth.user.timeZone ?? 'UTC');
          return rows.map((r) =>
            mapDoc(r, {
              // HR's note on an attachment is for HR: the person it is about sees the document, not the note
              showNote:
                r.employee_id !== auth.principal.employeeId ||
                can(auth.principal, 'documents.manage', { employeeId: r.employee_id }),
              expiryStatus: expiryStatus(r.expires_on, day, r.vault_record_id ? w.rtw : w.other),
            }),
          );
        },
        { readOnly: true },
      );
    },
  );

  // ---- upload: create → presigned PUT → complete (validated) ------------------------------------
  app.post(
    '/v1/documents',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        body: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 200 }),
          fileName: Type.String({ minLength: 1, maxLength: 200 }),
          contentType: Type.String(),
          sizeBytes: Type.Integer({ minimum: 1 }),
          employeeId: Type.Optional(Uuid),
          folderId: Type.Optional(Uuid),
          category: Type.Optional(Type.String({ maxLength: 40 })),
          expiresOn: Type.Optional(CivilDate),
        }),
        response: {
          201: Type.Object({ id: Uuid, uploadUrl: Type.String(), maxBytes: Type.Integer() }),
          400: Problem,
          403: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        title: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        employeeId?: string;
        folderId?: string;
        category?: string;
        expiresOn?: string;
      };
      if (!(b.contentType in ALLOWED_TYPES)) throw new ApiError('validation', 'File type not allowed');
      if (!extensionMatches(b.contentType, b.fileName))
        throw new ApiError('validation', 'The file name does not match the file type');
      if (b.sizeBytes > MAX_BYTES) throw new ApiError('validation', 'File too large');
      const row = await app.tenantTx(req, async (tx) => {
        if (b.employeeId) {
          const own = auth.principal.employeeId === b.employeeId;
          if (
            !(own
              ? can(auth.principal, 'documents.upload_own', { employeeId: b.employeeId }) ||
                can(auth.principal, 'self.read', { employeeId: b.employeeId })
              : can(auth.principal, 'documents.manage', await loadTarget(tx, b.employeeId)))
          )
            throw new ApiError('forbidden');
        } else if (!canSome(auth.principal, 'documents.manage')) throw new ApiError('forbidden');
        if (b.folderId) {
          const folder = await tx.maybe<{ visibility: string }>(
            'SELECT visibility FROM app.document_folders WHERE id = $1',
            [b.folderId],
          );
          if (!folder) throw new ApiError('validation', 'Unknown folder');
          // without HR rights a person may only file their own document where they can still see it
          const hr = b.employeeId
            ? can(auth.principal, 'documents.manage', await loadTarget(tx, b.employeeId))
            : true;
          if (!hr && folder.visibility !== 'employee' && folder.visibility !== 'everyone')
            throw new ApiError('forbidden');
        }
        const tenant = auth.tenantId;
        const key = objectKey(
          tenant,
          b.employeeId ? `employees/${b.employeeId}` : 'company',
          ALLOWED_TYPES[b.contentType],
        );
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.documents (tenant_id, folder_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, expires_on, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            b.folderId ?? null,
            b.employeeId ?? null,
            b.title,
            b.category ?? 'general',
            key,
            b.fileName,
            b.contentType,
            b.sizeBytes,
            b.expiresOn ?? null,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'document.upload_started',
          targetType: 'document',
          targetId: r.id,
          diff: { title: b.title, employeeId: b.employeeId },
        });
        return { id: r.id, key };
      });
      return reply.status(201).send({
        id: row.id,
        uploadUrl: await deps.objects.presignPut(row.key, b.contentType, MAX_BYTES),
        maxBytes: MAX_BYTES,
      });
    },
  );

  app.post(
    '/v1/documents/:id/complete',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        params: Type.Object({ id: Uuid }),
        response: { 200: Doc, 404: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const doc = await tx.maybe<DocRow>(`SELECT * FROM app.documents WHERE id = $1 AND created_by = $2`, [
          id,
          auth.userId,
        ]);
        if (!doc) throw new ApiError('notFound');
        const bytes = await deps.objects.get(doc.file_key).catch(() => undefined);
        const bad = !bytes || bytes.length > MAX_BYTES || !matchesMagic(doc.content_type, bytes);
        if (bad) {
          await tx.exec(`UPDATE app.documents SET status = 'rejected' WHERE id = $1`, [id]);
          if (bytes) await deps.objects.delete(doc.file_key);
          throw new ApiError('unprocessable', 'Upload missing, too large or not the declared type');
        }
        const r = await tx.one<DocRow>(
          `UPDATE app.documents SET status = 'ready', size_bytes = $2, sha256 = $3, uploaded_at = now() WHERE id = $1 RETURNING *`,
          [id, bytes!.length, sha256(bytes!)],
        );
        await app.audit(tx, req, {
          action: 'document.uploaded',
          targetType: 'document',
          targetId: id,
          diff: { sha256: r.sha256, size: bytes!.length },
        });
        return mapDoc(r);
      });
    },
  );

  app.get(
    '/v1/documents/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ url: Type.String() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const key = await app.tenantTx(req, async (tx) => {
        const doc = await tx.maybe<DocRow>(`SELECT * FROM app.documents WHERE id = $1 AND status = 'ready'`, [
          id,
        ]);
        if (!doc) throw new ApiError('notFound');
        if (!(await canReadDoc(tx, auth.principal, doc))) throw new ApiError('forbidden');
        // A vault-backed file is sealed at rest: it is opened and audited by the content route instead.
        if (doc.vault_record_id) return { key: null, name: doc.file_name };
        await app.audit(tx, req, {
          action: 'document.downloaded',
          targetType: 'document',
          targetId: id,
          sensitive: ['payslip', 'immigration', 'health'].includes(doc.category),
        });
        return { key: doc.file_key, name: doc.file_name };
      });
      return {
        url: key.key
          ? await deps.objects.presignGet(key.key, key.name)
          : `/v1/documents/${id}/content?download=true`,
      };
    },
  );

  // ---- templates and generation -----------------------------------------------------------------
  app.post(
    '/v1/document-templates',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 50_000 }),
          locale: Type.Optional(Type.String()),
          category: Type.Optional(Type.String({ maxLength: 40 })),
          /** Signed documents from this template need a countersignature (default: contracts, offers and policies). */
          requiresCountersign: Type.Optional(Type.Boolean()),
        }),
        response: { 201: Type.Object({ id: Uuid, mergeFields: Type.Array(Type.String()) }), 403: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'documents.manage');
      const b = req.body as {
        name: string;
        body: string;
        locale?: string;
        category?: string;
        requiresCountersign?: boolean;
      };
      const category = b.category ?? 'letter';
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.document_templates (tenant_id, name, body, locale, category, requires_countersign) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [
            b.name,
            b.body,
            isLocale(b.locale) ? b.locale : 'en-GB',
            category,
            b.requiresCountersign ?? COUNTERSIGNED_BY_DEFAULT.includes(category),
          ],
        );
        await app.audit(tx, req, {
          action: 'document_template.created',
          targetType: 'document_template',
          targetId: r.id,
        });
        return r;
      });
      return reply.status(201).send({
        id: row.id,
        mergeFields: [...b.body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]!),
      });
    },
  );
  app.get(
    '/v1/document-templates',
    {
      schema: {
        tags: ['documents'],
        response: {
          200: Type.Array(
            Type.Object({
              id: Uuid,
              name: Type.String(),
              locale: Type.String(),
              category: Type.String(),
              requiresCountersign: Type.Boolean(),
            }),
          ),
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'documents.manage');
      return app.tenantTx(
        req,
        (tx) =>
          tx.query(
            'SELECT id, name, locale, category, requires_countersign AS "requiresCountersign" FROM app.document_templates ORDER BY name',
          ),
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/document-templates/:id/generate',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          employeeId: Uuid,
          requireSignature: Type.Optional(Type.Boolean()),
          /** Overrides the template's countersignature setting for this document. */
          requireCountersign: Type.Optional(Type.Boolean()),
          title: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: { 201: Type.Object({ documentId: Uuid }), 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as {
        employeeId: string;
        requireSignature?: boolean;
        requireCountersign?: boolean;
        title?: string;
      };
      const documentId = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'documents.manage', await loadTarget(tx, b.employeeId)))
          throw new ApiError('forbidden');
        const docId = await generateFromTemplate(deps, tx, id, b.employeeId, auth.userId, b);
        await app.audit(tx, req, {
          action: 'document.generated',
          targetType: 'document',
          targetId: docId,
          diff: {
            templateId: id,
            employeeId: b.employeeId,
            requireSignature: !!b.requireSignature,
            requireCountersign: b.requireCountersign ?? null,
          },
        });
        return docId;
      });
      return reply.status(201).send({ documentId });
    },
  );

  // ---- bulk send (background job with progress) -------------------------------------------------------
  app.post(
    '/v1/documents/bulk-send',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        body: Type.Object({
          templateId: Uuid,
          requireSignature: Type.Optional(Type.Boolean()),
          filter: Type.Object({
            entityId: Type.Optional(Uuid),
            departmentId: Type.Optional(Uuid),
            locationId: Type.Optional(Uuid),
            employeeIds: Type.Optional(Type.Array(Uuid, { maxItems: 200_000 })),
          }),
          idempotencyKey: Type.Optional(Type.String({ maxLength: 100 })),
        }),
        response: { 202: Type.Object({ jobId: Uuid, recipients: Type.Integer() }), 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'documents.manage');
      const b = req.body as {
        templateId: string;
        requireSignature?: boolean;
        filter: { entityId?: string; departmentId?: string; locationId?: string; employeeIds?: string[] };
        idempotencyKey?: string;
      };
      const out = await app.tenantTx(req, async (tx) => {
        if (!(await tx.maybe('SELECT 1 FROM app.document_templates WHERE id = $1', [b.templateId])))
          throw new ApiError('notFound');
        const params: unknown[] = [];
        const where = [scopePredicate(auth.principal, 'documents.manage', params), `e.status <> 'leaver'`];
        const add = (v: unknown) => (params.push(v), `$${params.length}`);
        if (b.filter.entityId) where.push(`e.entity_id = ${add(b.filter.entityId)}`);
        if (b.filter.departmentId) where.push(`e.department_id = ${add(b.filter.departmentId)}`);
        if (b.filter.locationId) where.push(`e.location_id = ${add(b.filter.locationId)}`);
        if (b.filter.employeeIds) where.push(`e.id = ANY(${add(b.filter.employeeIds)}::uuid[])`);
        const ids = (
          await tx.query<{ id: string }>(
            `SELECT e.id FROM app.employees e WHERE ${where.join(' AND ')} ORDER BY e.id`,
            params,
          )
        ).map((r) => r.id);
        const job = await enqueueJob(
          tx,
          'documents.bulk_send',
          b.idempotencyKey ?? `${b.templateId}:${req.id}`,
          { templateId: b.templateId, employeeIds: ids, requireSignature: !!b.requireSignature },
          { createdBy: auth.userId, total: ids.length },
        );
        await app.audit(tx, req, {
          action: 'document.bulk_send_started',
          targetType: 'job',
          targetId: job.id,
          diff: { recipients: ids.length, templateId: b.templateId },
        });
        return { jobId: job.id, recipients: ids.length };
      });
      return reply.status(202).send(out);
    },
  );

  app.get(
    '/v1/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            id: Uuid,
            kind: Type.String(),
            status: Type.String(),
            progressDone: Type.String(),
            progressTotal: Nullable(Type.String()),
            result: Type.Any(),
            error: Nullable(Type.String()),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const row = await app.tenantTx(
        req,
        (tx) =>
          tx.maybe<Record<string, string | null>>(
            `SELECT id, kind, status, progress_done, progress_total, result, error, created_by FROM app.jobs WHERE id = $1`,
            [id],
          ),
        { readOnly: true },
      );
      if (
        !row ||
        (row.created_by !== auth.userId &&
          !canSome(auth.principal, 'reports.run') &&
          !canSome(auth.principal, 'documents.manage'))
      )
        throw new ApiError('notFound');
      return {
        id: row.id!,
        kind: row.kind!,
        status: row.status!,
        progressDone: row.progress_done!,
        progressTotal: row.progress_total,
        result: row.result,
        error: row.error,
      };
    },
  );

  // ---- click-to-sign (and the countersignature that may follow, ADR-0169) --------------------------------------
  const SigReq = Type.Object({
    id: Uuid,
    documentId: Uuid,
    title: Type.String(),
    /** pending (to sign) or signed. */
    status: Type.String(),
    requestedAt: Type.String(),
    signedAt: Nullable(Type.String()),
    requiresCountersign: Type.Boolean(),
    /** pending: signed, waiting for the approver; approved; returned (to sign again, see returnedReason). */
    approvalStatus: Nullable(Type.String()),
    returnedReason: Nullable(Type.String()),
    completedAt: Nullable(Type.String()),
    signedDocumentId: Nullable(Uuid),
  });
  type SigRow = {
    id: string;
    document_id: string;
    title: string;
    status: string;
    requested_at: string;
    signed_at: string | null;
    requires_countersign: boolean;
    approval_status: string | null;
    returned_reason: string | null;
    completed_at: string | null;
    signed_document_id: string | null;
  };
  const mapSig = (r: SigRow) => ({
    id: r.id,
    documentId: r.document_id,
    title: r.title,
    status: r.status,
    requestedAt: r.requested_at,
    signedAt: r.signed_at,
    requiresCountersign: r.requires_countersign,
    approvalStatus: r.approval_status,
    returnedReason: r.returned_reason,
    completedAt: r.completed_at,
    signedDocumentId: r.signed_document_id,
  });
  app.get(
    '/v1/signature-requests',
    { schema: { tags: ['documents'], response: { 200: Type.Array(SigReq) } } },
    async (req) => {
      const auth = requireAuth(req);
      if (!auth.principal.employeeId) return [];
      return app.tenantTx(
        req,
        async (tx) =>
          (
            await tx.query<SigRow>(
              `SELECT s.id, s.document_id, d.title, s.status, s.requested_at, s.signed_at, s.requires_countersign, s.approval_status,
                      s.returned_reason, s.completed_at, s.signed_document_id
                 FROM app.signature_requests s JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
                WHERE s.signer_employee_id = $1 AND s.status IN ('pending', 'signed') ORDER BY s.requested_at DESC`,
              [auth.principal.employeeId],
            )
          ).map(mapSig),
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/signature-requests/:id/sign',
    {
      config: { selfAudited: true, capability: 'documents.signOwn' },
      schema: {
        tags: ['documents'],
        summary:
          'Sign a document (consent and typed name). It is complete straight away, or goes to the approver when it needs a countersignature.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          consent: Type.Literal(true),
          typedName: Type.String({ minLength: 2, maxLength: 120 }),
        }),
        response: {
          200: Type.Object({
            /** completed, or awaiting_approval (countersignature needed). */
            status: Type.String(),
            /** The signed copy, once the document is complete. */
            signedDocumentId: Nullable(Uuid),
            documentSha256: Type.String(),
            signedSha256: Type.String(),
          }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as { typedName: string };
      return app.tenantTx(req, async (tx) => {
        const sr = await tx.maybe<{
          id: string;
          status: string;
          signer_employee_id: string;
          document_id: string;
          file_key: string;
          title: string;
          employee_id: string;
          requires_countersign: boolean;
        }>(
          `SELECT s.id, s.status, s.signer_employee_id, s.document_id, d.file_key, d.title, d.employee_id, s.requires_countersign FROM app.signature_requests s
             JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id WHERE s.id = $1 FOR UPDATE OF s`,
          [id],
        );
        if (!sr) throw new ApiError('notFound');
        if (
          sr.signer_employee_id !== auth.principal.employeeId ||
          !can(auth.principal, 'documents.signOwn', { employeeId: sr.signer_employee_id })
        )
          throw new ApiError('forbidden');
        if (sr.status !== 'pending') throw new ApiError('conflict');
        const original = await deps.objects.get(sr.file_key);
        const documentSha256 = sha256(original);
        const signedAt = deps.now().toISOString();
        const locale: Locale = isLocale(auth.user.locale) ? auth.user.locale : req.ctx.locale;
        const signed = await appendCertificate(original, {
          signerName: b.typedName,
          signerEmail: auth.user.email,
          signedAtUtc: signedAt,
          ip: req.ctx.ip,
          userAgent: req.ctx.userAgent ?? '',
          documentSha256,
          requestId: sr.id,
          labels: certificateLabels(locale, 'certificate'),
        });
        const signedKey = objectKey(auth.tenantId, `employees/${sr.employee_id}`, '.pdf');
        await deps.objects.put(signedKey, Buffer.from(signed), 'application/pdf');
        const signedSha256 = sha256(signed);
        // Without a countersignature the signed copy is the completed document; with one, it waits for the approver.
        const signedDoc = sr.requires_countersign
          ? null
          : await tx.one<{ id: string }>(
              `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, created_by, uploaded_at)
               VALUES (app.current_tenant(), $1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, 'ready', $7, now()) RETURNING id`,
              [
                sr.employee_id,
                t(locale, 'docSign.signedTitle', { title: sr.title }),
                signedKey,
                `${sr.title.replace(/[^\w.-]+/g, '_')}_signed.pdf`,
                signed.length,
                signedSha256,
                auth.userId,
              ],
            );
        await tx.exec(
          `UPDATE app.signature_requests SET status = 'signed', signed_at = $2, signer_user_id = $3, signer_name = $4, signer_ip = $5, signer_user_agent = $6,
                  document_sha256 = $7, signed_file_key = $8, signed_sha256 = $9, completed_at = $10, signed_document_id = $11 WHERE id = $1`,
          [
            id,
            signedAt,
            auth.userId,
            b.typedName,
            req.ctx.ip,
            req.ctx.userAgent?.slice(0, 512) ?? null,
            documentSha256,
            signedKey,
            signedSha256,
            signedDoc ? signedAt : null,
            signedDoc?.id ?? null,
          ],
        );
        // the signing task, and any "sign again" task after a return
        await tx.exec(
          `UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE (dedupe_key = $1 OR dedupe_key LIKE $1 || ':%') AND status = 'open'`,
          [`sign:${id}`, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'document.signed',
          targetType: 'signature_request',
          targetId: id,
          diff: { documentSha256, signedSha256, signer: b.typedName, countersign: sr.requires_countersign },
        });
        if (sr.requires_countersign) await requestCountersign(tx, sr, auth.userId);
        return {
          status: sr.requires_countersign ? 'awaiting_approval' : 'completed',
          signedDocumentId: signedDoc?.id ?? null,
          documentSha256,
          signedSha256,
        };
      });
    },
  );

  app.get(
    '/v1/signature-requests/:id/verify',
    {
      schema: {
        tags: ['documents'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            valid: Type.Boolean(),
            signedAt: Nullable(Type.String()),
            signerName: Nullable(Type.String()),
            documentSha256: Nullable(Type.String()),
            signedSha256: Nullable(Type.String()),
            countersignerName: Nullable(Type.String()),
            countersignedAt: Nullable(Type.String()),
            completedAt: Nullable(Type.String()),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const sr = await app.tenantTx(
        req,
        async (tx) => {
          const r = await tx.maybe<{
            signed_file_key: string | null;
            signed_sha256: string | null;
            signed_at: string | null;
            signer_name: string | null;
            document_sha256: string | null;
            signer_employee_id: string;
            file_key: string;
            countersigner_name: string | null;
            countersigned_at: string | null;
            completed_at: string | null;
          }>(
            `SELECT s.*, d.file_key FROM app.signature_requests s JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id WHERE s.id = $1`,
            [id],
          );
          if (!r) throw new ApiError('notFound');
          if (
            r.signer_employee_id !== auth.principal.employeeId &&
            !can(auth.principal, 'documents.read', await loadTarget(tx, r.signer_employee_id))
          )
            throw new ApiError('notFound');
          return r;
        },
        { readOnly: true },
      );
      const none = { countersignerName: null, countersignedAt: null, completedAt: null };
      if (!sr.signed_file_key)
        return {
          valid: false,
          signedAt: null,
          signerName: null,
          documentSha256: null,
          signedSha256: null,
          ...none,
        };
      const [signed, original] = await Promise.all([
        deps.objects.get(sr.signed_file_key),
        deps.objects.get(sr.file_key),
      ]);
      const valid = sha256(signed) === sr.signed_sha256 && sha256(original) === sr.document_sha256;
      return {
        valid,
        signedAt: sr.signed_at,
        signerName: sr.signer_name,
        documentSha256: sr.document_sha256,
        signedSha256: sr.signed_sha256,
        countersignerName: sr.countersigner_name,
        countersignedAt: sr.countersigned_at,
        completedAt: sr.completed_at,
      };
    },
  );

  // ---- folders -------------------------------------------------------------------------------------------
  app.post(
    '/v1/document-folders',
    {
      config: { selfAudited: true, capability: 'documents.manage' },
      schema: {
        tags: ['documents'],
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          parentId: Type.Optional(Uuid),
          visibility: Type.Union(['hr', 'employee', 'managers', 'everyone'].map((v) => Type.Literal(v))),
        }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem },
      },
    },
    async (req, reply) => {
      authorize(req, 'documents.manage');
      const b = req.body as { name: string; parentId?: string; visibility: string };
      const r = await app.tenantTx(req, async (tx) => {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.document_folders (tenant_id, name, parent_id, visibility) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
          [b.name, b.parentId ?? null, b.visibility],
        );
        await app.audit(tx, req, {
          action: 'document_folder.created',
          targetType: 'document_folder',
          targetId: row.id,
          diff: b,
        });
        return row;
      });
      return reply.status(201).send(r);
    },
  );
}

/** Magic-number checks so the declared content type matches the uploaded bytes. */
export { matchesMagic };

// ---- background jobs ------------------------------------------------------------------------------------
registerJob('documents.bulk_send', async (ctx) => {
  const { templateId, employeeIds, requireSignature } = ctx.job.input as {
    templateId: string;
    employeeIds: string[];
    requireSignature: boolean;
  };
  let done = 0;
  let skipped = 0;
  for (let i = 0; i < employeeIds.length; i += 50) {
    const chunk = employeeIds.slice(i, i + 50);
    await ctx.tx(async (tx) => {
      for (const emp of chunk) {
        // idempotent per job+employee: skip if this job already produced a document for them
        const existing = await tx.maybe(
          `SELECT 1 FROM app.documents WHERE template_id = $1 AND employee_id = $2 AND created_at >= (SELECT created_at FROM app.jobs WHERE id = $3)`,
          [templateId, emp, ctx.job.id],
        );
        if (existing) {
          skipped++;
          continue;
        }
        await generateFromTemplate(ctx.deps, tx, templateId, emp, ctx.job.created_by, { requireSignature });
      }
    });
    done += chunk.length;
    await ctx.progress(done, employeeIds.length);
  }
  return { sent: done - skipped, skipped };
});

registerJob('documents.expiry_reminders', async (ctx) => {
  const date = String(ctx.job.input.date);
  return ctx.tx(async (tx) => {
    let sent = 0;
    // Offsets are a tenant setting (ADR-0169). Documents HR attached to a person are reminded by the daily
    // compliance job, with tasks for HR; this sweep covers the rest of the library.
    for (const days of (await complianceSettings(tx)).documentReminderDays) {
      const docs = await tx.query<{
        id: string;
        title: string;
        employee_id: string | null;
        expires_on: string;
      }>(
        `SELECT id, title, employee_id, expires_on FROM app.documents WHERE status = 'ready' AND attachment_type IS NULL AND expires_on = ($1::date + $2::int)`,
        [date, days],
      );
      for (const d of docs) {
        const hr = await tx.query<{ user_id: string }>(
          `SELECT DISTINCT a.user_id FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id WHERE r.key IN ('hr_admin', 'owner')`,
        );
        const owner = await userForEmployee(tx, d.employee_id);
        sent += (
          await notify(tx, {
            userIds: [...new Set([...hr.map((h) => h.user_id), ...(owner ? [owner] : [])])],
            kind: 'document.expiring',
            titleKey: days === 0 ? 'notify.documentExpired' : 'notify.documentExpiring',
            params: { title: d.title, days, count: days },
            target: { type: 'document', id: d.id },
            dedupeKey: `expiry:${d.id}:${days}`,
          })
        ).length;
      }
    }
    return { date, sent };
  });
});

/** Enqueues the expiry-reminder sweep for the UTC date of the time the scheduler passes (never the real clock). */
export async function enqueueExpiryReminders(tx: Tx, now: Date) {
  const date = instantToDate(now.toISOString(), 'UTC');
  await enqueueJob(tx, 'documents.expiry_reminders', date, { date });
}
periodic.push(enqueueExpiryReminders);
