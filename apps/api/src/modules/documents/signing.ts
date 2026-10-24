import { formatDate, isLocale, t, type Locale } from '@thapsus/core/i18n';
import { instantToDate } from '@thapsus/core/time';
import { targetHref } from '@thapsus/core/links';
import {
  fieldsIn,
  isKnownField,
  mergeBlocks,
  parseMarkup,
  type AskField,
  type PlacedField,
  type SigningOrder,
  type SigningParty,
} from '@thapsus/core/documents';
import { writeAudit, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { createTask, notify, userForEmployee } from '../../lib/notify';
import { objectKey, type ObjectStore } from '../../lib/object-store';
import { tenantLocale } from '../compliance/service';
import { maybeCompleteInstance } from '../workflows/service';
import { mergeValuesFor } from './fields';
import {
  addSignaturePage,
  appendCertificate,
  placedFieldRects,
  renderTemplatePdf,
  sha256,
  stampSignature,
  type BlockLabels,
  type SignatureField,
} from './pdf';

/**
 * Sending documents for signature and following them to completion (ADR-0195 to ADR-0197).
 *
 * A signature request asks the employee to sign, the company to sign, or both, in a signing order (employee first by
 * default, company first, or either). The company signs through the approvals service (subject
 * `document.countersign`, ADR-0169), which keeps the approver's inbox and the Approvals page working; who may sign
 * for the company is the authorised signatories list (Settings → Documents, default HR admins and owners), and
 * nobody signs for the company on their own document. Each signature is stamped into the PDF's signature block (or
 * the boxes HR placed), the certificate page is appended, and every version is kept with its SHA-256 in the
 * timeline (app.signature_events) and the audit log. The request is complete when everyone who has to has signed;
 * the task it was sent from (an onboarding step) then closes.
 */

export type ObjectDeps = { objects: ObjectStore; now?: () => Date };
const nowOf = (deps: ObjectDeps) => (deps.now ? deps.now() : new Date());

// ---- template versions (ADR-0194) ------------------------------------------------------------------------------

export interface VersionRow {
  id: string;
  template_id: string;
  version: number;
  name: string;
  locale: string;
  category: string;
  body: string;
  ask_fields: AskField[];
  requires_countersign: boolean;
  signing_order: SigningOrder;
  status: string;
  sample_key: string | null;
}

/**
 * The current version of a template. A template saved before versions existed is given version 1 from its own
 * columns the first time it is read (idempotent), so documents made from it keep pointing at that wording.
 */
export async function templateVersion(tx: Tx, templateId: string): Promise<VersionRow | undefined> {
  const sql = `SELECT v.id, v.template_id, v.version, v.name, v.locale, v.category, v.body, v.ask_fields, v.requires_countersign,
                      v.signing_order, t.status, t.sample_key
                 FROM app.document_templates t
                 JOIN app.document_template_versions v ON v.tenant_id = t.tenant_id AND v.template_id = t.id AND v.version = t.current_version
                WHERE t.id = $1`;
  const found = await tx.maybe<VersionRow>(sql, [templateId]);
  if (found) return found;
  const created = await tx.maybe(
    `INSERT INTO app.document_template_versions (tenant_id, template_id, version, name, locale, category, body, requires_countersign, signing_order)
     SELECT tenant_id, id, current_version, name, locale, category, body, requires_countersign, signing_order FROM app.document_templates WHERE id = $1
     ON CONFLICT (tenant_id, template_id, version) DO NOTHING RETURNING id`,
    [templateId],
  );
  if (!created && !(await tx.maybe('SELECT 1 FROM app.document_templates WHERE id = $1', [templateId])))
    return undefined;
  return tx.maybe<VersionRow>(sql, [templateId]);
}

// ---- merging and rendering -------------------------------------------------------------------------------------

export interface MissingValue {
  key: string;
  /** unknown: no such field; empty: the person's record has no value; required: an ask-when-sending field left blank */
  reason: 'unknown' | 'empty' | 'required';
  label?: string;
}

/** Merge values for a person plus the values typed in at send time, and what is still missing (16.11). */
export async function valuesFor(
  tx: Tx,
  version: Pick<VersionRow, 'body' | 'ask_fields' | 'locale'>,
  employeeId: string,
  typed: Record<string, string> = {},
): Promise<{ values: Record<string, string>; missing: MissingValue[]; locale: Locale }> {
  const locale: Locale = isLocale(version.locale) ? version.locale : 'en-GB';
  const values = await mergeValuesFor(tx, employeeId, locale);
  for (const a of version.ask_fields) values[`ask.${a.key}`] = (typed[a.key] ?? '').trim();
  const missing: MissingValue[] = [];
  for (const key of fieldsIn(version.body)) {
    if (!isKnownField(key, version.ask_fields)) missing.push({ key, reason: 'unknown' });
    else if (!values[key]) {
      const ask = version.ask_fields.find((a) => `ask.${a.key}` === key);
      if (!ask || ask.required) missing.push({ key, reason: ask ? 'required' : 'empty', label: ask?.label });
    }
  }
  // a required field the wording does not use is still asked for
  for (const a of version.ask_fields)
    if (a.required && !values[`ask.${a.key}`] && !missing.some((m) => m.key === `ask.${a.key}`))
      missing.push({ key: `ask.${a.key}`, reason: 'required', label: a.label });
  return { values, missing, locale };
}

export function blockLabels(locale: Locale): BlockLabels & { page: (n: number, count: number) => string } {
  const L = (k: string) => t(locale, `docPdf.${k}`);
  return {
    heading: L('signatures'),
    employee: L('employee'),
    company: L('company'),
    signature: L('signature'),
    name: L('name'),
    date: L('date'),
    reference: L('reference'),
    onBehalf: '',
    page: (n, count) => t(locale, 'docPdf.page', { n, count }),
  };
}

/** The signing parties in the order their blocks appear: whoever signs first on the left. */
export function partiesFor(o: { employeeSigns: boolean; companySigns: boolean; order: SigningOrder }) {
  const parties: SigningParty[] = [];
  if (o.employeeSigns) parties.push('employee');
  if (o.companySigns) parties.push('company');
  return o.order === 'company_first' ? parties.reverse() : parties;
}

/** Renders a template version for a person (preview and send). */
export async function renderVersionFor(
  tx: Tx,
  version: VersionRow,
  employeeId: string,
  o: { typed?: Record<string, string>; parties: SigningParty[]; title?: string },
) {
  const { values, missing, locale } = await valuesFor(tx, version, employeeId, o.typed);
  const title = o.title?.trim() || version.name;
  const { bytes, fields } = await renderTemplatePdf({
    title,
    company: values['entity.name'] || values['company.name'] || '',
    blocks: mergeBlocks(parseMarkup(version.body), (k) => values[k] ?? ''),
    parties: o.parties,
    labels: blockLabels(locale),
  });
  return { bytes, fields, missing, title, locale };
}

// ---- authorised signatories (ADR-0196) -------------------------------------------------------------------------

export const DEFAULT_SIGNATORY_ROLES = ['hr_admin', 'owner'];

export async function signatoryEntries(tx: Tx) {
  const rows = await tx.query<{
    id: string;
    kind: 'role' | 'user';
    role_key: string | null;
    user_id: string | null;
  }>('SELECT id, kind, role_key, user_id FROM app.document_signatories ORDER BY kind, role_key, created_at');
  return rows.length
    ? { isDefault: false, entries: rows }
    : {
        isDefault: true,
        entries: DEFAULT_SIGNATORY_ROLES.map((r) => ({
          id: null,
          kind: 'role' as const,
          role_key: r,
          user_id: null,
        })),
      };
}

/** Everyone who may sign for the company now (active users). */
export async function signatoryUserIds(tx: Tx): Promise<string[]> {
  const { entries } = await signatoryEntries(tx);
  const roles = entries.filter((e) => e.kind === 'role').map((e) => e.role_key!);
  const users = entries.filter((e) => e.kind === 'user').map((e) => e.user_id!);
  const rows = await tx.query<{ id: string }>(
    `SELECT u.id FROM app.users u WHERE u.status = 'active' AND (u.id = ANY($2::uuid[]) OR EXISTS (
        SELECT 1 FROM app.role_assignments a JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
         WHERE a.user_id = u.id AND r.key = ANY($1::text[])))`,
    [roles, users],
  );
  return rows.map((r) => r.id);
}

export async function isSignatory(tx: Tx, userId: string) {
  return (await signatoryUserIds(tx)).includes(userId);
}

// ---- the request and its timeline ------------------------------------------------------------------------------

export interface SrRow {
  id: string;
  document_id: string;
  signer_employee_id: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
  requires_countersign: boolean;
  requires_employee_signature: boolean;
  signing_order: SigningOrder;
  approval_status: string | null;
  approval_request_id: string | null;
  signer_user_id: string | null;
  signer_name: string | null;
  signed_at: string | null;
  signed_file_key: string | null;
  signed_sha256: string | null;
  employee_signed_file_key: string | null;
  company_signed_file_key: string | null;
  countersigner_name: string | null;
  countersigned_at: string | null;
  completed_at: string | null;
  signed_document_id: string | null;
  original_file_key: string | null;
  original_sha256: string | null;
  fields: SignatureField[] | null;
  task_id: string | null;
  due_on: string | null;
  message: string | null;
  voided_at: string | null;
  void_reason: string | null;
  reminded_at: string | null;
  reminder_count: number;
  resent_as: string | null;
  /** from the document */
  title: string;
  employee_id: string;
  file_key: string;
  template_id: string | null;
}
export const SR_SELECT = `SELECT s.*, d.title, d.employee_id, d.file_key, d.template_id FROM app.signature_requests s
  JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id`;

export const loadRequest = (tx: Tx, id: string, lock = false) =>
  tx.maybe<SrRow>(`${SR_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]);

/** Whose turn it is. */
export type Stage = 'employee' | 'company' | 'both' | 'completed' | 'voided';
export function stageOf(
  sr: Pick<
    SrRow,
    | 'status'
    | 'completed_at'
    | 'requires_employee_signature'
    | 'requires_countersign'
    | 'signing_order'
    | 'approval_status'
  >,
): Stage {
  if (sr.status === 'cancelled') return 'voided';
  if (sr.completed_at) return 'completed';
  const employeeDone = !sr.requires_employee_signature || sr.status === 'signed';
  const companyDone = !sr.requires_countersign || sr.approval_status === 'approved';
  const employeeTurn =
    !employeeDone && (sr.signing_order !== 'company_first' || companyDone || !sr.requires_countersign);
  const companyTurn = !companyDone && sr.approval_status === 'pending';
  return employeeTurn && companyTurn
    ? 'both'
    : employeeTurn
      ? 'employee'
      : companyTurn
        ? 'company'
        : 'employee';
}

/** The copy the next signature goes into: the latest signed version, or the version that was sent. */
export function workingKey(
  sr: Pick<
    SrRow,
    | 'status'
    | 'employee_signed_file_key'
    | 'signed_file_key'
    | 'company_signed_file_key'
    | 'approval_status'
    | 'original_file_key'
    | 'file_key'
  >,
  party: SigningParty,
) {
  if (party === 'company' && sr.status === 'signed')
    return sr.employee_signed_file_key ?? sr.signed_file_key!;
  if (party === 'employee' && sr.approval_status === 'approved' && sr.company_signed_file_key)
    return sr.company_signed_file_key;
  return sr.original_file_key ?? sr.file_key;
}

export async function addEvent(
  tx: Tx,
  e: {
    requestId: string;
    employeeId: string;
    kind: string;
    actorUserId?: string | null;
    actorName?: string | null;
    fileKey?: string | null;
    sha256?: string | null;
    detail?: Record<string, unknown>;
    at?: string;
  },
) {
  await tx.exec(
    `INSERT INTO app.signature_events (tenant_id, signature_request_id, employee_id, kind, actor_user_id, actor_name, file_key, sha256, detail, at)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))`,
    [
      e.requestId,
      e.employeeId,
      e.kind,
      e.actorUserId ?? null,
      e.actorName?.slice(0, 200) ?? null,
      e.fileKey ?? null,
      e.sha256 ?? null,
      JSON.stringify(e.detail ?? {}),
      e.at ?? null,
    ],
  );
}

const userName = async (tx: Tx, userId: string | null | undefined) =>
  userId
    ? ((
        await tx.maybe<{ display_name: string }>('SELECT display_name FROM app.users WHERE id = $1', [userId])
      )?.display_name ?? null)
    : null;

/** Asks the employee to sign: their task and notification open the viewer at the request. */
export async function askEmployee(
  tx: Tx,
  sr: { id: string; document_id: string; signer_employee_id: string; due_on?: string | null; title: string },
) {
  const user = await userForEmployee(tx, sr.signer_employee_id);
  if (!user) return;
  const link = `${targetHref({ type: 'document', id: sr.document_id })}?sign=${sr.id}`;
  await notify(tx, {
    userIds: [user],
    kind: 'document.signature_requested',
    titleKey: 'notify.signatureRequested',
    target: { type: 'document', id: sr.document_id },
    link,
    dedupeKey: `sign:${sr.id}`,
  });
  await createTask(tx, {
    source: 'document',
    sourceId: sr.id,
    title: t(await tenantLocale(tx), 'docSign.taskSign', { title: sr.title }),
    subjectEmployeeId: sr.signer_employee_id,
    assigneeUserId: user,
    dueOn: sr.due_on ?? null,
    link,
    dedupeKey: `sign:${sr.id}`,
  });
}

export interface SendOptions {
  employeeSigns: boolean;
  companySigns: boolean;
  order: SigningOrder;
  dueOn?: string | null;
  message?: string | null;
  taskId?: string | null;
}

/** Raises the company's signature (circular import kept out: countersign.ts registers it here). */
export const companySignature: {
  request?: (
    tx: Tx,
    sr: { id: string; document_id: string; title: string; signer_employee_id: string },
    requestedBy: string | null,
  ) => Promise<string>;
} = {};

/**
 * Opens a signature request on a document whose PDF (with its signature block or placed boxes) is `fileKey`.
 * The employee is asked now unless the company signs first; the company's signature is requested now unless the
 * employee signs first.
 */
export async function openSignatureRequest(
  tx: Tx,
  o: SendOptions & {
    documentId: string;
    employeeId: string;
    actor: string | null;
    fileKey: string;
    sha: string;
    fields: SignatureField[] | null;
    title: string;
    at?: string;
  },
) {
  if (!o.employeeSigns && !o.companySigns) throw new ApiError('validation', 'nobodySigns');
  if (o.taskId) {
    const task = await tx.maybe<{ status: string; subject_employee_id: string | null }>(
      'SELECT status, subject_employee_id FROM app.tasks WHERE id = $1',
      [o.taskId],
    );
    if (!task || (task.subject_employee_id && task.subject_employee_id !== o.employeeId))
      throw new ApiError('validation', 'taskMismatch');
  }
  const sr = await tx.one<{ id: string }>(
    `INSERT INTO app.signature_requests (tenant_id, document_id, signer_employee_id, requested_by, requires_countersign, requires_employee_signature,
            signing_order, due_on, message, task_id, fields, original_file_key, original_sha256)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      o.documentId,
      o.employeeId,
      o.actor,
      o.companySigns,
      o.employeeSigns,
      o.order,
      o.dueOn ?? null,
      o.message?.trim() || null,
      o.taskId ?? null,
      o.fields ? JSON.stringify(o.fields) : null,
      o.fileKey,
      o.sha,
    ],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: o.employeeId,
    kind: 'sent',
    actorUserId: o.actor,
    actorName: await userName(tx, o.actor),
    fileKey: o.fileKey,
    sha256: o.sha,
    detail: { order: o.order, employee: o.employeeSigns, company: o.companySigns, dueOn: o.dueOn ?? null },
    at: o.at,
  });
  const base = { id: sr.id, document_id: o.documentId, signer_employee_id: o.employeeId, title: o.title };
  if (o.employeeSigns && (o.order !== 'company_first' || !o.companySigns))
    await askEmployee(tx, { ...base, due_on: o.dueOn });
  if (o.companySigns && (o.order !== 'employee_first' || !o.employeeSigns)) {
    if (!companySignature.request) throw new Error('company signature not registered');
    await companySignature.request(tx, base, (await userForEmployee(tx, o.employeeId)) ?? null);
  }
  return sr.id;
}

