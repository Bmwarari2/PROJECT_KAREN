import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { canSome } from '@thapsus/core/permissions';
import { isLocale, t as translate, type Locale } from '@thapsus/core/i18n';
import { compareInstants, isValidTimeZone, today } from '@thapsus/core/time';
import { enqueueJob } from '@thapsus/db';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { loadPrincipal } from '../authz/principal';
import { ruleBook } from '../rules/routes';
import { assertReportAccess, canUseReports } from './access';
import { BuilderSpec, catalogueFor, PREVIEW_ROWS, type BuilderSpec as Spec } from './builder/engine';
import { READY_REPORTS, readyReport, tenantJurisdictions } from './ready/registry';
import {
  auditReport,
  checkSource,
  executeReport,
  sourceFromSaved,
  tenantInfo,
  type RunSource,
  type SavedReportRow,
} from './runs';
import type { Relative } from './schedule';

/**
 * Reports API (BUILD_BRIEF 6.7; PROGRESS 7.1, 7.2): catalogue, ready-made reports, report builder preview,
 * background runs with progress and short-lived downloads, saved reports, scheduled delivery and settings.
 * Every report query runs on the reporting reader inside the caller's tenant context and scope.
 */
const ColumnType = Type.Union(
  ['text', 'enum', 'integer', 'decimal', 'percent', 'money', 'date', 'minutes', 'boolean'].map((t) =>
    Type.Literal(t),
  ),
);
const Cell = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Object({ amountMinor: Type.String(), currency: Type.String() }),
]);
const Column = Type.Object({
  key: Type.String(),
  labelKey: Type.String(),
  subLabelKey: Type.Optional(Type.String()),
  type: ColumnType,
  enumKey: Type.Optional(Type.String()),
  scale: Type.Optional(Type.Integer()),
  sensitive: Type.Optional(Type.Boolean()),
});
const RowSchema = Type.Record(Type.String(), Cell);
export const ReportResultSchema = Type.Object({
  title: Type.String(),
  parameters: Type.Array(Type.String()),
  generatedAt: Type.String(),
  columns: Type.Array(Column),
  rows: Type.Array(RowSchema),
  totals: Type.Optional(Type.Array(RowSchema)),
  chart: Type.Optional(
    Type.Object({
      type: Type.Union([Type.Literal('bar'), Type.Literal('line')]),
      x: Type.String(),
      y: Type.Array(Type.String()),
    }),
  ),
  notes: Type.Array(Type.String()),
  facts: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        labelKey: Type.String(),
        type: ColumnType,
        value: Cell,
        enumKey: Type.Optional(Type.String()),
      }),
    ),
  ),
  restricted: Type.Optional(Type.Integer()),
  sensitive: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.Boolean()),
});
const Format = Type.Union([
  Type.Literal('csv'),
  Type.Literal('xlsx'),
  Type.Literal('pdf'),
  Type.Literal('json'),
]);
const RelativeSchema = Type.Union(
  ['today', 'yesterday', 'previousWeek', 'previousMonth', 'monthToDate', 'yearToDate', 'previousYear'].map(
    (r) => Type.Literal(r),
  ),
);
const SourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('ready'),
      reportId: Type.String({ maxLength: 60 }),
      params: Type.Record(Type.String(), Type.Any()),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('builder'), spec: BuilderSpec }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('saved'), savedReportId: Uuid }, { additionalProperties: false }),
]);
const RunOut = Type.Object({
  id: Uuid,
  title: Type.String(),
  format: Type.String(),
  status: Type.String(),
  progressPercent: Type.Integer(),
  rowCount: Nullable(Type.Integer()),
  bytes: Nullable(Type.Integer()),
  fileName: Nullable(Type.String()),
  errorCode: Nullable(Type.String()),
  scheduled: Type.Boolean(),
  createdAt: Type.String(),
  finishedAt: Nullable(Type.String()),
  expiresAt: Nullable(Type.String()),
});
const SavedOut = Type.Object({
  id: Uuid,
  name: Type.String(),
  kind: Type.String(),
  reportId: Nullable(Type.String()),
  spec: Type.Any(),
  shared: Type.Boolean(),
  mine: Type.Boolean(),
  updatedAt: Type.String(),
});
const ScheduleOut = Type.Object({
  id: Uuid,
  savedReportId: Uuid,
  savedReportName: Type.String(),
  frequency: Type.String(),
  timeOfDay: Type.String(),
  weekday: Nullable(Type.Integer()),
  dayOfMonth: Nullable(Type.Integer()),
  timeZone: Type.String(),
  format: Type.String(),
  recipientUserIds: Type.Array(Uuid),
  enabled: Type.Boolean(),
  lastPeriodKey: Nullable(Type.String()),
});
const SettingsSchema = Type.Object({
  bradfordFactor: Type.Boolean(),
  resultTtlHours: Type.Integer({ minimum: 1, maximum: 720 }),
});

