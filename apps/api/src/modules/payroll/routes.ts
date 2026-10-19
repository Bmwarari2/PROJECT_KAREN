import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { compareDates, daysBetween } from '@thapsus/core/time';
import { enqueueJob, writeAudit, type Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem, Uuid } from '../../http/schemas';
import { registerJob } from '../../jobs/registry';
import type { Deps } from '../../deps';
import { ruleBook } from '../rules/routes';
import { consumeOAuthState, createOAuthState, credentialFields, getCredentials, mergeCredentials, putCredentials } from '../integrations/credentials';
import { IntegrationHttpError } from '../integrations/http';
import { CONNECTORS, CONNECTOR_KINDS, type ConnectorKind, type ConnectorRow, type DeliveryConfig, type ItemResult, type PushResult } from './connectors';
import { xeroAuthorizeUrl, xeroConnections, xeroExchangeCode } from './connectors/xero';
import { buildPayrollInputs, canonicalJson, sectionCounts, sha256Hex, SECTIONS } from './inputs';
import { defaultMapping, DATE_FORMATS, FIELD_CATALOGUE, validateMapping, type FieldMapping } from './mapping';
import { ConnectorBody, ConnectorOut, ConnectorPatch, CredentialsBody, DeliveryOut, ExportOut, InputsOut, PeriodBody, PeriodOut } from './schemas';
import { connectorConfigHash, createExport, inputsFor, loadConnector, loadPeriod, mapExport, type ExportRow } from './service';
import { SftpError, uploadSftp } from './sftp';

type Auth = ReturnType<typeof requireAuth>;

/** Payroll roles act company-wide, or per legal entity when their grant is entity-scoped. */
function allowed(auth: Auth, action: string, entityId: string | null) {
  return entityId ? can(auth.principal, action, { entityId }) : can(auth.principal, action);
}
function need(req: FastifyRequest, action: string) {
  const auth = requireAuth(req);
  if (!canSome(auth.principal, action)) throw new ApiError('forbidden');
  return auth;
}

interface DeliveryRow {
  id: string;
  export_id: string;
  connector_id: string;
  period_id: string;
  method: string;
  status: string;
  destination: string | null;
  detail: Record<string, unknown>;
  error: string | null;
  attempts: number;
  created_at: string;
  completed_at: string | null;
}
const mapDelivery = (d: DeliveryRow) => ({ id: d.id, exportId: d.export_id, connectorId: d.connector_id, periodId: d.period_id, method: d.method, status: d.status, destination: d.destination, detail: d.detail, error: d.error, attempts: d.attempts, createdAt: d.created_at, completedAt: d.completed_at });

async function presentConnector(tx: Tx, c: ConnectorRow & { created_at: string; updated_at: string }) {
  const def = CONNECTORS[c.kind];
  return { id: c.id, name: c.name, kind: c.kind, availability: def.status, docs: def.docs, entityId: c.entity_id, mapping: c.mapping, delivery: c.delivery, settings: c.settings, enabled: c.enabled, credentials: await credentialFields(tx, 'payroll_connector', c.id), configSha256: connectorConfigHash(c), createdAt: c.created_at, updatedAt: c.updated_at };
}

function checkConnector(kind: ConnectorKind, delivery: DeliveryConfig, mapping: FieldMapping, region: string) {
  const def = CONNECTORS[kind];
  if (!def.regions.includes(region as never)) throw new ApiError('unprocessable', `The ${kind} connector is not offered for ${region.toUpperCase()} workspaces`);
  if (!def.deliveries.includes(delivery.method) && def.status === 'available') throw new ApiError('validation', `Delivery by ${delivery.method} is not supported by ${kind}`);
  if (delivery.method === 'sftp') {
    if (!delivery.sftp) throw new ApiError('validation', 'SFTP delivery needs host, port, username, directory and the host key fingerprint');
    if (delivery.sftp.directory.split('/').includes('..')) throw new ApiError('validation', 'Directory may not contain ".."');
  }
  const problems = validateMapping(mapping);
  if (problems.length) throw new ApiError('validation', 'Invalid field mapping', { errors: problems.map((message) => ({ message })) });
}