/** Stores a new version of the document's PDF under the person's prefix. */
async function storeVersion(deps: ObjectDeps, tx: Tx, employeeId: string, bytes: Uint8Array) {
  const tenant = (await tx.one<{ t: string }>('SELECT app.current_tenant()::text AS t')).t;
  const key = objectKey(tenant, `employees/${employeeId}`, '.pdf');
  await deps.objects.put(key, Buffer.from(bytes), 'application/pdf');
  return { key, sha: sha256(bytes) };
}

/** Creates a document for a person from a template version (the unsigned version). */
export async function createTemplateDocument(
  deps: ObjectDeps,
  tx: Tx,
  o: {
    version: VersionRow;
    employeeId: string;
    actor: string | null;
    typed?: Record<string, string>;
    parties: SigningParty[];
    title?: string;
    /** the staging seed and the legacy generate route: empty values render empty; unknown fields still fail */
    allowEmpty?: boolean;
  },
) {
  const r = await renderVersionFor(tx, o.version, o.employeeId, o);
  const unknown = r.missing.filter((m) => m.reason === 'unknown');
  if (unknown.length)
    throw new ApiError('validation', `Unknown merge fields: ${unknown.map((m) => m.key).join(', ')}`);
  if (!o.allowEmpty && r.missing.length)
    throw new ApiError('unprocessable', 'missingValues', { missing: r.missing });
  const { key, sha } = await storeVersion(deps, tx, o.employeeId, r.bytes);
  const doc = await tx.one<{ id: string }>(
    `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, template_id, template_version_id, created_by, uploaded_at)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, 'application/pdf', $6, $7, 'ready', $8, $9, $10, now()) RETURNING id`,
    [
      o.employeeId,
      r.title,
      o.version.category,
      key,
      `${r.title.replace(/[^\w.-]+/g, '_')}.pdf`,
      r.bytes.length,
      sha,
      o.version.template_id,
      o.version.id,
      o.actor,
    ],
  );
  return { documentId: doc.id, key, sha, fields: r.fields, title: r.title };
}

