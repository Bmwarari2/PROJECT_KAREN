import { randomBytes, randomInt } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import type { Tx } from '@thapsus/db';
import { writeAudit } from '@thapsus/db';
import type { Deps } from '../../deps';
import { ApiError } from '../../http/errors';
import { getCredentials } from '../integrations/credentials';
import { integrationRequest, IntegrationHttpError, providerErrorCode } from '../integrations/http';
import {
  buildPlan,
  DIRECTORY,
  GRAPH,
  PASSWORD_PLACEHOLDER,
  SCOPES,
  USER_ID_PLACEHOLDER,
  type ItSettings,
  type Lifecycle,
  type Plan,
  type PlanAccount,
  type PlanEmployee,
  type PlannedOp,
  type PlanRule,
  type Provider,
} from './plan';

export interface ConnectionRow {
  id: string;
  provider: Provider;
  status: 'pending_consent' | 'connected' | 'disabled';
  directory_id: string | null;
  domain: string;
  client_id: string | null;
  admin_subject: string | null;
  settings: ItSettings;
  consented_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadConnection(tx: Tx, provider: Provider): Promise<ConnectionRow | undefined> {
  return tx.maybe<ConnectionRow>('SELECT * FROM app.it_connections WHERE provider = $1', [provider]);
}

export async function loadRules(tx: Tx, connectionId: string): Promise<PlanRule[]> {
  return tx.query<PlanRule>(
    'SELECT id, name, priority, match, licences, groups, org_unit_path FROM app.it_mapping_rules WHERE connection_id = $1 ORDER BY priority, name',
    [connectionId],
  );
}

/**
 * The employee as the directory should see them: job, department, location and country as of their
 * first day for a future joiner, today for a current employee, and their last day for a leaver.
 */
export async function loadPlanEmployee(
  tx: Tx,
  employeeId: string,
): Promise<PlanEmployee & { startDate: string; endDate: string | null; timeZone: string }> {
  const e = await tx.maybe<{
    id: string;
    employee_number: string;
    display_name: string;
    preferred_name: string | null;
    job_title: string | null;
    department_id: string | null;
    department: string | null;
    entity_id: string | null;
    location_id: string | null;
    country: string | null;
    work_email: string | null;
    start_date: string;
    end_date: string | null;
    first: string | null;
    last: string | null;
    tz: string;
  }>(
    `WITH emp AS (
       SELECT e.*, least(greatest(current_date, e.start_date), coalesce(e.end_date, 'infinity'::date)) AS as_of FROM app.employees e WHERE e.id = $1
     )
     SELECT e.id, e.employee_number, e.display_name, coalesce(p.preferred_name, e.preferred_name) AS preferred_name, coalesce(j.job_title, e.job_title) AS job_title,
            coalesce(j.department_id, e.department_id) AS department_id, d.name AS department, coalesce(j.entity_id, e.entity_id) AS entity_id,
            coalesce(j.location_id, e.location_id) AS location_id, coalesce(l.country, le.country, e.country) AS country, e.work_email, e.start_date, e.end_date,
            p.legal_first_name AS first, p.legal_last_name AS last, coalesce(l.time_zone, le.time_zone, e.time_zone, t.default_time_zone) AS tz
       FROM emp e JOIN app.tenants t ON t.tenant_id = e.tenant_id
       LEFT JOIN LATERAL (SELECT * FROM app.employee_jobs x WHERE x.employee_id = e.id AND x.valid_from <= e.as_of AND (x.valid_to IS NULL OR x.valid_to > e.as_of) LIMIT 1) j ON true
       LEFT JOIN LATERAL (SELECT * FROM app.employee_personal x WHERE x.employee_id = e.id AND x.valid_from <= e.as_of AND (x.valid_to IS NULL OR x.valid_to > e.as_of) LIMIT 1) p ON true
       LEFT JOIN app.departments d ON d.tenant_id = e.tenant_id AND d.id = coalesce(j.department_id, e.department_id)
       LEFT JOIN app.locations l ON l.tenant_id = e.tenant_id AND l.id = coalesce(j.location_id, e.location_id)
       LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = coalesce(j.entity_id, e.entity_id)`,
    [employeeId],
  );
  if (!e) throw new ApiError('notFound');
  return {
    employeeId: e.id,
    employeeNumber: e.employee_number,
    firstName: e.first ?? e.display_name.split(' ')[0] ?? '',
    lastName: e.last ?? e.display_name.split(' ').slice(1).join(' '),
    preferredName: e.preferred_name,
    displayName: e.display_name,
    jobTitle: e.job_title,
    department: e.department,
    departmentId: e.department_id,
    entityId: e.entity_id,
    locationId: e.location_id,
    country: e.country,
    workEmail: e.work_email,
    startDate: e.start_date,
    endDate: e.end_date,
    timeZone: e.tz,
  };
}

export async function loadAccount(
  tx: Tx,
  connectionId: string,
  employeeId: string,
): Promise<(PlanAccount & { id: string; status: string }) | undefined> {
  const a = await tx.maybe<{
    id: string;
    principal_name: string;
    remote_id: string | null;
    licences: PlanAccount['licences'];
    status: string;
  }>(
    'SELECT id, principal_name, remote_id, licences, status FROM app.it_accounts WHERE connection_id = $1 AND employee_id = $2',
    [connectionId, employeeId],
  );
  return a
    ? {
        id: a.id,
        principalName: a.principal_name,
        remoteId: a.remote_id,
        licences: a.licences,
        status: a.status,
      }
    : undefined;
}

/** The plan for one employee with live data (used by the dry-run preview and by execution). */
export async function planFor(
  tx: Tx,
  conn: ConnectionRow,
  employeeId: string,
  lifecycle: Lifecycle,
): Promise<Plan> {
  // one transaction runs one query at a time
  const rules = await loadRules(tx, conn.id);
  const emp = await loadPlanEmployee(tx, employeeId);
  const account = await loadAccount(tx, conn.id, employeeId);
  return buildPlan(
    conn.provider,
    { domain: conn.domain, settings: conn.settings },
    rules,
    emp,
    lifecycle,
    account,
  );
}

// ---- provider tokens ------------------------------------------------------------------------------------------------
/**
 * Microsoft identity platform client credentials grant, per customer directory:
 * POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token (scope https://graph.microsoft.com/.default)
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
 * Google service account with domain-wide delegation, JWT bearer grant (RS256, aud oauth2.googleapis.com/token,
 * sub = the customer's admin): https://developers.google.com/identity/protocols/oauth2/service-account
 */
export async function connectionCredentials(deps: Deps, tx: Tx, tenantId: string, conn: ConnectionRow) {
  return (await getCredentials(tx, deps.keys, tenantId, 'it_connection', conn.id)) ?? {};
}

export async function providerToken(
  deps: Deps,
  conn: ConnectionRow,
  creds: Record<string, string>,
): Promise<string> {
  if (conn.provider === 'microsoft365') {
    const app =
      creds.clientSecret && conn.client_id
        ? { clientId: conn.client_id, clientSecret: creds.clientSecret }
        : deps.integrations?.microsoft;
    if (!app || !conn.directory_id)
      throw new IntegrationHttpError(0, 'notConnected', 'Microsoft 365 is not connected');
    const r = await integrationRequest<{ access_token: string }>(
      deps.fetch,
      'POST',
      `https://login.microsoftonline.com/${encodeURIComponent(conn.directory_id)}/oauth2/v2.0/token`,
      {
        form: {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        },
      },
    );
    return r.body.access_token;
  }
  if (!creds.serviceAccountKey || !conn.admin_subject)
    throw new IntegrationHttpError(0, 'notConnected', 'Google Workspace is not connected');
  const key = JSON.parse(creds.serviceAccountKey) as { client_email: string; private_key: string };
  const now = Math.floor(deps.now().getTime() / 1000);
  const assertion = await new SignJWT({ scope: SCOPES.google_workspace.join(' ') })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(key.client_email)
    .setSubject(conn.admin_subject)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(key.private_key, 'RS256'));
  const r = await integrationRequest<{ access_token: string }>(
    deps.fetch,
    'POST',
    'https://oauth2.googleapis.com/token',
    { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion } },
  );
  return r.body.access_token;
}

