import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Value } from 'typebox/value';
import { canSome, type Principal } from '@thapsus/core/permissions';
import { formatDate, isLocale, t as translate, type Locale } from '@thapsus/core/i18n';
import {
  addMinutes,
  compareInstants,
  dateParts,
  instantToDate,
  isValidTimeZone,
  today,
} from '@thapsus/core/time';
import { enqueueJob, withTenant, withTenantReader, writeAudit, type Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { notify } from '../../lib/notify';
import { periodic, registerJob } from '../../jobs/registry';
import type { Deps } from '../../deps';
import { loadPrincipal } from '../authz/principal';
import { ruleBook } from '../rules/routes';
import { Vault } from '../vault/service';
import { assertReportAccess, paramAdder, rowScope } from './access';
import { runSpec, PREVIEW_ROWS, MAX_EXPORT_ROWS, type BuilderSpec } from './builder/engine';
import { dataset } from './builder/datasets';
import { vaultReader } from './builder/vault';
import { readyReport } from './ready/registry';
import { CONTENT_TYPES, fileNameFor, renderReport, type Format } from './render';
import { latestOccurrence, resolveRelative, type Relative } from './schedule';
import type { ReportResult } from './types';

/**
 * Report execution shared by on-screen runs, background runs (exports) and scheduled delivery.
 * Report SQL runs on the tenant's reporting READER (withTenantReader; RLS + scope + field masking);
 * vault values and the audit trail go through the writer.
 */
export type RunSource =
  | { kind: 'ready'; reportId: string; params: Record<string, unknown> }
  | { kind: 'builder'; spec: BuilderSpec; title?: string };

export interface ExecArgs {
  deps: Deps;
  tenantId: string;
  principal: Principal;
  actor: { userId: string; actorType: 'user' | 'support' | 'system'; requestId?: string; ip?: string };
  locale: Locale;
  timeZone: string;
  source: RunSource;
  via: { kind: 'report_preview' | 'report_run'; id?: string };
  limit: number;
  progress?: (done: number, total?: number) => Promise<void>;
}

export interface Executed {
  result: ReportResult & { truncated?: boolean };
  title: string;
  parameters: string[];
  reader: boolean;
}

/** Reports with per-employee calculations run on screen only for modest populations; larger ones in the background. */
export const SYNC_EMPLOYEE_LIMIT: Record<string, number> = { absence: 2_000, 'holiday-liability': 1_000 };

export async function tenantInfo(tx: Tx) {
  const row = await tx.one<{
    home_region: string;
    default_currency: string;
    default_time_zone: string;
    default_locale: string;
    features: Record<string, unknown>;
  }>('SELECT home_region, default_currency, default_time_zone, default_locale, features FROM app.tenants');
  return {
    homeRegion: row.home_region,
    defaultCurrency: row.default_currency,
    timeZone: row.default_time_zone,
    locale: row.default_locale,
    features: row.features ?? {},
  };
}

function describeParams(locale: Locale, params: Record<string, unknown>): string[] {
  const t = (k: string, v?: Record<string, string | number>) => translate(locale, k, v);
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      let value = String(v);
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) value = formatDate(v, locale);
      else if (k === 'groupBy') value = t(`reports.groupBy.${v}`);
      else if (k === 'sector') value = t(`compliance.gpg.sectorName.${v}`);
      return `${t(`reports.param.${k}`)}: ${value}`;
    });
}