/** Sends a template to a person for signature (16.11): blocked while any value is missing. */
export async function sendFromTemplate(
  deps: ObjectDeps,
  tx: Tx,
  o: SendOptions & {
    templateId: string;
    employeeId: string;
    actor: string | null;
    typed?: Record<string, string>;
    title?: string;
    allowEmpty?: boolean;
  },
) {
  const version = await templateVersion(tx, o.templateId);
  if (!version) throw new ApiError('notFound');
  if (version.status !== 'active') throw new ApiError('conflict', 'templateArchived');
  const doc = await createTemplateDocument(deps, tx, {
    version,
    employeeId: o.employeeId,
    actor: o.actor,
    typed: o.typed,
    title: o.title,
    parties: partiesFor(o),
    allowEmpty: o.allowEmpty,
  });
  const signatureRequestId =
    o.employeeSigns || o.companySigns
      ? await openSignatureRequest(tx, {
          ...o,
          ...doc,
          documentId: doc.documentId,
          fileKey: doc.key,
          at: nowOf(deps).toISOString(),
        })
      : null;
  return { documentId: doc.documentId, signatureRequestId, version };
}

/**
 * Sends a PDF already filed for the person (uploaded or attached): HR's placed boxes, or a signature page added at
 * the end when none are placed (16.13).
 */
