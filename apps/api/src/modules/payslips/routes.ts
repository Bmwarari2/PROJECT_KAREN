import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { can, canSome } from '@thapsus/core/permissions';
import { isLocale, type Locale } from '@thapsus/core/i18n';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { contentDisposition } from '../../http/security';
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
import { renderPayslipPdf } from './pdf';
import {
  checkStatement,
  PayslipStatement,
  StatementImport,
  storedStatement,
  type PayslipStatement as Statement,
} from './statement';

/**
 * Payslip and year-end document upload (PROGRESS 6.3). Files go to the home-region object store as
 * restricted documents: only the employee and payroll roles (payslips.*) can see them — not managers and
 * not the general document library. Every download is audited as sensitive.
 */
const KINDS = ['payslip', 'year_end'] as const;
const DOC_TYPES = ['payslip', 'p60', 'p11d', 'w2', 'form_1099', 'annual_statement', 'other'] as const;

const Item = Type.Object({
  id: Uuid,
  /** Null for a provider statement that came without a PDF. */
  fileName: Nullable(Type.String()),
  sizeBytes: Nullable(Type.Integer()),
  sha256: Nullable(Type.String()),
  hasStatement: Type.Boolean(),
  currency: Nullable(Type.String()),
  netMinor: Nullable(Type.String()),
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
  /** `files` (PDFs matched by name) or `provider_statements` (structured content from the payroll provider). */
  source: Type.String(),
  providerName: Nullable(Type.String()),
  sample: Type.Boolean(),
});
const BatchDetail = Type.Object({
  ...Batch.properties,
  items: Type.Array(Item),
  rejected: Type.Array(Type.Object({ name: Type.String(), reason: Type.String() })),
});
const Ytd = Type.Array(Type.Object({ key: Type.String(), label: Type.String(), amountMinor: Type.String() }));
const MyPayslip = Type.Object({
  id: Uuid,
  kind: Type.String(),
  docType: Type.String(),
  label: Type.String(),
  payDate: Nullable(Type.String()),
  taxYear: Nullable(Type.String()),
  fileName: Nullable(Type.String()),
  publishedAt: Type.String(),
  viewed: Type.Boolean(),
  /** Structured content from the payroll provider (ADR-0167); the amounts are the provider's, never ours. */
  hasStatement: Type.Boolean(),
  hasFile: Type.Boolean(),
  periodStart: Nullable(Type.String()),
  periodEnd: Nullable(Type.String()),
  currency: Nullable(Type.String()),
  grossMinor: Nullable(Type.String()),
  netMinor: Nullable(Type.String()),
  providerName: Nullable(Type.String()),
  sample: Type.Boolean(),
  /** Year-to-date figures as the provider printed them on this payslip. */
  ytd: Nullable(Ytd),
  ytdTaxYear: Nullable(Type.String()),
});
const PayslipDetail = Type.Object({
  ...MyPayslip.properties,
  employeeId: Uuid,
  employeeName: Nullable(Type.String()),
  statement: Nullable(PayslipStatement),
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
  source: string;
  provider_name: string | null;
  sample: boolean;
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
  source: b.source,
  providerName: b.provider_name,
  sample: b.sample,
});
type ItemRow = {
  id: string;
  file_name: string | null;
  size_bytes: number | null;
  sha256: string | null;
  has_statement: boolean;
  currency: string | null;
  net_minor: string | null;
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
  hasStatement: i.has_statement,
  currency: i.currency,
  netMinor: i.net_minor,
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
  file_name: string | null;
  file_key: string | null;
  published_at: string;
  first_viewed_at: string | null;
  statement: Statement | null;
  period_start: string | null;
  period_end: string | null;
  currency: string | null;
  gross_minor: string | null;
  net_minor: string | null;
  provider_name: string | null;
  sample: boolean;
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
  hasStatement: !!p.statement,
  hasFile: !!p.file_key,
  periodStart: p.period_start,
  periodEnd: p.period_end,
  currency: p.currency,
  grossMinor: p.gross_minor,
  netMinor: p.net_minor,
  providerName: p.provider_name,
  sample: p.sample || !!p.statement?.illustrative,
  ytd: p.statement?.ytd
    ? p.statement.ytd.map((y) => ({ key: y.key, label: y.label, amountMinor: String(y.amountMinor) }))
    : null,
  ytdTaxYear: p.statement?.period.taxYear ?? null,
});
const ITEM_COLS = `p.id, p.file_name, p.size_bytes, p.sha256, (p.statement IS NOT NULL) AS has_statement, p.currency, p.net_minor::text AS net_minor,
  p.match_status, p.employee_id, e.employee_number, e.display_name, p.status, p.match_detail`;