function describeSpec(locale: Locale, spec: BuilderSpec): string[] {
  const t = (k: string) => translate(locale, k);
  const lines = [`${t('reports.param.dataset')}: ${t(`reports.dataset.${spec.dataset}`)}`];
  if (spec.asOf) lines.push(`${t('reports.param.asOf')}: ${formatDate(spec.asOf, locale)}`);
  if (spec.from && spec.to)
    lines.push(
      `${t('reports.param.period')}: ${formatDate(spec.from, locale)} – ${formatDate(spec.to, locale)}`,
    );
  if (spec.groupBy?.length)
    lines.push(
      `${t('reports.param.groupBy')}: ${spec.groupBy.map((g) => t(`reports.field.${g.field}`)).join(', ')}`,
    );
  if (spec.filters?.length)
    lines.push(
      `${t('reports.param.filters')}: ${spec.filters.map((f) => `${t(`reports.field.${f.field}`)} ${t(`reports.op.${f.op}`)}${f.value !== undefined ? ` ${Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}` : ''}`).join('; ')}`,
    );
  return lines;
}

/** Validates that a stored or submitted source can be run by this principal (permission + parameters). */
export function checkSource(principal: Principal, source: RunSource) {
  assertReportAccess(principal);
  if (source.kind === 'ready') {
    const def = readyReport(source.reportId);
    if (!canSome(principal, def.permission)) throw new ApiError('forbidden');
    if (!Value.Check(def.params, source.params))
      throw new ApiError('validation', 'Invalid report parameters');
  } else {
    const d = dataset(source.spec.dataset);
    if (!d || !canSome(principal, d.permission)) throw new ApiError('forbidden');
  }
}

export async function executeReport(a: ExecArgs): Promise<Executed> {
  checkSource(a.principal, a.source);
  const book = await ruleBook({ deps: a.deps } as unknown as FastifyInstance);
  const t = (k: string, v?: Record<string, string | number>) => translate(a.locale, k, v);
  return withTenantReader(
    a.deps.router,
    a.tenantId,
    async (tx, info) => {
      const tenant = await tenantInfo(tx);
      if (a.source.kind === 'ready') {
        const def = readyReport(a.source.reportId);
        const limit = SYNC_EMPLOYEE_LIMIT[def.id];
        if (limit && a.via.kind === 'report_preview') {
          const params: unknown[] = [];
          const n = await tx.one<{ n: number }>(
            `SELECT count(*)::int AS n FROM app.employees e WHERE ${rowScope(a.principal, def.permission, params)} AND e.status <> 'leaver'`,
            params,
          );
          if (n.n > limit)
            throw new ApiError(
              'unprocessable',
              'This report is too large to show on screen; run it in the background',
              { code: 'useBackgroundRun', employees: n.n },
            );
        }
        const result = await def.run(
          {
            tx,
            principal: a.principal,
            book,
            tenant,
            t,
            locale: a.locale,
            progress: a.progress,
            compliance: (fn) =>
              withTenant(
                a.deps.router,
                a.tenantId,
                (wtx) =>
                  fn({
                    tx: wtx,
                    book,
                    principal: a.principal,
                    tenantId: a.tenantId,
                    actor: {
                      principal: a.principal,
                      actorType: a.actor.actorType,
                      requestId: a.actor.requestId,
                      ip: a.actor.ip,
                    },
                    vault: new Vault(a.deps.keys),
                  }),
                { actorId: a.actor.userId },
              ),
          },
          a.source.params as never,
        );
        return {
          result,
          title: t(def.titleKey),
          parameters: describeParams(a.locale, a.source.params),
          reader: info.reader,
        };
      }
      const spec = a.source.spec;
      const result = await runSpec(tx, a.principal, spec, {
        defaultAsOf: today(isValidTimeZone(a.timeZone) ? a.timeZone : tenant.timeZone),
        limit: a.limit,
        t,
        vault: vaultReader(a.deps.router, a.deps.keys, a.tenantId, a.actor, a.via),
      });
      return {
        result,
        title: a.source.title ?? t(`reports.dataset.${spec.dataset}`),
        parameters: describeSpec(a.locale, spec),
        reader: info.reader,
      };
    },
    { actorId: a.actor.userId },
  );
}

