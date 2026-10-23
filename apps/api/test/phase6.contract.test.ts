import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { mockProviders, phase6Company, type Phase6Company } from './phase6-fixtures';

/**
 * Contract tests for the Phase 6 endpoints: real responses from payroll, payslips, IT automation and
 * assets validate against the published OpenAPI 3.1 document (which is generated from the route schemas).
 */
type Spec = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>
  >;
  components?: { schemas?: Record<string, unknown> };
};
let spec: Spec;
let ctx: TestContext;
let c: Phase6Company;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

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

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {}))
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  const mock = mockProviders();
  mock.on('POST', /oauth2\/v2\.0\/token$/, () => ({ status: 200, json: { access_token: 't' } }));
  ctx = await startTestApp({ listen: false, overrides: { fetch: mock.fetch } });
  c = await phase6Company(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('Phase 6 endpoints match the spec', () => {
  it('payroll: catalogue, connectors, periods, inputs, exports, download, delivery log, 501 stubs', async () => {
    const emp = await c.hire({ startDate: '2026-04-06' });
    check('get', '/v1/payroll/catalogue', 200, (await c.api('GET', '/v1/payroll/catalogue')).json());
    const conn = await c.api('POST', '/v1/payroll/connectors', { name: 'Contract CSV', kind: 'csv' });
    check('post', '/v1/payroll/connectors', 201, conn.json());
    check('get', '/v1/payroll/connectors', 200, (await c.api('GET', '/v1/payroll/connectors')).json());
    check(
      'get',
      '/v1/payroll/connectors/{id}',
      200,
      (await c.api('GET', `/v1/payroll/connectors/${conn.json().id}`)).json(),
    );
    check(
      'patch',
      '/v1/payroll/connectors/{id}',
      200,
      (await c.api('PATCH', `/v1/payroll/connectors/${conn.json().id}`, { name: 'Contract CSV 2' })).json(),
    );
    check(
      'put',
      '/v1/payroll/connectors/{id}/credentials',
      200,
      (
        await c.api('PUT', `/v1/payroll/connectors/${conn.json().id}/credentials`, { password: 'fictional' })
      ).json(),
    );
    const bad = await c.api('POST', '/v1/payroll/connectors', {
      name: 'x',
      kind: 'csv',
      mapping: {
        dateFormat: 'yyyy-MM-dd',
        decimalSeparator: '.',
        delimiter: ',',
        includeHeader: true,
        sections: {},
      },
    });
    check('post', '/v1/payroll/connectors', 400, bad.json());
    const period = await c.api('POST', '/v1/payroll/periods', {
      name: 'April 2026',
      frequency: 'monthly',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });
    check('post', '/v1/payroll/periods', 201, period.json());
    check(
      'get',
      '/v1/payroll/periods/{id}/inputs',
      200,
      (await c.api('GET', `/v1/payroll/periods/${period.json().id}/inputs`)).json(),
    );
    check(
      'post',
      '/v1/payroll/periods/{id}/close',
      200,
      (await c.api('POST', `/v1/payroll/periods/${period.json().id}/close`)).json(),
    );
    check('get', '/v1/payroll/periods', 200, (await c.api('GET', '/v1/payroll/periods')).json());
    const ex = await c.api('POST', `/v1/payroll/periods/${period.json().id}/exports`, {
      connectorId: conn.json().id,
    });
    check('post', '/v1/payroll/periods/{id}/exports', 201, ex.json());
    check('get', '/v1/payroll/exports', 200, (await c.api('GET', '/v1/payroll/exports')).json());
    check(
      'get',
      '/v1/payroll/exports/{id}/download',
      200,
      (await c.api('GET', `/v1/payroll/exports/${ex.json().id}/download`)).json(),
    );
    check('get', '/v1/payroll/deliveries', 200, (await c.api('GET', '/v1/payroll/deliveries')).json());
    check(
      'post',
      '/v1/payroll/exports/{id}/deliver',
      422,
      (await c.api('POST', `/v1/payroll/exports/${ex.json().id}/deliver`, {})).json(),
    );
    const stub = await c.api('POST', '/v1/payroll/connectors', { name: 'Contract ADP', kind: 'adp' });
    const on = await c.api('PATCH', `/v1/payroll/connectors/${stub.json().id}`, { enabled: true });
    expect(on.statusCode).toBe(501);
    check('patch', '/v1/payroll/connectors/{id}', 501, on.json());
    const me = await c.login(emp);
    check(
      'get',
      '/v1/payroll/connectors',
      403,
      (await c.api('GET', '/v1/payroll/connectors', undefined, me)).json(),
    );
  });

  it('payslips: upload preview, batches, publish, self-service list and download', async () => {
    const emp = await c.hire({ employeeNumber: 'CT-77' });
    const me = await c.login(emp);
    const boundary = 'contractboundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nContract month\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="CT-77.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 fictional\r\n`,
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payslips/batches',
      payload,
      headers: { cookie: c.owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    check('post', '/v1/payslips/batches', 201, up.json());
    check('get', '/v1/payslips/batches', 200, (await c.api('GET', '/v1/payslips/batches')).json());
    check(
      'get',
      '/v1/payslips/batches/{id}',
      200,
      (await c.api('GET', `/v1/payslips/batches/${up.json().id}`)).json(),
    );
    check(
      'post',
      '/v1/payslips/batches/{id}/publish',
      200,
      (await c.api('POST', `/v1/payslips/batches/${up.json().id}/publish`)).json(),
    );
    const mine = await c.api('GET', '/v1/me/payslips', undefined, me);
    check('get', '/v1/me/payslips', 200, mine.json());
    check(
      'get',
      '/v1/payslips/{id}/download',
      200,
      (await c.api('GET', `/v1/payslips/${mine.json()[0].id}/download`, undefined, me)).json(),
    );
    check(
      'get',
      '/v1/employees/{id}/payslips',
      200,
      (await c.api('GET', `/v1/employees/${emp}/payslips`)).json(),
    );
  });

  it('IT automation: connections, rules, dry run and the execution log', async () => {
    const put = await c.api('PUT', '/v1/integrations/it/microsoft365', {
      domain: 'contract.example',
      directoryId: '9b4c2d1e-0000-4000-8000-00000000c0de',
      clientId: 'contract-app',
    });
    check('put', '/v1/integrations/it/{provider}', 200, put.json());
    check(
      'put',
      '/v1/integrations/it/{provider}/credentials',
      200,
      (
        await c.api('PUT', '/v1/integrations/it/microsoft365/credentials', { clientSecret: 'fictional' })
      ).json(),
    );
    check(
      'post',
      '/v1/integrations/it/{provider}/consent',
      200,
      (await c.api('POST', '/v1/integrations/it/microsoft365/consent')).json(),
    );
    check(
      'post',
      '/v1/integrations/it/{provider}/verify',
      200,
      (await c.api('POST', '/v1/integrations/it/microsoft365/verify')).json(),
    );
    check('get', '/v1/integrations/it', 200, (await c.api('GET', '/v1/integrations/it')).json());
    check(
      'post',
      '/v1/integrations/it/{provider}/rules',
      201,
      (
        await c.api('POST', '/v1/integrations/it/microsoft365/rules', {
          name: 'All',
          match: {},
          licences: [{ skuId: 'sku-1' }],
          groups: ['g-1'],
        })
      ).json(),
    );
    check(
      'get',
      '/v1/integrations/it/{provider}/rules',
      200,
      (await c.api('GET', '/v1/integrations/it/microsoft365/rules')).json(),
    );
    const emp = await c.hire({ startDate: '2030-01-07' });
    check(
      'get',
      '/v1/integrations/it/{provider}/preview/{employeeId}',
      200,
      (await c.api('GET', `/v1/integrations/it/microsoft365/preview/${emp}?lifecycle=joiner`)).json(),
    );
    check(
      'post',
      '/v1/integrations/it/{provider}/run/{employeeId}',
      200,
      (await c.api('POST', `/v1/integrations/it/microsoft365/run/${emp}`, { lifecycle: 'joiner' })).json(),
    );
    check(
      'get',
      '/v1/integrations/it/operations',
      200,
      (await c.api('GET', '/v1/integrations/it/operations')).json(),
    );
    check(
      'get',
      '/v1/integrations/it/{provider}/preview/{employeeId}',
      404,
      (await c.api('GET', `/v1/integrations/it/google_workspace/preview/${emp}?lifecycle=joiner`)).json(),
    );
  });

  it('assets: create, list, assign, acknowledge, return and self-service', async () => {
    const emp = await c.hire();
    const me = await c.login(emp);
    const a = await c.api('POST', '/v1/assets', {
      assetTag: 'CT-1',
      type: 'headset',
      name: 'Fictional Headset',
      costMinor: 9_900,
      currency: 'GBP',
    });
    check('post', '/v1/assets', 201, a.json());
    check('get', '/v1/assets', 200, (await c.api('GET', '/v1/assets')).json());
    const s = await c.api('POST', `/v1/assets/${a.json().id}/assign`, {
      employeeId: emp,
      assignedOn: '2026-09-01',
    });
    check('post', '/v1/assets/{id}/assign', 201, s.json());
    check('get', '/v1/me/assets', 200, (await c.api('GET', '/v1/me/assets', undefined, me)).json());
    check(
      'post',
      '/v1/asset-assignments/{id}/acknowledge',
      200,
      (await c.api('POST', `/v1/asset-assignments/${s.json().id}/acknowledge`, { confirm: true }, me)).json(),
    );
    check(
      'get',
      '/v1/asset-assignments',
      200,
      (await c.api('GET', `/v1/asset-assignments?employeeId=${emp}`)).json(),
    );
    check(
      'post',
      '/v1/asset-assignments/{id}/return',
      422,
      (
        await c.api('POST', `/v1/asset-assignments/${s.json().id}/return`, {
          returnedOn: '2026-09-02',
          checklist: [],
        })
      ).json(),
    );
    check(
      'post',
      '/v1/asset-assignments/{id}/return',
      200,
      (
        await c.api('POST', `/v1/asset-assignments/${s.json().id}/return`, {
          returnedOn: '2026-09-02',
          checklist: [{ key: 'device', done: true }],
        })
      ).json(),
    );
    check('get', '/v1/assets/{id}', 200, (await c.api('GET', `/v1/assets/${a.json().id}`)).json());
    check(
      'patch',
      '/v1/assets/{id}',
      200,
      (await c.api('PATCH', `/v1/assets/${a.json().id}`, { status: 'retired' })).json(),
    );
    check(
      'post',
      '/v1/assets',
      403,
      (await c.api('POST', '/v1/assets', { assetTag: 'CT-2', type: 'other', name: 'x' }, me)).json(),
    );
  });
});
