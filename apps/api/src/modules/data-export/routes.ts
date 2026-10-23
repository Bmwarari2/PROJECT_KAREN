import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { canSome } from '@thapsus/core/permissions';
import { compareInstants, isValidTimeZone, nowInstant, today } from '@thapsus/core/time';
import { enqueueJob, withTenantReader, writeAudit, type Tx } from '@thapsus/db';
import type { HomeRegion } from '@thapsus/core';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { open, seal, type Envelope } from '../../lib/kms';
import { periodic, registerJob } from '../../jobs/registry';
import type { Deps } from '../../deps';
import { loadPrincipal } from '../authz/principal';
import { DATASETS, dataset } from '../reports/builder/datasets';
import { MAX_EXPORT_ROWS, runSpec, type BuilderSpec } from '../reports/builder/engine';
import { renderCsv, renderJsonl } from '../reports/render';
import { latestOccurrence, resolveRelative } from '../reports/schedule';
import {
  DestinationError,
  EXPORT_ROLE_PREFIX,
  guardedAwsClients,
  newExternalId,
  S3Destination,
  SftpDestination,
  TRANSIENT,
  validateS3Config,
  validateSftpConfig,
  type AwsClients,
  type Destination,
  type S3Config,
  type SftpConfig,
  type SftpSecrets,
} from './destination';

/**
 * Scheduled data export (BUILD_BRIEF 6.7; PROGRESS 7.3) to the customer's own S3 bucket (home region only,
 * cross-account role + ExternalId) or SFTP server (pinned host key, password or key sealed with the regional
 * KMS key). Datasets and fields come from the report-builder catalogue with the same permission rules (rows
 * by scope, fields by field permission, evaluated for the export's run-as user at delivery time); vault-backed
 * fields are never exported. The delivery log holds counts and timings only.
 */
export const transports = {
  /** Seam for tests: AWS clients for S3 destinations (production: the residency-guarded factory). */
  awsClients: (cell: HomeRegion): AwsClients => guardedAwsClients(cell),
};

interface DestinationRow {
  id: string;
  name: string;
  kind: 's3' | 'sftp';
  config: S3Config | SftpConfig;
  credentials: Envelope | null;
  credential_fields: string[];
  last_tested_at: string | null;
}

const credContext = (tenantId: string, id: string) => ({
  tenant: tenantId,
  purpose: 'export-destination-credentials',
  owner: id,
});

export async function destinationFor(deps: Deps, tenantId: string, d: DestinationRow): Promise<Destination> {
  if (d.kind === 's3')
    return new S3Destination(
      deps.config.cell,
      tenantId,
      d.config as S3Config,
      transports.awsClients(deps.config.cell),
    );
  const secrets: SftpSecrets = d.credentials
    ? (JSON.parse(await open(deps.keys, d.credentials, credContext(tenantId, d.id))) as SftpSecrets)
    : {};
  return new SftpDestination(d.config as SftpConfig, secrets, {
    allowPrivateHosts: deps.config.env === 'dev' || deps.config.env === 'test',
  });
}

const destinationOut = (d: DestinationRow) => {
  const base = {
    id: d.id,
    name: d.name,
    kind: d.kind,
    lastTestedAt: d.last_tested_at,
    credentialFields: d.credential_fields,
  };
  if (d.kind === 's3') {
    const c = d.config as S3Config;
    return {
      ...base,
      s3: {
        bucket: c.bucket,
        region: c.region,
        prefix: c.prefix,
        roleArn: c.roleArn,
        externalId: c.externalId,
      },
      sftp: null,
    };
  }
  const c = d.config as SftpConfig;
  return {
    ...base,
    s3: null,
    sftp: {
      host: c.host,
      port: c.port,
      username: c.username,
      directory: c.directory,
      hostKeySha256: c.hostKeySha256,
      auth: c.auth,
    },
  };
};