export async function auditReport(
  deps: Deps,
  tenantId: string,
  a: ExecArgs['actor'],
  action: string,
  source: RunSource,
  e: Executed,
  ref?: string,
) {
  await withTenant(deps.router, tenantId, (tx) =>
    writeAudit(tx, {
      actorType: a.actorType,
      actorId: a.userId,
      action,
      targetType:
        source.kind === 'ready' ? `report:${source.reportId}` : `report_builder:${source.spec.dataset}`,
      targetId: ref,
      diff: {
        rows: e.result.rows.length,
        restricted: e.result.restricted ?? 0,
        reader: e.reader,
        sensitive: !!e.result.sensitive,
      },
      ip: a.ip,
      requestId: a.requestId,
      sensitive: !!e.result.sensitive,
    }),
  );
}

// ---- relative periods and saved reports --------------------------------------------------------------------

export interface SavedReportRow {
  id: string;
  name: string;
  kind: 'ready' | 'builder';
  report_key: string | null;
  spec: Record<string, unknown> & { relative?: Relative; params?: Record<string, unknown> };
  owner_user_id: string;
  shared: boolean;
}

/** Concrete source for a saved report, resolving a relative period against `date` (the run's local date). */
export function sourceFromSaved(r: SavedReportRow, date: string): RunSource {
  const rel = r.spec.relative ? resolveRelative(r.spec.relative, date) : null;
  if (r.kind === 'ready') {
    const def = readyReport(r.report_key!);
    const params: Record<string, unknown> = { ...(r.spec.params ?? {}) };
    const props = (def.params as { properties?: Record<string, unknown> }).properties ?? {};
    if (rel) {
      if ('asOf' in props) params.asOf = rel.asOf;
      if ('from' in props) params.from = rel.from;
      if ('to' in props) params.to = rel.to;
      if ('year' in props) params.year = dateParts(rel.asOf).year;
    }
    return { kind: 'ready', reportId: def.id, params };
  }
  const { relative: _rel, ...spec } = r.spec;
  void _rel;
  const s = spec as unknown as BuilderSpec;
  if (rel) {
    if (dataset(s.dataset)?.time === 'asOf') s.asOf = rel.asOf;
    else {
      s.from = rel.from;
      s.to = rel.to;
    }
  }
  return { kind: 'builder', spec: s, title: r.name };
}

// ---- background runs -------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  status: string;
  source: RunSource;
  title: string;
  format: Format;
  locale: string;
  time_zone: string;
  requested_by: string;
  schedule_id: string | null;
}

/** Hours a finished result stays downloadable (tenant setting features.reports.resultTtlHours, default 168). */
export function resultTtlHours(features: Record<string, unknown>): number {
  const v = Number((features.reports as { resultTtlHours?: number } | undefined)?.resultTtlHours ?? 168);
  return Number.isFinite(v) ? Math.min(720, Math.max(1, Math.round(v))) : 168;
}

const PERMANENT = new Set(['validation', 'forbidden', 'notFound', 'unprocessable']);