export async function sendExistingDocument(
  deps: ObjectDeps,
  tx: Tx,
  o: SendOptions & { documentId: string; employeeId: string; actor: string | null; placed: PlacedField[] },
) {
  const doc = await tx.maybe<{
    file_key: string;
    title: string;
    content_type: string;
    employee_id: string | null;
    vault_record_id: string | null;
  }>(
    `SELECT file_key, title, content_type, employee_id, vault_record_id FROM app.documents WHERE id = $1 AND status = 'ready'`,
    [o.documentId],
  );
  if (!doc || doc.employee_id !== o.employeeId) throw new ApiError('notFound');
  if (doc.content_type !== 'application/pdf' || doc.vault_record_id)
    throw new ApiError('unprocessable', 'notSignable');
  const open = await tx.maybe(
    `SELECT 1 FROM app.signature_requests WHERE document_id = $1 AND status <> 'cancelled' AND completed_at IS NULL`,
    [o.documentId],
  );
  if (open) throw new ApiError('conflict', 'alreadyInSignature');
  const original = new Uint8Array(await deps.objects.get(doc.file_key));
  const parties = partiesFor(o);
  const allowed = new Set(parties);
  if (o.placed.some((p) => !allowed.has(p.party))) throw new ApiError('validation', 'fieldForNonSigner');
  let bytes: Uint8Array = original;
  let fields: SignatureField[];
  try {
    if (o.placed.some((p) => p.kind === 'signature')) fields = await placedFieldRects(original, o.placed);
    else {
      const locale = await tenantLocale(tx);
      const page = await addSignaturePage(original, {
        title: doc.title,
        parties,
        labels: blockLabels(locale),
      });
      bytes = page.bytes;
      // date boxes placed without a signature box are kept as well
      fields = [...page.fields, ...(await placedFieldRects(original, o.placed))];
    }
  } catch (err) {
    if (err instanceof RangeError) throw new ApiError('validation', 'pageOutOfRange');
    throw new ApiError('unprocessable', 'unreadablePdf');
  }
  // the version sent for signature (with its added page, if any) is kept beside the upload
  const stored =
    bytes === original
      ? { key: doc.file_key, sha: sha256(original) }
      : await storeVersion(deps, tx, o.employeeId, bytes);
  const signatureRequestId = await openSignatureRequest(tx, {
    ...o,
    fileKey: stored.key,
    sha: stored.sha,
    fields,
    title: doc.title,
    at: nowOf(deps).toISOString(),
  });
  return { documentId: o.documentId, signatureRequestId };
}

