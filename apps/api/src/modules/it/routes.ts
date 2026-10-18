import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { canSome } from '@thapsus/core/permissions';
import { addDays, startOfDayInstant } from '@thapsus/core/time';
import { enqueueJob, type Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { registerJob, subscribe } from '../../jobs/registry';
import { consumeOAuthState, createOAuthState, credentialFields, putCredentials } from '../integrations/credentials';
import { IntegrationHttpError } from '../integrations/http';
import { loadTarget } from '../employees/service';
import { can } from '@thapsus/core/permissions';
import { SCOPES, type ItSettings, type Lifecycle, type Provider } from './plan';
import { connectionCredentials, executeLifecycle, loadConnection, loadPlanEmployee, planFor, providerToken, type ConnectionRow } from './service';

/**
 * Joiner / leaver IT automation (PROGRESS 6.4). The customer connects their own Microsoft 365 or Google
 * Workspace directory with admin consent (least-privilege scopes in plan.ts), maps licences and groups to
 * entities / departments / locations / job titles, previews the exact calls (dry run), and lifecycle events
 * run them through idempotent background jobs with a full execution log and audit trail.
 */
const PROVIDERS = ['microsoft365', 'google_workspace'] as const;
const lit = <T extends string>(v: readonly T[]) => Type.Union(v.map((x) => Type.Literal(x)));
const ProviderParam = Type.Object({ provider: lit(PROVIDERS) });

const SettingsSchema = Type.Object(
  {
    usernameFormat: Type.Optional(Type.String({ maxLength: 60, pattern: '^[a-z0-9{}._-]+$' })),
    joinerLeadDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
    leaverTiming: Type.Optional(lit(['end_of_last_day', 'immediately'] as const)),
    autoExecute: Type.Optional(Type.Boolean()),
    maxJoinerBackdateDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
    defaultOrgUnitPath: Type.Optional(Type.String({ maxLength: 300, pattern: '^/' })),
  },
  { additionalProperties: false },
);
const ConnectionOut = Type.Object({
  provider: Type.String(),
  status: Type.String(),
  domain: Nullable(Type.String()),
  directoryId: Nullable(Type.String()),
  clientId: Nullable(Type.String()),
  adminSubject: Nullable(Type.String()),
  settings: SettingsSchema,
  consentedAt: Nullable(Type.String()),
  credentials: Type.Array(Type.String()),
  scopes: Type.Array(Type.String()),
  rules: Type.Integer(),
});
const ConnectionBody = Type.Object(
  {
    domain: Type.String({ maxLength: 253, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' }),
    directoryId: Type.Optional(Nullable(Type.String({ maxLength: 100, pattern: '^[A-Za-z0-9-]+$' }))),
    clientId: Type.Optional(Nullable(Type.String({ maxLength: 200, pattern: '^[A-Za-z0-9.@_-]+$' }))),
    adminSubject: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 254 }))),
    settings: Type.Optional(SettingsSchema),
  },
  { additionalProperties: false },
);
const RuleBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    match: Type.Object({ entityId: Type.Optional(Uuid), departmentId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), jobTitleContains: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }, { additionalProperties: false }),
    licences: Type.Array(Type.Object({ skuId: Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' }), productId: Type.Optional(Type.String({ maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' })) }, { additionalProperties: false }), { maxItems: 20 }),
    groups: Type.Array(Type.String({ minLength: 1, maxLength: 254, pattern: '^[A-Za-z0-9.@_+-]+$' }), { maxItems: 50 }),
    orgUnitPath: Type.Optional(Nullable(Type.String({ maxLength: 300, pattern: '^/' }))),
  },
  { additionalProperties: false },
);
const RuleOut = Type.Object({ id: Uuid, name: Type.String(), priority: Type.Integer(), match: Type.Record(Type.String(), Type.String()), licences: Type.Array(Type.Object({ skuId: Type.String(), productId: Type.Optional(Type.String()) })), groups: Type.Array(Type.String()), orgUnitPath: Nullable(Type.String()) });
const PlanOut = Type.Object({
  provider: Type.String(),
  lifecycle: Type.String(),
  principalName: Type.String(),
  matchedRules: Type.Array(Type.String()),
  operations: Type.Array(Type.Object({ seq: Type.Integer(), op: Type.String(), method: Type.String(), url: Type.String(), target: Type.String(), body: Type.Optional(Type.Record(Type.String(), Type.Any())) })),
  skipped: Type.Optional(Type.String()),
});
const OperationOut = Type.Object({ id: Uuid, employeeId: Uuid, employeeName: Nullable(Type.String()), provider: Type.String(), lifecycle: Type.String(), anchorDate: Type.String(), seq: Type.Integer(), op: Type.String(), method: Type.String(), url: Type.String(), status: Type.String(), responseStatus: Nullable(Type.Integer()), error: Nullable(Type.String()), attempts: Type.Integer(), executedAt: Nullable(Type.String()), createdAt: Type.String() });