export async function payrollRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const callbackUrl = () => `${deps.config.appBaseUrl}/v1/payroll/xero/callback`;

  // ---- catalogue ------------------------------------------------------------------------------------------------
  app.get(
    '/v1/payroll/catalogue',
    { schema: { tags: ['payroll'], summary: 'Connector kinds, mappable fields per section, transforms and date formats', response: { 200: Type.Object({ connectors: Type.Array(Type.Object({ kind: Type.String(), availability: Type.String(), formats: Type.Array(Type.String()), deliveries: Type.Array(Type.String()), regions: Type.Array(Type.String()), docs: Type.String() })), sections: Type.Record(Type.String(), Type.Array(Type.Object({ field: Type.String(), type: Type.String() }))), dateFormats: Type.Array(Type.String()), defaultMapping: Type.Any() }), 403: Problem } },
    },
    async (req) => {
      need(req, 'payroll.read');
      return {
        connectors: CONNECTOR_KINDS.map((k) => ({ kind: k, availability: CONNECTORS[k].status, formats: CONNECTORS[k].formats, deliveries: CONNECTORS[k].deliveries, regions: CONNECTORS[k].regions, docs: CONNECTORS[k].docs })),
        sections: Object.fromEntries(SECTIONS.map((s) => [s, Object.entries(FIELD_CATALOGUE[s]).map(([field, d]) => ({ field, type: d.type }))])),
        dateFormats: [...DATE_FORMATS],
        defaultMapping: defaultMapping(),
      };
    },
  );

  // ---- connectors ---------------------------------------------------------------------------------------------------
  app.get('/v1/payroll/connectors', { schema: { tags: ['payroll'], response: { 200: Type.Array(ConnectorOut), 403: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    return app.tenantTx(
      req,
      async (tx) => {
        const rows = await tx.query<ConnectorRow & { created_at: string; updated_at: string }>('SELECT id, name, kind, entity_id, mapping, delivery, settings, enabled, created_at, updated_at FROM app.payroll_connectors ORDER BY name, id');
        const out = [];
        for (const r of rows) if (allowed(auth, 'payroll.read', r.entity_id)) out.push(await presentConnector(tx, r));
        return out;
      },
      { readOnly: true },
    );
  });

  app.post('/v1/payroll/connectors', { config: { selfAudited: true }, schema: { tags: ['payroll'], body: ConnectorBody, response: { 201: ConnectorOut, 400: Problem, 403: Problem, 422: Problem } } }, async (req, reply) => {
    const auth = need(req, 'payroll.manage');
    const b = req.body as { name: string; kind: ConnectorKind; entityId?: string | null; mapping?: FieldMapping; delivery?: DeliveryConfig; settings?: Record<string, unknown>; enabled?: boolean };
    if (!allowed(auth, 'payroll.manage', b.entityId ?? null)) throw new ApiError('forbidden');
    const mapping = b.mapping ?? defaultMapping();
    const delivery = b.delivery ?? { method: b.kind === 'xero_uk' ? 'api' : 'download' };
    const out = await app.tenantTx(req, async (tx) => {
      const region = (await tx.one<{ home_region: string }>('SELECT home_region FROM app.tenants')).home_region;
      checkConnector(b.kind, delivery, mapping, region);
      const stub = CONNECTORS[b.kind].status === 'stub';
      const row = await tx.one<ConnectorRow & { created_at: string; updated_at: string }>(
        `INSERT INTO app.payroll_connectors (tenant_id, name, kind, entity_id, mapping, delivery, settings, enabled, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, kind, entity_id, mapping, delivery, settings, enabled, created_at, updated_at`,
        [b.name, b.kind, b.entityId ?? null, JSON.stringify(mapping), JSON.stringify(delivery), JSON.stringify(b.settings ?? {}), stub ? false : (b.enabled ?? true), auth.userId],
      );
      await app.audit(tx, req, { action: 'payroll_connector.created', targetType: 'payroll_connector', targetId: row.id, diff: { name: b.name, kind: b.kind, delivery: delivery.method, destination: delivery.sftp ? `${delivery.sftp.host}:${delivery.sftp.port}` : null } });
      return presentConnector(tx, row);
    });
    return reply.status(201).send(out);
  });

  app.get('/v1/payroll/connectors/:id', { schema: { tags: ['payroll'], params: Type.Object({ id: Uuid }), response: { 200: ConnectorOut, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    return app.tenantTx(
      req,
      async (tx) => {
        const c = await loadConnector(tx, (req.params as { id: string }).id);
        if (!allowed(auth, 'payroll.read', c.entity_id)) throw new ApiError('notFound');
        return presentConnector(tx, c);
      },
      { readOnly: true },
    );
  });

  app.patch('/v1/payroll/connectors/:id', { config: { selfAudited: true }, schema: { tags: ['payroll'], params: Type.Object({ id: Uuid }), body: ConnectorPatch, response: { 200: ConnectorOut, 400: Problem, 403: Problem, 404: Problem, 422: Problem, 501: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.manage');
    const b = req.body as Partial<{ name: string; entityId: string | null; mapping: FieldMapping; delivery: DeliveryConfig; settings: Record<string, unknown>; enabled: boolean }>;
    return app.tenantTx(req, async (tx) => {
      const c = await loadConnector(tx, (req.params as { id: string }).id);
      if (!allowed(auth, 'payroll.manage', c.entity_id) || (b.entityId !== undefined && !allowed(auth, 'payroll.manage', b.entityId))) throw new ApiError('forbidden');
      const next = { ...c, name: b.name ?? c.name, entity_id: b.entityId === undefined ? c.entity_id : b.entityId, mapping: b.mapping ?? c.mapping, delivery: b.delivery ?? c.delivery, settings: b.settings ?? c.settings, enabled: b.enabled ?? c.enabled };
      const region = (await tx.one<{ home_region: string }>('SELECT home_region FROM app.tenants')).home_region;
      checkConnector(c.kind, next.delivery, next.mapping, region);
      if (next.enabled && CONNECTORS[c.kind].status === 'stub') throw new ApiError('notImplemented', `The ${c.kind} connector is a documented stub`, { docs: CONNECTORS[c.kind].docs });
      const row = await tx.one<ConnectorRow & { created_at: string; updated_at: string }>(
        `UPDATE app.payroll_connectors SET name = $2, entity_id = $3, mapping = $4, delivery = $5, settings = $6, enabled = $7 WHERE id = $1
         RETURNING id, name, kind, entity_id, mapping, delivery, settings, enabled, created_at, updated_at`,
        [c.id, next.name, next.entity_id, JSON.stringify(next.mapping), JSON.stringify(next.delivery), JSON.stringify(next.settings), next.enabled],
      );
      await app.audit(tx, req, { action: 'payroll_connector.updated', targetType: 'payroll_connector', targetId: c.id, diff: { fields: Object.keys(b), configSha256: { from: connectorConfigHash(c), to: connectorConfigHash(row) } } });
      return presentConnector(tx, row);
    });
  });

  app.put('/v1/payroll/connectors/:id/credentials', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Store connector secrets (sealed with the regional KMS key; never returned)', params: Type.Object({ id: Uuid }), body: CredentialsBody, response: { 200: Type.Object({ configured: Type.Array(Type.String()) }), 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.manage');
    const b = req.body as Record<string, string>;
    return app.tenantTx(req, async (tx) => {
      const c = await loadConnector(tx, (req.params as { id: string }).id);
      if (!allowed(auth, 'payroll.manage', c.entity_id)) throw new ApiError('forbidden');
      const configured = await putCredentials(tx, deps.keys, auth.tenantId, 'payroll_connector', c.id, b, auth.userId);
      // the names of the stored secrets are recorded, never their values
      await app.audit(tx, req, { action: 'payroll_connector.credentials_set', targetType: 'payroll_connector', targetId: c.id, diff: { configured } });
      return { configured };
    });
  });

  // ---- Xero OAuth 2.0 (authorisation code; the customer's admin consents in Xero) ------------------------------
  app.post('/v1/payroll/connectors/:id/xero/authorize', { config: { selfAudited: true }, schema: { tags: ['payroll'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ url: Type.String() }), 403: Problem, 404: Problem, 422: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.manage');
    const xero = deps.integrations?.xero;
    if (!xero) throw new ApiError('unprocessable', 'The Xero app is not registered for this region yet (HUMAN_TODO 4.4); use a Xero custom connection instead');
    const state = randomBytes(24).toString('base64url');
    await app.tenantTx(req, async (tx) => {
      const c = await loadConnector(tx, (req.params as { id: string }).id);
      if (c.kind !== 'xero_uk' || !allowed(auth, 'payroll.manage', c.entity_id)) throw new ApiError('notFound');
      await createOAuthState(tx, 'payroll_connector', c.id, auth.userId, deps.now(), state);
      await app.audit(tx, req, { action: 'payroll_connector.xero_authorize_started', targetType: 'payroll_connector', targetId: c.id });
    });
    return { url: xeroAuthorizeUrl(xero.clientId, callbackUrl(), state) };
  });

  app.get('/v1/payroll/xero/callback', { config: { selfAudited: true }, schema: { tags: ['payroll'], querystring: Type.Object({ code: Type.Optional(Type.String({ maxLength: 2000 })), state: Type.String({ maxLength: 200 }), error: Type.Optional(Type.String({ maxLength: 200 })) }), response: { 302: Type.Null(), 400: Problem, 403: Problem } } }, async (req, reply) => {
    const auth = need(req, 'payroll.manage');
    const q = req.query as { code?: string; state: string; error?: string };
    const xero = deps.integrations?.xero;
    const owner = await app.tenantTx(req, (tx) => consumeOAuthState(tx, q.state, auth.userId, deps.now()));
    if (!owner || owner.owner_type !== 'payroll_connector' || !xero) throw new ApiError('validation', 'Invalid or expired authorisation');
    if (q.error || !q.code) return reply.redirect(`${deps.config.appBaseUrl}/app/payroll?xero=denied`, 302);
    const tokens = await xeroExchangeCode(deps.fetch, xero, q.code, callbackUrl());
    const orgs = (await xeroConnections(deps.fetch, tokens.access_token)).filter((o) => o.tenantType === 'ORGANISATION');
    await app.tenantTx(req, async (tx) => {
      const c = await loadConnector(tx, owner.owner_id);
      await mergeCredentials(tx, deps.keys, auth.tenantId, 'payroll_connector', c.id, { refreshToken: tokens.refresh_token }, auth.userId);
      const settings = { ...c.settings, ...(orgs[0] && !c.settings.xeroTenantId ? { xeroTenantId: orgs[0].tenantId } : {}) };
      await tx.exec('UPDATE app.payroll_connectors SET settings = $2 WHERE id = $1', [c.id, JSON.stringify(settings)]);
      await app.audit(tx, req, { action: 'payroll_connector.xero_connected', targetType: 'payroll_connector', targetId: c.id, diff: { organisations: orgs.length } });
    });
    return reply.redirect(`${deps.config.appBaseUrl}/app/payroll?xero=connected`, 302);
  });

  // ---- pay periods ------------------------------------------------------------------------------------------------
  const presentPeriod = (p: Record<string, unknown>) => ({ id: p.id as string, name: p.name as string, entityId: (p.entity_id as string) ?? null, frequency: p.frequency as string, startDate: p.start_date as string, endDate: p.end_date as string, payDate: (p.pay_date as string) ?? null, status: p.status as string, closedAt: (p.closed_at as string) ?? null, snapshotSha256: (p.sha256 as string) ?? null, counts: (p.counts as Record<string, number>) ?? null, createdAt: p.created_at as string });

  app.get('/v1/payroll/periods', { schema: { tags: ['payroll'], querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed')])) }), response: { 200: Type.Array(PeriodOut), 403: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    const q = req.query as { status?: string };
    const rows = await app.tenantTx(req, (tx) => tx.query<Record<string, unknown>>(`SELECT p.*, s.sha256, s.counts FROM app.pay_periods p LEFT JOIN app.pay_period_snapshots s ON s.tenant_id = p.tenant_id AND s.id = p.snapshot_id WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.start_date DESC LIMIT 200`, [q.status ?? null]), { readOnly: true });
    return rows.filter((r) => allowed(auth, 'payroll.read', (r.entity_id as string) ?? null)).map(presentPeriod);
  });

  app.post('/v1/payroll/periods', { config: { selfAudited: true }, schema: { tags: ['payroll'], body: PeriodBody, response: { 201: PeriodOut, 400: Problem, 403: Problem, 409: Problem } } }, async (req, reply) => {
    const auth = need(req, 'payroll.manage');
    const b = req.body as { name: string; frequency: string; startDate: string; endDate: string; payDate?: string | null; entityId?: string | null };
    if (!allowed(auth, 'payroll.manage', b.entityId ?? null)) throw new ApiError('forbidden');
    if (compareDates(b.endDate, b.startDate) < 0) throw new ApiError('validation', 'endDate before startDate');
    if (daysBetween(b.startDate, b.endDate) > 31) throw new ApiError('validation', 'A pay period is at most 32 days');
    const row = await app.tenantTx(req, async (tx) => {
      const r = await tx.one<Record<string, unknown>>(
        `INSERT INTO app.pay_periods (tenant_id, entity_id, name, frequency, start_date, end_date, pay_date, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [b.entityId ?? null, b.name, b.frequency, b.startDate, b.endDate, b.payDate ?? null, auth.userId],
      );
      await app.audit(tx, req, { action: 'pay_period.created', targetType: 'pay_period', targetId: r.id as string, diff: { name: b.name, startDate: b.startDate, endDate: b.endDate, entityId: b.entityId ?? null } });
      return r;
    });
    return reply.status(201).send(presentPeriod(row));
  });

  app.post('/v1/payroll/periods/:id/close', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Close a period: snapshot its inputs so every later export is reproducible', params: Type.Object({ id: Uuid }), response: { 200: PeriodOut, 403: Problem, 404: Problem, 409: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.manage');
    const book = await ruleBook(app);
    const row = await app.tenantTx(req, async (tx) => {
      const p = await loadPeriod(tx, (req.params as { id: string }).id, true);
      if (!allowed(auth, 'payroll.manage', p.entity_id)) throw new ApiError('forbidden');
      if (p.status === 'closed') throw new ApiError('conflict', 'This period is already closed');
      const inputs = await buildPayrollInputs(tx, book, p);
      const sha256 = sha256Hex(canonicalJson(inputs));
      const counts = sectionCounts(inputs);
      const snap = await tx.one<{ id: string }>(`INSERT INTO app.pay_period_snapshots (tenant_id, period_id, inputs, sha256, counts, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [p.id, canonicalJson(inputs), sha256, JSON.stringify(counts), auth.userId]);
      await tx.exec(`UPDATE app.pay_periods SET status = 'closed', snapshot_id = $2, closed_at = $3, closed_by = $4 WHERE id = $1`, [p.id, snap.id, deps.now().toISOString(), auth.userId]);
      await app.audit(tx, req, { action: 'pay_period.closed', targetType: 'pay_period', targetId: p.id, diff: { snapshotSha256: sha256, counts } });
      return tx.one<Record<string, unknown>>(`SELECT p.*, s.sha256, s.counts FROM app.pay_periods p JOIN app.pay_period_snapshots s ON s.tenant_id = p.tenant_id AND s.id = p.snapshot_id WHERE p.id = $1`, [p.id]);
    });
    return presentPeriod(row);
  });

  app.get('/v1/payroll/periods/:id/inputs', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Preview the canonical payroll inputs (live while open, the snapshot once closed)', params: Type.Object({ id: Uuid }), response: { 200: InputsOut, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    const book = await ruleBook(app);
    return app.tenantTx(req, async (tx) => {
      const p = await loadPeriod(tx, (req.params as { id: string }).id);
      if (!allowed(auth, 'payroll.read', p.entity_id)) throw new ApiError('forbidden');
      const { inputs, sha256 } = await inputsFor(tx, book, p);
      // contains absence (incl. sickness) dates and sick pay: the view is audited as sensitive
      await app.audit(tx, req, { action: 'payroll.inputs_viewed', targetType: 'pay_period', targetId: p.id, diff: { inputsSha256: sha256 }, sensitive: true });
      return inputs;
    });
  });

  // ---- exports ---------------------------------------------------------------------------------------------------
  app.post('/v1/payroll/periods/:id/exports', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Render a pay-period export with a connector (reproducible once the period is closed)', params: Type.Object({ id: Uuid }), body: Type.Object({ connectorId: Uuid }, { additionalProperties: false }), response: { 201: ExportOut, 403: Problem, 404: Problem, 422: Problem, 501: Problem } } }, async (req, reply) => {
    const auth = need(req, 'payroll.export');
    const book = await ruleBook(app);
    const out = await app.tenantTx(req, async (tx) => {
      const p = await loadPeriod(tx, (req.params as { id: string }).id);
      const c = await loadConnector(tx, (req.body as { connectorId: string }).connectorId);
      if (!allowed(auth, 'payroll.export', p.entity_id)) throw new ApiError('forbidden');
      if (c.entity_id && p.entity_id && c.entity_id !== p.entity_id) throw new ApiError('unprocessable', 'Connector and period belong to different legal entities');
      const e = await createExport(tx, deps.objects, auth.tenantId, book, p, c, auth.userId);
      await app.audit(tx, req, { action: 'payroll.exported', targetType: 'payroll_export', targetId: e.id, diff: { periodId: p.id, connectorId: c.id, kind: c.kind, sha256: e.sha256, inputsSha256: e.inputs_sha256, reproducible: e.snapshot_id !== null, counts: e.counts }, sensitive: true });
      return e;
    });
    return reply.status(201).send(mapExport(out));
  });

  app.get('/v1/payroll/exports', { schema: { tags: ['payroll'], querystring: Type.Object({ periodId: Type.Optional(Uuid) }), response: { 200: Type.Array(ExportOut), 403: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    const q = req.query as { periodId?: string };
    const rows = await app.tenantTx(req, (tx) => tx.query<ExportRow & { entity_id: string | null }>(`SELECT x.*, p.entity_id FROM app.payroll_exports x JOIN app.pay_periods p ON p.tenant_id = x.tenant_id AND p.id = x.period_id WHERE ($1::uuid IS NULL OR x.period_id = $1) ORDER BY x.created_at DESC LIMIT 200`, [q.periodId ?? null]), { readOnly: true });
    return rows.filter((r) => allowed(auth, 'payroll.read', r.entity_id)).map(mapExport);
  });

  async function loadExport(tx: Tx, auth: Auth, id: string, action: string) {
    const e = await tx.maybe<ExportRow & { entity_id: string | null }>(`SELECT x.*, p.entity_id FROM app.payroll_exports x JOIN app.pay_periods p ON p.tenant_id = x.tenant_id AND p.id = x.period_id WHERE x.id = $1`, [id]);
    if (!e || !allowed(auth, action, e.entity_id)) throw new ApiError('notFound');
    return e;
  }

  app.get('/v1/payroll/exports/:id/download', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Short-lived download link (home-region object store); logged as a delivery', params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ url: Type.String(), fileName: Type.String(), sha256: Type.String(), deliveryId: Uuid }), 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.export');
    const out = await app.tenantTx(req, async (tx) => {
      const e = await loadExport(tx, auth, (req.params as { id: string }).id, 'payroll.export');
      const d = await tx.one<{ id: string }>(
        `INSERT INTO app.payroll_deliveries (tenant_id, export_id, connector_id, period_id, method, status, destination, detail, attempts, idempotency_key, requested_by, completed_at)
         VALUES (app.current_tenant(), $1, $2, $3, 'download', 'succeeded', 'download', $4, 1, $5, $6, $7) RETURNING id`,
        [e.id, e.connector_id, e.period_id, JSON.stringify({ sha256: e.sha256, bytes: e.size_bytes }), `download:${e.id}:${req.id}`, auth.userId, deps.now().toISOString()],
      );
      await app.audit(tx, req, { action: 'payroll.export_downloaded', targetType: 'payroll_export', targetId: e.id, diff: { deliveryId: d.id, sha256: e.sha256 }, sensitive: true });
      return { key: e.file_key, fileName: e.file_name, sha256: e.sha256, deliveryId: d.id };
    });
    return { url: await deps.objects.presignGet(out.key, out.fileName), fileName: out.fileName, sha256: out.sha256, deliveryId: out.deliveryId };
  });

  app.post('/v1/payroll/exports/:id/deliver', { config: { selfAudited: true }, schema: { tags: ['payroll'], summary: 'Deliver an export by SFTP or API push (background job; idempotent)', params: Type.Object({ id: Uuid }), body: Type.Object({ idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 100 })) }, { additionalProperties: false }), response: { 201: DeliveryOut, 200: DeliveryOut, 403: Problem, 404: Problem, 422: Problem } } }, async (req, reply) => {
    const auth = need(req, 'payroll.export');
    const b = req.body as { idempotencyKey?: string };
    const out = await app.tenantTx(req, async (tx) => {
      const e = await loadExport(tx, auth, (req.params as { id: string }).id, 'payroll.export');
      const c = await loadConnector(tx, e.connector_id);
      const method = c.delivery.method;
      if (method === 'download') throw new ApiError('unprocessable', 'This connector delivers by download');
      if (!c.enabled) throw new ApiError('unprocessable', 'This connector is disabled');
      const key = `deliver:${e.id}:${b.idempotencyKey ?? req.id}`;
      const existing = await tx.maybe<DeliveryRow>('SELECT * FROM app.payroll_deliveries WHERE idempotency_key = $1', [key]);
      if (existing) return { row: existing, created: false };
      const destination = method === 'sftp' && c.delivery.sftp ? `sftp://${c.delivery.sftp.host}:${c.delivery.sftp.port}/${c.delivery.sftp.directory.replace(/^\/+/, '')}` : c.kind;
      const d = await tx.one<DeliveryRow>(
        `INSERT INTO app.payroll_deliveries (tenant_id, export_id, connector_id, period_id, method, destination, idempotency_key, requested_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [e.id, c.id, e.period_id, method, destination, key, auth.userId],
      );
      const job = await enqueueJob(tx, 'payroll.deliver', d.id, { deliveryId: d.id }, { createdBy: auth.userId });
      await tx.exec('UPDATE app.payroll_deliveries SET job_id = $2 WHERE id = $1', [d.id, job.id]);
      await app.audit(tx, req, { action: 'payroll.delivery_requested', targetType: 'payroll_delivery', targetId: d.id, diff: { exportId: e.id, method, destination } });
      return { row: { ...d, job_id: job.id }, created: true };
    });
    return reply.status(out.created ? 201 : 200).send(mapDelivery(out.row));
  });

  app.get('/v1/payroll/deliveries', { schema: { tags: ['payroll'], summary: 'Delivery log (downloads, SFTP uploads and API pushes)', querystring: Type.Object({ periodId: Type.Optional(Uuid), exportId: Type.Optional(Uuid) }), response: { 200: Type.Array(DeliveryOut), 403: Problem } } }, async (req) => {
    const auth = need(req, 'payroll.read');
    const q = req.query as { periodId?: string; exportId?: string };
    const rows = await app.tenantTx(
      req,
      (tx) =>
        tx.query<DeliveryRow & { entity_id: string | null }>(
          `SELECT d.*, p.entity_id FROM app.payroll_deliveries d JOIN app.pay_periods p ON p.tenant_id = d.tenant_id AND p.id = d.period_id
            WHERE ($1::uuid IS NULL OR d.period_id = $1) AND ($2::uuid IS NULL OR d.export_id = $2) ORDER BY d.created_at DESC, d.id LIMIT 500`,
          [q.periodId ?? null, q.exportId ?? null],
        ),
      { readOnly: true },
    );
    return rows.filter((r) => allowed(auth, 'payroll.read', r.entity_id)).map(mapDelivery);
  });
}

// ---- delivery job (idempotent per delivery; items already pushed are never sent twice) --------------------------------
const PERMANENT = new Set(['hostNotAllowed', 'hostKeyMismatch', 'authFailed', 'notConnected', 'notConfigured']);

export async function runDelivery(ctx: { tenantId: string; deps: Deps; tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>; jobCreatedBy: string | null }, deliveryId: string) {
  const d = await ctx.tx((tx) => tx.maybe<DeliveryRow & { file_key: string; file_name: string; content_type: string; sha256: string; counts: Record<string, number> }>(
    `SELECT d.*, x.file_key, x.file_name, x.content_type, x.sha256, x.counts FROM app.payroll_deliveries d JOIN app.payroll_exports x ON x.tenant_id = d.tenant_id AND x.id = d.export_id WHERE d.id = $1`,
    [deliveryId],
  ));
  if (!d || d.status === 'succeeded') return { skipped: true };
  const connector = await ctx.tx((tx) => loadConnector(tx, d.connector_id));
  await ctx.tx((tx) => tx.exec(`UPDATE app.payroll_deliveries SET status = 'running', attempts = attempts + 1 WHERE id = $1`, [d.id]));
  const body = await ctx.deps.objects.get(d.file_key);
  let status: 'succeeded' | 'partial' | 'failed' = 'failed';
  let destination = d.destination;
  let detail: Record<string, unknown> = {};
  let error: string | null = null;
  let retry = false;
  try {
    if (sha256Hex(body) !== d.sha256) throw new ApiError('internal', 'Export file integrity check failed');
    const credentials = await ctx.tx((tx) => getCredentials(tx, ctx.deps.keys, ctx.tenantId, 'payroll_connector', connector.id));
    if (d.method === 'sftp') {
      const sftp = connector.delivery.sftp!;
      const r = await uploadSftp(sftp, credentials ?? {}, d.file_name, body, { allowPrivateHosts: ctx.deps.config.env === 'dev' || ctx.deps.config.env === 'test' || process.env.SFTP_ALLOW_PRIVATE_HOSTS === 'true' });
      status = 'succeeded';
      destination = `sftp://${sftp.host}:${sftp.port}${r.path.startsWith('/') ? '' : '/'}${r.path}`;
      detail = { bytes: r.bytes, sha256: d.sha256, fileName: d.file_name };
    } else {
      const def = CONNECTORS[connector.kind];
      const earlier = await ctx.tx((tx) => tx.query<{ detail: { items?: ItemResult[] } }>(`SELECT detail FROM app.payroll_deliveries WHERE export_id = $1 AND id <> $2 AND method = 'api'`, [d.export_id, d.id]));
      const previous: Record<string, ItemResult> = {};
      for (const e of [...earlier, { detail: d.detail as { items?: ItemResult[] } }]) for (const i of e.detail.items ?? []) if (i.status === 'succeeded') previous[i.key] = i;
      const r: PushResult = await def.push!(
        {
          fetch: ctx.deps.fetch,
          credentials,
          saveCredentials: (values) => ctx.tx((tx) => mergeCredentials(tx, ctx.deps.keys, ctx.tenantId, 'payroll_connector', connector.id, values, ctx.jobCreatedBy)).then(() => undefined),
          platformApp: ctx.deps.integrations?.xero,
          idempotencyPrefix: `thr-${d.export_id}`,
          previous,
        },
        { body, fileName: d.file_name, contentType: d.content_type, counts: d.counts },
        connector,
      );
      status = r.status;
      destination = r.destination;
      detail = { items: r.items, pushed: r.items.filter((i) => i.status === 'succeeded').length, skipped: r.items.filter((i) => i.status === 'skipped').length, failed: r.items.filter((i) => i.status === 'failed').length };
    }
  } catch (err) {
    const code = err instanceof SftpError || err instanceof IntegrationHttpError ? err.code : err instanceof ApiError ? err.code : 'error';
    error = err instanceof SftpError || err instanceof IntegrationHttpError ? err.message : 'Delivery failed';
    detail = { code };
    retry = !PERMANENT.has(code);
  }
  await ctx.tx(async (tx) => {
    await tx.exec(`UPDATE app.payroll_deliveries SET status = $2, destination = $3, detail = $4, error = $5, completed_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() END WHERE id = $1`, [d.id, status, destination, JSON.stringify(detail), error]);
    await writeAudit(tx, { actorType: 'system', actorId: ctx.jobCreatedBy, action: 'payroll.delivered', targetType: 'payroll_delivery', targetId: d.id, diff: { exportId: d.export_id, method: d.method, status, destination, error } });
  });
  if (status === 'failed' && retry) throw new Error(`payroll delivery ${d.id} failed (${String(detail.code)})`);
  return { status, destination };
}

registerJob('payroll.deliver', async (ctx) => runDelivery({ tenantId: ctx.tenantId, deps: ctx.deps, tx: ctx.tx, jobCreatedBy: ctx.job.created_by }, String(ctx.job.input.deliveryId)));