// ---- signing --------------------------------------------------------------------------------------------------

export interface SignatureInput {
  userId: string;
  email: string;
  typedName: string;
  method: 'typed' | 'drawn';
  drawing?: Uint8Array;
  ip: string;
  userAgent: string;
  at: string;
  /** the signer's time zone, for the date stamped on the document */
  zone: string;
}

/** A drawn signature arrives as a PNG data URL; anything else is refused. */
export function decodeDrawing(dataUrl: string | undefined): Uint8Array | undefined {
  if (!dataUrl) return undefined;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ApiError('validation', 'drawingNotPng');
  const bytes = Buffer.from(m[1]!, 'base64');
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 300_000 || PNG.some((b, i) => bytes[i] !== b))
    throw new ApiError('validation', 'drawingNotPng');
  return new Uint8Array(bytes);
}

/** Keeps a drawn signature as the person drew it, under their prefix in the home region's object store. */
export async function storeDrawing(deps: ObjectDeps, tx: Tx, employeeId: string, png: Uint8Array) {
  const tenant = (await tx.one<{ t: string }>('SELECT app.current_tenant()::text AS t')).t;
  const key = objectKey(tenant, `employees/${employeeId}`, '.png');
  await deps.objects.put(key, Buffer.from(png), 'image/png');
  return key;
}