const DatasetSel = Type.Object(
  {
    dataset: Type.Union(DATASETS.map((d) => Type.Literal(d.key))),
    fields: Type.Array(Type.String({ maxLength: 60 }), { minItems: 1, maxItems: 60 }),
  },
  { additionalProperties: false },
);
type DatasetSelT = { dataset: BuilderSpec['dataset']; fields: string[] };

/** The builder spec delivered for one dataset and period (asOf datasets: the period date; others: the previous period). */
export function specFor(
  sel: DatasetSelT,
  frequency: 'daily' | 'weekly' | 'monthly',
  periodDate: string,
): BuilderSpec {
  const d = dataset(sel.dataset)!;
  if (d.time === 'asOf')
    return { dataset: sel.dataset, columns: sel.fields, asOf: periodDate, population: 'all' };
  const rel = resolveRelative(
    frequency === 'daily' ? 'yesterday' : frequency === 'weekly' ? 'previousWeek' : 'previousMonth',
    periodDate,
  );
  return { dataset: sel.dataset, columns: sel.fields, from: rel.from, to: rel.to };
}

function assertSelectable(sel: DatasetSelT[]) {
  for (const s of sel) {
    const d = dataset(s.dataset);
    if (!d) throw new ApiError('validation', 'Unknown dataset');
    for (const f of s.fields) {
      const def = d.fields.find((x) => x.key === f);
      if (!def) throw new ApiError('validation', `Unknown field: ${f}`);
      if (def.vault) throw new ApiError('validation', `Vault-backed fields are never exported: ${f}`);
    }
  }
}