type RunDbRow = {
  id: string;
  title: string;
  format: string;
  status: string;
  progress_done: string;
  progress_total: string | null;
  row_count: string | null;
  bytes: string | null;
  file_name: string | null;
  error_code: string | null;
  schedule_id: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
};
const runOut = (r: RunDbRow) => ({
  id: r.id,
  title: r.title,
  format: r.format,
  status: r.status,
  progressPercent:
    r.status === 'succeeded'
      ? 100
      : r.progress_total && Number(r.progress_total) > 0
        ? Math.min(100, Math.floor((Number(r.progress_done) * 100) / Number(r.progress_total)))
        : 0,
  rowCount: r.row_count === null ? null : Number(r.row_count),
  bytes: r.bytes === null ? null : Number(r.bytes),
  fileName: r.file_name,
  errorCode: r.error_code,
  scheduled: !!r.schedule_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  expiresAt: r.expires_at,
});

export async function reportRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const localeOf = (req: FastifyRequest): Locale =>
    isLocale(req.auth?.user.locale) ? (req.auth!.user.locale as Locale) : req.ctx.locale;
  const zoneOf = (req: FastifyRequest, fallback = 'UTC') => {
    const z = req.auth?.user.timeZone;
    return z && isValidTimeZone(z) ? z : fallback;
  };
  const actorOf = (req: FastifyRequest) => {
    const auth = requireAuth(req);
    return {
      userId: auth.userId,
      actorType: auth.method === 'support' ? ('support' as const) : ('user' as const),
      requestId: req.id,
      ip: req.ctx.ip,
    };
  };

  async function loadSaved(req: FastifyRequest, id: string): Promise<SavedReportRow> {
    const auth = requireAuth(req);
    const r = await app.tenantTx(
      req,
      (tx) =>
        tx.maybe<SavedReportRow>(
          'SELECT id, name, kind, report_key, spec, owner_user_id, shared FROM app.saved_reports WHERE id = $1',
          [id],
        ),
      { readOnly: true },
    );
    if (!r || (r.owner_user_id !== auth.userId && !r.shared)) throw new ApiError('notFound');
    return r;
  }

  async function resolveSource(
    req: FastifyRequest,
    s: RunSource | { kind: 'saved'; savedReportId: string },
  ): Promise<{ source: RunSource; savedReportId: string | null; name?: string }> {
    if (s.kind !== 'saved') return { source: s, savedReportId: null };
    const saved = await loadSaved(req, s.savedReportId);
    return { source: sourceFromSaved(saved, today(zoneOf(req))), savedReportId: saved.id, name: saved.name };
  }

  // ---- catalogue -----------------------------------------------------------------------------------------
  app.get(
    '/v1/reports/catalogue',
    {
      schema: {
        tags: ['reports'],
        summary:
          'Ready-made reports and report-builder datasets available to the caller (permission-filtered)',
        response: {
          200: Type.Object({
            ready: Type.Array(
              Type.Object({
                id: Type.String(),
                category: Type.String(),
                titleKey: Type.String(),
                descriptionKey: Type.String(),
                jurisdictions: Type.Array(Type.String()),
                applicable: Type.Boolean(),
                sensitivity: Type.String(),
                params: Type.Any(),
              }),
            ),
            datasets: Type.Array(Type.Any()),
            formats: Type.Array(Type.String()),
            canSchedule: Type.Boolean(),
            canExportData: Type.Boolean(),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      assertReportAccess(auth.principal);
      const book = await ruleBook(app);
      const countries = await app.tenantTx(
        req,
        (tx) => tx.query<{ country: string }>('SELECT DISTINCT country FROM app.legal_entities'),
        { readOnly: true },
      );
      const jur = tenantJurisdictions(
        book,
        countries.map((c) => c.country.trim()),
      );
      return {
        ready: READY_REPORTS.filter((r) => canSome(auth.principal, r.permission)).map((r) => ({
          id: r.id,
          category: r.category,
          titleKey: r.titleKey,
          descriptionKey: r.descriptionKey,
          jurisdictions: r.jurisdictions,
          applicable: r.jurisdictions.some((j) => jur.has(j)),
          sensitivity: r.sensitivity,
          params: r.params,
        })),
        datasets: catalogueFor(auth.principal),
        formats: ['csv', 'xlsx', 'pdf'],
        canSchedule: canSome(auth.principal, 'reports.schedule'),
        canExportData: canSome(auth.principal, 'exports.schedule'),
      };
    },
  );

  // ---- on-screen runs ------------------------------------------------------------------------------------
  app.post(
    '/v1/reports/ready/:id/run',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary:
          'Run a ready-made report on screen (reporting reader; large populations must use a background run)',
        params: Type.Object({ id: Type.String({ maxLength: 60 }) }),
        body: Type.Object(
          { params: Type.Record(Type.String(), Type.Any()) },
          { additionalProperties: false },
        ),
        response: { 200: ReportResultSchema, 400: Problem, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const def = readyReport(id);
      const params = (req.body as { params: Record<string, unknown> }).params;
      const source: RunSource = { kind: 'ready', reportId: def.id, params };
      const e = await executeReport({
        deps,
        tenantId: auth.tenantId,
        principal: auth.principal,
        actor: actorOf(req),
        locale: localeOf(req),
        timeZone: zoneOf(req),
        source,
        via: { kind: 'report_preview' },
        limit: PREVIEW_ROWS,
      });
      await auditReport(deps, auth.tenantId, actorOf(req), 'report.viewed', source, e);
      req.auditWritten = true;
      return { title: e.title, parameters: e.parameters, generatedAt: deps.now().toISOString(), ...e.result };
    },
  );

  app.post(
    '/v1/reports/builder/preview',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary: `Preview a report-builder specification (first ${PREVIEW_ROWS} rows, permission-masked, on the reporting reader)`,
        body: BuilderSpec,
        response: { 200: ReportResultSchema, 400: Problem, 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const source: RunSource = { kind: 'builder', spec: req.body as Spec };
      const e = await executeReport({
        deps,
        tenantId: auth.tenantId,
        principal: auth.principal,
        actor: actorOf(req),
        locale: localeOf(req),
        timeZone: zoneOf(req),
        source,
        via: { kind: 'report_preview' },
        limit: PREVIEW_ROWS,
      });
      await auditReport(deps, auth.tenantId, actorOf(req), 'report.viewed', source, e);
      req.auditWritten = true;
      return { title: e.title, parameters: e.parameters, generatedAt: deps.now().toISOString(), ...e.result };
    },
  );

  // ---- background runs -------------------------------------------------------------------------------------
  app.post(
    '/v1/reports/runs',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary:
          'Start a background report run (export to CSV, Excel or PDF); poll it, then download the result',
        body: Type.Object({ source: SourceSchema, format: Format }, { additionalProperties: false }),
        response: { 202: RunOut, 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        source: RunSource | { kind: 'saved'; savedReportId: string };
        format: 'csv' | 'xlsx' | 'pdf' | 'json';
      };
      const { source, savedReportId, name } = await resolveSource(req, b.source);
      checkSource(auth.principal, source);
      const title =
        name ??
        translate(
          localeOf(req),
          source.kind === 'ready'
            ? readyReport(source.reportId).titleKey
            : `reports.dataset.${source.spec.dataset}`,
        );
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<RunDbRow>(
          `INSERT INTO app.report_runs (tenant_id, saved_report_id, source, title, format, locale, time_zone, requested_by, progress_total)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, 100) RETURNING *`,
          [
            savedReportId,
            JSON.stringify(source),
            title,
            b.format,
            localeOf(req),
            zoneOf(req, (await tenantInfo(tx)).timeZone),
            auth.userId,
          ],
        );
        const job = await enqueueJob(tx, 'reports.run', r.id, { runId: r.id }, { createdBy: auth.userId });
        await tx.exec('UPDATE app.report_runs SET job_id = $2 WHERE id = $1', [r.id, job.id]);
        await app.audit(tx, req, {
          action: 'report.run_requested',
          targetType: 'report_run',
          targetId: r.id,
          diff: { source: source.kind === 'ready' ? source.reportId : source.spec.dataset, format: b.format },
        });
        return r;
      });
      return reply.status(202).send(runOut(row));
    },
  );

  app.get(
    '/v1/reports/runs',
    {
      schema: {
        tags: ['reports'],
        summary: 'My recent report runs (exports and scheduled deliveries)',
        response: { 200: Type.Array(RunOut) },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<RunDbRow>(
            'SELECT * FROM app.report_runs WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50',
            [auth.userId],
          ),
        { readOnly: true },
      );
      return rows.map(runOut);
    },
  );

  const ownRun = async (req: FastifyRequest, id: string) => {
    const auth = requireAuth(req);
    const r = await app.tenantTx(
      req,
      (tx) =>
        tx.maybe<RunDbRow & { requested_by: string; result_key: string | null }>(
          'SELECT * FROM app.report_runs WHERE id = $1',
          [id],
        ),
      { readOnly: true },
    );
    // only the requester (or recipient, for scheduled deliveries) can see a run and its file
    if (!r || r.requested_by !== auth.userId) throw new ApiError('notFound');
    return r;
  };

  app.get(
    '/v1/reports/runs/:id',
    {
      schema: {
        tags: ['reports'],
        summary: 'Poll a report run: status and progress',
        params: Type.Object({ id: Uuid }),
        response: { 200: RunOut, 404: Problem },
      },
    },
    async (req) => runOut(await ownRun(req, (req.params as { id: string }).id)),
  );

  app.get(
    '/v1/reports/runs/:id/download',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary:
          'Short-lived download link for a finished run (home-region object store; the download is audited)',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ url: Type.String(), fileName: Type.String(), expiresInSeconds: Type.Integer() }),
          404: Problem,
          409: Problem,
          410: Problem,
        },
      },
    },
    async (req) => {
      const r = await ownRun(req, (req.params as { id: string }).id);
      if (
        r.status === 'expired' ||
        (r.expires_at && compareInstants(r.expires_at, deps.now().toISOString()) <= 0)
      )
        throw new ApiError('gone', 'This result has expired; run the report again');
      if (r.status !== 'succeeded' || !r.result_key)
        throw new ApiError('conflict', 'The run has not finished');
      await app.tenantTx(req, (tx) =>
        app.audit(tx, req, {
          action: 'report.downloaded',
          targetType: 'report_run',
          targetId: r.id,
          diff: { format: r.format },
        }),
      );
      return {
        url: await deps.objects.presignGet(r.result_key, r.file_name ?? undefined),
        fileName: r.file_name ?? 'report',
        expiresInSeconds: 300,
      };
    },
  );

  app.get(
    '/v1/reports/runs/:id/result',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary: 'The result of a finished JSON run (large reports shown on screen)',
        params: Type.Object({ id: Uuid }),
        response: { 200: ReportResultSchema, 404: Problem, 409: Problem, 410: Problem },
      },
    },
    async (req) => {
      const r = await ownRun(req, (req.params as { id: string }).id);
      if (r.status === 'expired') throw new ApiError('gone');
      if (r.status !== 'succeeded' || !r.result_key || r.format !== 'json') throw new ApiError('conflict');
      await app.tenantTx(req, (tx) =>
        app.audit(tx, req, { action: 'report.viewed', targetType: 'report_run', targetId: r.id }),
      );
      return JSON.parse((await deps.objects.get(r.result_key)).toString('utf8'));
    },
  );

  // ---- saved reports ---------------------------------------------------------------------------------------
  const SavedBody = Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 120 }),
      kind: Type.Union([Type.Literal('ready'), Type.Literal('builder')]),
      reportId: Type.Optional(Type.String({ maxLength: 60 })),
      params: Type.Optional(Type.Record(Type.String(), Type.Any())),
      spec: Type.Optional(BuilderSpec),
      relative: Type.Optional(RelativeSchema),
      shared: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  type SavedBodyT = {
    name: string;
    kind: 'ready' | 'builder';
    reportId?: string;
    params?: Record<string, unknown>;
    spec?: Spec;
    relative?: Relative;
    shared?: boolean;
  };
  const toSpec = (req: FastifyRequest, b: SavedBodyT) => {
    const auth = requireAuth(req);
    if (b.kind === 'ready') {
      if (!b.reportId) throw new ApiError('validation', 'reportId is required');
      const def = readyReport(b.reportId);
      if (!canSome(auth.principal, def.permission)) throw new ApiError('forbidden');
      return {
        reportKey: def.id,
        spec: { params: b.params ?? {}, ...(b.relative ? { relative: b.relative } : {}) },
      };
    }
    if (!b.spec) throw new ApiError('validation', 'spec is required');
    checkSource(auth.principal, { kind: 'builder', spec: b.spec });
    return { reportKey: null, spec: { ...b.spec, ...(b.relative ? { relative: b.relative } : {}) } };
  };
  const savedOut = (userId: string) => (r: SavedReportRow & { updated_at: string }) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    reportId: r.report_key,
    spec: r.spec,
    shared: r.shared,
    mine: r.owner_user_id === userId,
    updatedAt: r.updated_at,
  });

  app.get(
    '/v1/reports/saved',
    { schema: { tags: ['reports'], response: { 200: Type.Array(SavedOut), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      assertReportAccess(auth.principal);
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<SavedReportRow & { updated_at: string }>(
            'SELECT * FROM app.saved_reports WHERE owner_user_id = $1 OR shared ORDER BY name',
            [auth.userId],
          ),
        { readOnly: true },
      );
      return rows.map(savedOut(auth.userId));
    },
  );

  app.post(
    '/v1/reports/saved',
    {
      config: { selfAudited: true },
      schema: { tags: ['reports'], body: SavedBody, response: { 201: SavedOut, 400: Problem, 403: Problem } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      assertReportAccess(auth.principal);
      const b = req.body as SavedBodyT;
      const { reportKey, spec } = toSpec(req, b);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<SavedReportRow & { updated_at: string }>(
          `INSERT INTO app.saved_reports (tenant_id, name, kind, report_key, spec, owner_user_id, shared) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [b.name, b.kind, reportKey, JSON.stringify(spec), auth.userId, b.shared ?? false],
        );
        await app.audit(tx, req, {
          action: 'report.saved',
          targetType: 'saved_report',
          targetId: r.id,
          diff: { kind: b.kind, report: reportKey ?? b.spec?.dataset, shared: b.shared ?? false },
        });
        return r;
      });
      return reply.status(201).send(savedOut(auth.userId)(row));
    },
  );

  app.get(
    '/v1/reports/saved/:id',
    {
      schema: {
        tags: ['reports'],
        params: Type.Object({ id: Uuid }),
        response: { 200: SavedOut, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const r = await loadSaved(req, (req.params as { id: string }).id);
      return savedOut(auth.userId)({
        ...r,
        updated_at: (r as SavedReportRow & { updated_at?: string }).updated_at ?? '',
      });
    },
  );

  app.put(
    '/v1/reports/saved/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        params: Type.Object({ id: Uuid }),
        body: SavedBody,
        response: { 200: SavedOut, 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as SavedBodyT;
      const { reportKey, spec } = toSpec(req, b);
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<SavedReportRow & { updated_at: string }>(
          `UPDATE app.saved_reports SET name = $2, kind = $3, report_key = $4, spec = $5, shared = $6 WHERE id = $1 AND (owner_user_id = $7 OR $8) RETURNING *`,
          [
            id,
            b.name,
            b.kind,
            reportKey,
            JSON.stringify(spec),
            b.shared ?? false,
            auth.userId,
            canSome(auth.principal, 'reports.manage'),
          ],
        );
        if (!r) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'report.updated',
          targetType: 'saved_report',
          targetId: id,
          diff: { kind: b.kind, shared: b.shared ?? false },
        });
        return r;
      });
      return savedOut(auth.userId)(row);
    },
  );

  app.delete(
    '/v1/reports/saved/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        const n = await tx.exec(
          'DELETE FROM app.saved_reports WHERE id = $1 AND (owner_user_id = $2 OR $3)',
          [id, auth.userId, canSome(auth.principal, 'reports.manage')],
        );
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'report.deleted', targetType: 'saved_report', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- scheduled delivery -----------------------------------------------------------------------------
  const ScheduleBody = Type.Object(
    {
      savedReportId: Uuid,
      frequency: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('monthly')]),
      timeOfDay: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
      weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
      dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 28 })),
      timeZone: Type.String({ maxLength: 64 }),
      format: Type.Union([Type.Literal('csv'), Type.Literal('xlsx'), Type.Literal('pdf')]),
      recipientUserIds: Type.Array(Uuid, { minItems: 1, maxItems: 50 }),
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  type ScheduleBodyT = {
    savedReportId: string;
    frequency: 'daily' | 'weekly' | 'monthly';
    timeOfDay: string;
    weekday?: number;
    dayOfMonth?: number;
    timeZone: string;
    format: string;
    recipientUserIds: string[];
    enabled?: boolean;
  };
  const scheduleOut = (r: {
    id: string;
    saved_report_id: string;
    name: string;
    frequency: string;
    time_of_day: string;
    weekday: number | null;
    day_of_month: number | null;
    time_zone: string;
    format: string;
    recipient_user_ids: string[];
    enabled: boolean;
    last_period_key: string | null;
  }) => ({
    id: r.id,
    savedReportId: r.saved_report_id,
    savedReportName: r.name,
    frequency: r.frequency,
    timeOfDay: r.time_of_day,
    weekday: r.weekday,
    dayOfMonth: r.day_of_month,
    timeZone: r.time_zone,
    format: r.format,
    recipientUserIds: r.recipient_user_ids,
    enabled: r.enabled,
    lastPeriodKey: r.last_period_key,
  });

  app.get(
    '/v1/reports/recipients',
    {
      schema: {
        tags: ['reports'],
        summary: 'Active users who may receive scheduled reports (for the recipient picker)',
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }),
        response: { 200: Type.Array(Type.Object({ id: Uuid, displayName: Type.String() })), 403: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'reports.schedule');
      const q = (req.query as { q?: string }).q?.trim();
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          let where = `status = 'active'`;
          if (q) {
            params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
            where += ` AND display_name ILIKE $1`;
          }
          const users = await tx.query<{ id: string; display_name: string }>(
            `SELECT id, display_name FROM app.users WHERE ${where} ORDER BY display_name, id LIMIT 40`,
            params,
          );
          const out: Array<{ id: string; displayName: string }> = [];
          for (const u of users)
            if (canUseReports(await loadPrincipal(tx, u.id)))
              out.push({ id: u.id, displayName: u.display_name });
          return out.slice(0, 20);
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/reports/schedules',
    { schema: { tags: ['reports'], response: { 200: Type.Array(ScheduleOut), 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'reports.schedule');
      const rows = await app.tenantTx(
        req,
        (tx) =>
          tx.query<Parameters<typeof scheduleOut>[0]>(
            'SELECT s.*, r.name FROM app.report_schedules s JOIN app.saved_reports r ON r.tenant_id = s.tenant_id AND r.id = s.saved_report_id ORDER BY r.name, s.created_at',
          ),
        { readOnly: true },
      );
      return rows.map(scheduleOut);
    },
  );

  app.post(
    '/v1/reports/schedules',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        summary:
          'Schedule delivery of a saved report (each recipient receives their own run, limited to their own permissions)',
        body: ScheduleBody,
        response: { 201: ScheduleOut, 400: Problem, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'reports.schedule');
      const b = req.body as ScheduleBodyT;
      if (!isValidTimeZone(b.timeZone)) throw new ApiError('validation', 'Unknown time zone');
      if (
        (b.frequency === 'weekly') !== (b.weekday !== undefined) ||
        (b.frequency === 'monthly') !== (b.dayOfMonth !== undefined)
      )
        throw new ApiError('validation', 'weekday is for weekly and dayOfMonth for monthly schedules');
      const saved = await loadSaved(req, b.savedReportId);
      const row = await app.tenantTx(req, async (tx) => {
        // every recipient must be an active user who may use reports and run this report themselves
        for (const id of [...new Set(b.recipientUserIds)]) {
          const u = await tx.maybe<{ status: string }>('SELECT status FROM app.users WHERE id = $1', [id]);
          if (u?.status !== 'active')
            throw new ApiError('unprocessable', 'A recipient is not an active user', { recipient: id });
          const p = await loadPrincipal(tx, id);
          try {
            if (!canUseReports(p)) throw new ApiError('forbidden');
            checkSource(p, sourceFromSaved(saved, today(b.timeZone)));
          } catch {
            throw new ApiError('unprocessable', 'A recipient may not run this report', { recipient: id });
          }
        }
        const r = await tx.one<Parameters<typeof scheduleOut>[0]>(
          `INSERT INTO app.report_schedules (tenant_id, saved_report_id, frequency, time_of_day, weekday, day_of_month, time_zone, format, recipient_user_ids, enabled, created_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *, (SELECT name FROM app.saved_reports WHERE id = $1) AS name`,
          [
            b.savedReportId,
            b.frequency,
            b.timeOfDay,
            b.weekday ?? null,
            b.dayOfMonth ?? null,
            b.timeZone,
            b.format,
            [...new Set(b.recipientUserIds)],
            b.enabled ?? true,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'report.schedule_created',
          targetType: 'report_schedule',
          targetId: r.id,
          diff: {
            frequency: b.frequency,
            timeOfDay: b.timeOfDay,
            timeZone: b.timeZone,
            format: b.format,
            recipients: b.recipientUserIds.length,
          },
        });
        return r;
      });
      return reply.status(201).send(scheduleOut(row));
    },
  );

  app.patch(
    '/v1/reports/schedules/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        response: { 200: ScheduleOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'reports.schedule');
      const { id } = req.params as { id: string };
      const { enabled } = req.body as { enabled: boolean };
      return app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<Parameters<typeof scheduleOut>[0]>(
          `UPDATE app.report_schedules s SET enabled = $2 FROM app.saved_reports r WHERE s.id = $1 AND r.tenant_id = s.tenant_id AND r.id = s.saved_report_id RETURNING s.*, r.name`,
          [id, enabled],
        );
        if (!r) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: enabled ? 'report.schedule_enabled' : 'report.schedule_disabled',
          targetType: 'report_schedule',
          targetId: id,
        });
        return scheduleOut(r);
      });
    },
  );

  app.delete(
    '/v1/reports/schedules/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['reports'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      authorizeSome(req, 'reports.schedule');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        if (!(await tx.exec('DELETE FROM app.report_schedules WHERE id = $1', [id])))
          throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'report.schedule_deleted',
          targetType: 'report_schedule',
          targetId: id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- settings ------------------------------------------------------------------------------------------
  const readSettings = (features: Record<string, unknown>) => {
    const r = (features.reports ?? {}) as { bradfordFactor?: boolean; resultTtlHours?: number };
    return { bradfordFactor: r.bradfordFactor === true, resultTtlHours: r.resultTtlHours ?? 168 };
  };
  app.get(
    '/v1/settings/reports',
    {
      schema: {
        tags: ['settings'],
        summary: 'Report settings: Bradford factor in absence reports (off by default) and result retention',
        response: { 200: SettingsSchema, 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      assertReportAccess(auth.principal);
      return app.tenantTx(req, async (tx) => readSettings((await tenantInfo(tx)).features), {
        readOnly: true,
      });
    },
  );
  app.put(
    '/v1/settings/reports',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        body: Type.Partial(SettingsSchema),
        response: { 200: SettingsSchema, 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'reports.manage');
      const patch = req.body as Partial<{ bradfordFactor: boolean; resultTtlHours: number }>;
      return app.tenantTx(req, async (tx) => {
        const before = readSettings((await tenantInfo(tx)).features);
        const next = { ...before, ...patch };
        await tx.exec(`UPDATE app.tenants SET features = jsonb_set(features, '{reports}', $1::jsonb)`, [
          JSON.stringify(next),
        ]);
        await app.audit(tx, req, {
          action: 'settings.reports_updated',
          targetType: 'tenant',
          diff: { before, after: next },
        });
        return next;
      });
    },
  );
}
