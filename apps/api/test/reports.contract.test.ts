import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readerUrl, testRouter, TEST_DBS } from '@thapsus/db/testing';
import { buildSpec } from '../src/openapi';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { widgets, type Widgets } from './reports-fixtures';
import { transports } from '../src/modules/data-export/routes';

/** Phase 7 contract tests: real responses of the reports, data export and self-service endpoints validate against the published spec. */
type Spec = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>; components?: { schemas?: Record<string, unknown> } };
let spec: Spec;
let ctx: TestContext;
let w: Widgets;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const original = transports.awsClients;

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  transports.awsClients = () => ({ sts: () => ({ send: async () => ({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b' } }) }), s3: () => ({ send: async () => ({ BucketRegion: 'eu-west-2' }) }) });
  ctx = await startTestApp({ listen: false, overrides: { router: testRouter('uk', { readers: { shared: readerUrl(TEST_DBS.shared) } }) } });
  w = await widgets(ctx);
});
afterAll(async () => {
  transports.awsClients = original;
  await ctx.close();
  await closeDb();
});

function check(method: string, path: string, res: { statusCode: number; body: string }) {
  const op = spec.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(res.statusCode)];
  expect(response, `${method.toUpperCase()} ${path} documents ${res.statusCode}: ${res.body}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (!media || !res.body) return;
  const validate = ajv.compile(media.schema as object);
  expect(validate(JSON.parse(res.body)), `${method.toUpperCase()} ${path} ${res.statusCode}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe('reports, exports and self-service match the spec', () => {
  it('reports', async () => {
    check('get', '/v1/reports/catalogue', await w.api('GET', '/v1/reports/catalogue'));
    check('post', '/v1/reports/ready/{id}/run', await w.api('POST', '/v1/reports/ready/holiday-liability/run', { params: { asOf: '2026-06-30' } }));
    check('post', '/v1/reports/ready/{id}/run', await w.api('POST', '/v1/reports/ready/turnover/run', { params: { from: '2026-01-01', to: '2026-06-30', groupBy: 'entity' } }));
    check('post', '/v1/reports/ready/{id}/run', await w.api('POST', '/v1/reports/ready/headcount/run', { params: { asOf: 'yesterday' } }));
    check('post', '/v1/reports/builder/preview', await w.api('POST', '/v1/reports/builder/preview', { dataset: 'employees', asOf: '2026-03-31', groupBy: [{ field: 'startDate', granularity: 'year' }], measures: [{ fn: 'count' }, { fn: 'avg', field: 'payAmount' }] }));
    const run = await w.api('POST', '/v1/reports/runs', { source: { kind: 'ready', reportId: 'overtime', params: { from: '2026-06-01', to: '2026-06-30' } }, format: 'xlsx' });
    check('post', '/v1/reports/runs', run);
    check('get', '/v1/reports/runs/{id}/download', await w.api('GET', `/v1/reports/runs/${run.json().id}/download`));
    await w.drain();
    check('get', '/v1/reports/runs/{id}', await w.api('GET', `/v1/reports/runs/${run.json().id}`));
    check('get', '/v1/reports/runs/{id}/download', await w.api('GET', `/v1/reports/runs/${run.json().id}/download`));
    check('get', '/v1/reports/runs', await w.api('GET', '/v1/reports/runs'));
    const saved = await w.api('POST', '/v1/reports/saved', { name: 'Contract builder', kind: 'builder', spec: { dataset: 'timesheets', from: '2026-06-01', to: '2026-06-30', columns: ['displayName', 'workedMinutes'] }, relative: 'previousMonth' });
    check('post', '/v1/reports/saved', saved);
    check('get', '/v1/reports/saved', await w.api('GET', '/v1/reports/saved'));
    check('get', '/v1/reports/saved/{id}', await w.api('GET', `/v1/reports/saved/${saved.json().id}`));
    check('put', '/v1/reports/saved/{id}', await w.api('PUT', `/v1/reports/saved/${saved.json().id}`, { name: 'Contract builder 2', kind: 'builder', spec: { dataset: 'timesheets', from: '2026-06-01', to: '2026-06-30', columns: ['displayName'] } }));
    const sched = await w.api('POST', '/v1/reports/schedules', { savedReportId: saved.json().id, frequency: 'weekly', weekday: 1, timeOfDay: '06:45', timeZone: 'Europe/London', format: 'csv', recipientUserIds: [w.owner.userId] });
    check('post', '/v1/reports/schedules', sched);
    check('get', '/v1/reports/schedules', await w.api('GET', '/v1/reports/schedules'));
    check('patch', '/v1/reports/schedules/{id}', await w.api('PATCH', `/v1/reports/schedules/${sched.json().id}`, { enabled: false }));
    check('delete', '/v1/reports/schedules/{id}', await w.api('DELETE', `/v1/reports/schedules/${sched.json().id}`));
    check('delete', '/v1/reports/saved/{id}', await w.api('DELETE', `/v1/reports/saved/${saved.json().id}`));
    check('get', '/v1/settings/reports', await w.api('GET', '/v1/settings/reports'));
    check('put', '/v1/settings/reports', await w.api('PUT', '/v1/settings/reports', { resultTtlHours: 48 }));
  });

  it('data exports', async () => {
    const d = await w.api('POST', '/v1/data-exports/destinations', { name: 'Contract bucket', kind: 's3', s3: { bucket: 'fictional-contract-bucket', region: 'eu-west-2', roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-export-contract' } });
    check('post', '/v1/data-exports/destinations', d);
    check('post', '/v1/data-exports/destinations', await w.api('POST', '/v1/data-exports/destinations', { name: 'Elsewhere', kind: 's3', s3: { bucket: 'fictional-contract-bucket', region: 'us-east-2', roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-export-contract' } }));
    check('get', '/v1/data-exports/destinations', await w.api('GET', '/v1/data-exports/destinations'));
    check('post', '/v1/data-exports/destinations/{id}/test', await w.api('POST', `/v1/data-exports/destinations/${d.json().id}/test`));
    const e = await w.api('POST', '/v1/data-exports', { name: 'Contract export', destinationId: d.json().id, datasets: [{ dataset: 'employees', fields: ['employeeNumber', 'startDate'] }], format: 'jsonl', frequency: 'daily', timeOfDay: '01:15', timeZone: 'Europe/London' });
    check('post', '/v1/data-exports', e);
    check('get', '/v1/data-exports', await w.api('GET', '/v1/data-exports'));
    check('patch', '/v1/data-exports/{id}', await w.api('PATCH', `/v1/data-exports/${e.json().id}`, { enabled: false }));
    check('post', '/v1/data-exports/{id}/run', await w.api('POST', `/v1/data-exports/${e.json().id}/run`));
    await w.drain();
    check('get', '/v1/data-exports/{id}/deliveries', await w.api('GET', `/v1/data-exports/${e.json().id}/deliveries`));
    check('delete', '/v1/data-exports/destinations/{id}', await w.api('DELETE', `/v1/data-exports/destinations/${d.json().id}`));
    check('delete', '/v1/data-exports/{id}', await w.api('DELETE', `/v1/data-exports/${e.json().id}`));
  });

  it('self-service', async () => {
    const ada = await w.login(w.people.ada, 'employee', { type: 'self' });
    check('get', '/v1/me/summary', await w.api('GET', '/v1/me/summary', undefined, ada.cookie));
    check('get', '/v1/me/summary', await w.api('GET', '/v1/me/summary'));
    check('get', '/v1/me/profile', await w.api('GET', '/v1/me/profile', undefined, ada.cookie));
    check('get', '/v1/me/profile', await w.api('GET', '/v1/me/profile'));
    check('post', '/v1/me/change-requests', await w.api('POST', '/v1/me/change-requests', { nationality: 'GB' }, ada.cookie));
    check('get', '/v1/me/change-requests', await w.api('GET', '/v1/me/change-requests', undefined, ada.cookie));
    check('get', '/v1/me/notifications', await w.api('GET', '/v1/me/notifications?limit=5', undefined, ada.cookie));
    check('post', '/v1/me/notifications/read', await w.api('POST', '/v1/me/notifications/read', { all: true }, ada.cookie));
    check('get', '/v1/me/notification-preferences', await w.api('GET', '/v1/me/notification-preferences', undefined, ada.cookie));
    check('put', '/v1/me/notification-preferences', await w.api('PUT', '/v1/me/notification-preferences', { push: false }, ada.cookie));
  });
});
