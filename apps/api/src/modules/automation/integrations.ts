import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * "Call integration" automation actions are dispatched to handlers registered here, keyed by
 * integration id. Connectors added in later phases register themselves the same way. Handlers run in
 * the integrations.dispatch job (never in the request path); only identifiers leave the cell.
 */
export interface IntegrationRequest {
  tenantId: string;
  integration: string;
  operation: string;
  params: Record<string, string | number | boolean>;
  ruleId: string | null;
  eventKey: string;
  employeeId: string | null;
  date: string;
}

export interface IntegrationResult {
  ok: boolean;
  detail: Record<string, unknown>;
}

export interface IntegrationContext {
  fetch: typeof fetch;
  /** Server-side key for signing outbound calls (per-tenant key derived from it); absent = not configured. */
  signingKey?: string;
}

export interface IntegrationHandler {
  /** Checks an action's operation and params when a rule is saved; returns a problem or undefined. */
  validate(operation: string, params: Record<string, unknown>): string | undefined;
  call(req: IntegrationRequest, ctx: IntegrationContext): Promise<IntegrationResult>;
}

export const integrationHandlers: Record<string, IntegrationHandler> = {};

export function registerIntegration(id: string, handler: IntegrationHandler) {
  integrationHandlers[id] = handler;
}

/** Outbound calls only go to public HTTPS hosts (no loopback, private, link-local or internal names). */
export function isPublicHttpsUrl(raw: unknown): boolean {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host) || (!host.includes('.') && !isIP(host))) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (isIP(host) === 6) return !(host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'));
  return true;
}

/** Signature over the exact body with a key unique to the tenant. */
export function signBody(signingKey: string, tenantId: string, body: string): string {
  const tenantKey = createHmac('sha256', signingKey).update(`integration:${tenantId}`).digest();
  return `sha256=${createHmac('sha256', tenantKey).update(body).digest('hex')}`;
}

// ---- built-in: log (records the request in the execution log; no external call) -----------------
registerIntegration('log', {
  validate: (operation) => (/^[a-z][a-z0-9_.-]{0,59}$/.test(operation) ? undefined : 'operation must be a short lowercase identifier'),
  call: async (req) => ({ ok: true, detail: { logged: true, operation: req.operation } }),
});

// ---- built-in: http (signed JSON POST of identifiers to a customer endpoint) --------------------
registerIntegration('http', {
  validate: (operation, params) => {
    if (!/^[a-z][a-z0-9_.-]{0,59}$/.test(operation)) return 'operation must be a short lowercase identifier';
    if (!isPublicHttpsUrl(params.url)) return 'params.url must be a public https URL';
    return undefined;
  },
  call: async (req, ctx) => {
    const url = String(req.params.url);
    if (!isPublicHttpsUrl(url)) return { ok: false, detail: { reason: 'url_not_allowed' } };
    if (!ctx.signingKey) return { ok: false, detail: { reason: 'signing_key_not_configured' } };
    // Identifiers only: receivers fetch any details through the API with their own credentials.
    const body = JSON.stringify({ integration: req.integration, operation: req.operation, rule: req.ruleId, event: req.eventKey, employeeId: req.employeeId, date: req.date });
    const res = await ctx
      .fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-thapsus-signature': signBody(ctx.signingKey, req.tenantId, body) }, body, signal: AbortSignal.timeout(5000) })
      .catch((e: Error) => ({ ok: false, status: 0, statusText: e.name }));
    return { ok: res.ok, detail: { status: res.status } };
  },
});
