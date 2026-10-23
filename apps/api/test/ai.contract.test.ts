import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { setFeatureFlag, withTenant } from '@thapsus/db';
import { buildSpec } from '../src/openapi';
import { FakeAiProvider } from '../src/modules/ai/provider';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/** Ask HR responses validate against the published OpenAPI document (packages/sdk/openapi.json). */
type Spec = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>
  >;
  components?: { schemas?: Record<string, unknown> };
};
let spec: Spec;
let ctx: TestContext;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {}))
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  ctx = await startTestApp({ listen: false, overrides: { ai: new FakeAiProvider() } });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

function check(method: string, path: string, status: number, body: unknown) {
  const op = spec.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(status)];
  expect(response, `${method.toUpperCase()} ${path} documents ${status}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (!media) return;
  const validate = ajv.compile(media.schema as object);
  expect(
    validate(body),
    `${method.toUpperCase()} ${path} ${status}: ${ajv.errorsText(validate.errors)}`,
  ).toBe(true);
}

describe('Ask HR endpoints match the spec', () => {
  it('status, settings, policy documents, ask (answered, refused, disabled), feedback and re-index', async () => {
    const o = await ownerSession(ctx);
    const h = { cookie: o.cookie };
    const call = (method: string, url: string, payload?: unknown) =>
      ctx.app.inject({ method: method as 'GET', url, headers: h, payload: payload as object });
    check('get', '/v1/ai/status', 200, (await call('GET', '/v1/ai/status')).json());
    const disabled = await call('POST', '/v1/ai/ask', { question: 'What is the leave policy?' });
    expect(disabled.statusCode).toBe(403);
    check('post', '/v1/ai/ask', 403, disabled.json());
    await withTenant(ctx.deps.router, o.tenantId, (tx) => setFeatureFlag(tx, 'aiAssistant', true));
    const folder = (
      await call('POST', '/v1/document-folders', { name: 'Policies', visibility: 'everyone' })
    ).json().id;
    const bad = await call('PUT', '/v1/ai/settings', { policyFolderIds: [crypto.randomUUID()] });
    check('put', '/v1/ai/settings', 422, bad.json());
    const put = await call('PUT', '/v1/ai/settings', { enabled: true, policyFolderIds: [folder] });
    check('put', '/v1/ai/settings', 200, put.json());
    const doc = await call('POST', '/v1/ai/policy-documents', {
      title: 'Expenses policy',
      body: '# Expenses\nTravel expenses are reimbursed within 30 days of a valid claim.',
      folderId: folder,
    });
    check('post', '/v1/ai/policy-documents', 201, doc.json());
    check('get', '/v1/ai/settings', 200, (await call('GET', '/v1/ai/settings')).json());
    const answered = await call('POST', '/v1/ai/ask', {
      question: 'How quickly are travel expenses reimbursed?',
    });
    expect(answered.json().outcome).toBe('answered');
    check('post', '/v1/ai/ask', 200, answered.json());
    const refused = await call('POST', '/v1/ai/ask', { question: 'Should I fire Tom?' });
    expect(refused.json().outcome).toBe('refused');
    check('post', '/v1/ai/ask', 200, refused.json());
    const fb = await call('POST', `/v1/ai/questions/${answered.json().id}/feedback`, { rating: 'helpful' });
    expect(fb.statusCode).toBe(204);
    check(
      'post',
      '/v1/ai/questions/{id}/feedback',
      404,
      (await call('POST', `/v1/ai/questions/${crypto.randomUUID()}/feedback`, { rating: 'helpful' })).json(),
    );
    const reindex = await call('POST', '/v1/ai/reindex');
    check('post', '/v1/ai/reindex', 202, reindex.json());
  });
});