/** Stamps a party's signature (when the request has fields) and appends their certificate. */
export async function signCopy(
  deps: ObjectDeps,
  tx: Tx,
  sr: SrRow,
  party: SigningParty,
  s: SignatureInput,
  labels: Record<string, string>,
) {
  const locale = await tenantLocale(tx);
  const input = new Uint8Array(await deps.objects.get(workingKey(sr, party)));
  const inputSha = sha256(input);
  const company =
    party === 'company'
      ? ((
          await tx.maybe<{ name: string }>(
            `SELECT coalesce(le.name, t.name) AS name FROM app.employees e JOIN app.tenants t ON t.tenant_id = e.tenant_id
             LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = e.entity_id WHERE e.id = $1`,
            [sr.signer_employee_id],
          )
        )?.name ?? '')
      : '';
  const stamped = sr.fields?.length
    ? await stampSignature(input, sr.fields, party, {
        method: s.method,
        name: s.typedName,
        drawing: s.drawing,
        onBehalf: party === 'company' ? t(locale, 'docPdf.onBehalf', { company }) : undefined,
        date: formatDate(instantToDate(s.at, s.zone), locale, 'long'),
        reference: t(locale, 'docPdf.ref', { id: sr.id }),
      })
    : input;
  const signed = await appendCertificate(stamped, {
    signerName: s.typedName,
    signerEmail: s.email,
    signedAtUtc: s.at,
    ip: s.ip,
    userAgent: s.userAgent,
    documentSha256: inputSha,
    requestId: sr.id,
    labels: { ...labels, method: t(locale, `documents.certificate.method.${s.method}`) },
  });
  const stored = await storeVersion(deps, tx, sr.employee_id, signed);
  return { ...stored, inputSha, bytes: signed };
}

/** The document is complete: the last version becomes the signed copy, the person is told, the task closes. */
export async function completeRequest(
  tx: Tx,
  sr: SrRow,
  o: { key: string; sha: string; size: number; actor: string; at: string },
) {
  const locale = await tenantLocale(tx);
  const doc = await tx.one<{ id: string }>(
    `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, created_by, uploaded_at)
     VALUES (app.current_tenant(), $1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, 'ready', $7, now()) RETURNING id`,
    [
      sr.employee_id,
      t(locale, 'docSign.signedTitle', { title: sr.title }),
      o.key,
      `${sr.title.replace(/[^\w.-]+/g, '_')}_signed.pdf`,
      o.size,
      o.sha,
      o.actor,
    ],
  );
  await tx.exec(
    `UPDATE app.signature_requests SET completed_at = $2, signed_document_id = $3, signed_file_key = $4, signed_sha256 = $5 WHERE id = $1`,
    [sr.id, o.at, doc.id, o.key, o.sha],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'completed',
    fileKey: o.key,
    sha256: o.sha,
    detail: { signedDocumentId: doc.id },
    at: o.at,
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: o.actor,
    action: 'document.completed',
    targetType: 'signature_request',
    targetId: sr.id,
    diff: { signedDocumentId: doc.id, completedSha256: o.sha, originalSha256: sr.original_sha256 },
  });
  // the person and the sender hear about it, unless they did the last step themselves
  const signer = sr.signer_user_id ?? (await userForEmployee(tx, sr.signer_employee_id));
  const tell = [...new Set([signer, sr.requested_by].filter((u): u is string => !!u && u !== o.actor))];
  if (tell.length)
    await notify(tx, {
      userIds: tell,
      kind: 'document.completed',
      titleKey: 'notify.documentCompleted',
      params: { title: sr.title },
      target: { type: 'document', id: doc.id },
      dedupeKey: `completed:${sr.id}`,
    });
  // the task the document was sent from (16.14) is done now
  if (sr.task_id) {
    const task = await tx.maybe<{ id: string; source: string; source_id: string | null }>(
      `UPDATE app.tasks SET status = 'done', completed_at = $2, completed_by = $3 WHERE id = $1 AND status = 'open' RETURNING id, source, source_id`,
      [sr.task_id, o.at, o.actor],
    );
    if (task) {
      await writeAudit(tx, {
        actorType: 'system',
        action: 'task.completed',
        targetType: 'task',
        targetId: task.id,
        diff: { by: 'document.completed', signatureRequestId: sr.id, documentId: sr.document_id },
      });
      if (task.source === 'workflow' && task.source_id) await maybeCompleteInstance(tx, task.source_id);
    }
  }
  return doc.id;
}

/**
 * The employee signs (16.11–16.13). In "company first" they wait for the company. Their signature goes into the
 * latest version; the company's signature is requested next (employee first) unless it is already there.
 */