/** A strong one-time password (upper, lower, digit, symbol) that is sent once and never stored. */
export function generatedPassword(): string {
  const base = randomBytes(18).toString('base64url');
  const sym = '!#%+=?@'[randomInt(7)]!;
  return `${base}${sym}${randomInt(10)}Aa`;
}

function withValues(value: unknown, password: string, userId: string | null): unknown {
  if (typeof value === 'string')
    return value === PASSWORD_PLACEHOLDER
      ? password
      : userId
        ? value.replace(USER_ID_PLACEHOLDER, userId)
        : value;
  if (Array.isArray(value)) return value.map((v) => withValues(v, password, userId));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withValues(v, password, userId)]));
  return value;
}

interface OpRow {
  id: string;
  seq: number;
  op: PlannedOp['op'];
  method: PlannedOp['method'];
  url: string;
  body: Record<string, unknown> | null;
  status: string;
  idempotency_key: string;
}

/**
 * Executes a lifecycle for one employee: persists the plan (idempotency key per call), then runs every
 * call that has not succeeded yet. Joiner calls stop at the first failure (later calls need the
 * account); leaver calls each run regardless, so a failed licence removal never leaves sign-in open.
 */
export async function executeLifecycle(
  deps: Deps,
  ctx: {
    tenantId: string;
    tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
    jobId: string | null;
    actorId: string | null;
  },
  provider: Provider,
  employeeId: string,
  lifecycle: Lifecycle,
  anchorDate: string,
) {
  const prepared = await ctx.tx(async (tx) => {
    const conn = await loadConnection(tx, provider);
    if (!conn || conn.status !== 'connected') return { skipped: 'notConnected' as const };
    const emp = await loadPlanEmployee(tx, employeeId);
    if (lifecycle === 'leaver' && emp.endDate !== anchorDate) return { skipped: 'leaveDateChanged' as const };
    if (lifecycle === 'joiner' && emp.startDate !== anchorDate)
      return { skipped: 'startDateChanged' as const };
    const plan = await planFor(tx, conn, employeeId, lifecycle);
    for (const o of plan.operations) {
      await tx.exec(
        `INSERT INTO app.it_operations (tenant_id, connection_id, employee_id, lifecycle, anchor_date, seq, op, method, url, body, idempotency_key, job_id)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          conn.id,
          employeeId,
          lifecycle,
          anchorDate,
          o.seq,
          o.op,
          o.method,
          o.url,
          o.body ? JSON.stringify(o.body) : null,
          `${conn.id}:${employeeId}:${lifecycle}:${anchorDate}:${o.seq}:${o.op}:${o.target}`,
          ctx.jobId,
        ],
      );
    }
    const keys = plan.operations.map(
      (o) => `${conn.id}:${employeeId}:${lifecycle}:${anchorDate}:${o.seq}:${o.op}:${o.target}`,
    );
    const ops = await tx.query<OpRow>(
      `SELECT id, seq, op, method, url, body, status, idempotency_key FROM app.it_operations WHERE idempotency_key = ANY($1::text[]) ORDER BY seq`,
      [keys],
    );
    const account = await loadAccount(tx, conn.id, employeeId);
    const creds = await connectionCredentials(deps, tx, ctx.tenantId, conn);
    return { conn, plan, ops, account, creds };
  });
  if ('skipped' in prepared) return { skipped: prepared.skipped };
  const { conn, plan, ops } = prepared;
  // network calls happen outside database transactions
  const token = ops.some((o) => o.status !== 'succeeded')
    ? await providerToken(deps, conn, prepared.creds)
    : '';
  let userId = prepared.account?.remoteId ?? null;
  const results = { succeeded: 0, failed: 0, skipped: 0, alreadyDone: 0 };
  let blocked = false;
  for (const o of ops) {
    if (o.status === 'succeeded') {
      results.alreadyDone++;
      continue;
    }
    if (blocked) {
      await ctx.tx((tx) =>
        tx.exec(
          `UPDATE app.it_operations SET status = 'skipped', error = 'An earlier step failed' WHERE id = $1`,
          [o.id],
        ),
      );
      results.skipped++;
      continue;
    }
    if (o.url.includes(USER_ID_PLACEHOLDER) && !userId) {
      await ctx.tx((tx) =>
        tx.exec(
          `UPDATE app.it_operations SET status = 'failed', error = 'The account id is not known yet', attempts = attempts + 1 WHERE id = $1`,
          [o.id],
        ),
      );
      results.failed++;
      blocked = lifecycle === 'joiner';
      continue;
    }
    const password = generatedPassword();
    let status = 'succeeded';
    let responseStatus: number | null = null;
    let response: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      const headers = { authorization: `Bearer ${token}` };
      const url = withValues(o.url, password, userId) as string;
      const json = o.body ? withValues(o.body, password, userId) : undefined;
      const r = await integrationRequest<{
        id?: string;
        externalIds?: Array<{ value?: string }>;
        employeeId?: string;
      }>(deps.fetch, o.method, url, { headers, json, okStatuses: okStatusesFor(conn.provider, o.op) });
      responseStatus = r.status;
      if (o.op === 'create_user') {
        if (r.status >= 400) {
          if (conn.provider === 'microsoft365' && !/already exist/i.test(JSON.stringify(r.body ?? {})))
            throw new IntegrationHttpError(
              r.status,
              providerErrorCode(r.body),
              'Creating the account failed',
            );
          // the name is taken: adopt the existing account only when it carries this employee's number
          const existing = await integrationRequest<{
            id?: string;
            employeeId?: string;
            externalIds?: Array<{ value?: string }>;
          }>(
            deps.fetch,
            'GET',
            conn.provider === 'microsoft365'
              ? `${GRAPH}/users/${encodeURIComponent(plan.principalName)}?$select=id,employeeId`
              : `${DIRECTORY}/users/${encodeURIComponent(plan.principalName)}`,
            { headers },
          );
          const owner =
            conn.provider === 'microsoft365'
              ? existing.body.employeeId
              : existing.body.externalIds?.[0]?.value;
          const emp = await ctx.tx((tx) =>
            tx.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [
              employeeId,
            ]),
          );
          if (!existing.body.id || (owner ?? '').slice(0, 16) !== emp.employee_number.slice(0, 16))
            throw new IntegrationHttpError(
              r.status,
              'principalNameTaken',
              'Another account already uses this name',
            );
          userId = existing.body.id;
          response = { id: userId, adopted: true };
        } else {
          userId = r.body?.id ?? null;
          response = { id: userId };
        }
      } else if (r.status >= 400) response = { alreadyApplied: true };
    } catch (err) {
      status = 'failed';
      responseStatus = err instanceof IntegrationHttpError ? err.status : null;
      error =
        err instanceof IntegrationHttpError ? `${err.code}: ${err.message}`.slice(0, 500) : 'Request failed';
    }
    await ctx.tx(async (tx) => {
      await tx.exec(
        `UPDATE app.it_operations SET status = $2, response_status = $3, response = $4, error = $5, attempts = attempts + 1, executed_at = $6, job_id = coalesce($7, job_id) WHERE id = $1`,
        [
          o.id,
          status,
          responseStatus,
          response ? JSON.stringify(response) : null,
          error,
          deps.now().toISOString(),
          ctx.jobId,
        ],
      );
      if (status === 'succeeded') await recordAccount(tx, conn, employeeId, plan, o, userId);
    });
    if (status === 'succeeded') results.succeeded++;
    else {
      results.failed++;
      if (lifecycle === 'joiner') blocked = true;
    }
  }
  await ctx.tx((tx) =>
    writeAudit(tx, {
      actorType: ctx.actorId ? 'user' : 'system',
      actorId: ctx.actorId,
      action: `it.${lifecycle}_executed`,
      targetType: 'employee',
      targetId: employeeId,
      diff: { provider, anchorDate, principalName: plan.principalName, ...results },
    }),
  );
  return { provider, lifecycle, ...results };
}

/** Provider answers that mean "already in that state" (safe re-runs). */
function okStatusesFor(provider: Provider, op: PlannedOp['op']): number[] {
  if (op === 'create_user') return provider === 'microsoft365' ? [400] : [409];
  if (provider === 'google_workspace' && (op === 'add_group' || op === 'assign_licence')) return [409];
  if (provider === 'google_workspace' && op === 'remove_licence') return [404];
  return [];
}

async function recordAccount(
  tx: Tx,
  conn: ConnectionRow,
  employeeId: string,
  plan: Plan,
  o: OpRow,
  userId: string | null,
) {
  if (o.op === 'create_user') {
    await tx.exec(
      `INSERT INTO app.it_accounts (tenant_id, connection_id, employee_id, principal_name, remote_id) VALUES (app.current_tenant(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, connection_id, employee_id) DO UPDATE SET principal_name = EXCLUDED.principal_name, remote_id = coalesce(EXCLUDED.remote_id, app.it_accounts.remote_id), status = 'active'`,
      [conn.id, employeeId, plan.principalName, userId],
    );
    return;
  }
  const lic = (body: Record<string, unknown> | null) => {
    if (conn.provider === 'microsoft365')
      return ((body?.addLicenses as Array<{ skuId: string }>) ?? []).map((l) => ({ skuId: l.skuId }));
    const m = /\/product\/([^/]+)\/sku\/([^/]+)\/user$/.exec(o.url);
    return m ? [{ productId: decodeURIComponent(m[1]!), skuId: decodeURIComponent(m[2]!) }] : [];
  };
  if (o.op === 'assign_licence') {
    await tx.exec(
      `INSERT INTO app.it_accounts (tenant_id, connection_id, employee_id, principal_name, licences) VALUES (app.current_tenant(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, connection_id, employee_id) DO UPDATE SET licences = (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(app.it_accounts.licences || EXCLUDED.licences) x)`,
      [conn.id, employeeId, plan.principalName, JSON.stringify(lic(o.body))],
    );
  }
  if (o.op === 'add_group')
    await tx.exec(
      `UPDATE app.it_accounts SET groups = (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(groups || $3::jsonb) x) WHERE connection_id = $1 AND employee_id = $2`,
      [conn.id, employeeId, JSON.stringify([o.url.split('/groups/')[1]?.split('/')[0] ?? ''])],
    );
  if (o.op === 'block_sign_in' || o.op === 'suspend_user') {
    await tx.exec(
      `INSERT INTO app.it_accounts (tenant_id, connection_id, employee_id, principal_name, status) VALUES (app.current_tenant(), $1, $2, $3, 'blocked')
       ON CONFLICT (tenant_id, connection_id, employee_id) DO UPDATE SET status = 'blocked'`,
      [conn.id, employeeId, plan.principalName],
    );
  }
  if (o.op === 'remove_licence')
    await tx.exec(
      `UPDATE app.it_accounts SET licences = '[]'::jsonb WHERE connection_id = $1 AND employee_id = $2`,
      [conn.id, employeeId],
    );
}
