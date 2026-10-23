import { integrationRequest, IntegrationHttpError } from '../../integrations/http';
import { ratioToDecimal } from '../mapping';
import { sectionCounts, type PayrollInputs } from '../inputs';
import { fileBaseName } from '../render';
import type { ConnectorRow, ItemResult, PayrollConnector, PushContext } from './types';

/**
 * Xero Payroll (UK). Pushes approved timesheets (per earnings rate) and leave to the customer's Xero
 * organisation. Endpoint and payload shapes follow Xero's official OpenAPI description of the Payroll UK
 * API — https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero-payroll-uk.yaml (servers:
 * https://api.xero.com/payroll.xro/2.0; header `Xero-Tenant-Id`; optional `Idempotency-Key`, 128 chars max):
 *  - POST /Timesheets  {payrollCalendarID, employeeID, startDate, endDate, timesheetLines:[{date, earningsRateID, numberOfUnits}]}
 *    https://developer.xero.com/documentation/api/payrolluk/timesheets
 *  - POST /Employees/{EmployeeID}/Leave  {leaveTypeID, description (≤ 50 chars), startDate, endDate}
 *    https://developer.xero.com/documentation/api/payrolluk/employeeleave
 *  - GET /Employees?page=n (100 per page) to match employees by employee number when not mapped explicitly
 * OAuth 2.0 (https://developer.xero.com/documentation/guides/oauth2/auth-flow): authorise at
 * https://login.xero.com/identity/connect/authorize, tokens from https://identity.xero.com/connect/token
 * (refresh tokens rotate on every use and are re-sealed), organisations from GET https://api.xero.com/connections.
 * Custom connections (client credentials, one organisation) are also supported:
 * https://developer.xero.com/documentation/guides/oauth2/custom-connections
 * Starters, leavers, pay changes and SSP stay in the rendered document for the payroll team; Xero's
 * statutory sick leave endpoint needs medical flags that Thapsus-HR does not send.
 */
export const XERO_API = 'https://api.xero.com/payroll.xro/2.0';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
/** Least privilege: timesheets, and employees (leave lives under the employee resource). */
export const XERO_SCOPES = ['offline_access', 'payroll.timesheets', 'payroll.employees'];

export interface XeroSettings {
  xeroTenantId?: string;
  payrollCalendarId?: string;
  earningsRates?: { regular?: string; overtime?: string; doubleTime?: string };
  /** Thapsus leave type key → Xero leave type id. */
  leaveTypes?: Record<string, string>;
  /** Thapsus leave type key → description shown in Xero (≤ 50 chars; never medical detail). */
  leaveDescriptions?: Record<string, string>;
  /** Thapsus employee number → Xero employee id (otherwise matched by employee number in Xero). */
  employees?: Record<string, string>;
}

interface XeroDocument {
  format: 'thapsus.xero_uk.v1';
  period: { startDate: string; endDate: string };
  timesheets: Array<{
    employeeNumber: string;
    payload: {
      payrollCalendarID: string | null;
      employeeID: string | null;
      startDate: string;
      endDate: string;
      timesheetLines: Array<{ date: string; earningsRateID: string; numberOfUnits: number }>;
    };
  }>;
  leave: Array<{
    employeeNumber: string;
    leaveRequestId: string;
    employeeID: string | null;
    payload: { leaveTypeID: string; description: string; startDate: string; endDate: string };
  }>;
  unmapped: Array<{ section: string; employeeNumber: string; reason: string; ref: string }>;
  handOff: { starters: number; leavers: number; payChanges: number; sickPay: number };
}

