import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSpec } from '../src/openapi';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/** Contract tests for the compliance centre: real responses validate against the published OpenAPI 3.1 schemas. */
type Spec = {
  paths: Record<
    string,
    Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>
  >;
  components?: { schemas?: Record<string, unknown> };
};
let spec: Spec;
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  spec = (await buildSpec()) as Spec;
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {}))
    ajv.addSchema(schema as object, `#/components/schemas/${name}`);
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  path: string,
  payload?: unknown,
  expected?: number,
) {
  const res = await ctx.app.inject({
    method,
    url,
    payload: payload as object,
    headers: { cookie: owner.cookie },
  });
  if (expected) expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(expected);
  const op = spec.paths[path]?.[method.toLowerCase()];
  expect(op, `${method} ${path} is in the spec`).toBeDefined();
  const response = op!.responses[String(res.statusCode)];
  expect(response, `${method} ${path} documents ${res.statusCode}`).toBeDefined();
  const media = response!.content?.['application/json'] ?? Object.values(response!.content ?? {})[0];
  if (media && res.body) {
    const validate = ajv.compile(media.schema as object);
    expect(
      validate(res.json()),
      `${method} ${path} ${res.statusCode}: ${ajv.errorsText(validate.errors)}`,
    ).toBe(true);
  }
  return res;
}

