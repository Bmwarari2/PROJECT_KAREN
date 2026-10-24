import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { notify, userForEmployee } from '../../lib/notify';
import { objectKey } from '../../lib/object-store';
import { loadTarget, scopePredicate } from '../employees/service';
import {
  candidates,
  compilePattern,
  decide,
  expandUploads,
  MAX_UPLOAD_BYTES,
  type MatchBy,
  type UploadedFile,
} from './matching';

/**
 * Payslip and year-end document upload (PROGRESS 6.3). Files go to the home-region object store as
 * restricted documents: only the employee and payroll roles (payslips.*) can see them — not managers and
 * not the general document library. Every download is audited as sensitive.
 */
const KINDS = ['payslip', 'year_end'] as const;
const DOC_TYPES = ['payslip', 'p60', 'p11d', 'w2', 'form_1099', 'annual_statement', 'other'] as const;

const Item = Type.Object({
  id: Uuid,
  fileName: Type.String(),
  sizeBytes: Type.Integer(),
  sha256: Type.String(),
  matchStatus: Type.String(),
  employeeId: Nullable(Type.String()),
  employeeNumber: Nullable(Type.String()),
  employeeName: Nullable(Type.String()),
  status: Type.String(),
  detail: Type.Record(Type.String(), Type.Any()),
});
const Batch = Type.Object({
  id: Uuid,
  kind: Type.String(),
  docType: Type.String(),
  label: Type.String(),
  payDate: Nullable(Type.String()),
  taxYear: Nullable(Type.String()),
  matchBy: Type.String(),
  status: Type.String(),
  fileCount: Type.Integer(),
  matchedCount: Type.Integer(),
  createdAt: Type.String(),
  publishedAt: Nullable(Type.String()),
});
const BatchDetail = Type.Object({
  ...Batch.properties,
  items: Type.Array(Item),
  rejected: Type.Array(Type.Object({ name: Type.String(), reason: Type.String() })),
});
const MyPayslip = Type.Object({
  id: Uuid,
  kind: Type.String(),
  docType: Type.String(),
  label: Type.String(),
  payDate: Nullable(Type.String()),
  taxYear: Nullable(Type.String()),
  fileName: Type.String(),
  publishedAt: Type.String(),
  viewed: Type.Boolean(),
});

type BatchRow = {
  id: string;
  kind: string;
  doc_type: string;
  label: string;
  pay_date: string | null;
  tax_year: string | null;
  match_by: MatchBy;
  pattern: string | null;
  status: string;
  file_count: number;
  matched_count: number;
  created_at: string;
  published_at: string | null;
};
const mapBatch = (b: BatchRow) => ({
  id: b.id,
  kind: b.kind,
  docType: b.doc_type,
  label: b.label,
  payDate: b.pay_date,
  taxYear: b.tax_year,
  matchBy: b.match_by,
  status: b.status,
  fileCount: b.file_count,
  matchedCount: b.matched_count,
  createdAt: b.created_at,
  publishedAt: b.published_at,
});
type ItemRow = {
  id: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  match_status: string;
  employee_id: string | null;
  employee_number: string | null;
  display_name: string | null;
  status: string;
  match_detail: Record<string, unknown>;
};
const mapItem = (i: ItemRow) => ({
  id: i.id,
  fileName: i.file_name,
  sizeBytes: i.size_bytes,
  sha256: i.sha256,
  matchStatus: i.match_status,
  employeeId: i.employee_id,
  employeeNumber: i.employee_number,
  employeeName: i.display_name,
  status: i.status,
  detail: i.match_detail,
});
type PayslipRow = {
  id: string;
  employee_id: string;
  kind: string;
  doc_type: string;
  label: string;
  pay_date: string | null;
  tax_year: string | null;
  file_name: string;
  file_key: string;
  published_at: string;
  first_viewed_at: string | null;
};
const mapMine = (p: PayslipRow) => ({
  id: p.id,
  kind: p.kind,
  docType: p.doc_type,
  label: p.label,
  payDate: p.pay_date,
  taxYear: p.tax_year,
  fileName: p.file_name,
  publishedAt: p.published_at,
  viewed: !!p.first_viewed_at,
});

