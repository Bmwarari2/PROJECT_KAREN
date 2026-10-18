import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { privacyCompany, type PrivacyCompany } from './privacy-fixtures';

/** Contract tests for the privacy endpoints: real responses validate against the published spec. */
type Spec = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>; components?: { schemas?: Record<string, unknown> } };
let spec: Spec;
let ctx: TestContext;
let c: PrivacyCompany;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  ctx = await startTestApp({ listen: false });
  c = await privacyCompany(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

function check(method: string, path: string, res: { statusCode: number; json(): unknown }) {
  const op = spec.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(res.statusCode)];
  expect(response, `${method.toUpperCase()} ${path} documents ${res.statusCode}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (!media) return;
  const validate = ajv.compile(media.schema as object);
  expect(validate(res.json()), `${method.toUpperCase()} ${path} ${res.statusCode}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe('privacy endpoints match the spec', () => {
  it('requests, retention, legal, incidents, exports and closure', async () => {
    const emp = await c.hire('london');
    const created = await c.api('POST', '/v1/privacy/requests', { kind: 'access', subjectEmployeeId: emp, receivedOn: '2026-03-10' });
    check('post', '/v1/privacy/requests', created);
    const id = (created.json() as { id: string }).id;
    check('get', '/v1/privacy/requests', await c.api('GET', '/v1/privacy/requests?status=all'));
    check('get', '/v1/privacy/requests/{id}', await c.api('GET', `/v1/privacy/requests/${id}`));
    check('post', '/v1/privacy/requests/{id}/identity', await c.api('POST', `/v1/privacy/requests/${id}/identity`, { method: 'signed_in_account' }));
    check('get', '/v1/privacy/requests/{id}/download', await c.api('GET', `/v1/privacy/requests/${id}/download?file=pdf`));
    check('post', '/v1/privacy/requests/{id}/export', await c.api('POST', `/v1/privacy/requests/${id}/export`));
    check('get', '/v1/privacy/requests/{id}/download', await c.api('GET', `/v1/privacy/requests/${id}/download?file=pdf`));
    check('get', '/v1/privacy/requests/{id}/erasure-plan', await c.api('GET', `/v1/privacy/requests/${id}/erasure-plan`));
    check('post', '/v1/privacy/requests/{id}/close', await c.api('POST', `/v1/privacy/requests/${id}/close`, { outcome: 'completed' }));
    check('post', '/v1/privacy/requests/{id}/close', await c.api('POST', `/v1/privacy/requests/${id}/close`, { outcome: 'completed' }));
    check('post', '/v1/privacy/legal-holds', await c.api('POST', '/v1/privacy/legal-holds', { reason: 'Fictional audit' }));
    check('get', '/v1/privacy/legal-holds', await c.api('GET', '/v1/privacy/legal-holds'));
    check('get', '/v1/privacy/retention', await c.api('GET', '/v1/privacy/retention'));
    check('put', '/v1/privacy/retention/policies', await c.api('PUT', '/v1/privacy/retention/policies', { category: 'time_records', jurisdiction: 'GB', period: 'P1Y', enabled: true }));
    check('put', '/v1/privacy/retention/policies', await c.api('PUT', '/v1/privacy/retention/policies', { category: 'notifications', period: 'P1Y', enabled: false }));
    check('post', '/v1/privacy/retention/dry-run', await c.api('POST', '/v1/privacy/retention/dry-run', {}));
    check('get', '/v1/privacy/retention/runs', await c.api('GET', '/v1/privacy/retention/runs'));
    check('get', '/v1/privacy/dpa', await c.api('GET', '/v1/privacy/dpa'));
    check('get', '/v1/privacy/subprocessors', await c.api('GET', '/v1/privacy/subprocessors'));
    check('get', '/v1/privacy/notices', await c.api('GET', '/v1/privacy/notices'));
    const inc = await c.api('POST', '/v1/privacy/incidents', { title: 'Fictional email sent to the wrong person', personalDataBreach: true, awareAt: '2026-10-01T09:30:00Z', affected: { GB: 1 } });
    check('post', '/v1/privacy/incidents', inc);
    check('get', '/v1/privacy/incidents', await c.api('GET', '/v1/privacy/incidents'));
    check('post', '/v1/privacy/company-exports', await c.api('POST', '/v1/privacy/company-exports'));
    check('get', '/v1/privacy/company-exports', await c.api('GET', '/v1/privacy/company-exports'));
    check('get', '/v1/privacy/closure', await c.api('GET', '/v1/privacy/closure'));
    check('post', '/v1/privacy/closure', await c.api('POST', '/v1/privacy/closure', { confirmWorkspace: 'nope' }));
  });
});
