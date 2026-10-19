import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { FakeBillingProvider } from '../src/modules/billing/provider';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { injector, postWebhook, signedEvent, staffSession, userSession, WEBHOOK_SECRET } from './phase10-helpers';

/** Phase 10 responses validate against the published OpenAPI 3.1 document. */
type Spec = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>; components?: { schemas?: Record<string, unknown> } };
let spec: Spec;
let ctx: TestContext;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  ctx = await startTestApp({ listen: false });
  ctx.deps.billing = new FakeBillingProvider(() => ctx.clock.now);
  ctx.deps.stripeWebhookSecret = WEBHOOK_SECRET;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

function check(method: string, path: string, res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  const op = spec.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(res.statusCode)];
  expect(response, `${method.toUpperCase()} ${path} documents ${res.statusCode}: ${res.body.slice(0, 200)}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (!media || !res.body) return;
  const validate = ajv.compile(media.schema as object);
  const ok = validate(JSON.parse(res.body));
  expect(ok, `${method.toUpperCase()} ${path} ${res.statusCode}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe('phase 10 endpoints match the spec', () => {
  it('billing, help, support, status and back office', async () => {
    const o = await ownerSession(ctx);
    const api = injector(ctx);
    check('get', '/v1/billing/plans', await ctx.app.inject({ method: 'GET', url: '/v1/billing/plans' }));
    check('get', '/v1/billing', await api('GET', '/v1/billing', undefined, o.cookie));
    check('post', '/v1/billing/quote', await api('POST', '/v1/billing/quote', { planId: 'core', term: 'monthly', currency: 'GBP' }, o.cookie));
    check('post', '/v1/billing/subscription', await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: 'GBP' }, o.cookie)); // 422: no details yet
    const acct = (await api('GET', '/v1/billing', undefined, o.cookie)).json().accounts[0];
    check('put', '/v1/billing/accounts/{id}/details', await api('PUT', `/v1/billing/accounts/${acct.id}/details`, { name: 'Fictional Contract Ltd', address: { line1: '1 Spec Street', city: 'London', postalCode: 'N1 1AA', country: 'GB' }, contacts: [{ name: 'Bill Payer', email: 'bill@contract.example.test', isPrimary: true }] }, o.cookie));
    check('post', '/v1/billing/subscription', await api('POST', '/v1/billing/subscription', { planId: 'core', term: 'monthly', currency: 'GBP' }, o.cookie));
    check('post', '/v1/billing/subscription/change', await api('POST', '/v1/billing/subscription/change', { planId: 'plus', term: 'monthly' }, o.cookie));
    check('post', '/v1/billing/subscription/cancel', await api('POST', '/v1/billing/subscription/cancel', undefined, o.cookie));
    check('post', '/v1/billing/subscription/reactivate', await api('POST', '/v1/billing/subscription/reactivate', undefined, o.cookie));
    check('post', '/v1/billing/payment-method', await api('POST', '/v1/billing/payment-method', {}, o.cookie));
    check('get', '/v1/billing/invoices', await api('GET', '/v1/billing/invoices', undefined, o.cookie));
    check('post', '/v1/billing/webhooks/stripe', await postWebhook(ctx, signedEvent(ctx, 'invoice.paid', { id: 'in_test_contract', customer: 'cus_unknown' })));
    check('post', '/v1/billing/webhooks/stripe', await postWebhook(ctx, { payload: '{}', header: 'bad' }));

    const e = await userSession(ctx, o);
    check('get', '/v1/billing', await api('GET', '/v1/billing', undefined, e.cookie)); // 403
    check('get', '/v1/help/articles', await api('GET', '/v1/help/articles?q=rota', undefined, e.cookie));
    check('get', '/v1/help/articles/{slug}', await api('GET', '/v1/help/articles/getting-started', undefined, e.cookie));
    check('get', '/v1/support/contact', await api('GET', '/v1/support/contact', undefined, e.cookie));
    const t = await api('POST', '/v1/support/tickets', { subject: 'Contract test ticket', body: 'Fictional', category: 'question', priority: 'low' }, e.cookie);
    check('post', '/v1/support/tickets', t);
    check('get', '/v1/support/tickets', await api('GET', '/v1/support/tickets', undefined, e.cookie));
    check('get', '/v1/support/tickets/{id}', await api('GET', `/v1/support/tickets/${t.json().id}`, undefined, e.cookie));
    check('post', '/v1/support/tickets/{id}/messages', await api('POST', `/v1/support/tickets/${t.json().id}/messages`, { body: 'More detail' }, e.cookie));
    check('get', '/v1/status', await ctx.app.inject({ method: 'GET', url: '/v1/status' }));

    const s = await staffSession(ctx, 'super_admin');
    check('get', '/v1/backoffice/auth/session', await api('GET', '/v1/backoffice/auth/session', undefined, s.cookie));
    check('get', '/v1/backoffice/overview', await api('GET', '/v1/backoffice/overview', undefined, s.cookie));
    check('get', '/v1/backoffice/tenants', await api('GET', '/v1/backoffice/tenants', undefined, s.cookie));
    check('get', '/v1/backoffice/tenants/all-regions', await api('GET', '/v1/backoffice/tenants/all-regions', undefined, s.cookie));
    check('get', '/v1/backoffice/tenants/{tenantId}', await api('GET', `/v1/backoffice/tenants/${o.tenantId}`, undefined, s.cookie));
    check('get', '/v1/backoffice/support/queue', await api('GET', '/v1/backoffice/support/queue', undefined, s.cookie));
    check('get', '/v1/backoffice/support/tickets/{tenantId}/{ticketId}', await api('GET', `/v1/backoffice/support/tickets/${o.tenantId}/${t.json().id}`, undefined, s.cookie));
    check('post', '/v1/backoffice/support/tickets/{tenantId}/{ticketId}/messages', await api('POST', `/v1/backoffice/support/tickets/${o.tenantId}/${t.json().id}/messages`, { body: 'Reply' }, s.cookie));
    check('get', '/v1/backoffice/tenants/{tenantId}/employees/{employeeId}', await api('GET', `/v1/backoffice/tenants/${o.tenantId}/employees/${o.userId}`, undefined, s.cookie)); // 403 without a grant
    check('get', '/v1/backoffice/grants', await api('GET', '/v1/backoffice/grants', undefined, s.cookie));
    check('get', '/v1/backoffice/plans', await api('GET', '/v1/backoffice/plans', undefined, s.cookie));
    check('get', '/v1/backoffice/contracts', await api('GET', '/v1/backoffice/contracts', undefined, s.cookie));
    check('get', '/v1/backoffice/settings/contact-channels', await api('GET', '/v1/backoffice/settings/contact-channels', undefined, s.cookie));
    check('get', '/v1/backoffice/status/incidents', await api('GET', '/v1/backoffice/status/incidents', undefined, s.cookie));
    check('post', '/v1/backoffice/status/incidents', await api('POST', '/v1/backoffice/status/incidents', { kind: 'incident', impact: 'minor', title: 'Spec check', components: ['email'], body: 'x' }, s.cookie));
    check('get', '/v1/backoffice/rules/catalogue', await api('GET', '/v1/backoffice/rules/catalogue', undefined, s.cookie));
  });
});