export async function payslipRoutes(app: FastifyInstance) {
  const deps = app.deps;
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 500, fields: 20, fieldSize: 1000 },
  });

  const batchDetail = async (tx: Tx, id: string, rejected: Array<{ name: string; reason: string }> = []) => {
    const b = await tx.maybe<BatchRow>('SELECT * FROM app.payslip_batches WHERE id = $1', [id]);
    if (!b) throw new ApiError('notFound');
    const items = await tx.query<ItemRow>(
      `SELECT p.id, p.file_name, p.size_bytes, p.sha256, p.match_status, p.employee_id, e.employee_number, e.display_name, p.status, p.match_detail
         FROM app.payslips p LEFT JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id WHERE p.batch_id = $1 ORDER BY p.file_name, p.id`,
      [id],
    );
    return { ...mapBatch(b), items: items.map(mapItem), rejected };
  };

  // ---- bulk upload with matching preview ------------------------------------------------------------------------
  app.post(
    '/v1/payslips/batches',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary:
          'Bulk upload payslips or year-end documents (PDFs or a zip of PDFs); returns the matching preview',
        consumes: ['multipart/form-data'],
        response: { 201: BatchDetail, 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      const fields: Record<string, string> = {};
      const files: UploadedFile[] = [];
      let received = 0;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const body = await part.toBuffer();
          received += body.length;
          // one request may carry at most MAX_UPLOAD_BYTES in total (ASVS V5.2.1)
          if (received > MAX_UPLOAD_BYTES)
            throw new ApiError('validation', 'The upload is too large; send it in smaller batches', {
              maxBytes: MAX_UPLOAD_BYTES,
            });
          files.push({ name: (part.filename || 'file').slice(0, 255), body });
        } else fields[part.fieldname] = String(part.value ?? '');
      }
      const kind = fields.kind ?? 'payslip';
      const docType = fields.docType ?? (kind === 'payslip' ? 'payslip' : 'other');
      const matchBy = (fields.matchBy ?? 'employee_number') as MatchBy;
      const label = (fields.label ?? '').trim();
      if (
        !(KINDS as readonly string[]).includes(kind) ||
        !(DOC_TYPES as readonly string[]).includes(docType) ||
        !['employee_number', 'pattern'].includes(matchBy) ||
        !label ||
        label.length > 120
      )
        throw new ApiError('validation', 'kind, docType, matchBy and label are required');
      if (fields.payDate && !/^\d{4}-\d{2}-\d{2}$/.test(fields.payDate))
        throw new ApiError('validation', 'payDate must be YYYY-MM-DD');
      const pattern = matchBy === 'pattern' ? (fields.pattern ?? '') : null;
      if (pattern !== null) {
        try {
          compilePattern(pattern);
        } catch {
          throw new ApiError('validation', 'pattern is not a valid regular expression');
        }
      }
      const { accepted, rejected } = await expandUploads(files);
      if (!accepted.length) throw new ApiError('validation', 'No PDF files found', { rejected });
      const out = await app.tenantTx(req, async (tx) => {
        const b = await tx.one<{ id: string }>(
          `INSERT INTO app.payslip_batches (tenant_id, kind, doc_type, label, pay_date, tax_year, match_by, pattern, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            kind,
            docType,
            label,
            fields.payDate || null,
            fields.taxYear?.slice(0, 20) || null,
            matchBy,
            pattern,
            auth.userId,
          ],
        );
        // look up only the employee numbers that appear in the file names, within the uploader's scope
        const wanted = [...new Set(accepted.flatMap((f) => candidates(f.name, matchBy, pattern)))];
        const params: unknown[] = [wanted];
        const scope = scopePredicate(auth.principal, 'payslips.manage', params);
        const emps = await tx.query<{ id: string; employee_number: string }>(
          `SELECT e.id, e.employee_number FROM app.employees e WHERE lower(e.employee_number) = ANY($1::text[]) AND ${scope}`,
          params,
        );
        const numbers = new Map(
          emps.map((e) => [e.employee_number.toLowerCase(), { id: e.id, employeeNumber: e.employee_number }]),
        );
        const seen = new Set<string>();
        let matched = 0;
        let stored = 0;
        for (const f of accepted) {
          const sha = createHash('sha256').update(f.body).digest('hex');
          if (seen.has(sha)) {
            rejected.push({ name: f.name, reason: 'duplicate' });
            continue;
          }
          seen.add(sha);
          const m = decide(f.name, matchBy, pattern, numbers);
          if (m.status === 'matched') matched++;
          const key = objectKey(auth.tenantId, `payslips/${b.id}`, '.pdf');
          await deps.objects.put(key, f.body, 'application/pdf');
          await tx.exec(
            `INSERT INTO app.payslips (tenant_id, batch_id, employee_id, file_name, file_key, size_bytes, sha256, match_status, match_detail) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`,
            [b.id, m.employeeId, f.name, key, f.body.length, sha, m.status, JSON.stringify(m.detail)],
          );
          stored++;
        }
        await tx.exec('UPDATE app.payslip_batches SET file_count = $2, matched_count = $3 WHERE id = $1', [
          b.id,
          stored,
          matched,
        ]);
        await app.audit(tx, req, {
          action: 'payslip_batch.uploaded',
          targetType: 'payslip_batch',
          targetId: b.id,
          diff: { kind, docType, label, files: stored, matched, rejected: rejected.length },
        });
        return batchDetail(tx, b.id, rejected);
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/payslips/batches',
    { schema: { tags: ['payslips'], response: { 200: Type.Array(Batch), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      return (
        await app.tenantTx(
          req,
          (tx) =>
            tx.query<BatchRow>(
              `SELECT * FROM app.payslip_batches WHERE status <> 'discarded' ORDER BY created_at DESC LIMIT 200`,
            ),
          { readOnly: true },
        )
      ).map(mapBatch);
    },
  );

  app.get(
    '/v1/payslips/batches/:id',
    {
      schema: {
        tags: ['payslips'],
        params: Type.Object({ id: Uuid }),
        response: { 200: BatchDetail, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      return app.tenantTx(req, (tx) => batchDetail(tx, (req.params as { id: string }).id), {
        readOnly: true,
      });
    },
  );

  app.put(
    '/v1/payslips/batches/:id/items/:itemId',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary: 'Match (or unmatch) one file by hand',
        params: Type.Object({ id: Uuid, itemId: Uuid }),
        body: Type.Object({ employeeId: Nullable(Uuid) }, { additionalProperties: false }),
        response: { 200: Item, 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id, itemId } = req.params as { id: string; itemId: string };
      const { employeeId } = req.body as { employeeId: string | null };
      return app.tenantTx(req, async (tx) => {
        const item = await tx.maybe<{ status: string }>(
          'SELECT status FROM app.payslips WHERE id = $1 AND batch_id = $2 FOR UPDATE',
          [itemId, id],
        );
        if (!item) throw new ApiError('notFound');
        if (item.status !== 'draft')
          throw new ApiError('conflict', 'Only unpublished files can be re-matched');
        if (employeeId && !can(auth.principal, 'payslips.manage', await loadTarget(tx, employeeId)))
          throw new ApiError('forbidden');
        if (!employeeId && !canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
        await tx.exec(
          `UPDATE app.payslips SET employee_id = $2, match_status = $3, match_detail = $4 WHERE id = $1`,
          [
            itemId,
            employeeId,
            employeeId ? 'manual' : 'unmatched',
            JSON.stringify(employeeId ? { matchedBy: auth.userId } : { reason: 'unmatchedByHand' }),
          ],
        );
        await tx.exec(
          `UPDATE app.payslip_batches SET matched_count = (SELECT count(*) FROM app.payslips WHERE batch_id = $1 AND employee_id IS NOT NULL AND status <> 'discarded') WHERE id = $1`,
          [id],
        );
        await app.audit(tx, req, {
          action: 'payslip.matched',
          targetType: 'payslip',
          targetId: itemId,
          diff: { employeeId },
        });
        const r = await tx.one<ItemRow>(
          `SELECT p.id, p.file_name, p.size_bytes, p.sha256, p.match_status, p.employee_id, e.employee_number, e.display_name, p.status, p.match_detail FROM app.payslips p LEFT JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id WHERE p.id = $1`,
          [itemId],
        );
        return mapItem(r);
      });
    },
  );

  app.post(
    '/v1/payslips/batches/:id/publish',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary: 'Publish every matched file to its employee and notify them',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            published: Type.Integer(),
            notified: Type.Integer(),
            unmatched: Type.Integer(),
          }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const b = await tx.maybe<BatchRow>('SELECT * FROM app.payslip_batches WHERE id = $1 FOR UPDATE', [
          id,
        ]);
        if (!b) throw new ApiError('notFound');
        if (b.status === 'discarded') throw new ApiError('conflict', 'This batch was discarded');
        const ready = await tx.query<{ id: string; employee_id: string }>(
          `SELECT id, employee_id FROM app.payslips WHERE batch_id = $1 AND status = 'draft' AND employee_id IS NOT NULL`,
          [id],
        );
        let notified = 0;
        const now = deps.now().toISOString();
        for (const p of ready) {
          if (!can(auth.principal, 'payslips.manage', await loadTarget(tx, p.employee_id)))
            throw new ApiError('forbidden');
          await tx.exec(`UPDATE app.payslips SET status = 'published', published_at = $2 WHERE id = $1`, [
            p.id,
            now,
          ]);
          const user = await userForEmployee(tx, p.employee_id);
          if (user)
            notified += (
              await notify(tx, {
                userIds: [user],
                kind: b.kind === 'payslip' ? 'payslip.published' : 'payslip.year_end_published',
                titleKey: b.kind === 'payslip' ? 'notify.payslipAvailable' : 'notify.yearEndAvailable',
                params: { label: b.label },
                target: { type: 'payslip', id: p.id },
                dedupeKey: `payslip:${p.id}`,
              })
            ).length;
        }
        const unmatched = (
          await tx.one<{ n: number }>(
            `SELECT count(*)::int AS n FROM app.payslips WHERE batch_id = $1 AND status = 'draft' AND employee_id IS NULL`,
            [id],
          )
        ).n;
        await tx.exec(
          `UPDATE app.payslip_batches SET status = 'published', published_at = coalesce(published_at, $2), published_by = coalesce(published_by, $3) WHERE id = $1`,
          [id, now, auth.userId],
        );
        await app.audit(tx, req, {
          action: 'payslip_batch.published',
          targetType: 'payslip_batch',
          targetId: id,
          diff: { published: ready.length, notified, unmatched },
        });
        return { published: ready.length, notified, unmatched };
      });
    },
  );

  app.delete(
    '/v1/payslips/batches/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary: 'Discard the unpublished files of a batch (deletes them from storage)',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Object({ discarded: Type.Integer() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      const { id } = req.params as { id: string };
      const keys = await app.tenantTx(req, async (tx) => {
        const b = await tx.maybe<BatchRow>('SELECT * FROM app.payslip_batches WHERE id = $1 FOR UPDATE', [
          id,
        ]);
        if (!b) throw new ApiError('notFound');
        const rows = await tx.query<{ file_key: string }>(
          `UPDATE app.payslips SET status = 'discarded' WHERE batch_id = $1 AND status = 'draft' RETURNING file_key`,
          [id],
        );
        if (b.status === 'draft')
          await tx.exec(`UPDATE app.payslip_batches SET status = 'discarded' WHERE id = $1`, [id]);
        await app.audit(tx, req, {
          action: 'payslip_batch.discarded',
          targetType: 'payslip_batch',
          targetId: id,
          diff: { files: rows.length },
        });
        return rows.map((r) => r.file_key);
      });
      for (const k of keys) await deps.objects.delete(k);
      return { discarded: keys.length };
    },
  );

  app.post(
    '/v1/payslips/:id/withdraw',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary: 'Withdraw a published document sent in error',
        params: Type.Object({ id: Uuid }),
        body: Type.Object(
          { reason: Type.String({ minLength: 3, maxLength: 300 }) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const key = await app.tenantTx(req, async (tx) => {
        const p = await tx.maybe<{ employee_id: string | null; file_key: string; status: string }>(
          'SELECT employee_id, file_key, status FROM app.payslips WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!p || p.status === 'discarded') throw new ApiError('notFound');
        if (
          !(p.employee_id
            ? can(auth.principal, 'payslips.manage', await loadTarget(tx, p.employee_id))
            : canSome(auth.principal, 'payslips.manage'))
        )
          throw new ApiError('forbidden');
        await tx.exec(`UPDATE app.payslips SET status = 'discarded' WHERE id = $1`, [id]);
        await app.audit(tx, req, {
          action: 'payslip.withdrawn',
          targetType: 'payslip',
          targetId: id,
          diff: { reason: (req.body as { reason: string }).reason },
        });
        return p.file_key;
      });
      await deps.objects.delete(key);
      return { id, status: 'discarded' };
    },
  );

  // ---- self-service and payroll views --------------------------------------------------------------------------------
  const PUBLISHED = `SELECT p.id, p.employee_id, b.kind, b.doc_type, b.label, b.pay_date, b.tax_year, p.file_name, p.file_key, p.published_at, p.first_viewed_at
                       FROM app.payslips p JOIN app.payslip_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id WHERE p.status = 'published'`;

  app.get(
    '/v1/me/payslips',
    {
      schema: {
        tags: ['payslips'],
        summary: 'My payslips and year-end documents',
        response: { 200: Type.Array(MyPayslip) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const employeeId = auth.principal.employeeId;
      if (!employeeId || !can(auth.principal, 'payslips.read_own', { employeeId })) return [];
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<PayslipRow>(
            `${PUBLISHED} AND p.employee_id = $1 ORDER BY coalesce(b.pay_date, p.published_at::date) DESC, p.published_at DESC LIMIT 500`,
            [employeeId],
          ),
        { readOnly: true },
      );
      return rows.map(mapMine);
    },
  );

  app.get(
    '/v1/employees/:id/payslips',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Array(MyPayslip), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const own = auth.principal.employeeId === id;
        if (
          !(own
            ? can(auth.principal, 'payslips.read_own', { employeeId: id })
            : can(auth.principal, 'payslips.read', await loadTarget(tx, id)))
        )
          throw new ApiError('forbidden');
        if (!own)
          await app.audit(tx, req, {
            action: 'payslips.listed',
            targetType: 'employee',
            targetId: id,
            sensitive: true,
          });
        return (
          await tx.query<PayslipRow>(
            `${PUBLISHED} AND p.employee_id = $1 ORDER BY p.published_at DESC LIMIT 500`,
            [id],
          )
        ).map(mapMine);
      });
    },
  );

  app.get(
    '/v1/payslips/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ url: Type.String(), fileName: Type.String() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const out = await app.tenantTx(req, async (tx) => {
        const p = await tx.maybe<PayslipRow>(`${PUBLISHED} AND p.id = $1`, [id]);
        if (!p) throw new ApiError('notFound');
        const own = p.employee_id === auth.principal.employeeId;
        const ok = own
          ? can(auth.principal, 'payslips.read_own', { employeeId: p.employee_id })
          : can(auth.principal, 'payslips.read', await loadTarget(tx, p.employee_id));
        // other people's payslips are indistinguishable from missing ones
        if (!ok) throw new ApiError('notFound');
        if (own && !p.first_viewed_at)
          await tx.exec('UPDATE app.payslips SET first_viewed_at = $2 WHERE id = $1', [
            id,
            deps.now().toISOString(),
          ]);
        await app.audit(tx, req, {
          action: 'payslip.downloaded',
          targetType: 'payslip',
          targetId: id,
          diff: { own },
          sensitive: true,
        });
        return { key: p.file_key, fileName: p.file_name };
      });
      return { url: await deps.objects.presignGet(out.key, out.fileName), fileName: out.fileName };
    },
  );
}
