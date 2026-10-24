import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { checkZipBounds, isZipArchive } from '../../lib/archive';
import { registerJob } from '../../jobs/registry';
import { FIELDS } from '../employees/model';
import {
  applyEmployeeChange,
  applySectionChange,
  employeeAsOf,
  refreshCurrent,
  refreshCurrentMany,
  setManager,
} from '../employees/service';
import { readTable, suggestMapping, validateRow, IMPORT_TARGETS, type RowError } from './parse';
import {
  bulkCreatable,
  bulkCreateEmployees,
  bulkLinkManagers,
  currentSectionValues,
  sameValue,
} from './bulk';
import type { Deps } from '../../deps';

const MAX_IMPORT_BYTES = 60 * 1024 * 1024;
/** Limits for an .xlsx import once unpacked (generous for 200,000 rows; a zip bomb stops here). */
export const XLSX_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 300 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
};
/** Rows per transaction (and per progress update) in the import job; tests lower it to see progress. */
export const importTuning = { chunkSize: 500 };
/** Created rows after which the job refreshes table statistics (see migration 0007i). */
const ANALYZE_AFTER_CREATES = 1000;

async function refMaps(tx: Tx) {
  const m = async (sql: string) =>
    new Map((await tx.query<{ name: string; id: string }>(sql)).map((r) => [r.name.toLowerCase(), r.id]));
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
    {
      config: { selfAudited: true, capability: 'people.imports' },
      schema: {
        tags: ['imports'],
        consumes: ['multipart/form-data'],
        response: {
          201: Type.Object({
            id: Uuid,
            headers: Type.Array(Type.String()),
            rowCount: Type.Integer(),
            suggestedMapping: Type.Record(Type.String(), Type.String()),
            targets: Type.Array(Type.String()),
          }),
          400: Problem,
          403: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'imports.run');
      const file = await req.file();
      if (!file) throw new ApiError('validation', 'No file');
      if (!/\.(csv|xlsx)$/i.test(file.filename))
        throw new ApiError('validation', 'Upload a .csv or .xlsx file');
      const buf = await file.toBuffer();
      if (/\.xlsx$/i.test(file.filename)) {
        // An .xlsx file is a zip archive: its entry count and inflated size are checked before the
        // spreadsheet parser opens it (ASVS V5.2.2, V5.2.3).
        if (!isZipArchive(buf)) throw new ApiError('validation', 'The file is not a valid .xlsx workbook');
        const problem = await checkZipBounds(buf, XLSX_LIMITS);
        if (problem)
          throw new ApiError(
            'validation',
            problem === 'badArchive'
              ? 'The file is not a valid .xlsx workbook'
              : 'The workbook is too large once unpacked',
            { reason: problem },
          );
      } else if (buf.subarray(0, 4096).includes(0)) {
        throw new ApiError('validation', 'The file is not a text CSV file');
      }
      const table = await readTable(buf, file.filename);
      if (!table.headers.length) throw new ApiError('validation', 'The file has no header row');
      const key = objectKey(auth.tenantId, 'imports', /\.xlsx$/i.test(file.filename) ? '.xlsx' : '.csv');
      await deps.objects.put(key, buf, file.mimetype);
      const id = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.import_batches (tenant_id, file_key, file_name, file_sha256, row_count, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
          [
            key,
            file.filename,
            createHash('sha256').update(buf).digest('hex'),
            table.rows.length,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'import.uploaded',
          targetType: 'import',
          targetId: r.id,
          diff: { file: file.filename, rows: table.rows.length },
        });
        return r.id;
      });
      return reply.status(201).send({
        id,
        headers: table.headers,
        rowCount: table.rows.length,
        suggestedMapping: suggestMapping(table.headers),
        targets: [...IMPORT_TARGETS],
      });
    },
  );

  app.post(
    '/v1/imports/:id/preview',
    {
      config: { selfAudited: true, capability: 'people.imports' },
      schema: {
        tags: ['imports'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ mapping: Type.Record(Type.String(), Type.String()) }),
        response: {
          200: Type.Object({
            rows: Type.Integer(),
            valid: Type.Integer(),
            creates: Type.Integer(),
            updates: Type.Integer(),
            errors: Type.Array(
              Type.Object({ row: Type.Integer(), column: Type.String(), message: Type.String() }),
            ),
            sample: Type.Array(Type.Any()),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const { mapping } = req.body as { mapping: Record<string, string> };
      for (const t of Object.values(mapping))
        if (!(IMPORT_TARGETS as readonly string[]).includes(t))
          throw new ApiError('validation', `Unknown target ${t}`);
      return app.tenantTx(req, async (tx) => {
        const batch = await tx.maybe<{ file_key: string; file_name: string }>(
          'SELECT file_key, file_name FROM app.import_batches WHERE id = $1',
          [id],
        );
        if (!batch) throw new ApiError('notFound');
        const table = await readTable(await deps.objects.get(batch.file_key), batch.file_name);
        const refs = await refMaps(tx);
        const existing = new Set(
          (await tx.query<{ employee_number: string }>('SELECT employee_number FROM app.employees')).map(
            (r) => r.employee_number,
          ),
        );
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
        await tx.exec(
          `UPDATE app.import_batches SET mapping = $2, status = 'previewed', stats = $3 WHERE id = $1`,
          [id, JSON.stringify(mapping), JSON.stringify({ creates, updates, errors: errors.length })],
        );
        req.auditWritten = true;
        return {
          rows: table.rows.length,
          valid: creates + updates,
          creates,
          updates,
          errors: errors.slice(0, 1000),
          sample,
        };
      });
    },
  );

  app.post(
    '/v1/imports/:id/run',
    {
      config: { selfAudited: true, capability: 'people.imports' },
      schema: {
        tags: ['imports'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
        response: { 202: Type.Object({ jobId: Uuid, created: Type.Boolean() }), 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const dryRun = !!(req.body as { dryRun?: boolean }).dryRun;
      const out = await app.tenantTx(req, async (tx) => {
        const batch = await tx.maybe<{
          file_sha256: string;
          mapping: Record<string, string>;
          status: string;
        }>('SELECT file_sha256, mapping, status FROM app.import_batches WHERE id = $1', [id]);
        if (!batch) throw new ApiError('notFound');
        if (batch.status === 'uploaded') throw new ApiError('conflict', 'Preview the import first');
        // Idempotent: running the same batch (file + mapping + mode) again reuses its job; re-uploading the
        // same file creates a new batch whose rows are upserted, so unchanged rows change nothing.
        const key = createHash('sha256')
          .update(`${id}:${batch.file_sha256}:${JSON.stringify(batch.mapping)}:${dryRun}`)
          .digest('hex');
        const job = await enqueueJob(
          tx,
          'imports.employees',
          key,
          { batchId: id, dryRun },
          { createdBy: auth.userId },
        );
        await tx.exec(`UPDATE app.import_batches SET job_id = $2, status = 'running' WHERE id = $1 AND $3`, [
          id,
          job.id,
          !dryRun,
        ]);
        await app.audit(tx, req, {
          action: 'import.started',
          targetType: 'import',
          targetId: id,
          diff: { dryRun, jobId: job.id, reused: !job.created },
        });
        return { jobId: job.id, created: job.created };
      });
      return reply.status(202).send(out);
    },
  );

  app.get(
    '/v1/imports/:id',
    {
      schema: {
        tags: ['imports'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            id: Uuid,
            status: Type.String(),
            stats: Type.Any(),
            rowCount: Nullable(Type.Integer()),
            jobId: Nullable(Type.String()),
            errorReportUrl: Nullable(Type.String()),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'imports.run');
      const { id } = req.params as { id: string };
      const b = await app.tenantTx(
        req,
        (tx) =>
          tx.maybe<{
            id: string;
            status: string;
            stats: unknown;
            row_count: number | null;
            job_id: string | null;
            error_file_key: string | null;
          }>('SELECT * FROM app.import_batches WHERE id = $1', [id]),
        { readOnly: true },
      );
      if (!b) throw new ApiError('notFound');
      return {
        id: b.id,
        status: b.status,
        stats: b.stats,
        rowCount: b.row_count,
        jobId: b.job_id,
        errorReportUrl: b.error_file_key
          ? await deps.objects.presignGet(b.error_file_key, 'import-errors.csv')
          : null,
      };
    },
  );
}

// ---- the import job: chunked, progress-reporting, idempotent ----------------------------------------------
registerJob('imports.employees', async (ctx) => {
  const deps = ctx.deps as Deps;
  const { batchId, dryRun } = ctx.job.input as { batchId: string; dryRun: boolean };
  const batch = await ctx.tx((tx) =>
    tx.one<{ file_key: string; file_name: string; mapping: Record<string, string> }>(
      'SELECT file_key, file_name, mapping FROM app.import_batches WHERE id = $1',
      [batchId],
    ),
  );
  const table = await readTable(await deps.objects.get(batch.file_key), batch.file_name);
  const refs = await ctx.tx(refMaps);
  const stats = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  const errors: RowError[] = [];
  const managerLinks: Array<{ row: number; employee: string; manager: string; date: string }> = [];
  /** People whose records this run wrote: their current values are refreshed at the end. */
  const touched = new Set<string>();
  const CHUNK = importTuning.chunkSize;
  const today = new Date().toISOString().slice(0, 10);
  await ctx.progress(0, table.rows.length);
  for (let start = 0; start < table.rows.length; start += CHUNK) {
    const rows = table.rows.slice(start, start + CHUNK).map((row, i) => ({
      n: start + i + 2,
      ...validateRow(mapRow(table.headers, row, batch.mapping), start + i + 2, refs),
    }));
    await ctx.tx(async (tx) => {
      const numbers = rows.filter((r) => !r.errors.length).map((r) => String(r.values.employeeNumber));
      const existing = new Map(
        (
          await tx.query<{ employee_number: string; id: string }>(
            'SELECT employee_number, id FROM app.employees WHERE employee_number = ANY($1)',
            [numbers],
          )
        ).map((e) => [e.employee_number, e.id]),
      );
      const valid: typeof rows = [];
      for (const r of rows) {
        if (r.errors.length) {
          errors.push(...r.errors);
          stats.failed++;
          continue;
        }
        const v = r.values;
        if (v.managerEmployeeNumber)
          managerLinks.push({
            row: r.n,
            employee: String(v.employeeNumber),
            manager: String(v.managerEmployeeNumber),
            date: String(v.effectiveDate ?? v.startDate ?? today),
          });
        delete v.managerEmployeeNumber;
        valid.push(r);
      }
      // 1. new people, in bulk (first occurrence of each number; the rest take the per-row path)
      const seen = new Set<string>();
      const bulkNew = valid.filter((r) => {
        const num = String(r.values.employeeNumber);
        const ok = !existing.has(num) && !seen.has(num) && bulkCreatable(r.values);
        seen.add(num);
        return ok;
      });
      let perRow = valid.filter((r) => !bulkNew.includes(r));
      if (bulkNew.length) {
        if (dryRun) stats.created += bulkNew.length;
        else {
          await tx.exec('SAVEPOINT bulk');
          try {
            for (const [num, id] of await bulkCreateEmployees(
              tx,
              bulkNew.map((r) => r.values),
              ctx.job.created_by,
            )) {
              existing.set(num, id);
              touched.add(id);
            }
            await tx.exec('RELEASE SAVEPOINT bulk');
            stats.created += bulkNew.length;
          } catch {
            // a constraint failed somewhere in the chunk: fall back to one row at a time for exact errors
            await tx.exec('ROLLBACK TO SAVEPOINT bulk');
            perRow = valid;
          }
        }
      }
      // 2. people who already exist: compare with the values in force (bulk read), apply only real changes
      const known = perRow.filter(
        (r) => existing.has(String(r.values.employeeNumber)) && !bulkNew.includes(r),
      );
      const byDate = new Map<string, typeof known>();
      for (const r of known) {
        const d = String(r.values.effectiveDate ?? today);
        (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(r);
      }
      const unchanged = new Set<(typeof rows)[number]>();
      for (const [d, group] of byDate) {
        const current = await currentSectionValues(
          tx,
          group.map((r) => existing.get(String(r.values.employeeNumber))!),
          d,
        );
        for (const r of group) {
          const cur = current.get(existing.get(String(r.values.employeeNumber))!)!;
          const changed = Object.entries(r.values).filter(
            ([k, val]) => k in FIELDS && FIELDS[k]!.section !== 'core' && !sameValue(k, cur[k], val),
          );
          if (!changed.length) unchanged.add(r);
          else
            r.values = {
              ...Object.fromEntries(changed),
              employeeNumber: r.values.employeeNumber,
              effectiveDate: d,
            };
        }
      }
      stats.unchanged += unchanged.size;
      // 3. everything else, one row at a time
      for (const r of perRow) {
        if (unchanged.has(r) || (bulkNew.includes(r) && perRow !== valid)) continue;
        const v = r.values;
        try {
          await tx.exec('SAVEPOINT row');
          const id = existing.get(String(v.employeeNumber));
          if (!id) {
            if (!v.startDate) throw new Error('startDate is required for new employees');
            if (!dryRun) {
              const e = await tx.one<{ id: string }>(
                `INSERT INTO app.employees (tenant_id, employee_number, start_date, end_date, work_email, display_name) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`,
                [
                  v.employeeNumber,
                  v.startDate,
                  v.endDate ?? null,
                  v.workEmail ?? null,
                  `${v.preferredName ?? v.legalFirstName ?? ''} ${v.legalLastName ?? ''}`.trim(),
                ],
              );
              for (const s of ['personal', 'job', 'pay', 'contract'] as const) {
                const sv = Object.fromEntries(Object.entries(v).filter(([k]) => FIELDS[k]?.section === s));
                if (Object.keys(sv).length)
                  await applySectionChange(tx, e.id, s, String(v.startDate), sv, ctx.job.created_by);
              }
              existing.set(String(v.employeeNumber), e.id);
              touched.add(e.id);
            }
            stats.created++;
          } else {
            const date = String(v.effectiveDate ?? today);
            const current = await employeeAsOf(tx, id, date);
            const changed = Object.fromEntries(
              Object.entries(v).filter(
                ([k, val]) => k in FIELDS && FIELDS[k]!.section !== 'core' && !sameValue(k, current[k], val),
              ),
            );
            // Re-importing the same file changes nothing (idempotent): only real differences are applied.
            if (!Object.keys(changed).length) stats.unchanged++;
            else {
              if (!dryRun)
                await applyEmployeeChange(tx, id, { ...changed, effectiveDate: date }, ctx.job.created_by);
              touched.add(id);
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
  // many new rows in one tenant: refresh planner statistics before the set-based steps below join on them
  if (!dryRun && stats.created >= ANALYZE_AFTER_CREATES)
    await ctx.tx((tx) => tx.query('SELECT app.analyze_core_hr()'));
  if (!dryRun && managerLinks.length) {
    for (let i = 0; i < managerLinks.length; i += 5000) {
      await ctx.tx(async (tx) => {
        const chunk = managerLinks.slice(i, i + 5000);
        const people = new Map(
          (
            await tx.query<{ employee_number: string; id: string; manager_id: string | null }>(
              'SELECT employee_number, id, manager_id FROM app.employees WHERE employee_number = ANY($1)',
              [[...new Set(chunk.flatMap((l) => [l.employee, l.manager]))]],
            )
          ).map((p) => [p.employee_number, p]),
        );
        const todo: Array<{ employeeId: string; managerId: string; date: string; row: number }> = [];
        for (const l of chunk) {
          const e = people.get(l.employee);
          const m = people.get(l.manager);
          if (!e || !m)
            errors.push({
              row: l.row,
              column: 'managerEmployeeNumber',
              message: `manager ${l.manager} not found for ${l.employee}`,
            });
          else if (e.manager_id !== m.id)
            todo.push({ employeeId: e.id, managerId: m.id, date: l.date, row: l.row }); // unchanged links are skipped
        }
        const { rest } = await bulkLinkManagers(tx, todo, ctx.job.created_by);
        for (const l of todo) touched.add(l.employeeId);
        for (const l of rest as typeof todo) {
          await tx.exec('SAVEPOINT link');
          try {
            await setManager(tx, l.employeeId, l.managerId, l.date, 'solid', ctx.job.created_by);
            // the next link's cycle check walks current managers: keep this person's up to date
            await refreshCurrent(tx, l.employeeId);
            await tx.exec('RELEASE SAVEPOINT link');
          } catch (err) {
            await tx.exec('ROLLBACK TO SAVEPOINT link');
            errors.push({
              row: l.row,
              column: 'managerEmployeeNumber',
              message: (err as Error).message.slice(0, 200),
            });
          }
        }
      });
    }
  }
  // denormalised current values (lists, search, org chart) for the people this run wrote, in short batches
  const ids = [...touched];
  for (let i = 0; i < ids.length; i += 2000)
    await ctx.tx((tx) => refreshCurrentMany(tx, ids.slice(i, i + 2000)));
  let errorKey: string | null = null;
  if (errors.length) {
    errorKey = objectKey(ctx.tenantId, 'imports', '.csv');
    const csv = [
      'row,column,message',
      ...errors.map((e) => `${e.row},"${e.column}","${e.message.replace(/"/g, '""')}"`),
    ].join('\r\n');
    await deps.objects.put(errorKey, Buffer.from(csv), 'text/csv');
  }
  await ctx.tx((tx) =>
    tx.exec(`UPDATE app.import_batches SET status = $2, stats = $3, error_file_key = $4 WHERE id = $1`, [
      batchId,
      dryRun ? 'previewed' : 'completed',
      JSON.stringify({ ...stats, dryRun, errors: errors.length }),
      errorKey,
    ]),
  );
  return { ...stats, dryRun, errors: errors.length };
});