export async function payslipRoutes(app: FastifyInstance) {
  const deps = app.deps;
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 500, fields: 20, fieldSize: 1000 },
  });

  const batchDetail = async (tx: Tx, id: string, rejected: Array<{ name: string; reason: string }> = []) => {
    const b = await tx.maybe<BatchRow>('SELECT * FROM app.payslip_batches WHERE id = $1', [id]);
    if (!b) throw new ApiError('notFound');
    const items = await tx.query<ItemRow>(
      `SELECT ${ITEM_COLS}
         FROM app.payslips p LEFT JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id WHERE p.batch_id = $1 ORDER BY coalesce(p.file_name, e.employee_number), p.id`,
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
          'Bulk upload payslips or year-end documents (PDFs or a zip of PDFs) and/or the payroll provider’s structured statements (a JSON file in the `statements` part, StatementImport); returns the matching preview',
        consumes: ['multipart/form-data'],
        response: { 201: BatchDetail, 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'payslips.manage')) throw new ApiError('forbidden');
      const fields: Record<string, string> = {};
      const files: UploadedFile[] = [];
      let statementsFile: Buffer | undefined;
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
          if (part.fieldname === 'statements') {
            if (statementsFile) throw new ApiError('validation', 'Send one statements file');
            statementsFile = body;
          } else files.push({ name: (part.filename || 'file').slice(0, 255), body });
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
      // The provider's statements (ADR-0167): the shape is checked, then each statement's lines against its totals.
      let imported: StatementImport | undefined;
      if (statementsFile) {
        if (kind !== 'payslip') throw new ApiError('validation', 'Statements are for payslips only');
        let json: unknown;
        try {
          json = JSON.parse(statementsFile.toString('utf8'));
        } catch {
          throw new ApiError('validation', 'The statements file is not valid JSON');
        }
        if (!Value.Check(StatementImport, json))
          throw new ApiError('validation', 'The statements file does not match the statement format', {
            errors: [...Value.Errors(StatementImport, json)]
              .slice(0, 20)
              .map((e) => ({ path: e.instancePath, message: e.message })),
          });
        imported = json as StatementImport;
      }
      const expanded = await expandUploads(files);
      const accepted = expanded.accepted;
      const rejected: Array<{ name: string; reason: string }> = expanded.rejected;
      if (!accepted.length && !imported) throw new ApiError('validation', 'No PDF files found', { rejected });
      const out = await app.tenantTx(req, async (tx) => {
        const b = await tx.one<{ id: string }>(
          `INSERT INTO app.payslip_batches (tenant_id, kind, doc_type, label, pay_date, tax_year, match_by, pattern, created_by, source, provider_name, sample)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            kind,
            docType,
            label,
            fields.payDate || imported?.statements[0]?.period.payDate || null,
            fields.taxYear?.slice(0, 20) || null,
            matchBy,
            pattern,
            auth.userId,
            imported ? 'provider_statements' : 'files',
            imported?.provider.name ?? null,
            !!imported?.sample,
          ],
        );
        // look up only the employee numbers that appear in the file names and statements, within the uploader's scope
        const wanted = [
          ...new Set([
            ...accepted.flatMap((f) => candidates(f.name, matchBy, pattern)),
            ...(imported?.statements ?? []).map((st) => st.employeeNumber.toLowerCase()),
          ]),
        ];
        const params: unknown[] = [wanted];
        const scope = scopePredicate(auth.principal, 'payslips.manage', params);
        const emps = await tx.query<{ id: string; employee_number: string }>(
          `SELECT e.id, e.employee_number FROM app.employees e WHERE lower(e.employee_number) = ANY($1::text[]) AND ${scope}`,
          params,
        );
        const numbers = new Map(
          emps.map((e) => [e.employee_number.toLowerCase(), { id: e.id, employeeNumber: e.employee_number }]),
        );
        // statements by employee: a PDF matched to the same person in this upload is attached to their statement
        const statements = new Map<string, Statement>();
        const loose: Statement[] = [];
        for (const st of imported?.statements ?? []) {
          const problems = checkStatement(st);
          if (problems.length) {
            rejected.push({ name: st.employeeNumber, reason: problems[0]! });
            continue;
          }
          const e = numbers.get(st.employeeNumber.toLowerCase());
          if (e && statements.has(e.id)) rejected.push({ name: st.employeeNumber, reason: 'duplicate' });
          else if (e) statements.set(e.id, storedStatement(st));
          else loose.push(storedStatement(st));
        }
        const insert = (row: {
          employeeId: string | null;
          file?: { name: string; key: string; size: number; sha: string };
          statement?: Statement;
          status: string;
          detail: unknown;
        }) =>
          tx.exec(
            `INSERT INTO app.payslips (tenant_id, batch_id, employee_id, file_name, file_key, size_bytes, sha256, match_status, match_detail,
                                       statement, pay_date, period_start, period_end, currency, gross_minor, net_minor)
             VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              b.id,
              row.employeeId,
              row.file?.name ?? null,
              row.file?.key ?? null,
              row.file?.size ?? null,
              row.file?.sha ?? null,
              row.status,
              JSON.stringify(row.detail),
              row.statement ? JSON.stringify(row.statement) : null,
              row.statement?.period.payDate ?? null,
              row.statement?.period.start ?? null,
              row.statement?.period.end ?? null,
              row.statement?.currency ?? null,
              row.statement?.totals.grossMinor ?? null,
              row.statement?.totals.netMinor ?? null,
            ],
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
          const statement = m.employeeId ? statements.get(m.employeeId) : undefined;
          if (statement) statements.delete(m.employeeId!);
          await insert({
            employeeId: m.employeeId,
            file: { name: f.name, key, size: f.body.length, sha },
            statement,
            status: m.status,
            detail: m.detail,
          });
          stored++;
        }
        for (const [employeeId, statement] of statements) {
          matched++;
          stored++;
          await insert({
            employeeId,
            statement,
            status: 'matched',
            detail: { employeeNumber: statement.employeeNumber },
          });
        }
        for (const statement of loose) {
          stored++;
          await insert({
            employeeId: null,
            statement,
            status: 'unmatched',
            detail: { reason: 'noEmployeeNumber' },
          });
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
          diff: {
            kind,
            docType,
            label,
            files: accepted.length,
            statements: imported?.statements.length ?? 0,
            stored,
            matched,
            rejected: rejected.length,
            provider: imported?.provider.name ?? null,
            sample: !!imported?.sample,
          },
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
          `SELECT ${ITEM_COLS} FROM app.payslips p LEFT JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id WHERE p.id = $1`,
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
        const ready = await tx.query<{ id: string; employee_id: string; period_start: string | null }>(
          `SELECT id, employee_id, period_start::text AS period_start FROM app.payslips WHERE batch_id = $1 AND status = 'draft' AND employee_id IS NOT NULL`,
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
                // a provider statement knows its period: the month is formatted in each reader's locale
                ...(b.kind === 'payslip' && p.period_start
                  ? { titleKey: 'notify.payslipReady', params: { period: p.period_start } }
                  : {
                      titleKey: b.kind === 'payslip' ? 'notify.payslipAvailable' : 'notify.yearEndAvailable',
                      params: { label: b.label },
                    }),
                // the payslip's own page (ADR-0160, ADR-0167)
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
        const rows = await tx.query<{ file_key: string | null }>(
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
      for (const k of keys) if (k) await deps.objects.delete(k);
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
        const p = await tx.maybe<{ employee_id: string | null; file_key: string | null; status: string }>(
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
      if (key) await deps.objects.delete(key);
      return { id, status: 'discarded' };
    },
  );

  // ---- self-service and payroll views --------------------------------------------------------------------------------
  const PUBLISHED = `SELECT p.id, p.employee_id, b.kind, b.doc_type, b.label, coalesce(p.pay_date, b.pay_date)::text AS pay_date, b.tax_year, p.file_name, p.file_key,
                            p.published_at, p.first_viewed_at, p.statement, p.period_start::text AS period_start, p.period_end::text AS period_end, p.currency,
                            p.gross_minor::text AS gross_minor, p.net_minor::text AS net_minor, b.provider_name, b.sample
                       FROM app.payslips p JOIN app.payslip_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id WHERE p.status = 'published'`;
  const ORDER = `ORDER BY coalesce(p.pay_date, b.pay_date, p.published_at::date) DESC, p.published_at DESC`;
  const YEAR = `($2::int IS NULL OR extract(year FROM coalesce(p.pay_date, b.pay_date, p.published_at::date)) = $2::int)`;

  app.get(
    '/v1/me/payslips',
    {
      schema: {
        tags: ['payslips'],
        summary: 'My payslips and year-end documents (optionally one calendar year of pay dates)',
        querystring: Type.Object({ year: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2999 })) }),
        response: { 200: Type.Array(MyPayslip) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const employeeId = auth.principal.employeeId;
      if (!employeeId || !can(auth.principal, 'payslips.read_own', { employeeId })) return [];
      const year = (req.query as { year?: number }).year ?? null;
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<PayslipRow>(`${PUBLISHED} AND p.employee_id = $1 AND ${YEAR} ${ORDER} LIMIT 500`, [
            employeeId,
            year,
          ]),
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
        querystring: Type.Object({ year: Type.Optional(Type.Integer({ minimum: 1900, maximum: 2999 })) }),
        response: { 200: Type.Array(MyPayslip), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const year = (req.query as { year?: number }).year ?? null;
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
          await tx.query<PayslipRow>(`${PUBLISHED} AND p.employee_id = $1 AND ${YEAR} ${ORDER} LIMIT 500`, [
            id,
            year,
          ])
        ).map(mapMine);
      });
    },
  );

  /** A published payslip the caller may read (theirs, or one they hold payslips.read for); others are a 404. */
  async function readable(tx: Tx, req: FastifyRequest, id: string) {
    const auth = requireAuth(req);
    const p = await tx.maybe<PayslipRow & { employee_name: string | null }>(
      `${PUBLISHED.replace('FROM app.payslips p', ', e.display_name AS employee_name FROM app.payslips p LEFT JOIN app.employees e ON e.tenant_id = p.tenant_id AND e.id = p.employee_id')} AND p.id = $1`,
      [id],
    );
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
    return { p, own };
  }
  const localeOf = (req: FastifyRequest): Locale => {
    const l = requireAuth(req).user.locale;
    return isLocale(l) ? l : req.ctx.locale;
  };
  const pdfName = (p: PayslipRow) =>
    `payslip-${p.statement?.employeeNumber ?? 'statement'}-${p.pay_date ?? p.published_at.slice(0, 10)}.pdf`.replace(
      /[^\w.-]+/g,
      '_',
    );

  app.get(
    '/v1/payslips/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary:
          'One payslip with the provider’s structured statement (every view is audited as sensitive); amounts are the provider’s',
        params: Type.Object({ id: Uuid }),
        response: { 200: PayslipDetail, 404: Problem },
      },
    },
    async (req) =>
      app.tenantTx(req, async (tx) => {
        const { p, own } = await readable(tx, req, (req.params as { id: string }).id);
        await app.audit(tx, req, {
          action: 'payslip.viewed',
          targetType: 'payslip',
          targetId: p.id,
          diff: { own },
          sensitive: true,
        });
        return {
          ...mapMine({ ...p, first_viewed_at: p.first_viewed_at ?? deps.now().toISOString() }),
          employeeId: p.employee_id,
          employeeName: p.employee_name,
          statement: p.statement,
        };
      }),
  );

  app.get(
    '/v1/payslips/:id/file',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary:
          'The payroll provider’s PDF, for the in-app viewer (inline) or as a download (download=true)',
        params: Type.Object({ id: Uuid }),
        querystring: Type.Object({ download: Type.Optional(Type.Boolean()) }),
        response: { 404: Problem },
      },
    },
    async (req, reply) => {
      const download = !!(req.query as { download?: boolean }).download;
      const out = await app.tenantTx(req, async (tx) => {
        const { p, own } = await readable(tx, req, (req.params as { id: string }).id);
        if (!p.file_key) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: download ? 'payslip.downloaded' : 'payslip.viewed',
          targetType: 'payslip',
          targetId: p.id,
          diff: { own, file: 'provider' },
          sensitive: true,
        });
        return { key: p.file_key, name: p.file_name ?? 'payslip.pdf' };
      });
      const body = await deps.objects.get(out.key);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(out.name, download ? 'attachment' : 'inline'))
        .send(body);
    },
  );

  app.get(
    '/v1/payslips/:id/pdf',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary:
          'A PDF of the provider’s statement, for payslips that came without the provider’s own PDF (the provider’s figures, laid out; nothing is calculated)',
        params: Type.Object({ id: Uuid }),
        response: { 404: Problem },
      },
    },
    async (req, reply) => {
      const out = await app.tenantTx(req, async (tx) => {
        const { p, own } = await readable(tx, req, (req.params as { id: string }).id);
        if (!p.statement) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'payslip.downloaded',
          targetType: 'payslip',
          targetId: p.id,
          diff: { own, file: 'generated' },
          sensitive: true,
        });
        return p;
      });
      const pdf = await renderPayslipPdf({
        statement: out.statement!,
        provider: out.provider_name,
        sample: out.sample || !!out.statement!.illustrative,
        locale: localeOf(req),
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(pdfName(out), 'attachment'))
        .send(Buffer.from(pdf));
    },
  );

  app.get(
    '/v1/payslips/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['payslips'],
        summary:
          'A download link: the provider’s PDF when there is one, otherwise a PDF of the provider’s statement',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ url: Type.String(), fileName: Type.String() }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const out = await app.tenantTx(req, async (tx) => {
        const { p, own } = await readable(tx, req, id);
        if (!p.file_key) return { key: null, fileName: pdfName(p) };
        await app.audit(tx, req, {
          action: 'payslip.downloaded',
          targetType: 'payslip',
          targetId: id,
          diff: { own },
          sensitive: true,
        });
        return { key: p.file_key, fileName: p.file_name ?? pdfName(p) };
      });
      // a statement without the provider's PDF is downloaded (and audited) through the generated-PDF route
      return {
        url: out.key ? await deps.objects.presignGet(out.key, out.fileName) : `/v1/payslips/${id}/pdf`,
        fileName: out.fileName,
      };
    },
  );
}