export async function dataExportRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const errorOf = (err: unknown) =>
    err instanceof DestinationError ? new ApiError('unprocessable', err.message, { code: err.code }) : err;

  // ---- destinations ------------------------------------------------------------------------------------
  const S3Body = Type.Object(
    {
      bucket: Type.String({ minLength: 3, maxLength: 63 }),
      region: Type.String({ maxLength: 30 }),
      prefix: Type.Optional(Type.String({ maxLength: 200 })),
      roleArn: Type.String({ maxLength: 120 }),
    },
    { additionalProperties: false },
  );
  const SftpBody = Type.Object(
    {
      host: Type.String({ maxLength: 253 }),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      username: Type.String({ minLength: 1, maxLength: 100 }),
      directory: Type.Optional(Type.String({ maxLength: 200 })),
      hostKeySha256: Type.String({ maxLength: 60 }),
      password: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      privateKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
      passphrase: Type.Optional(Type.String({ maxLength: 200 })),
    },
    { additionalProperties: false },
  );
  const DestOut = Type.Object({
    id: Uuid,
    name: Type.String(),
    kind: Type.String(),
    lastTestedAt: Nullable(Type.String()),
    credentialFields: Type.Array(Type.String()),
    s3: Nullable(
      Type.Object({
        bucket: Type.String(),
        region: Type.String(),
        prefix: Type.String(),
        roleArn: Type.String(),
        externalId: Type.String(),
      }),
    ),
    sftp: Nullable(
      Type.Object({
        host: Type.String(),
        port: Type.Integer(),
        username: Type.String(),
        directory: Type.String(),
        hostKeySha256: Type.String(),
        auth: Type.String(),
      }),
    ),
  });

  app.get(
    '/v1/data-exports/destinations',
    {
      schema: {
        tags: ['data-exports'],
        response: {
          200: Type.Object({
            data: Type.Array(DestOut),
            homeRegion: Type.String(),
            rolePrefix: Type.String(),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'exports.destinations');
      const rows = await app.tenantTx(
        req,
        (tx) => tx.query<DestinationRow>('SELECT * FROM app.export_destinations ORDER BY name'),
        { readOnly: true },
      );
      return { data: rows.map(destinationOut), homeRegion: deps.config.cell, rolePrefix: EXPORT_ROLE_PREFIX };
    },
  );

  app.post(
    '/v1/data-exports/destinations',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        summary: 'Add an S3 (home-region bucket, cross-account role) or SFTP (pinned host key) destination',
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 120 }),
            kind: Type.Union([Type.Literal('s3'), Type.Literal('sftp')]),
            s3: Type.Optional(S3Body),
            sftp: Type.Optional(SftpBody),
          },
          { additionalProperties: false },
        ),
        response: { 201: DestOut, 400: Problem, 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'exports.destinations');
      const b = req.body as {
        name: string;
        kind: 's3' | 'sftp';
        s3?: { bucket: string; region: string; prefix?: string; roleArn: string };
        sftp?: {
          host: string;
          port?: number;
          username: string;
          directory?: string;
          hostKeySha256: string;
        } & SftpSecrets;
      };
      let config: S3Config | SftpConfig;
      let secrets: SftpSecrets | null = null;
      try {
        if (b.kind === 's3') {
          if (!b.s3) throw new ApiError('validation', 's3 is required');
          config = {
            bucket: b.s3.bucket,
            region: b.s3.region,
            prefix: b.s3.prefix ?? '',
            roleArn: b.s3.roleArn,
            externalId: newExternalId(),
          };
          validateS3Config(deps.config.cell, config);
        } else {
          if (!b.sftp) throw new ApiError('validation', 'sftp is required');
          const s = b.sftp;
          if (!s.password && !s.privateKey)
            throw new ApiError('validation', 'A password or a private key is required');
          config = {
            host: s.host,
            port: s.port ?? 22,
            username: s.username,
            directory: s.directory ?? '',
            hostKeySha256: s.hostKeySha256,
            auth: s.privateKey ? 'key' : 'password',
          };
          validateSftpConfig(config);
          secrets = Object.fromEntries(
            Object.entries({
              password: s.password,
              privateKey: s.privateKey,
              passphrase: s.passphrase,
            }).filter(([, v]) => v),
          ) as SftpSecrets;
        }
      } catch (err) {
        throw errorOf(err);
      }
      const row = await app.tenantTx(req, async (tx) => {
        const id = crypto.randomUUID();
        const envelope = secrets
          ? await seal(deps.keys, JSON.stringify(secrets), credContext(auth.tenantId, id))
          : null;
        const r = await tx.one<DestinationRow>(
          `INSERT INTO app.export_destinations (tenant_id, id, name, kind, config, credentials, credential_fields, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            id,
            b.name,
            b.kind,
            JSON.stringify(config),
            envelope ? JSON.stringify(envelope) : null,
            secrets ? Object.keys(secrets).sort() : [],
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'export.destination_created',
          targetType: 'export_destination',
          targetId: id,
          diff: {
            kind: b.kind,
            target:
              b.kind === 's3'
                ? `s3://${(config as S3Config).bucket}`
                : `sftp://${(config as SftpConfig).host}`,
            credentials: r.credential_fields,
          },
        });
        return r;
      });
      return reply.status(201).send(destinationOut(row));
    },
  );

  app.post(
    '/v1/data-exports/destinations/:id/test',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        summary: 'Check the destination is reachable and writable',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({ ok: Type.Boolean(), target: Type.String() }),
          403: Problem,
          404: Problem,
          422: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'exports.destinations');
      const { id } = req.params as { id: string };
      const d = await app.tenantTx(
        req,
        (tx) => tx.maybe<DestinationRow>('SELECT * FROM app.export_destinations WHERE id = $1', [id]),
        { readOnly: true },
      );
      if (!d) throw new ApiError('notFound');
      const dest = await destinationFor(deps, auth.tenantId, d);
      let failure: DestinationError | null = null;
      await dest.test().catch((err) => {
        failure =
          err instanceof DestinationError ? err : new DestinationError('connect', 'Connection failed');
      });
      await app.tenantTx(req, async (tx) => {
        if (!failure)
          await tx.exec('UPDATE app.export_destinations SET last_tested_at = now() WHERE id = $1', [id]);
        await app.audit(tx, req, {
          action: 'export.destination_tested',
          targetType: 'export_destination',
          targetId: id,
          diff: { ok: !failure, code: (failure as DestinationError | null)?.code ?? null },
        });
      });
      if (failure) throw errorOf(failure);
      return { ok: true, target: dest.describe() };
    },
  );

  app.delete(
    '/v1/data-exports/destinations/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      authorizeSome(req, 'exports.destinations');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        if (await tx.maybe('SELECT 1 FROM app.data_exports WHERE destination_id = $1 LIMIT 1', [id]))
          throw new ApiError('conflict', 'Delete the exports that use this destination first');
        if (!(await tx.exec('DELETE FROM app.export_destinations WHERE id = $1', [id])))
          throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: 'export.destination_deleted',
          targetType: 'export_destination',
          targetId: id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- data exports ---------------------------------------------------------------------------------------
  const ExportBody = Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 120 }),
      destinationId: Uuid,
      datasets: Type.Array(DatasetSel, { minItems: 1, maxItems: 4 }),
      format: Type.Union([Type.Literal('csv'), Type.Literal('jsonl')]),
      frequency: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('monthly')]),
      timeOfDay: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
      weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
      dayOfMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 28 })),
      timeZone: Type.String({ maxLength: 64 }),
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  const ExportOut = Type.Object({
    id: Uuid,
    name: Type.String(),
    destinationId: Uuid,
    datasets: Type.Array(DatasetSel),
    format: Type.String(),
    frequency: Type.String(),
    timeOfDay: Type.String(),
    weekday: Nullable(Type.Integer()),
    dayOfMonth: Nullable(Type.Integer()),
    timeZone: Type.String(),
    enabled: Type.Boolean(),
    runAsUserId: Uuid,
  });
  type ExportRow = {
    id: string;
    name: string;
    destination_id: string;
    datasets: DatasetSelT[];
    format: 'csv' | 'jsonl';
    frequency: 'daily' | 'weekly' | 'monthly';
    time_of_day: string;
    weekday: number | null;
    day_of_month: number | null;
    time_zone: string;
    enabled: boolean;
    run_as_user_id: string;
  };
  const exportOut = (r: ExportRow) => ({
    id: r.id,
    name: r.name,
    destinationId: r.destination_id,
    datasets: r.datasets,
    format: r.format,
    frequency: r.frequency,
    timeOfDay: r.time_of_day,
    weekday: r.weekday,
    dayOfMonth: r.day_of_month,
    timeZone: r.time_zone,
    enabled: r.enabled,
    runAsUserId: r.run_as_user_id,
  });

  app.get(
    '/v1/data-exports',
    { schema: { tags: ['data-exports'], response: { 200: Type.Array(ExportOut), 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'exports.schedule');
      return (
        await app.tenantTx(req, (tx) => tx.query<ExportRow>('SELECT * FROM app.data_exports ORDER BY name'), {
          readOnly: true,
        })
      ).map(exportOut);
    },
  );

  app.post(
    '/v1/data-exports',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        summary:
          'Schedule a data export of report-builder datasets (rows and fields limited to your own permissions at each delivery)',
        body: ExportBody,
        response: { 201: ExportOut, 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'exports.schedule');
      const b = req.body as {
        name: string;
        destinationId: string;
        datasets: DatasetSelT[];
        format: 'csv' | 'jsonl';
        frequency: 'daily' | 'weekly' | 'monthly';
        timeOfDay: string;
        weekday?: number;
        dayOfMonth?: number;
        timeZone: string;
        enabled?: boolean;
      };
      if (!isValidTimeZone(b.timeZone)) throw new ApiError('validation', 'Unknown time zone');
      if (
        (b.frequency === 'weekly') !== (b.weekday !== undefined) ||
        (b.frequency === 'monthly') !== (b.dayOfMonth !== undefined)
      )
        throw new ApiError('validation', 'weekday is for weekly and dayOfMonth for monthly exports');
      assertSelectable(b.datasets);
      for (const s of b.datasets)
        if (!canSome(auth.principal, dataset(s.dataset)!.permission)) throw new ApiError('forbidden');
      const row = await app.tenantTx(req, async (tx) => {
        if (!(await tx.maybe('SELECT 1 FROM app.export_destinations WHERE id = $1', [b.destinationId])))
          throw new ApiError('notFound');
        const r = await tx.one<ExportRow>(
          `INSERT INTO app.data_exports (tenant_id, name, destination_id, datasets, format, frequency, time_of_day, weekday, day_of_month, time_zone, enabled, run_as_user_id, created_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
          [
            b.name,
            b.destinationId,
            JSON.stringify(b.datasets),
            b.format,
            b.frequency,
            b.timeOfDay,
            b.weekday ?? null,
            b.dayOfMonth ?? null,
            b.timeZone,
            b.enabled ?? true,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'export.created',
          targetType: 'data_export',
          targetId: r.id,
          diff: {
            datasets: b.datasets.map((d) => ({ dataset: d.dataset, fields: d.fields.length })),
            format: b.format,
            frequency: b.frequency,
          },
        });
        return r;
      });
      return reply.status(201).send(exportOut(row));
    },
  );

  app.patch(
    '/v1/data-exports/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        response: { 200: ExportOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'exports.schedule');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<ExportRow>(
          'UPDATE app.data_exports SET enabled = $2 WHERE id = $1 RETURNING *',
          [id, (req.body as { enabled: boolean }).enabled],
        );
        if (!r) throw new ApiError('notFound');
        await app.audit(tx, req, {
          action: r.enabled ? 'export.enabled' : 'export.disabled',
          targetType: 'data_export',
          targetId: id,
        });
        return exportOut(r);
      });
    },
  );

  app.delete(
    '/v1/data-exports/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      authorizeSome(req, 'exports.schedule');
      const { id } = req.params as { id: string };
      await app.tenantTx(req, async (tx) => {
        if (!(await tx.exec('DELETE FROM app.data_exports WHERE id = $1', [id])))
          throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'export.deleted', targetType: 'data_export', targetId: id });
      });
      return reply.status(204).send(null);
    },
  );

  const DeliveryOut = Type.Object({
    id: Uuid,
    periodKey: Type.String(),
    trigger: Type.String(),
    status: Type.String(),
    files: Nullable(Type.Integer()),
    rows: Nullable(Type.Integer()),
    bytes: Nullable(Type.Integer()),
    durationMs: Nullable(Type.Integer()),
    errorCode: Nullable(Type.String()),
    attempts: Type.Integer(),
    createdAt: Type.String(),
    finishedAt: Nullable(Type.String()),
  });
  const deliveryOut = (d: DeliveryRow) => ({
    id: d.id,
    periodKey: d.period_key,
    trigger: d.trigger,
    status: d.status,
    files: d.files,
    rows: d.rows === null ? null : Number(d.rows),
    bytes: d.bytes === null ? null : Number(d.bytes),
    durationMs: d.duration_ms,
    errorCode: d.error_code,
    attempts: d.attempts,
    createdAt: d.created_at,
    finishedAt: d.finished_at,
  });

  app.post(
    '/v1/data-exports/:id/run',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['data-exports'],
        summary: 'Deliver now (a manual delivery for the current period)',
        params: Type.Object({ id: Uuid }),
        response: { 202: DeliveryOut, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      authorizeSome(req, 'exports.schedule');
      const { id } = req.params as { id: string };
      const d = await app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<ExportRow>('SELECT * FROM app.data_exports WHERE id = $1', [id]);
        if (!e) throw new ApiError('notFound');
        const row = await queueDelivery(
          tx,
          e.id,
          e.destination_id,
          `manual:${today(e.time_zone)}:${nowInstant()}`,
          'manual',
        );
        await app.audit(tx, req, { action: 'export.run_requested', targetType: 'data_export', targetId: id });
        if (!row) throw new ApiError('conflict');
        return row;
      });
      return reply.status(202).send(deliveryOut(d));
    },
  );

  app.get(
    '/v1/data-exports/:id/deliveries',
    {
      schema: {
        tags: ['data-exports'],
        summary: 'Delivery log (status, files, rows, bytes, duration, error code; never personal data)',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Array(DeliveryOut), 403: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'exports.schedule');
      const { id } = req.params as { id: string };
      return (
        await app.tenantTx(
          req,
          (tx) =>
            tx.query<DeliveryRow>(
              'SELECT * FROM app.export_deliveries WHERE export_id = $1 ORDER BY created_at DESC LIMIT 100',
              [id],
            ),
          { readOnly: true },
        )
      ).map(deliveryOut);
    },
  );
}

type DeliveryRow = {
  id: string;
  period_key: string;
  trigger: string;
  status: string;
  files: number | null;
  rows: string | null;
  bytes: string | null;
  duration_ms: number | null;
  error_code: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
};

/** One delivery per export + period (unique); the job's idempotency key is the delivery id. */
export async function queueDelivery(
  tx: Tx,
  exportId: string,
  destinationId: string,
  periodKey: string,
  trigger: 'schedule' | 'manual',
): Promise<DeliveryRow | undefined> {
  const row = await tx.maybe<DeliveryRow>(
    `INSERT INTO app.export_deliveries (tenant_id, export_id, destination_id, period_key, trigger) VALUES (app.current_tenant(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, export_id, period_key) DO NOTHING RETURNING *`,
    [exportId, destinationId, periodKey, trigger],
  );
  if (row) await enqueueJob(tx, 'exports.deliver', row.id, { deliveryId: row.id });
  return row;
}

registerJob('exports.deliver', async (ctx) => {
  const deps = ctx.deps as Deps;
  const deliveryId = String(ctx.job.input.deliveryId);
  const d = await ctx.tx((tx) =>
    tx.maybe<
      { id: string; status: string; period_key: string; trigger: string; export_id: string } & {
        name: string;
        datasets: DatasetSelT[];
        format: 'csv' | 'jsonl';
        frequency: 'daily' | 'weekly' | 'monthly';
        time_zone: string;
        run_as_user_id: string;
        destination: DestinationRow;
      }
    >(
      `SELECT x.id, x.status, x.period_key, x.trigger, x.export_id, e.name, e.datasets, e.format, e.frequency, e.time_zone, e.run_as_user_id, to_jsonb(dst) AS destination
         FROM app.export_deliveries x JOIN app.data_exports e ON e.tenant_id = x.tenant_id AND e.id = x.export_id
         JOIN app.export_destinations dst ON dst.tenant_id = e.tenant_id AND dst.id = e.destination_id WHERE x.id = $1`,
      [deliveryId],
    ),
  );
  if (!d) return { skipped: 'missing' };
  if (d.status === 'succeeded') return { skipped: 'delivered' }; // idempotent: a period is delivered once
  const started = Date.now();
  await ctx.tx((tx) =>
    tx.exec(
      `UPDATE app.export_deliveries SET status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()) WHERE id = $1`,
      [deliveryId],
    ),
  );
  const fail = async (code: string, message: string) => {
    await ctx.tx(async (tx) => {
      await tx.exec(
        `UPDATE app.export_deliveries SET status = 'failed', error_code = $2, error = $3, duration_ms = $4, finished_at = now() WHERE id = $1`,
        [deliveryId, code, message.slice(0, 300), Date.now() - started],
      );
      await writeAudit(tx, {
        actorType: 'system',
        action: 'export.delivery_failed',
        targetType: 'data_export',
        targetId: d.export_id,
        diff: { deliveryId, code },
      });
    });
  };
  try {
    const user = await ctx.tx((tx) =>
      tx.maybe<{ status: string }>('SELECT status FROM app.users WHERE id = $1', [d.run_as_user_id]),
    );
    if (user?.status !== 'active') throw new ApiError('forbidden', 'The export owner is no longer active');
    const principal = await ctx.tx((tx) => loadPrincipal(tx, d.run_as_user_id));
    if (!canSome(principal, 'exports.schedule'))
      throw new ApiError('forbidden', 'The export owner may no longer schedule exports');
    const periodDate = d.trigger === 'manual' ? d.period_key.split(':')[1]! : d.period_key;
    const destination = await destinationFor(deps, ctx.tenantId, d.destination);
    let rows = 0;
    let bytes = 0;
    let files = 0;
    await ctx.progress(0, d.datasets.length);
    for (const sel of d.datasets) {
      assertSelectable([sel]);
      const spec = specFor(sel, d.frequency, periodDate);
      const result = await withTenantReader(
        deps.router,
        ctx.tenantId,
        (tx) =>
          runSpec(tx, principal, spec, { defaultAsOf: periodDate, limit: MAX_EXPORT_ROWS, t: (k) => k }),
        { actorId: d.run_as_user_id },
      );
      if (result.truncated) throw new ApiError('unprocessable', `More than ${MAX_EXPORT_ROWS} rows`);
      // machine-readable files: stable column keys as CSV headers, ISO dates, decimal amounts with ISO 4217 codes
      const body = d.format === 'csv' ? renderCsv(result, 'en-GB', 'keys') : renderJsonl(result);
      const safePeriod = d.period_key.replace(/[^0-9A-Za-z-]/g, '');
      await destination.put({
        name: `${sel.dataset}/${sel.dataset}-${safePeriod}.${d.format}`,
        body,
        contentType: d.format === 'csv' ? 'text/csv' : 'application/x-ndjson',
      });
      rows += result.rows.length;
      bytes += body.length;
      files++;
      await ctx.progress(files, d.datasets.length);
    }
    await ctx.tx(async (tx) => {
      await tx.exec(
        `UPDATE app.export_deliveries SET status = 'succeeded', files = $2, rows = $3, bytes = $4, duration_ms = $5, error_code = NULL, error = NULL, finished_at = now() WHERE id = $1`,
        [deliveryId, files, rows, bytes, Date.now() - started],
      );
      await writeAudit(tx, {
        actorType: 'system',
        action: 'export.delivered',
        targetType: 'data_export',
        targetId: d.export_id,
        diff: { deliveryId, files, rows, bytes, target: destination.describe() },
      });
    });
    return { files, rows, bytes };
  } catch (err) {
    if (err instanceof DestinationError) {
      if (TRANSIENT.includes(err.code) && ctx.job.attempts < 5) {
        await ctx.tx((tx) =>
          tx.exec(
            `UPDATE app.export_deliveries SET status = 'queued', error_code = $2, error = $3 WHERE id = $1`,
            [deliveryId, err.code, err.message.slice(0, 300)],
          ),
        );
        throw err; // retried with backoff
      }
      await fail(err.code, err.message);
      return { failed: err.code };
    }
    const code = err instanceof ApiError ? err.code : 'internal';
    if (!(err instanceof ApiError) && ctx.job.attempts < 5) throw err;
    await fail(code, err instanceof ApiError ? err.message : 'Delivery failed');
    return { failed: code };
  }
});

/** Enqueues due scheduled deliveries (idempotent per export + period). */
export async function enqueueDueExports(tx: Tx, now: Date): Promise<number> {
  const rows = await tx.query<{
    id: string;
    destination_id: string;
    frequency: 'daily' | 'weekly' | 'monthly';
    time_of_day: string;
    weekday: number | null;
    day_of_month: number | null;
    time_zone: string;
    created_at: string;
  }>(
    `SELECT id, destination_id, frequency, time_of_day, weekday, day_of_month, time_zone, created_at FROM app.data_exports WHERE enabled`,
  );
  let n = 0;
  for (const e of rows) {
    const occ = latestOccurrence(now.toISOString(), {
      frequency: e.frequency,
      timeOfDay: e.time_of_day,
      weekday: e.weekday,
      dayOfMonth: e.day_of_month,
      timeZone: e.time_zone,
    });
    if (!occ || compareInstants(occ.at, e.created_at) < 0) continue;
    if (await queueDelivery(tx, e.id, e.destination_id, occ.periodKey, 'schedule')) n++;
  }
  return n;
}

periodic.push(async (tx, now) => {
  await enqueueDueExports(tx, now);
});