registerJob('reports.run', async (ctx) => {
  const deps = ctx.deps as Deps;
  const runId = String(ctx.job.input.runId);
  const run = await ctx.tx((tx) =>
    tx.maybe<RunRow>(
      'SELECT id, status, source, title, format, locale, time_zone, requested_by, schedule_id FROM app.report_runs WHERE id = $1',
      [runId],
    ),
  );
  if (!run) return { skipped: 'missing' };
  if (run.status === 'succeeded' || run.status === 'expired' || run.status === 'failed')
    return { skipped: run.status }; // idempotent
  await ctx.tx((tx) =>
    tx.exec(
      `UPDATE app.report_runs SET status = 'running', started_at = coalesce(started_at, now()), job_id = $2 WHERE id = $1`,
      [runId, ctx.job.id],
    ),
  );
  const progress = async (done: number, total?: number) => {
    await ctx.progress(done, total);
    await ctx.tx((tx) =>
      tx.exec(
        'UPDATE app.report_runs SET progress_done = $2, progress_total = coalesce($3, progress_total) WHERE id = $1',
        [runId, done, total ?? null],
      ),
    );
  };
  try {
    const user = await ctx.tx((tx) =>
      tx.maybe<{ status: string }>('SELECT status FROM app.users WHERE id = $1', [run.requested_by]),
    );
    if (user?.status !== 'active') throw new ApiError('forbidden', 'The requester is no longer active');
    const principal = await ctx.tx((tx) => loadPrincipal(tx, run.requested_by));
    const locale: Locale = isLocale(run.locale) ? run.locale : 'en-GB';
    await progress(0, 100);
    const actor = { userId: run.requested_by, actorType: 'user' as const };
    const e = await executeReport({
      deps,
      tenantId: ctx.tenantId,
      principal,
      actor,
      locale,
      timeZone: run.time_zone,
      source: run.source,
      via: { kind: 'report_run', id: runId },
      limit: MAX_EXPORT_ROWS,
      progress: (d, total) => progress(Math.min(90, Math.round((d / Math.max(1, total ?? d)) * 90)), 100),
    });
    await progress(90, 100);
    const generatedAt = deps.now().toISOString();
    const body =
      run.format === 'json'
        ? Buffer.from(JSON.stringify({ title: e.title, parameters: e.parameters, generatedAt, ...e.result }))
        : await renderReport(e.result, run.format, {
            title: e.title,
            parameters: e.parameters,
            locale,
            timeZone: run.time_zone,
            generatedAt,
          });
    const fileName = fileNameFor(e.title, instantToDate(generatedAt, run.time_zone), run.format);
    const key = `${ctx.tenantId}/reports/${runId}/${fileName}`;
    await deps.objects.put(key, body, run.format === 'json' ? 'application/json' : CONTENT_TYPES[run.format]);
    await auditReport(deps, ctx.tenantId, actor, 'report.run_completed', run.source, e, runId);
    await ctx.tx(async (tx) => {
      const ttl = resultTtlHours((await tenantInfo(tx)).features);
      await tx.exec(
        `UPDATE app.report_runs SET status = 'succeeded', progress_done = 100, progress_total = 100, row_count = $2, bytes = $3, result_key = $4, result_sha256 = $5, file_name = $6, finished_at = now(), expires_at = $7, title = $8 WHERE id = $1`,
        [
          runId,
          e.result.rows.length,
          body.length,
          key,
          createHash('sha256').update(body).digest('hex'),
          fileName,
          addMinutes(generatedAt, ttl * 60),
          e.title,
        ],
      );
      // Scheduled delivery: email from the home region with a sign-in-protected link; no report content or names.
      if (run.schedule_id)
        await notify(tx, {
          userIds: [run.requested_by],
          kind: 'report.ready',
          titleKey: 'notify.reportReady',
          target: { type: 'report_run', id: runId },
          dedupeKey: `report-ready:${runId}`,
        });
    });
    return { rows: e.result.rows.length, bytes: body.length };
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'internal';
    if (PERMANENT.has(code) || ctx.job.attempts >= 5) {
      await ctx.tx((tx) =>
        tx.exec(
          `UPDATE app.report_runs SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1`,
          [runId, code],
        ),
      );
      return { failed: code };
    }
    throw err;
  }
});

// Expired results: the file is deleted from the object store and the run marked expired (idempotent per day).
registerJob('reports.cleanup', async (ctx) => {
  const deps = ctx.deps as Deps;
  const expired = await ctx.tx((tx) =>
    tx.query<{ id: string; result_key: string }>(
      `SELECT id, result_key FROM app.report_runs WHERE result_key IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT 5000`,
      [deps.now().toISOString()],
    ),
  );
  for (const r of expired) {
    await deps.objects.delete(r.result_key).catch(() => undefined);
    await ctx.tx((tx) =>
      tx.exec(`UPDATE app.report_runs SET status = 'expired', result_key = NULL WHERE id = $1`, [r.id]),
    );
  }
  return { expired: expired.length };
});

