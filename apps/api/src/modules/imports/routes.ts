import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import ExcelJS from 'exceljs';
import { canSome, fieldAccess } from '@thapsus/core/permissions';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { registerJob } from '../../jobs/registry';
import { FIELDS, permKeyFor } from '../employees/model';
import { applyEmployeeChange, applySectionChange, employeeAsOf, refreshCurrent, scopePredicate, setManager } from '../employees/service';
import { readTable, suggestMapping, validateRow, IMPORT_TARGETS, type RowError } from './parse';
import type { Deps } from '../../deps';

const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

async function refMaps(tx: Tx) {
  const m = async (sql: string) => new Map((await tx.query<{ name: string; id: string }>(sql)).map((r) => [r.name.toLowerCase(), r.id]));
  return {
    entities: await m('SELECT name, id FROM app.legal_entities'),
    departments: await m('SELECT name, id FROM app.departments'),
    locations: await m('SELECT name, id FROM app.locations'),
  };
}

function mapRow(headers: string[], row: string[], mapping: Record<string, string>) {
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const target = mapping[h];
    if (target) out[target] = row[i] ?? '';
  });
  return out;
}

export async function importRoutes(app: FastifyInstance) {
  const deps = app.deps;
  await app.register(multipart, { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

  app.post(
    '/v1/imports',
    { config: { selfAudited: true }, schema: { tags: ['imports'], consumes: ['multipart/form-data'], response: { 201: Type.Object({ id: Uuid, headers: Type.Array(Type.String()), rowCount: Type.Integer(), suggestedMapping: Type.Record(Type.String(), Type.String()), targets: Type.Array(Type.String()) }), 400: Problem, 403: Problem } } },
    async (req, reply) => {
      const auth = authorizeSome(req, 'imports.run');
      const file = await req.file();
      if (!file) throw new ApiError('validation', 'No file');
      if (!/\.(csv|xlsx)$/i.test(file.filename)) throw new ApiError('validation', 'Upload a .csv or .xlsx file');
      const buf = await file.toBuffer();
      const table = await readTable(buf, file.filename);
      if (!table.headers.length) throw new ApiError('validation', 'The file has no header row');
      const key = objectKey(auth.tenantId, 'imports', /\.xlsx$/i.test(file.filename) ? '.xlsx' : '.csv');
      await deps.objects.put(key, buf, file.mimetype);
      const id = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.import_batches (tenant_id, file_key, file_name, file_sha256, row_count, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [key, file.filename, createHash('sha256').update(buf).digest('hex'), table.rows.length, auth.userId],
        );
        await app.audit(tx, req, { action: 'import.uploaded', targetType: 'import', targetId: r.id, diff: { file: file.filename, rows: table.rows.length } });
        return r.id;
      });
      return reply.status(201).send({ id, headers: table.headers, rowCount: table.rows.length, suggestedMapping: suggestMapping(table.headers), targets: [...IMPORT_TARGETS] });
    },
  );

  app.post(
    '/v1/imports/:id/preview',
    { config: { selfAudited: true }, schema: { tags: ['imports'], params: Type.Object({ id: Uuid }), body: Type.Object({ mapping: Type.Record(Type.String(), Type.String()) }), response: { 200: Type.Object({ rows: Type.Integer(), valid: Type.Integer(), creates: Type.Integer(), updates: Type.Integer(), errors: Type.Array(Type.Object({ row: Type.Integer(), column: Type.String(), message: Type.String() })), sample: Type.Array(Type.Any()) }), 404: Problem } } },
    async (req) => {
      authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const { mapping } = req.body as { mapping: Record<string, string> };
      for (const t of Object.values(mapping)) if (!(IMPORT_TARGETS as readonly string[]).includes(t)) throw new ApiError('validation', `Unknown target ${t}`);
      return app.tenantTx(req, async (tx) => {
        const batch = await tx.maybe<{ file_key: string; file_name: string }>('SELECT file_key, file_name FROM app.import_batches WHERE id = $1', [id]);
        if (!batch) throw new ApiError('notFound');
        const table = await readTable(await deps.objects.get(batch.file_key), batch.file_name);
        const refs = await refMaps(tx);
        const existing = new Set((await tx.query<{ employee_number: string }>('SELECT employee_number FROM app.employees')).map((r) => r.employee_number));
        const errors: RowError[] = [];
        let creates = 0;
        let updates = 0;
        const sample: unknown[] = [];
        table.rows.forEach((row, i) => {
          const { values, errors: e } = validateRow(mapRow(table.headers, row, mapping), i + 2, refs);
          errors.push(...e);
          if (!e.length) {
            if (existing.has(String(values.employeeNumber))) updates++;
            else creates++;
          }
          if (sample.length < 5) sample.push(values);
        });
        await tx.exec(`UPDATE app.import_batches SET mapping = $2, status = 'previewed', stats = $3 WHERE id = $1`, [id, JSON.stringify(mapping), JSON.stringify({ creates, updates, errors: errors.length })]);
        req.auditWritten = true;
        return { rows: table.rows.length, valid: creates + updates, creates, updates, errors: errors.slice(0, 1000), sample };
      });
    },
  );

  app.post(
    '/v1/imports/:id/run',
    { config: { selfAudited: true }, schema: { tags: ['imports'], params: Type.Object({ id: Uuid }), body: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }), response: { 202: Type.Object({ jobId: Uuid, created: Type.Boolean() }), 404: Problem, 409: Problem } } },
    async (req, reply) => {
      const auth = authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const dryRun = !!(req.body as { dryRun?: boolean }).dryRun;
      const out = await app.tenantTx(req, async (tx) => {
        const batch = await tx.maybe<{ file_sha256: string; mapping: Record<string, string>; status: string }>('SELECT file_sha256, mapping, status FROM app.import_batches WHERE id = $1', [id]);
        if (!batch) throw new ApiError('notFound');
        if (batch.status === 'uploaded') throw new ApiError('conflict', 'Preview the import first');
        // Idempotent: running the same batch (file + mapping + mode) again reuses its job; re-uploading the
        // same file creates a new batch whose rows are upserted, so unchanged rows change nothing.
        const key = createHash('sha256').update(`${id}:${batch.file_sha256}:${JSON.stringify(batch.mapping)}:${dryRun}`).digest('hex');
        const job = await enqueueJob(tx, 'imports.employees', key, { batchId: id, dryRun }, { createdBy: auth.userId });
        await tx.exec(`UPDATE app.import_batches SET job_id = $2, status = 'running' WHERE id = $1 AND $3`, [id, job.id, !dryRun]);
        await app.audit(tx, req, { action: 'import.started', targetType: 'import', targetId: id, diff: { dryRun, jobId: job.id, reused: !job.created } });
        return { jobId: job.id, created: job.created };
      });
      return reply.status(202).send(out);
    },
  );

  app.get(
    '/v1/imports/:id',
    { schema: { tags: ['imports'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ id: Uuid, status: Type.String(), stats: Type.Any(), rowCount: Nullable(Type.Integer()), jobId: Nullable(Type.String()), errorReportUrl: Nullable(Type.String()) }), 404: Problem } } },
    async (req) => {
      authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const b = await app.tenantTx(req, (tx) => tx.maybe<{ id: string; status: string; stats: unknown; row_count: number | null; job_id: string | null; error_file_key: string | null }>('SELECT * FROM app.import_batches WHERE id = $1', [id]), { readOnly: true });
      if (!b) throw new ApiError('notFound');
      return { id: b.id, status: b.status, stats: b.stats, rowCount: b.row_count, jobId: b.job_id, errorReportUrl: b.error_file_key ? await deps.objects.presignGet(b.error_file_key, 'import-errors.csv') : null };
    },
  );

  // ---- export ------------------------------------------------------------------------------------------
  app.get(
    '/v1/exports/employees',
    { config: { selfAudited: true }, schema: { tags: ['exports'], querystring: Type.Object({ format: Type.Union([Type.Literal('csv'), Type.Literal('xlsx')]), fields: Type.Optional(Type.String({ maxLength: 2000 })), status: Type.Optional(Type.String()) }), response: { 200: Type.Any(), 403: Problem, 413: Problem } } },
    async (req, reply) => {
      const auth = authorizeSome(req, 'exports.run');
      const q = req.query as { format: 'csv' | 'xlsx'; fields?: string; status?: string };
      const fields = (q.fields?.split(',') ?? ['employeeNumber', 'displayName', 'jobTitle', 'department', 'location', 'country', 'status', 'startDate', 'workEmail']).filter(Boolean);
      const rows = await app.tenantTx(req, async (tx) => {
        const params: unknown[] = [];
        const scope = scopePredicate(auth.principal, 'employees.read', params);
        params.push(q.status ?? 'active');
        const ids = await tx.query<{ id: string; entity_id: string | null; country: string | null; department_id: string | null; location_id: string | null; manager_id: string | null }>(
          `SELECT id, entity_id, country, department_id, location_id, manager_id FROM app.employees e WHERE ${scope} AND ($${params.length} = 'all' OR e.status = $${params.length}) ORDER BY display_name, id LIMIT 10001`,
          params,
        );
        if (ids.length > 10_000) throw new ApiError('unprocessable', 'More than 10,000 rows — use the report builder background export');
        const today = new Date().toISOString().slice(0, 10);
        const out: Array<Record<string, unknown>> = [];
        for (const r of ids) {
          const target = { employeeId: r.id, entityId: r.entity_id, country: r.country, departmentId: r.department_id, locationId: r.location_id, managerChain: r.manager_id ? [r.manager_id] : [] };
          const view = await employeeAsOf(tx, r.id, today);
          // field-level permissions: a column the caller cannot read is blank for that row
          out.push(Object.fromEntries(fields.map((f) => [f, fieldAccess(auth.principal, 'employee', permKeyFor(f), target) === 'none' ? '' : (view[f] ?? '')])));
        }
        await app.audit(tx, req, { action: 'export.employees', diff: { format: q.format, rows: out.length, fields } });
        return out;
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (q.format === 'csv') {
        const cell = (v: unknown) => {
          const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
        };
        const csv = [fields.join(','), ...rows.map((r) => fields.map((f) => cell(r[f])).join(','))].join('\r\n');
        return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="employees_${stamp}.csv"`).send(csv);
      }
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Employees');
      ws.addRow(fields);
      for (const r of rows) ws.addRow(fields.map((f) => (typeof r[f] === 'object' && r[f] !== null ? JSON.stringify(r[f]) : r[f])));
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="employees_${stamp}.xlsx"`).send(buf);
    },
  );

  void canSome;
}

// ---- the import job: chunked, progress-reporting, idempotent ----------------------------------------------
registerJob('imports.employees', async (ctx) => {
  const deps = ctx.deps as Deps;
  const { batchId, dryRun } = ctx.job.input as { batchId: string; dryRun: boolean };
  const batch = await ctx.tx((tx) => tx.one<{ file_key: string; file_name: string; mapping: Record<string, string> }>('SELECT file_key, file_name, mapping FROM app.import_batches WHERE id = $1', [batchId]));
  const table = await readTable(await deps.objects.get(batch.file_key), batch.file_name);
  const refs = await ctx.tx(refMaps);
  const stats = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  const errors: RowError[] = [];
  const managerLinks: Array<[string, string, string]> = [];
  const CHUNK = 500;
  await ctx.progress(0, table.rows.length);
  for (let start = 0; start < table.rows.length; start += CHUNK) {
    const rows = table.rows.slice(start, start + CHUNK).map((row, i) => ({ n: start + i + 2, ...validateRow(mapRow(table.headers, row, batch.mapping), start + i + 2, refs) }));
    await ctx.tx(async (tx) => {
      const numbers = rows.filter((r) => !r.errors.length).map((r) => String(r.values.employeeNumber));
      const existing = new Map((await tx.query<{ employee_number: string; id: string }>('SELECT employee_number, id FROM app.employees WHERE employee_number = ANY($1)', [numbers])).map((e) => [e.employee_number, e.id]));
      for (const r of rows) {
        if (r.errors.length) {
          errors.push(...r.errors);
          stats.failed++;
          continue;
        }
        const v = r.values;
        if (v.managerEmployeeNumber) managerLinks.push([String(v.employeeNumber), String(v.managerEmployeeNumber), String(v.effectiveDate ?? v.startDate ?? new Date().toISOString().slice(0, 10))]);
        delete v.managerEmployeeNumber;
        try {
          await tx.exec('SAVEPOINT row');
          const id = existing.get(String(v.employeeNumber));
          if (!id) {
            if (!v.startDate) throw new Error('startDate is required for new employees');
            if (!dryRun) {
              const e = await tx.one<{ id: string }>(`INSERT INTO app.employees (tenant_id, employee_number, start_date, end_date, work_email, display_name) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [v.employeeNumber, v.startDate, v.endDate ?? null, v.workEmail ?? null, `${v.preferredName ?? v.legalFirstName ?? ''} ${v.legalLastName ?? ''}`.trim()]);
              for (const s of ['personal', 'job', 'pay', 'contract'] as const) {
                const sv = Object.fromEntries(Object.entries(v).filter(([k]) => FIELDS[k]?.section === s));
                if (Object.keys(sv).length) await applySectionChange(tx, e.id, s, String(v.startDate), sv, ctx.job.created_by);
              }
              existing.set(String(v.employeeNumber), e.id);
            }
            stats.created++;
          } else {
            const date = String(v.effectiveDate ?? new Date().toISOString().slice(0, 10));
            const current = await employeeAsOf(tx, id, date);
            const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => k in FIELDS && FIELDS[k]!.section !== 'core' && String(current[k] ?? '') !== String(val)));
            // Re-importing the same file changes nothing (idempotent): only real differences are applied.
            if (!Object.keys(changed).length) stats.unchanged++;
            else {
              if (!dryRun) await applyEmployeeChange(tx, id, { ...changed, effectiveDate: date }, ctx.job.created_by);
              stats.updated++;
            }
          }
          await tx.exec('RELEASE SAVEPOINT row');
        } catch (e) {
          await tx.exec('ROLLBACK TO SAVEPOINT row');
          errors.push({ row: r.n, column: '', message: (e as Error).message.slice(0, 200) });
          stats.failed++;
        }
      }
    });
    await ctx.progress(Math.min(start + CHUNK, table.rows.length), table.rows.length);
  }
  if (!dryRun && managerLinks.length) {
    for (let i = 0; i < managerLinks.length; i += 1000) {
      await ctx.tx(async (tx) => {
        for (const [emp, mgr, date] of managerLinks.slice(i, i + 1000)) {
          const ids = await tx.query<{ employee_number: string; id: string; manager_id: string | null }>('SELECT employee_number, id, manager_id FROM app.employees WHERE employee_number = ANY($1)', [[emp, mgr]]);
          const e = ids.find((x) => x.employee_number === emp);
          const m = ids.find((x) => x.employee_number === mgr);
          if (!e || !m) {
            errors.push({ row: 0, column: 'managerEmployeeNumber', message: `manager ${mgr} not found for ${emp}` });
            continue;
          }
          if (e.manager_id === m.id) continue;
          await setManager(tx, e.id, m.id, date, 'solid', ctx.job.created_by).catch((err: Error) => errors.push({ row: 0, column: 'managerEmployeeNumber', message: err.message }));
        }
      });
    }
    await ctx.tx((tx) => refreshCurrent(tx, null));
  } else if (!dryRun) await ctx.tx((tx) => refreshCurrent(tx, null));
  let errorKey: string | null = null;
  if (errors.length) {
    errorKey = objectKey(ctx.tenantId, 'imports', '.csv');
    const csv = ['row,column,message', ...errors.map((e) => `${e.row},"${e.column}","${e.message.replace(/"/g, '""')}"`)].join('\r\n');
    await deps.objects.put(errorKey, Buffer.from(csv), 'text/csv');
  }
  await ctx.tx((tx) => tx.exec(`UPDATE app.import_batches SET status = $2, stats = $3, error_file_key = $4 WHERE id = $1`, [batchId, dryRun ? 'previewed' : 'completed', JSON.stringify({ ...stats, dryRun, errors: errors.length }), errorKey]));
  return { ...stats, dryRun, errors: errors.length };
});