const units = (minutes: number) => Number(ratioToDecimal(minutes, 60, 2));
const humanise = (key: string) =>
  (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')).slice(0, 50);

export function xeroDocument(inputs: PayrollInputs, s: XeroSettings): XeroDocument {
  const map = s.employees ?? {};
  const rates = s.earningsRates ?? {};
  const unmapped: XeroDocument['unmapped'] = [];
  const byEmployee = new Map<string, XeroDocument['timesheets'][number]['payload']['timesheetLines']>();
  for (const h of inputs.hours) {
    const lines =
      byEmployee.get(h.employeeNumber) ?? byEmployee.set(h.employeeNumber, []).get(h.employeeNumber)!;
    for (const [minutes, rate, label] of [
      [h.regularMinutes, rates.regular, 'regular'],
      [h.overtimeMinutes, rates.overtime, 'overtime'],
      [h.doubleMinutes, rates.doubleTime, 'doubleTime'],
    ] as const) {
      if (!minutes) continue;
      if (!rate)
        unmapped.push({
          section: 'hours',
          employeeNumber: h.employeeNumber,
          reason: `earningsRateNotMapped:${label}`,
          ref: h.weekStart,
        });
      else lines.push({ date: h.weekStart, earningsRateID: rate, numberOfUnits: units(minutes) });
    }
  }
  const timesheets = [...byEmployee.entries()]
    .filter(([, lines]) => lines.length)
    .map(([employeeNumber, timesheetLines]) => ({
      employeeNumber,
      payload: {
        payrollCalendarID: s.payrollCalendarId ?? null,
        employeeID: map[employeeNumber] ?? null,
        startDate: inputs.period.startDate,
        endDate: inputs.period.endDate,
        timesheetLines,
      },
    }));
  const leave: XeroDocument['leave'] = [];
  for (const a of inputs.absences) {
    const leaveTypeID = s.leaveTypes?.[a.leaveType];
    if (!leaveTypeID) {
      unmapped.push({
        section: 'absences',
        employeeNumber: a.employeeNumber,
        reason: `leaveTypeNotMapped:${a.leaveType}`,
        ref: a.startDate,
      });
      continue;
    }
    leave.push({
      employeeNumber: a.employeeNumber,
      leaveRequestId: a.leaveRequestId,
      employeeID: map[a.employeeNumber] ?? null,
      payload: {
        leaveTypeID,
        description: (s.leaveDescriptions?.[a.leaveType] ?? humanise(a.leaveType)).slice(0, 50),
        startDate: a.startDate,
        endDate: a.endDate,
      },
    });
  }
  return {
    format: 'thapsus.xero_uk.v1',
    period: { startDate: inputs.period.startDate, endDate: inputs.period.endDate },
    timesheets,
    leave,
    unmapped,
    handOff: {
      starters: inputs.starters.length,
      leavers: inputs.leavers.length,
      payChanges: inputs.payChanges.length,
      sickPay: inputs.sickPay.length,
    },
  };
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

export function xeroAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  const u = new URL(XERO_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: XERO_SCOPES.join(' '),
    state,
  }).toString();
  return u.toString();
}

export async function xeroExchangeCode(
  fetchImpl: typeof fetch,
  app: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
) {
  const r = await integrationRequest<{ access_token: string; refresh_token: string }>(
    fetchImpl,
    'POST',
    XERO_TOKEN_URL,
    {
      headers: { authorization: basic(app.clientId, app.clientSecret) },
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    },
  );
  return r.body;
}

export async function xeroConnections(fetchImpl: typeof fetch, accessToken: string) {
  const r = await integrationRequest<Array<{ tenantId: string; tenantType: string; tenantName?: string }>>(
    fetchImpl,
    'GET',
    XERO_CONNECTIONS_URL,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return r.body ?? [];
}

/** Access token: custom connection (client credentials) or the rotating refresh token of the platform app. */
export async function xeroAccessToken(
  ctx: Pick<PushContext, 'fetch' | 'credentials' | 'platformApp' | 'saveCredentials'>,
): Promise<string> {
  const c = ctx.credentials ?? {};
  if (c.clientId && c.clientSecret) {
    const r = await integrationRequest<{ access_token: string }>(ctx.fetch, 'POST', XERO_TOKEN_URL, {
      headers: { authorization: basic(c.clientId, c.clientSecret) },
      form: {
        grant_type: 'client_credentials',
        scope: XERO_SCOPES.filter((s) => s !== 'offline_access').join(' '),
      },
    });
    return r.body.access_token;
  }
  if (c.refreshToken && ctx.platformApp) {
    const r = await integrationRequest<{ access_token: string; refresh_token?: string }>(
      ctx.fetch,
      'POST',
      XERO_TOKEN_URL,
      {
        headers: { authorization: basic(ctx.platformApp.clientId, ctx.platformApp.clientSecret) },
        form: { grant_type: 'refresh_token', refresh_token: c.refreshToken },
      },
    );
    if (r.body.refresh_token && r.body.refresh_token !== c.refreshToken)
      await ctx.saveCredentials({ refreshToken: r.body.refresh_token });
    return r.body.access_token;
  }
  throw new IntegrationHttpError(0, 'notConnected', 'Xero is not connected for this connector');
}

async function xeroEmployeeIds(ctx: PushContext, token: string, tenantId: string, wanted: Set<string>) {
  const found = new Map<string, string>();
  for (let page = 1; page <= 50 && found.size < wanted.size; page++) {
    const r = await integrationRequest<{
      employees?: Array<{ employeeID: string; employeeNumber?: string | null }>;
    }>(ctx.fetch, 'GET', `${XERO_API}/Employees?page=${page}`, {
      headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId },
    });
    const list = r.body?.employees ?? [];
    for (const e of list)
      if (e.employeeNumber && wanted.has(e.employeeNumber)) found.set(e.employeeNumber, e.employeeID);
    if (list.length < 100) break;
  }
  return found;
}