export async function employeeSign(
  deps: ObjectDeps,
  tx: Tx,
  sr: SrRow,
  s: SignatureInput,
  labels: Record<string, string>,
) {
  if (sr.status !== 'pending' || !sr.requires_employee_signature) throw new ApiError('conflict');
  if (stageOf(sr) === 'company') throw new ApiError('conflict', 'companySignsFirst');
  const copy = await signCopy(deps, tx, sr, 'employee', s, labels);
  const drawingKey = s.drawing ? await storeDrawing(deps, tx, sr.employee_id, s.drawing) : null;
  const companyDone = !sr.requires_countersign || sr.approval_status === 'approved';
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'signed', signed_at = $2, signer_user_id = $3, signer_name = $4, signer_ip = $5, signer_user_agent = $6,
            document_sha256 = $7, signed_file_key = $8, signed_sha256 = $9, employee_signed_file_key = $8, employee_signed_sha256 = $9,
            signature_method = $10, signature_drawing_key = $11 WHERE id = $1`,
    [
      sr.id,
      s.at,
      s.userId,
      s.typedName,
      s.ip,
      s.userAgent.slice(0, 512) || null,
      copy.inputSha,
      copy.key,
      copy.sha,
      s.method,
      drawingKey,
    ],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'employee_signed',
    actorUserId: s.userId,
    actorName: s.typedName,
    fileKey: copy.key,
    sha256: copy.sha,
    detail: { method: s.method, documentSha256: copy.inputSha },
    at: s.at,
  });
  // the signing task, and any "sign again" task after a return
  await tx.exec(
    `UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE (dedupe_key = $1 OR dedupe_key LIKE $1 || ':%') AND status = 'open'`,
    [`sign:${sr.id}`, s.userId],
  );
  const after = { ...sr, status: 'signed', signer_user_id: s.userId };
  let signedDocumentId: string | null = null;
  if (companyDone)
    signedDocumentId = await completeRequest(tx, after, {
      key: copy.key,
      sha: copy.sha,
      size: copy.bytes.length,
      actor: s.userId,
      at: s.at,
    });
  else if (sr.approval_status !== 'pending') {
    if (!companySignature.request) throw new Error('company signature not registered');
    await companySignature.request(tx, sr, s.userId);
  }
  return {
    status: companyDone ? 'completed' : 'awaiting_approval',
    signedDocumentId,
    documentSha256: copy.inputSha,
    signedSha256: copy.sha,
  };
}

// ---- reminders, void and send again (16.12) -------------------------------------------------------------------

export async function remindRequest(tx: Tx, sr: SrRow, actor: string, at?: string) {
  const stage = stageOf(sr);
  if (stage === 'completed' || stage === 'voided') throw new ApiError('conflict');
  const n = sr.reminder_count + 1;
  const told: string[] = [];
  if (stage === 'employee' || stage === 'both') {
    const user = await userForEmployee(tx, sr.signer_employee_id);
    if (user) {
      await notify(tx, {
        userIds: [user],
        kind: 'document.signature_reminder',
        titleKey: 'notify.signatureReminder',
        params: { title: sr.title },
        target: { type: 'document', id: sr.document_id },
        link: `${targetHref({ type: 'document', id: sr.document_id })}?sign=${sr.id}`,
        dedupeKey: `remind:${sr.id}:${n}`,
      });
      told.push('employee');
    }
  }
  if ((stage === 'company' || stage === 'both') && sr.approval_request_id) {
    const step = await tx.maybe<{ approver_user_ids: string[] }>(
      `SELECT st.approver_user_ids FROM app.approval_steps st JOIN app.approval_requests r ON r.tenant_id = st.tenant_id AND r.id = st.request_id
        WHERE r.id = $1 AND st.step_index = r.current_step`,
      [sr.approval_request_id],
    );
    if (step?.approver_user_ids.length) {
      await notify(tx, {
        userIds: step.approver_user_ids.filter((u) => u !== actor),
        kind: 'document.countersign_reminder',
        titleKey: 'notify.countersignReminder',
        params: { title: sr.title },
        target: { type: 'document', id: sr.document_id },
        dedupeKey: `remind:${sr.id}:${n}:company`,
      });
      told.push('company');
    }
  }
  await tx.exec('UPDATE app.signature_requests SET reminded_at = now(), reminder_count = $2 WHERE id = $1', [
    sr.id,
    n,
  ]);
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'reminded',
    actorUserId: actor,
    actorName: await userName(tx, actor),
    detail: { told, count: n },
    at,
  });
  return { told };
}

export async function voidRequest(tx: Tx, sr: SrRow, actor: string | null, reason: string, at?: string) {
  if (sr.completed_at || sr.status === 'cancelled') throw new ApiError('conflict');
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'cancelled', voided_at = now(), voided_by = $2, void_reason = $3,
            approval_status = CASE WHEN approval_status = 'pending' THEN NULL ELSE approval_status END WHERE id = $1`,
    [sr.id, actor, reason],
  );
  if (sr.approval_request_id)
    await tx.exec(
      `UPDATE app.approval_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'`,
      [sr.approval_request_id],
    );
  await tx.exec(
    `UPDATE app.tasks SET status = 'cancelled', completed_at = now(), completed_by = $3
      WHERE status = 'open' AND ((source = 'document' AND (dedupe_key = $1 OR dedupe_key LIKE $1 || ':%')) OR (source = 'approval' AND source_id = $2))`,
    [`sign:${sr.id}`, sr.approval_request_id, actor],
  );
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'voided',
    actorUserId: actor,
    actorName: await userName(tx, actor),
    detail: { reason },
    at,
  });
  const user = sr.requires_employee_signature ? await userForEmployee(tx, sr.signer_employee_id) : undefined;
  if (user && user !== actor)
    await notify(tx, {
      userIds: [user],
      kind: 'document.voided',
      titleKey: 'notify.documentVoided',
      params: { title: sr.title },
      target: { type: 'document', id: sr.document_id },
      dedupeKey: `voided:${sr.id}`,
    });
}