function need(req: FastifyRequest, action: string) {
  const auth = requireAuth(req);
  if (!canSome(auth.principal, action)) throw new ApiError('forbidden');
  return auth;
}

async function present(tx: Tx, provider: Provider, c: ConnectionRow | undefined) {
  const rules = c ? (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM app.it_mapping_rules WHERE connection_id = $1', [c.id])).n : 0;
  return {
    provider,
    status: c?.status ?? 'not_configured',
    domain: c?.domain ?? null,
    directoryId: c?.directory_id ?? null,
    clientId: c?.client_id ?? null,
    adminSubject: c?.admin_subject ?? null,
    settings: c?.settings ?? {},
    consentedAt: c?.consented_at ?? null,
    credentials: c ? await credentialFields(tx, 'it_connection', c.id) : [],
    scopes: SCOPES[provider],
    rules,
  };
}

const mapRule = (r: { id: string; name: string; priority: number; match: Record<string, string>; licences: Array<{ skuId: string; productId?: string }>; groups: string[]; org_unit_path: string | null }) => ({ id: r.id, name: r.name, priority: r.priority, match: r.match, licences: r.licences, groups: r.groups, orgUnitPath: r.org_unit_path });

export async function itRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const consentCallback = () => `${deps.config.appBaseUrl}/v1/integrations/it/microsoft365/consent-callback`;

  async function connectionOr404(tx: Tx, provider: Provider) {
    const c = await loadConnection(tx, provider);
    if (!c) throw new ApiError('notFound');
    return c;
  }

  app.get('/v1/integrations/it', { schema: { tags: ['integrations'], summary: 'Microsoft 365 and Google Workspace connection status', response: { 200: Type.Array(ConnectionOut), 403: Problem } } }, async (req) => {
    need(req, 'integrations.read');
    return app.tenantTx(
      req,
      async (tx) => {
        const out = [];
        for (const p of PROVIDERS) out.push(await present(tx, p, await loadConnection(tx, p)));
        return out;
      },
      { readOnly: true },
    );
  });

  app.put('/v1/integrations/it/:provider', { config: { selfAudited: true }, schema: { tags: ['integrations'], params: ProviderParam, body: ConnectionBody, response: { 200: ConnectionOut, 400: Problem, 403: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    const b = req.body as { domain: string; directoryId?: string | null; clientId?: string | null; adminSubject?: string | null; settings?: ItSettings };
    return app.tenantTx(req, async (tx) => {
      const before = await loadConnection(tx, provider);
      // changing the directory or the app means consent has to be given again
      const reconsent = !!before && ((b.directoryId !== undefined && b.directoryId !== before.directory_id) || (b.clientId !== undefined && b.clientId !== before.client_id) || (b.adminSubject !== undefined && b.adminSubject !== before.admin_subject) || b.domain !== before.domain);
      if (!before) {
        await tx.exec(
          `INSERT INTO app.it_connections (tenant_id, provider, domain, directory_id, client_id, admin_subject, settings, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7)`,
          [provider, b.domain, b.directoryId ?? null, b.clientId ?? null, b.adminSubject ?? null, JSON.stringify(b.settings ?? {}), auth.userId],
        );
      } else {
        await tx.exec(
          `UPDATE app.it_connections SET domain = $2, directory_id = $3, client_id = $4, admin_subject = $5, settings = $6,
             status = CASE WHEN $7 THEN 'pending_consent' ELSE status END, consented_at = CASE WHEN $7 THEN NULL ELSE consented_at END WHERE id = $1`,
          [
            before.id,
            b.domain,
            b.directoryId === undefined ? before.directory_id : b.directoryId,
            b.clientId === undefined ? before.client_id : b.clientId,
            b.adminSubject === undefined ? before.admin_subject : b.adminSubject,
            JSON.stringify(b.settings ?? before.settings),
            reconsent,
          ],
        );
      }
      await app.audit(tx, req, { action: 'it_connection.saved', targetType: 'it_connection', targetId: provider, diff: { domain: b.domain, directoryId: b.directoryId, clientId: b.clientId, settings: b.settings, reconsentRequired: reconsent } });
      return present(tx, provider, await loadConnection(tx, provider));
    });
  });

  app.put('/v1/integrations/it/:provider/credentials', { config: { selfAudited: true }, schema: { tags: ['integrations'], summary: 'Store the client secret (Microsoft) or service account key (Google); sealed, never returned', params: ProviderParam, body: Type.Object({ clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), serviceAccountKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })) }, { additionalProperties: false }), response: { 200: Type.Object({ configured: Type.Array(Type.String()) }), 400: Problem, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    const b = req.body as { clientSecret?: string; serviceAccountKey?: string };
    if (provider === 'google_workspace' && b.serviceAccountKey) {
      let key: { client_email?: string; private_key?: string };
      try {
        key = JSON.parse(b.serviceAccountKey);
      } catch {
        throw new ApiError('validation', 'serviceAccountKey must be the JSON key file');
      }
      if (!key.client_email || !key.private_key?.includes('PRIVATE KEY')) throw new ApiError('validation', 'serviceAccountKey must contain client_email and private_key');
    }
    return app.tenantTx(req, async (tx) => {
      const c = await connectionOr404(tx, provider);
      const values: Record<string, string> = {};
      if (provider === 'microsoft365' && b.clientSecret) values.clientSecret = b.clientSecret;
      if (provider === 'google_workspace' && b.serviceAccountKey) values.serviceAccountKey = b.serviceAccountKey;
      const configured = await putCredentials(tx, deps.keys, auth.tenantId, 'it_connection', c.id, values, auth.userId);
      await app.audit(tx, req, { action: 'it_connection.credentials_set', targetType: 'it_connection', targetId: provider, diff: { configured } });
      return { configured };
    });
  });

  // ---- consent -----------------------------------------------------------------------------------------------------
  // Microsoft admin consent (v2 endpoint): https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
  app.post('/v1/integrations/it/:provider/consent', { config: { selfAudited: true }, schema: { tags: ['integrations'], summary: 'Start per-customer admin consent (Microsoft) or get the delegation details to enter (Google)', params: ProviderParam, response: { 200: Type.Object({ url: Nullable(Type.String()), clientId: Nullable(Type.String()), scopes: Type.Array(Type.String()) }), 403: Problem, 404: Problem, 422: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    return app.tenantTx(req, async (tx) => {
      const c = await connectionOr404(tx, provider);
      await app.audit(tx, req, { action: 'it_connection.consent_started', targetType: 'it_connection', targetId: provider });
      if (provider === 'google_workspace') {
        const creds = await connectionCredentials(deps, tx, auth.tenantId, c);
        const clientId = creds.serviceAccountKey ? ((JSON.parse(creds.serviceAccountKey) as { client_id?: string }).client_id ?? c.client_id) : c.client_id;
        return { url: null, clientId: clientId ?? null, scopes: SCOPES.google_workspace };
      }
      const clientId = c.client_id ?? deps.integrations?.microsoft?.clientId;
      if (!clientId) throw new ApiError('unprocessable', 'No Microsoft Entra application is configured (HUMAN_TODO 4.2), and none was entered for this workspace');
      const state = randomBytes(24).toString('base64url');
      await createOAuthState(tx, 'it_connection', c.id, auth.userId, deps.now(), state);
      const u = new URL(`https://login.microsoftonline.com/${encodeURIComponent(c.directory_id ?? 'organizations')}/v2.0/adminconsent`);
      u.search = new URLSearchParams({ client_id: clientId, scope: 'https://graph.microsoft.com/.default', redirect_uri: consentCallback(), state }).toString();
      return { url: u.toString(), clientId, scopes: SCOPES.microsoft365 };
    });
  });

  app.get('/v1/integrations/it/microsoft365/consent-callback', { config: { selfAudited: true }, schema: { tags: ['integrations'], querystring: Type.Object({ state: Type.String({ maxLength: 200 }), tenant: Type.Optional(Type.String({ maxLength: 100, pattern: '^[A-Za-z0-9-]+$' })), admin_consent: Type.Optional(Type.String({ maxLength: 10 })), error: Type.Optional(Type.String({ maxLength: 200 })), error_description: Type.Optional(Type.String({ maxLength: 2000 })), scope: Type.Optional(Type.String({ maxLength: 2000 })) }), response: { 302: Type.Null(), 400: Problem, 403: Problem } } }, async (req, reply) => {
    const auth = need(req, 'integrations.manage');
    const q = req.query as { state: string; tenant?: string; admin_consent?: string; error?: string };
    const ok = await app.tenantTx(req, async (tx) => {
      const owner = await consumeOAuthState(tx, q.state, auth.userId, deps.now());
      if (!owner || owner.owner_type !== 'it_connection') throw new ApiError('validation', 'Invalid or expired consent request');
      const granted = q.admin_consent?.toLowerCase() === 'true' && !!q.tenant && !q.error;
      if (granted) await tx.exec(`UPDATE app.it_connections SET directory_id = $2, status = 'connected', consented_at = $3, consented_by = $4 WHERE id = $1`, [owner.owner_id, q.tenant, deps.now().toISOString(), auth.userId]);
      await app.audit(tx, req, { action: granted ? 'it_connection.consented' : 'it_connection.consent_declined', targetType: 'it_connection', targetId: 'microsoft365', diff: { directoryId: q.tenant ?? null } });
      return granted;
    });
    return reply.redirect(`${deps.config.appBaseUrl}/app/integrations?consent=${ok ? 'granted' : 'declined'}`, 302);
  });

  app.post('/v1/integrations/it/:provider/verify', { config: { selfAudited: true }, schema: { tags: ['integrations'], summary: 'Prove the consent / delegation works by obtaining a token; marks the connection connected', params: ProviderParam, response: { 200: ConnectionOut, 403: Problem, 404: Problem, 422: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    const { conn, creds } = await app.tenantTx(req, async (tx) => {
      const c = await connectionOr404(tx, provider);
      return { conn: c, creds: await connectionCredentials(deps, tx, auth.tenantId, c) };
    });
    let error: string | null = null;
    try {
      await providerToken(deps, conn, creds);
    } catch (err) {
      error = err instanceof IntegrationHttpError ? err.code : 'error';
    }
    return app.tenantTx(req, async (tx) => {
      if (!error) await tx.exec(`UPDATE app.it_connections SET status = 'connected', consented_at = coalesce(consented_at, $2), consented_by = coalesce(consented_by, $3) WHERE id = $1`, [conn.id, deps.now().toISOString(), auth.userId]);
      await app.audit(tx, req, { action: 'it_connection.verified', targetType: 'it_connection', targetId: provider, diff: { ok: !error, error } });
      if (error) throw new ApiError('unprocessable', `The provider refused the credentials (${error})`);
      return present(tx, provider, await loadConnection(tx, provider));
    });
  });

  app.post('/v1/integrations/it/:provider/disable', { config: { selfAudited: true }, schema: { tags: ['integrations'], params: ProviderParam, response: { 200: ConnectionOut, 403: Problem, 404: Problem } } }, async (req) => {
    need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    return app.tenantTx(req, async (tx) => {
      const c = await connectionOr404(tx, provider);
      await tx.exec(`UPDATE app.it_connections SET status = 'disabled' WHERE id = $1`, [c.id]);
      await app.audit(tx, req, { action: 'it_connection.disabled', targetType: 'it_connection', targetId: provider });
      return present(tx, provider, await loadConnection(tx, provider));
    });
  });

  // ---- mapping rules ------------------------------------------------------------------------------------------------
  app.get('/v1/integrations/it/:provider/rules', { schema: { tags: ['integrations'], params: ProviderParam, response: { 200: Type.Array(RuleOut), 403: Problem } } }, async (req) => {
    need(req, 'integrations.read');
    const { provider } = req.params as { provider: Provider };
    return app.tenantTx(req, async (tx) => {
      const c = await loadConnection(tx, provider);
      if (!c) return [];
      return (await tx.query<Parameters<typeof mapRule>[0]>('SELECT * FROM app.it_mapping_rules WHERE connection_id = $1 ORDER BY priority, name', [c.id])).map(mapRule);
    }, { readOnly: true });
  });

  app.post('/v1/integrations/it/:provider/rules', { config: { selfAudited: true }, schema: { tags: ['integrations'], params: ProviderParam, body: RuleBody, response: { 201: RuleOut, 403: Problem, 404: Problem } } }, async (req, reply) => {
    need(req, 'integrations.manage');
    const { provider } = req.params as { provider: Provider };
    const b = req.body as { name: string; priority?: number; match: Record<string, string>; licences: unknown[]; groups: string[]; orgUnitPath?: string | null };
    const out = await app.tenantTx(req, async (tx) => {
      const c = await connectionOr404(tx, provider);
      const r = await tx.one<Parameters<typeof mapRule>[0]>(`INSERT INTO app.it_mapping_rules (tenant_id, connection_id, name, priority, match, licences, groups, org_unit_path) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`, [c.id, b.name, b.priority ?? 100, JSON.stringify(b.match), JSON.stringify(b.licences), JSON.stringify(b.groups), b.orgUnitPath ?? null]);
      await app.audit(tx, req, { action: 'it_rule.created', targetType: 'it_mapping_rule', targetId: r.id, diff: { provider, ...b } });
      return mapRule(r);
    });
    return reply.status(201).send(out);
  });

  app.put('/v1/integrations/it/rules/:id', { config: { selfAudited: true }, schema: { tags: ['integrations'], params: Type.Object({ id: Uuid }), body: RuleBody, response: { 200: RuleOut, 403: Problem, 404: Problem } } }, async (req) => {
    need(req, 'integrations.manage');
    const { id } = req.params as { id: string };
    const b = req.body as { name: string; priority?: number; match: Record<string, string>; licences: unknown[]; groups: string[]; orgUnitPath?: string | null };
    return app.tenantTx(req, async (tx) => {
      const r = await tx.maybe<Parameters<typeof mapRule>[0]>(`UPDATE app.it_mapping_rules SET name = $2, priority = $3, match = $4, licences = $5, groups = $6, org_unit_path = $7 WHERE id = $1 RETURNING *`, [id, b.name, b.priority ?? 100, JSON.stringify(b.match), JSON.stringify(b.licences), JSON.stringify(b.groups), b.orgUnitPath ?? null]);
      if (!r) throw new ApiError('notFound');
      await app.audit(tx, req, { action: 'it_rule.updated', targetType: 'it_mapping_rule', targetId: id, diff: b });
      return mapRule(r);
    });
  });

  app.delete('/v1/integrations/it/rules/:id', { config: { selfAudited: true }, schema: { tags: ['integrations'], params: Type.Object({ id: Uuid }), response: { 204: Type.Null(), 403: Problem, 404: Problem } } }, async (req, reply) => {
    need(req, 'integrations.manage');
    const { id } = req.params as { id: string };
    await app.tenantTx(req, async (tx) => {
      if (!(await tx.exec('DELETE FROM app.it_mapping_rules WHERE id = $1', [id]))) throw new ApiError('notFound');
      await app.audit(tx, req, { action: 'it_rule.deleted', targetType: 'it_mapping_rule', targetId: id });
    });
    return reply.status(204).send();
  });

  // ---- dry run, run now, execution log ----------------------------------------------------------------------------------
  app.get('/v1/integrations/it/:provider/preview/:employeeId', { config: { selfAudited: true }, schema: { tags: ['integrations'], summary: 'Dry run: the exact provider calls for this employee, without calling the provider', params: Type.Object({ provider: lit(PROVIDERS), employeeId: Uuid }), querystring: Type.Object({ lifecycle: lit(['joiner', 'leaver'] as const) }), response: { 200: PlanOut, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.read');
    const { provider, employeeId } = req.params as { provider: Provider; employeeId: string };
    const { lifecycle } = req.query as { lifecycle: Lifecycle };
    return app.tenantTx(req, async (tx) => {
      if (!can(auth.principal, 'integrations.read', await loadTarget(tx, employeeId))) throw new ApiError('forbidden');
      const c = await connectionOr404(tx, provider);
      const plan = await planFor(tx, c, employeeId, lifecycle);
      await app.audit(tx, req, { action: 'it.preview', targetType: 'employee', targetId: employeeId, diff: { provider, lifecycle, operations: plan.operations.length } });
      return plan;
    });
  });

  app.post('/v1/integrations/it/:provider/run/:employeeId', { config: { selfAudited: true }, schema: { tags: ['integrations'], summary: 'Run (or re-run) the joiner or leaver steps for one employee now', params: Type.Object({ provider: lit(PROVIDERS), employeeId: Uuid }), body: Type.Object({ lifecycle: lit(['joiner', 'leaver'] as const) }, { additionalProperties: false }), response: { 200: Type.Object({ jobId: Uuid, created: Type.Boolean() }), 403: Problem, 404: Problem, 422: Problem } } }, async (req) => {
    const auth = need(req, 'integrations.manage');
    const { provider, employeeId } = req.params as { provider: Provider; employeeId: string };
    const { lifecycle } = req.body as { lifecycle: Lifecycle };
    return app.tenantTx(req, async (tx) => {
      if (!can(auth.principal, 'integrations.manage', await loadTarget(tx, employeeId))) throw new ApiError('forbidden');
      const c = await connectionOr404(tx, provider);
      if (c.status !== 'connected') throw new ApiError('unprocessable', 'Connect and verify the directory first');
      const e = await tx.one<{ start_date: string; end_date: string | null }>('SELECT start_date, end_date FROM app.employees WHERE id = $1', [employeeId]);
      const anchor = lifecycle === 'joiner' ? e.start_date : e.end_date;
      if (!anchor) throw new ApiError('unprocessable', 'This employee has no leave date');
      // a manual run re-tries anything not yet done; completed calls are skipped by their idempotency keys
      const job = await enqueueJob(tx, 'it.lifecycle', `${lifecycle}:${provider}:${employeeId}:${anchor}:manual:${req.id}`, { provider, employeeId, lifecycle, anchorDate: anchor }, { createdBy: auth.userId });
      await app.audit(tx, req, { action: 'it.run_requested', targetType: 'employee', targetId: employeeId, diff: { provider, lifecycle, jobId: job.id } });
      return { jobId: job.id, created: job.created };
    });
  });

  app.get('/v1/integrations/it/operations', { schema: { tags: ['integrations'], summary: 'Execution log of provider calls', querystring: Type.Object({ employeeId: Type.Optional(Uuid), provider: Type.Optional(lit(PROVIDERS)) }), response: { 200: Type.Array(OperationOut), 403: Problem } } }, async (req) => {
    need(req, 'integrations.read');
    const q = req.query as { employeeId?: string; provider?: Provider };
    const rows = await app.tenantTx(
      req,
      (tx) =>
        tx.query<{ id: string; employee_id: string; display_name: string | null; provider: string; lifecycle: string; anchor_date: string; seq: number; op: string; method: string; url: string; status: string; response_status: number | null; error: string | null; attempts: number; executed_at: string | null; created_at: string }>(
          `SELECT o.*, c.provider, e.display_name FROM app.it_operations o JOIN app.it_connections c ON c.tenant_id = o.tenant_id AND c.id = o.connection_id
             LEFT JOIN app.employees e ON e.tenant_id = o.tenant_id AND e.id = o.employee_id
            WHERE ($1::uuid IS NULL OR o.employee_id = $1) AND ($2::text IS NULL OR c.provider = $2) ORDER BY o.created_at DESC, o.seq LIMIT 500`,
          [q.employeeId ?? null, q.provider ?? null],
        ),
      { readOnly: true },
    );
    return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: r.display_name, provider: r.provider, lifecycle: r.lifecycle, anchorDate: r.anchor_date, seq: r.seq, op: r.op, method: r.method, url: r.url, status: r.status, responseStatus: r.response_status, error: r.error, attempts: r.attempts, executedAt: r.executed_at, createdAt: r.created_at }));
  });
}

// ---- lifecycle events → idempotent jobs --------------------------------------------------------------------------------------
async function schedule(tx: Tx, employeeId: string, lifecycle: Lifecycle, anchorDate: string) {
  const conns = await tx.query<ConnectionRow>(`SELECT * FROM app.it_connections WHERE status = 'connected'`);
  if (!conns.length) return;
  const e = { tz: (await loadPlanEmployee(tx, employeeId)).timeZone };
  for (const c of conns) {
    if (c.settings.autoExecute === false) continue;
    let runAfter: string | undefined;
    if (lifecycle === 'joiner') {
      // hires backdated beyond the window (for example an import of existing staff) are never provisioned automatically
      const old = await tx.one<{ old: boolean }>(`SELECT $1::date < (current_date - $2::int) AS old`, [anchorDate, c.settings.maxJoinerBackdateDays ?? 7]);
      if (old.old) continue;
      runAfter = startOfDayInstant(addDays(anchorDate, -(c.settings.joinerLeadDays ?? 3)), e.tz);
    } else if (c.settings.leaverTiming !== 'immediately') {
      runAfter = startOfDayInstant(addDays(anchorDate, 1), e.tz); // the end of the last working day
    }
    await enqueueJob(tx, 'it.lifecycle', `${lifecycle}:${c.provider}:${employeeId}:${anchorDate}`, { provider: c.provider, employeeId, lifecycle, anchorDate }, { runAfter });
  }
}
subscribe('employee.created', async (tx, ev) => schedule(tx, String(ev.payload.employeeId), 'joiner', String(ev.payload.startDate)));
subscribe('employee.terminated', async (tx, ev) => schedule(tx, String(ev.payload.employeeId), 'leaver', String(ev.payload.endDate)));

registerJob('it.lifecycle', async (ctx) => {
  const i = ctx.job.input as { provider: Provider; employeeId: string; lifecycle: Lifecycle; anchorDate: string };
  return executeLifecycle(ctx.deps, { tenantId: ctx.tenantId, tx: ctx.tx, jobId: ctx.job.id, actorId: ctx.job.created_by }, i.provider, i.employeeId, i.lifecycle, i.anchorDate);
});