/** Enqueues due scheduled deliveries: one run per schedule + period + recipient (unique index), each an idempotent job. */
export async function enqueueDueSchedules(tx: Tx, now: Date): Promise<number> {
  const rows = await tx.query<
    {
      id: string;
      frequency: 'daily' | 'weekly' | 'monthly';
      time_of_day: string;
      weekday: number | null;
      day_of_month: number | null;
      time_zone: string;
      format: Format;
      recipient_user_ids: string[];
      last_period_key: string | null;
      created_at: string;
    } & {
      r_id: string;
      name: string;
      kind: 'ready' | 'builder';
      report_key: string | null;
      spec: SavedReportRow['spec'];
      owner_user_id: string;
      shared: boolean;
    }
  >(
    `SELECT s.id, s.frequency, s.time_of_day, s.weekday, s.day_of_month, s.time_zone, s.format, s.recipient_user_ids, s.last_period_key, s.created_at,
            r.id AS r_id, r.name, r.kind, r.report_key, r.spec, r.owner_user_id, r.shared
       FROM app.report_schedules s JOIN app.saved_reports r ON r.tenant_id = s.tenant_id AND r.id = s.saved_report_id WHERE s.enabled`,
  );
  let n = 0;
  for (const s of rows) {
    const occ = latestOccurrence(now.toISOString(), {
      frequency: s.frequency,
      timeOfDay: s.time_of_day,
      weekday: s.weekday,
      dayOfMonth: s.day_of_month,
      timeZone: s.time_zone,
    });
    if (!occ || occ.periodKey === s.last_period_key || compareInstants(occ.at, s.created_at) < 0) continue;
    let source: RunSource;
    try {
      source = sourceFromSaved(
        {
          id: s.r_id,
          name: s.name,
          kind: s.kind,
          report_key: s.report_key,
          spec: s.spec,
          owner_user_id: s.owner_user_id,
          shared: s.shared,
        },
        occ.periodKey,
      );
    } catch {
      continue;
    }
    const users = await tx.query<{ id: string; locale: string | null; time_zone: string | null }>(
      `SELECT id, locale, time_zone FROM app.users WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [s.recipient_user_ids],
    );
    const tenant = await tenantInfo(tx);
    for (const u of users) {
      const add: unknown[] = [];
      const p = paramAdder(add);
      const run = await tx.maybe<{ id: string }>(
        `INSERT INTO app.report_runs (tenant_id, saved_report_id, schedule_id, period_key, source, title, format, locale, time_zone, requested_by)
         VALUES (app.current_tenant(), ${p(s.r_id)}, ${p(s.id)}, ${p(occ.periodKey)}, ${p(JSON.stringify(source))}, ${p(s.name)}, ${p(s.format)}, ${p(u.locale ?? tenant.locale)}, ${p(u.time_zone ?? s.time_zone)}, ${p(u.id)})
         ON CONFLICT (tenant_id, schedule_id, period_key, requested_by) WHERE schedule_id IS NOT NULL DO NOTHING RETURNING id`,
        add,
      );
      if (!run) continue;
      const job = await enqueueJob(tx, 'reports.run', run.id, { runId: run.id }, { createdBy: u.id });
      await tx.exec('UPDATE app.report_runs SET job_id = $2 WHERE id = $1', [run.id, job.id]);
      n++;
    }
    await tx.exec('UPDATE app.report_schedules SET last_period_key = $2 WHERE id = $1', [
      s.id,
      occ.periodKey,
    ]);
  }
  return n;
}

periodic.push(async (tx, now) => {
  await enqueueDueSchedules(tx, now);
  await enqueueJob(tx, 'reports.cleanup', now.toISOString().slice(0, 13), {});
});

export { PREVIEW_ROWS };