describe('compliance endpoints match the spec', () => {
  it('right to work, I-9, matrix, alerts, reports, coverage, settings, dashboard and the law-changes feed', async () => {
    const gb = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/org/legal-entities',
        headers: { cookie: owner.cookie },
        payload: {
          name: 'Fictional Contract Ltd',
          country: 'GB',
          regionCode: 'GB-ENG',
          currency: 'GBP',
          timeZone: 'Europe/London',
        },
      })
    ).json().id;
    const us = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/org/legal-entities',
        headers: { cookie: owner.cookie },
        payload: {
          name: 'Fictional Contract Inc',
          country: 'US',
          regionCode: 'US-CA',
          currency: 'USD',
          timeZone: 'America/Los_Angeles',
        },
      })
    ).json().id;
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/org/legal-entities',
      headers: { cookie: owner.cookie },
      payload: { name: 'Fictional Contract SARL', country: 'FR', currency: 'EUR', timeZone: 'Europe/Paris' },
    });
    const hire = async (entityId: string, v: Record<string, unknown> = {}) =>
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/employees',
          headers: { cookie: owner.cookie },
          payload: {
            startDate: '2026-03-02',
            legalFirstName: 'Fictional',
            legalLastName: 'Contract',
            jobTitle: 'Analyst',
            entityId,
            weeklyHours: 40,
            payAmountMinor: 4_000_000,
            payCurrency: 'GBP',
            payFrequency: 'annual',
            contractType: 'permanent',
            ...v,
          },
        })
      ).json().id as string;
    const uk = await hire(gb, { probationEndDate: '2026-10-25' });
    const usEmp = await hire(us, { payCurrency: 'USD', flsaStatus: 'exempt' });

    await call(
      'GET',
      '/v1/compliance/right-to-work/rules?date=2026-10-18',
      '/v1/compliance/right-to-work/rules',
      undefined,
      200,
    );
    await call(
      'POST',
      '/v1/compliance/right-to-work/checks',
      '/v1/compliance/right-to-work/checks',
      {
        employeeId: uk,
        checkMethod: 'manual_document_check',
        listType: 'list_b_group_1',
        checkedOn: '2026-10-05',
      },
      400,
    );
    const check = await call(
      'POST',
      '/v1/compliance/right-to-work/checks',
      '/v1/compliance/right-to-work/checks',
      {
        employeeId: uk,
        checkMethod: 'manual_document_check',
        listType: 'list_b_group_1',
        checkedOn: '2026-10-05',
        permissionExpiresOn: '2027-03-31',
      },
      201,
    );
    await call(
      'GET',
      `/v1/compliance/right-to-work/checks/${check.json().id}`,
      '/v1/compliance/right-to-work/checks/{id}',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/right-to-work?asOf=2026-10-18',
      '/v1/compliance/right-to-work',
      undefined,
      200,
    );
    const i9 = await call(
      'POST',
      '/v1/compliance/i9',
      '/v1/compliance/i9',
      { employeeId: usEmp, section1CompletedOn: '2026-03-02' },
      200,
    );
    await call(
      'PATCH',
      `/v1/compliance/i9/${i9.json().id}`,
      '/v1/compliance/i9/{id}',
      { section2CompletedOn: '2026-03-04' },
      200,
    );
    await call('GET', '/v1/compliance/i9?asOf=2026-10-18', '/v1/compliance/i9', undefined, 200);
    const req = await call(
      'POST',
      '/v1/compliance/requirements',
      '/v1/compliance/requirements',
      { kind: 'training', name: 'Fictional induction', validityMonths: 12 },
      201,
    );
    await call(
      'PATCH',
      `/v1/compliance/requirements/${req.json().id}`,
      '/v1/compliance/requirements/{id}',
      { reminderDays: [30] },
      200,
    );
    await call('GET', '/v1/compliance/requirements', '/v1/compliance/requirements', undefined, 200);
    await call(
      'POST',
      '/v1/compliance/records',
      '/v1/compliance/records',
      { requirementId: req.json().id, employeeId: uk, issuedOn: '2026-03-02' },
      201,
    );
    await call('GET', '/v1/compliance/matrix?asOf=2026-10-18', '/v1/compliance/matrix', undefined, 200);
    await call('GET', '/v1/compliance/alerts?asOf=2026-10-18', '/v1/compliance/alerts', undefined, 200);
    await call('GET', '/v1/compliance/flsa?asOf=2026-10-18', '/v1/compliance/flsa', undefined, 200);
    await call(
      'GET',
      `/v1/compliance/flsa/${usEmp}/overtime-eligibility?asOf=2026-10-18`,
      '/v1/compliance/flsa/{employeeId}/overtime-eligibility',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/leave-coverage?asOf=2026-10-18',
      '/v1/compliance/leave-coverage',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/uk/holiday-accrual?asOf=2026-10-18',
      '/v1/compliance/uk/holiday-accrual',
      undefined,
      200,
    );
    await call(
      'POST',
      '/v1/compliance/uk/holiday-accrual/calculate',
      '/v1/compliance/uk/holiday-accrual/calculate',
      { minutesWorked: 600, payPeriodEnd: '2026-06-30' },
      200,
    );
    await call('GET', '/v1/compliance/uk/ssp?asOf=2026-10-18', '/v1/compliance/uk/ssp', undefined, 200);
    await call(
      'PUT',
      `/v1/compliance/demographics/${uk}`,
      '/v1/compliance/demographics/{employeeId}',
      { sex: 'female' },
      204,
    );
    await call(
      'POST',
      '/v1/compliance/eeo/self-identification',
      '/v1/compliance/eeo/self-identification',
      { employeeId: usEmp, raceEthnicity: 'two_or_more_races', sex: 'declined' },
      204,
    );
    await call(
      'GET',
      `/v1/compliance/eeo/self-identification/${usEmp}`,
      '/v1/compliance/eeo/self-identification/{employeeId}',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/eeo/job-categories',
      '/v1/compliance/eeo/job-categories',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/reports/gender-pay-gap?year=2026',
      '/v1/compliance/reports/gender-pay-gap',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/reports/eeo-1?year=2026',
      '/v1/compliance/reports/eeo-1',
      undefined,
      200,
    );
    await call(
      'GET',
      '/v1/compliance/reports/eeo-1?year=2026&snapshotDate=2026-01-15',
      '/v1/compliance/reports/eeo-1',
      undefined,
      422,
    );
    await call(
      'GET',
      '/v1/compliance/reports/pay-transparency?year=2027',
      '/v1/compliance/reports/pay-transparency',
      undefined,
      200,
    );
    await call('GET', '/v1/settings/compliance', '/v1/settings/compliance', undefined, 200);
    await call(
      'PUT',
      '/v1/settings/compliance',
      '/v1/settings/compliance',
      { rtwReminderDays: [60, 14] },
      200,
    );
    await call('GET', '/v1/compliance/law-changes', '/v1/compliance/law-changes', undefined, 200);
    await call('GET', '/v1/compliance/dashboard?asOf=2026-10-18', '/v1/compliance/dashboard', undefined, 200);
  });
});