/** Sends a voided request again: a new request for the same document and version, with the same options. */
export async function resendRequest(tx: Tx, sr: SrRow, actor: string, at?: string) {
  if (sr.status !== 'cancelled' || sr.resent_as) throw new ApiError('conflict');
  const id = await openSignatureRequest(tx, {
    documentId: sr.document_id,
    employeeId: sr.signer_employee_id,
    actor,
    fileKey: sr.original_file_key ?? sr.file_key,
    sha: sr.original_sha256 ?? '',
    fields: sr.fields,
    title: sr.title,
    employeeSigns: sr.requires_employee_signature,
    companySigns: sr.requires_countersign,
    order: sr.signing_order,
    dueOn: sr.due_on,
    message: sr.message,
    taskId: sr.task_id,
    at,
  });
  await tx.exec('UPDATE app.signature_requests SET resent_as = $2, task_id = NULL WHERE id = $1', [
    sr.id,
    id,
  ]);
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: sr.employee_id,
    kind: 'resent',
    actorUserId: actor,
    actorName: await userName(tx, actor),
    detail: { resentAs: id },
    at,
  });
  return id;
}

// ---- the status timeline (16.12) ------------------------------------------------------------------------------

export interface TimelineEvent {
  kind: string;
  at: string;
  actorName: string | null;
  sha256: string | null;
  detail: Record<string, unknown>;
}

/** The latest signature request of a document with its timeline and whose turn it is, for its details panel. */
export async function signingStatus(tx: Tx, documentId: string) {
  const sr = await tx.maybe<SrRow>(
    `${SR_SELECT} WHERE s.document_id = $1 ORDER BY s.requested_at DESC LIMIT 1`,
    [documentId],
  );
  if (!sr) return null;
  const events = await tx.query<{
    kind: string;
    at: string;
    actor_name: string | null;
    sha256: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT kind, at, actor_name, sha256, detail FROM app.signature_events WHERE signature_request_id = $1 ORDER BY at, seq`,
    [sr.id],
  );
  const stage = stageOf(sr);
  const companyNames =
    (stage === 'company' || stage === 'both') && sr.approval_request_id
      ? (
          await tx.query<{ display_name: string }>(
            `SELECT u.display_name FROM app.approval_steps st JOIN app.approval_requests r ON r.tenant_id = st.tenant_id AND r.id = st.request_id
               JOIN app.users u ON u.tenant_id = st.tenant_id AND u.id = ANY(st.approver_user_ids)
              WHERE r.id = $1 AND st.step_index = r.current_step ORDER BY u.display_name`,
            [sr.approval_request_id],
          )
        ).map((r) => r.display_name)
      : [];
  const employee = await tx.maybe<{ display_name: string }>(
    'SELECT display_name FROM app.employees WHERE id = $1',
    [sr.signer_employee_id],
  );
  // waiting since: the last step that moved it on
  const moved = [...events]
    .reverse()
    .find((e) => ['sent', 'employee_signed', 'company_signed', 'returned', 'resent'].includes(e.kind));
  return {
    id: sr.id,
    stage,
    signingOrder: sr.signing_order,
    requiresEmployeeSignature: sr.requires_employee_signature,
    requiresCompanySignature: sr.requires_countersign,
    employeeName: employee?.display_name ?? null,
    companySigners: companyNames,
    waitingSince: stage === 'completed' || stage === 'voided' ? null : (moved?.at ?? sr.requested_at),
    dueOn: sr.due_on,
    message: sr.message,
    reminderCount: sr.reminder_count,
    remindedAt: sr.reminded_at,
    voidReason: sr.void_reason,
    signedDocumentId: sr.signed_document_id,
    replacedBy: sr.resent_as,
    templateId: sr.template_id,
    taskId: sr.task_id,
    events: events.map((e): TimelineEvent => ({
      kind: e.kind,
      at: new Date(e.at).toISOString(),
      actorName: e.actor_name,
      sha256: e.sha256,
      detail: e.detail,
    })),
  };
}

export const timelineNow = (deps: ObjectDeps) => nowOf(deps).toISOString();