export const xeroConnector: PayrollConnector = {
  kind: 'xero_uk',
  status: 'available',
  formats: ['json'],
  deliveries: ['download', 'api'],
  regions: ['uk'],
  docs: 'docs/integrations.md#xero-payroll-uk',
  async render(inputs, connector: ConnectorRow) {
    const doc = xeroDocument(inputs, connector.settings as XeroSettings);
    const body = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return {
      body,
      fileName: `${fileBaseName(connector.name, inputs.period.startDate, inputs.period.endDate)}.json`,
      contentType: 'application/json',
      counts: {
        ...sectionCounts(inputs),
        xeroTimesheets: doc.timesheets.length,
        xeroLeave: doc.leave.length,
        unmapped: doc.unmapped.length,
      },
    };
  },
  async push(ctx, rendered, connector) {
    const s = connector.settings as XeroSettings;
    const doc = JSON.parse(rendered.body.toString('utf8')) as XeroDocument;
    if (!s.xeroTenantId) throw new IntegrationHttpError(0, 'notConnected', 'No Xero organisation selected');
    if (!s.payrollCalendarId)
      throw new IntegrationHttpError(0, 'notConfigured', 'No Xero payroll calendar selected');
    const tsKey = (t: XeroDocument['timesheets'][number]) => `ts:${t.employeeNumber}:${t.payload.startDate}`;
    const leaveKey = (l: XeroDocument['leave'][number]) =>
      `leave:${l.employeeNumber}:${l.leaveRequestId}:${l.payload.startDate}`;
    const pendingTs = doc.timesheets.filter((t) => ctx.previous[tsKey(t)]?.status !== 'succeeded');
    const pendingLeave = doc.leave.filter((l) => ctx.previous[leaveKey(l)]?.status !== 'succeeded');
    // nothing left to send: no token request and no lookups
    const token = pendingTs.length || pendingLeave.length ? await xeroAccessToken(ctx) : '';
    const headers = (key: string) => ({
      authorization: `Bearer ${token}`,
      'xero-tenant-id': s.xeroTenantId!,
      'idempotency-key': `${ctx.idempotencyPrefix}:${key}`.slice(0, 128),
    });
    const missing = new Set([
      ...pendingTs.filter((t) => !t.payload.employeeID).map((t) => t.employeeNumber),
      ...pendingLeave.filter((l) => !l.employeeID).map((l) => l.employeeNumber),
    ]);
    const resolved = missing.size
      ? await xeroEmployeeIds(ctx, token, s.xeroTenantId, missing)
      : new Map<string, string>();
    const items: ItemResult[] = [];
    const run = async (
      key: string,
      employeeNumber: string,
      call: (employeeID: string) => Promise<string | undefined>,
      employeeID: string | null,
    ) => {
      const prev = ctx.previous[key];
      if (prev?.status === 'succeeded') return items.push(prev);
      const id = employeeID ?? resolved.get(employeeNumber);
      if (!id) return items.push({ key, status: 'skipped', reason: 'employeeNotMapped' });
      try {
        items.push({ key, status: 'succeeded', remoteId: await call(id) });
      } catch (err) {
        items.push({
          key,
          status: 'failed',
          reason: err instanceof IntegrationHttpError ? `${err.status}:${err.code}` : 'error',
        });
      }
    };
    for (const t of doc.timesheets) {
      const key = tsKey(t);
      await run(
        key,
        t.employeeNumber,
        async (employeeID) =>
          (
            await integrationRequest<{ timesheet?: { timesheetID?: string } }>(
              ctx.fetch,
              'POST',
              `${XERO_API}/Timesheets`,
              {
                headers: headers(key),
                json: { ...t.payload, payrollCalendarID: s.payrollCalendarId, employeeID },
              },
            )
          ).body?.timesheet?.timesheetID,
        t.payload.employeeID,
      );
    }
    for (const l of doc.leave) {
      const key = leaveKey(l);
      await run(
        key,
        l.employeeNumber,
        async (employeeID) =>
          (
            await integrationRequest<{ leave?: { leaveID?: string } }>(
              ctx.fetch,
              'POST',
              `${XERO_API}/Employees/${encodeURIComponent(employeeID)}/Leave`,
              { headers: headers(key), json: l.payload },
            )
          ).body?.leave?.leaveID,
        l.employeeID,
      );
    }
    const notDone = items.filter((i) => i.status !== 'succeeded').length;
    const ok = items.length - notDone;
    return {
      status: notDone === 0 ? 'succeeded' : ok === 0 ? 'failed' : 'partial',
      destination: `xero:${s.xeroTenantId}`,
      items,
    };
  },
};
