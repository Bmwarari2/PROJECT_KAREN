import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import {
  closeDb,
  cookieFrom,
  enrolTotp,
  ownerSession,
  PASSWORD,
  startTestApp,
  type TestContext,
} from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { runComplianceDaily } from '../src/modules/compliance/jobs';
import { elevate, staffSession } from './staff-helpers';

/**
 * Phase 5 compliance centre, end to end through the API on explicit dates (never today's date).
 * Fictional companies and people only.
 */
let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
const ent: Record<string, string> = {};
const loc: Record<string, string> = {};
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const api = (method: Method, url: string, payload?: unknown, cookie = owner.cookie) =>
  ctx.app.inject({ method, url, payload: payload as object, headers: { cookie } });
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.deps.router, owner.tenantId, fn);
const daily = (date: string) => tx((t) => runComplianceDaily(ctx.deps, t, date));
let n = 0;

async function hire(entity: string, v: Record<string, unknown> = {}) {
  n++;
  const r = await api('POST', '/v1/employees', {
    startDate: '2025-01-06',
    legalFirstName: `Fictional${n}`,
    legalLastName: 'Person',
    jobTitle: 'Analyst',
    entityId: entity,
    weeklyHours: 40,
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    ...v,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
/** Sets the employment end date (core field, not a hire section). */
const endEmployment = (id: string, date: string) =>
  tx((t) => t.exec('UPDATE app.employees SET end_date = $2 WHERE id = $1', [id, date]));
async function login(
  employeeId: string,
  role: string,
  scope: { type: 'self' | 'own_team' | 'entity'; values?: string[] } = { type: 'self' },
) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  await tx(async (t) => {
    const u = await t.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`,
      [email, employeeId],
    );
    await t.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(t, u.id, role, scope);
    if (role !== 'employee') await assignRole(t, u.id, 'employee', { type: 'self' });
  });
  const cookie = cookieFrom(
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email, password: PASSWORD },
      remoteAddress: `10.81.${Math.floor(Math.random() * 250)}.7`,
    }),
  );
  if (['payroll_admin', 'entity_hr_admin', 'hr_admin'].includes(role)) await enrolTotp(ctx, cookie); // admins must complete MFA
  return cookie;
}
const auditCount = (action: string, extra = '') =>
  tx((t) =>
    t.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit.events WHERE action = $1 ${extra}`, [action]),
  ).then((r) => r.n);
const notifications = (prefix: string) =>
  tx((t) =>
    t.query<{ dedupe_key: string; title_key: string; user_id: string }>(
      `SELECT dedupe_key, title_key, user_id FROM app.notifications WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`,
      [`${prefix}%`],
    ),
  );

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  const mk = async (key: string, body: Record<string, unknown>) => {
    const r = await api('POST', '/v1/org/legal-entities', body);
    expect(r.statusCode, r.body).toBe(201);
    ent[key] = r.json().id;
  };
  await mk('gb', {
    name: 'Fictional UK Ltd',
    country: 'GB',
    regionCode: 'GB-ENG',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  await mk('gb2', {
    name: 'Fictional UK Two Ltd',
    country: 'GB',
    regionCode: 'GB-SCT',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  await mk('us', {
    name: 'Fictional US Inc',
    country: 'US',
    regionCode: 'US-CA',
    currency: 'USD',
    timeZone: 'America/Los_Angeles',
  });
  await mk('de', { name: 'Fictional GmbH', country: 'DE', currency: 'EUR', timeZone: 'Europe/Berlin' });
  const l = await api('POST', '/v1/org/locations', {
    name: 'Fictional NYC office',
    entityId: ent.us,
    country: 'US',
    regionCode: 'US-NY-NYC',
    timeZone: 'America/New_York',
  });
  expect(l.statusCode, l.body).toBe(201);
  loc.nyc = l.json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('5.1 UK right-to-work checks', () => {
  let emp: string;
  let checkId: string;
  it('exposes check methods, document lists, follow-up and retention rules from the GB pack', async () => {
    const r = (await api('GET', '/v1/compliance/right-to-work/rules?date=2026-10-18')).json();
    expect(r.rules.listTypes).toEqual([
      'list_a',
      'list_b_group_1',
      'list_b_group_2',
      'online_unlimited',
      'online_time_limited',
    ]);
    expect(r.rules.documentCatalogue.list_b_group_2).toContain(
      'application_registration_card_permitting_work_with_pvn',
    );
    expect(r.retention.retainAfterEmploymentEnds).toBe('P2Y');
    expect(r.source.url).toMatch(/^https:\/\/www\.gov\.uk\//);
  });

  it('records a List B Group 2 check: excuse six months from the PVN date, follow-up before it ends; documents only in the vault', async () => {
    emp = await hire(ent.gb!, { startDate: '2026-10-05' });
    const bad = await api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: emp,
      checkMethod: 'manual_document_check',
      listType: 'list_b_group_1',
      checkedOn: '2026-10-05',
    });
    expect(bad.statusCode).toBe(400); // permission expiry date required
    expect(
      (
        await api('POST', '/v1/compliance/right-to-work/checks', {
          employeeId: emp,
          checkMethod: 'guesswork',
          listType: 'list_a',
          checkedOn: '2026-10-05',
        })
      ).statusCode,
    ).toBe(400);
    const res = await api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: emp,
      checkMethod: 'manual_document_check',
      listType: 'list_b_group_2',
      checkedOn: '2026-10-05',
      pvnDate: '2026-10-02',
      documentType: 'application_registration_card_permitting_work_with_pvn',
      documentReference: 'FICT-ARC-0001',
      shareCode: 'W12345678',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      excuse: 'time_limited',
      excuseEndsOn: '2027-04-02',
      followUpDueOn: '2027-04-01',
    });
    checkId = res.json().id;
    const stored = await tx((t) =>
      t.one<{ envelope: unknown }>(
        `SELECT envelope FROM vault.records WHERE category = 'immigration' AND field = $1`,
        [`rtw_details:${checkId}`],
      ),
    );
    expect(JSON.stringify(stored.envelope)).not.toContain('W12345678');
    const row = await tx((t) =>
      t.one<Record<string, unknown>>('SELECT * FROM app.rtw_checks WHERE id = $1', [checkId]),
    );
    expect(JSON.stringify(row)).not.toContain('FICT-ARC-0001');
    expect(await auditCount('compliance.rtw_check_recorded', 'AND sensitive')).toBeGreaterThan(0);
  });

  it('statuses on explicit dates: valid, follow-up due inside the reminder window, expired; missing for an employee without a check', async () => {
    const other = await hire(ent.gb!, { startDate: '2026-09-01' });
    const at = async (d: string) =>
      (await api('GET', `/v1/compliance/right-to-work?asOf=${d}`)).json() as Array<{
        employeeId: string;
        status: string;
      }>;
    expect((await at('2026-10-18')).find((r) => r.employeeId === emp)!.status).toBe('valid');
    expect((await at('2027-02-01')).find((r) => r.employeeId === emp)!.status).toBe('follow_up_due');
    expect((await at('2027-04-02')).find((r) => r.employeeId === emp)!.status).toBe('expired');
    expect((await at('2026-10-18')).find((r) => r.employeeId === other)!.status).toBe('missing');
    expect(await auditCount('compliance.rtw_listed', 'AND sensitive')).toBeGreaterThan(0);
  });

  it('stores the evidence in the vault and decrypts it only on an audited detail view', async () => {
    const boundary = '----rtw';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional-check.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from('%PDF-1.4 fictional'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/v1/compliance/right-to-work/checks/${checkId}/evidence`,
      payload,
      headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode, up.body).toBe(201);
    const before = await auditCount('vault.read');
    const d = await api('GET', `/v1/compliance/right-to-work/checks/${checkId}`);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().details).toEqual({
      documentType: 'application_registration_card_permitting_work_with_pvn',
      documentReference: 'FICT-ARC-0001',
      shareCode: 'W12345678',
    });
    expect(d.json().evidence.fileName).toBe('fictional-check.pdf');
    expect(await auditCount('vault.read')).toBe(before + 2);
  });

  it('is permission-scoped: an employee cannot record checks; a manager cannot see another team', async () => {
    const someone = await hire(ent.gb!);
    const me = await login(someone, 'employee');
    expect(
      (
        await api(
          'POST',
          '/v1/compliance/right-to-work/checks',
          {
            employeeId: someone,
            checkMethod: 'manual_document_check',
            listType: 'list_a',
            checkedOn: '2026-10-05',
          },
          me,
        )
      ).statusCode,
    ).toBe(403);
    expect((await api('GET', '/v1/compliance/right-to-work', undefined, me)).statusCode).toBe(403);
    const mgr = await login(someone, 'manager', { type: 'own_team' });
    expect(
      (await api('GET', `/v1/compliance/right-to-work/checks/${checkId}`, undefined, mgr)).statusCode,
    ).toBe(403);
    expect(
      ((await api('GET', '/v1/compliance/right-to-work?asOf=2026-10-18', undefined, mgr)).json() as unknown[])
        .length,
    ).toBe(0);
  });

  it('daily job: reminders before the follow-up date and a task, idempotent per offset; a new check closes the task', async () => {
    const first = await daily('2027-01-01'); // 90 days before 2027-04-01
    expect(first.rtw).toBeGreaterThan(0);
    expect((await notifications(`rtwcheck:${checkId}`)).map((x) => x.dedupe_key)).toContain(
      `rtwcheck:${checkId}:90`,
    );
    expect((await daily('2027-01-01')).rtw).toBe(0);
    const tasks = await tx((t) =>
      t.query<{ status: string }>(`SELECT status FROM app.tasks WHERE dedupe_key = $1`, [
        `rtwcheck:${checkId}:task`,
      ]),
    );
    expect(tasks).toEqual([{ status: 'open' }]);
    const again = await api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: emp,
      checkMethod: 'home_office_online_check',
      listType: 'online_unlimited',
      checkedOn: '2027-03-20',
    });
    expect(again.statusCode).toBe(201);
    expect(
      (
        await tx((t) =>
          t.one<{ status: string }>(`SELECT status FROM app.tasks WHERE dedupe_key = $1`, [
            `rtwcheck:${checkId}:task`,
          ]),
        )
      ).status,
    ).toBe('done');
    expect(
      (
        await tx((t) =>
          t.one<{ superseded_by: string }>('SELECT superseded_by FROM app.rtw_checks WHERE id = $1', [
            checkId,
          ]),
        )
      ).superseded_by,
    ).toBe(again.json().id);
  });

  it('keeps records for two years after employment ends, then drops them from the list', async () => {
    const leaver = await hire(ent.gb!, { startDate: '2026-10-05' });
    await endEmployment(leaver, '2026-11-30');
    // the pack models the right-to-work guidance from 1 October 2026 only: an earlier check date is refused, not guessed
    expect(
      (
        await api('POST', '/v1/compliance/right-to-work/checks', {
          employeeId: leaver,
          checkMethod: 'manual_document_check',
          listType: 'list_a',
          checkedOn: '2025-02-01',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await api('POST', '/v1/compliance/right-to-work/checks', {
          employeeId: leaver,
          checkMethod: 'manual_document_check',
          listType: 'list_a',
          checkedOn: '2026-10-02',
        })
      ).statusCode,
    ).toBe(201);
    const row = (
      (await api('GET', '/v1/compliance/right-to-work?asOf=2027-01-01')).json() as Array<{
        employeeId: string;
        status: string;
        retainUntil: string;
      }>
    ).find((r) => r.employeeId === leaver)!;
    expect(row).toMatchObject({ status: 'retention', retainUntil: '2028-11-30' });
    expect(
      (
        (await api('GET', '/v1/compliance/right-to-work?asOf=2028-12-01')).json() as Array<{
          employeeId: string;
        }>
      ).some((r) => r.employeeId === leaver),
    ).toBe(false);
  });
});

describe('5.1 probation and service-length alerts (ERA 2025 qualifying period from 1 January 2027)', () => {
  it('lists probation ends and the date unfair dismissal protection begins, effective-dated', async () => {
    const mgrEmp = await hire(ent.gb2!, { startDate: '2020-01-06' });
    const prob = await hire(ent.gb2!, {
      startDate: '2026-08-03',
      probationEndDate: '2026-11-01',
      managerId: mgrEmp,
    });
    const sixMonths = await hire(ent.gb2!, { startDate: '2026-09-01' });
    const transitional = await hire(ent.gb2!, { startDate: '2025-06-01' });
    await login(mgrEmp, 'manager', { type: 'own_team' });
    const at = async (d: string, within?: number) =>
      (
        await api(
          'GET',
          `/v1/compliance/alerts?asOf=${d}${within !== undefined ? `&withinDays=${within}` : ''}`,
        )
      ).json() as Array<{ kind: string; employeeId: string; dueOn: string; qualifyingPeriod: string | null }>;
    expect((await at('2026-10-18')).find((a) => a.employeeId === prob)).toMatchObject({
      kind: 'probation_ending',
      dueOn: '2026-11-01',
    });
    expect((await at('2026-12-15', 30)).find((a) => a.employeeId === transitional)).toMatchObject({
      kind: 'unfair_dismissal_qualifying_period',
      dueOn: '2027-01-01',
      qualifyingPeriod: 'P6M',
    });
    expect((await at('2027-02-01', 30)).find((a) => a.employeeId === sixMonths)).toMatchObject({
      dueOn: '2027-02-28',
      qualifyingPeriod: 'P6M',
    });
    // daily job: probation reminder 14 days before to HR and the manager, once
    const first = await daily('2026-10-18');
    expect(first.service).toBeGreaterThan(0);
    const sent = await notifications(`probation:${prob}`);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect((await daily('2026-10-18')).service).toBe(0);
    await daily('2026-12-02'); // 30 days before 1 January 2027
    expect((await notifications(`qualifying:${transitional}:2027-01-01:30`)).length).toBeGreaterThan(0);
  });
});

describe('5.1 holiday accrual and SSP', () => {
  it('flags irregular-hours workers whose leave policy does not accrue 12.07% per hour worked; calculates reg. 15B accrual', async () => {
    const casual = await hire(ent.gb!, { employmentType: 'casual', contractType: 'zero_hours' });
    await api('GET', `/v1/leave/balances/${casual}?asOf=2026-10-18`); // the leave module seeds its default policies
    const rows = (await api('GET', '/v1/compliance/uk/holiday-accrual?asOf=2026-10-18')).json() as Array<{
      employeeId: string;
      ok: boolean;
      statutoryPercent: number;
      basis: string;
    }>;
    const r = rows.find((x) => x.employeeId === casual)!;
    expect(r).toMatchObject({ ok: false, statutoryPercent: 12.07, basis: 'zero_hours_contract' });
    const calc = await api('POST', '/v1/compliance/uk/holiday-accrual/calculate', {
      minutesWorked: 68 * 60,
      payPeriodEnd: '2026-06-30',
    });
    expect(calc.json()).toMatchObject({ accruedHours: 8, percent: 12.07 });
  });

  it("the SSP view reads the leave module's statutory-pay calculation for employees with sickness", async () => {
    const sick = await hire(ent.gb!, { startDate: '2024-01-08', payAmountMinor: 3_120_000 });
    expect(
      (
        await api('POST', '/v1/sickness', {
          employeeId: sick,
          startDate: '2026-09-07',
          endDate: '2026-09-11',
        })
      ).statusCode,
    ).toBe(201);
    const view = (await api('GET', '/v1/compliance/uk/ssp?asOf=2026-10-18')).json() as Array<{
      employeeId: string;
      scheme: string;
      result: unknown;
    }>;
    const direct = (await api('GET', `/v1/sickness/${sick}/statutory-pay?asOf=2026-10-18`)).json();
    expect(view.find((v) => v.employeeId === sick)).toMatchObject({
      scheme: 'uk_ssp',
      result: direct.result,
    });
  });
});

describe('5.1 / 5.3 pay reporting with sex held in the vault', () => {
  it('UK gender pay gap: figures from current pay records, sex decrypted from the vault (audited), threshold from the pack', async () => {
    const people = [
      ['male', 5_200_000],
      ['male', 4_160_000],
      ['female', 4_160_000],
      ['female', 3_120_000],
    ] as const;
    const ids: string[] = [];
    for (const [sex, pay] of people) {
      const id = await hire(ent.gb2!, { startDate: '2026-01-05', payAmountMinor: pay });
      ids.push(id);
      expect((await api('PUT', `/v1/compliance/demographics/${id}`, { sex })).statusCode).toBe(204);
    }
    const plaintext = await tx((t) =>
      t.query<{ envelope: unknown }>(
        `SELECT envelope FROM vault.records WHERE category = 'diversity' AND subject_id = ANY($1::uuid[])`,
        [ids],
      ),
    );
    expect(plaintext).toHaveLength(4);
    expect(JSON.stringify(plaintext)).not.toMatch(/female/);
    const before = await auditCount('vault.read');
    const r = await api('GET', `/v1/compliance/reports/gender-pay-gap?year=2026&entityId=${ent.gb2}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      snapshotDate: '2026-04-05',
      deadline: '2027-04-04',
      employeeThreshold: 250,
      required: false,
      dataSource: 'employee_pay',
    });
    expect(body.population).toMatchObject({ male: 2, female: 2 });
    // mean hourly: men (52,000 + 41,600) / 2 vs women (41,600 + 31,200) / 2 → 22.2%
    expect(body.figures.meanHourlyPayGap).toBe(22.2);
    expect(await auditCount('vault.read')).toBeGreaterThanOrEqual(before + 4); // one audited decrypt per person with a record
    expect(await auditCount('compliance.gpg_report_viewed', 'AND sensitive')).toBe(1);
  });

  it('a payroll admin without compliance reporting rights cannot run it', async () => {
    const p = await login(await hire(ent.gb!), 'payroll_admin', { type: 'entity', values: [ent.gb!] });
    expect(
      (await api('GET', '/v1/compliance/reports/gender-pay-gap?year=2026', undefined, p)).statusCode,
    ).toBe(403);
  });

  it('EU pay transparency: indicators from loaded payroll data, with the member state transposition status', async () => {
    const rows = [];
    for (const [sex, basic, variable] of [
      ['male', 6_000_000, 600_000],
      ['female', 5_000_000, 0],
      ['female', 4_000_000, 200_000],
      ['male', 4_500_000, 0],
    ] as const) {
      const id = await hire(ent.de!, { startDate: '2025-03-03', payCurrency: 'EUR', payAmountMinor: basic });
      await api('PUT', `/v1/compliance/demographics/${id}`, { sex });
      rows.push({
        employeeId: id,
        currency: 'EUR',
        annualBasicMinor: basic,
        annualVariableMinor: variable,
        annualHours: 1720,
        workerCategory: 'engineering',
      });
    }
    expect(
      (
        await api('PUT', '/v1/compliance/pay-report-inputs', {
          kind: 'eu_pay_transparency',
          snapshotDate: '2026-12-31',
          rows,
        })
      ).json(),
    ).toEqual({ saved: 4 });
    const r = await api('GET', `/v1/compliance/reports/pay-transparency?year=2027&entityId=${ent.de}`);
    expect(r.statusCode, r.body).toBe(200);
    const de = r.json()[0];
    expect(de.transposition).toMatchObject({ status: 'not_transposed' });
    expect(de.transposition.source.url).toMatch(/eur-lex\.europa\.eu/);
    expect(de.indicators.population).toMatchObject({ workers: 4, included: 4, payLevelBasis: 'hourly' });
    // mean total: men (6.6m + 4.5m)/2 = 5.55m; women (5.0m + 4.2m)/2 = 4.6m → 17.1%
    expect(de.indicators.genderPayGap.toFixed(1)).toBe('17.1');
    expect(de.indicators.jointPayAssessment.categoriesIndicated).toEqual(['engineering']);
    expect(de.indicators.obligation.reportingRequired).toBe(false);
  });
});

describe('5.2 US Form I-9, FLSA, EEO-1 and leave coverage', () => {
  it('I-9: Section 2 within three business days, reverification before authorization expires, retention; attestation in the vault', async () => {
    const emp = await hire(ent.us!, { startDate: '2026-10-19', payCurrency: 'USD' });
    const r = await api('POST', '/v1/compliance/i9', {
      employeeId: emp,
      section1CompletedOn: '2026-10-19',
      workAuthorizationExpiresOn: '2027-06-30',
      citizenshipAttestation: 'noncitizen_authorized_to_work',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      section1DueOn: '2026-10-19',
      section2DueOn: '2026-10-22',
      reverificationDueOn: '2027-06-30',
      retainAtLeastUntil: '2029-10-19',
    });
    const id = r.json().id;
    const status = async (d: string) =>
      (
        (await api('GET', `/v1/compliance/i9?asOf=${d}`)).json() as Array<{
          employeeId: string;
          status: string;
        }>
      ).find((x) => x.employeeId === emp)!.status;
    expect(await status('2026-10-21')).toBe('section2_due');
    expect(await status('2026-10-23')).toBe('section2_overdue');
    expect(
      (await api('PATCH', `/v1/compliance/i9/${id}`, { section2CompletedOn: '2026-10-21' })).statusCode,
    ).toBe(200);
    expect(await status('2026-12-01')).toBe('complete');
    expect(await status('2027-05-01')).toBe('reverification_due');
    expect(await status('2027-07-01')).toBe('reverification_overdue');
    const plain = await tx((t) =>
      t.one<Record<string, unknown>>('SELECT * FROM app.i9_records WHERE id = $1', [id]),
    );
    expect(JSON.stringify(plain)).not.toContain('noncitizen');
    expect(
      (
        await tx((t) =>
          t.query(`SELECT 1 FROM vault.records WHERE category = 'immigration' AND field = $1`, [
            `i9_attestation:${id}`,
          ]),
        )
      ).length,
    ).toBe(1);
    expect((await daily('2027-04-01')).i9).toBeGreaterThan(0); // 90 days before 30 June 2027
    expect((await notifications(`i9-rev:${id}:2027-06-30:90`)).length).toBeGreaterThan(0);
    expect((await daily('2027-04-01')).i9).toBe(0);
    // reverification completed with a new expiry starts the next cycle
    const p = await api('PATCH', `/v1/compliance/i9/${id}`, {
      supplementBCompletedOn: '2027-06-15',
      workAuthorizationExpiresOn: '2029-06-30',
    });
    expect(p.json().reverificationDueOn).toBe('2029-06-30');
    expect(await status('2027-07-01')).toBe('complete');
  });

  it('I-9 retention for a leaver is the later of three years after hire or one year after termination', async () => {
    const leaver = await hire(ent.us!, { startDate: '2024-03-04', payCurrency: 'USD' });
    await endEmployment(leaver, '2026-08-31');
    await api('POST', '/v1/compliance/i9', {
      employeeId: leaver,
      section1CompletedOn: '2024-03-04',
      section2CompletedOn: '2024-03-05',
    });
    const row = (
      (await api('GET', '/v1/compliance/i9?asOf=2026-10-18')).json() as Array<{
        employeeId: string;
        retainUntil: string;
      }>
    ).find((x) => x.employeeId === leaver)!;
    expect(row.retainUntil).toBe('2027-08-31');
  });

  it('FLSA: California threshold (2× state minimum wage) and the duties attestation decide overtime eligibility', async () => {
    const low = await hire(ent.us!, { payCurrency: 'USD', payAmountMinor: 6_000_000, flsaStatus: 'exempt' });
    const ok = await hire(ent.us!, { payCurrency: 'USD', payAmountMinor: 8_000_000, flsaStatus: 'exempt' });
    const duties = [
      'primary_duty_office_or_non_manual_work_related_to_management_or_general_business_operations',
      'discretion_and_independent_judgment_on_matters_of_significance',
    ];
    for (const e of [low, ok])
      expect(
        (
          await api('POST', '/v1/compliance/flsa/attestations', {
            employeeId: e,
            exemption: 'administrative',
            duties,
            validFrom: '2025-01-06',
          })
        ).json(),
      ).toMatchObject({ complete: true });
    expect(
      (
        await api('POST', '/v1/compliance/flsa/attestations', {
          employeeId: ok,
          exemption: 'administrative',
          duties: ['made_up'],
          validFrom: '2025-01-06',
        })
      ).statusCode,
    ).toBe(400);
    const rows = (await api('GET', '/v1/compliance/flsa?asOf=2026-06-01')).json() as Array<{
      employeeId: string;
      status: string;
      overtimeEligible: boolean;
      issues: string[];
      applicableAnnualThresholdMinor: number;
    }>;
    expect(rows.find((r) => r.employeeId === low)).toMatchObject({
      status: 'exempt_at_risk',
      overtimeEligible: true,
      issues: ['below_salary_threshold'],
      applicableAnnualThresholdMinor: 7_030_400,
    });
    expect(rows.find((r) => r.employeeId === ok)).toMatchObject({
      status: 'exempt',
      overtimeEligible: false,
    });
    expect(
      (await api('GET', `/v1/compliance/flsa/${ok}/overtime-eligibility?asOf=2026-06-01`)).json(),
    ).toMatchObject({ overtimeEligible: false });
  });

  it('EEO-1: self-identification stored only in the vault; aggregates suppress small cells; exact counts need the extra permission', async () => {
    expect(
      (
        await api('PUT', '/v1/compliance/eeo/job-categories', {
          mappings: [
            { jobTitle: 'Engineer', category: 'professionals' },
            { jobTitle: 'Engineer', category: 'astronauts' },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('PUT', '/v1/compliance/eeo/job-categories', {
          mappings: [{ jobTitle: 'Engineer', category: 'professionals' }],
        })
      ).statusCode,
    ).toBe(200);
    const plan = [
      ...Array.from({ length: 6 }, () => ['asian', 'female']),
      ...Array.from({ length: 2 }, () => ['hispanic_or_latino', 'male']),
    ];
    let selfCookie = '';
    for (const [i, [race, sex]] of plan.entries()) {
      const id = await hire(ent.us!, { jobTitle: 'Engineer', startDate: '2026-02-02', payCurrency: 'USD' });
      if (i === 0) {
        selfCookie = await login(id, 'employee');
        expect(
          (
            await api(
              'POST',
              '/v1/compliance/eeo/self-identification',
              { raceEthnicity: race, sex, veteranStatus: 'declined' },
              selfCookie,
            )
          ).statusCode,
        ).toBe(204);
        expect(
          (await api('GET', `/v1/compliance/eeo/self-identification/${id}`, undefined, selfCookie)).json(),
        ).toMatchObject({ raceEthnicity: race, source: 'self' });
      } else
        expect(
          (
            await api('POST', '/v1/compliance/eeo/self-identification', {
              employeeId: id,
              raceEthnicity: race,
              sex,
            })
          ).statusCode,
        ).toBe(204);
    }
    expect(
      (
        await api(
          'POST',
          '/v1/compliance/eeo/self-identification',
          { raceEthnicity: 'martian', sex: 'male' },
          selfCookie,
        )
      ).statusCode,
    ).toBe(400);
    const cipher = await tx((t) =>
      t.query<{ envelope: unknown }>(`SELECT envelope FROM vault.records WHERE category = 'eeo'`),
    );
    expect(cipher.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(cipher)).not.toMatch(/asian|hispanic/);
    expect(
      (await api('GET', '/v1/compliance/reports/eeo-1?year=2026', undefined, selfCookie)).statusCode,
    ).toBe(403);
    const r = await api('GET', '/v1/compliance/reports/eeo-1?year=2026&snapshotDate=2026-12-15');
    expect(r.statusCode, r.body).toBe(200);
    const prof = (
      r.json().table as Array<{
        jobCategory: string;
        total: number;
        cells: Array<{ raceEthnicity: string; sex: string; count: number | null; suppressed: boolean }>;
      }>
    ).find((t) => t.jobCategory === 'professionals')!;
    expect(
      prof.cells.find((c) => c.raceEthnicity === 'hispanic_or_latino' && c.sex === 'male'),
    ).toMatchObject({ count: null, suppressed: true });
    expect(prof.total).toBe(8);
    expect(r.json()).toMatchObject({
      required: false,
      threshold: 100,
      suppressionThreshold: 5,
      window: { from: '2026-10-01', to: '2026-12-31' },
    });
    expect(
      (await api('GET', '/v1/compliance/reports/eeo-1?year=2026&snapshotDate=2026-06-30')).statusCode,
    ).toBe(422);
    const exact = (await api('GET', '/v1/compliance/reports/eeo-1?year=2026&exact=true')).json();
    expect(exact.suppressionThreshold).toBeNull();
    expect(await auditCount('compliance.eeo1_report_viewed', 'AND sensitive')).toBe(2);
  });

  it('surfaces state and local paid sick leave and FMLA coverage from the packs and the leave records', async () => {
    await hire(ent.us!, { locationId: loc.nyc, payCurrency: 'USD' });
    const r = (await api('GET', '/v1/compliance/leave-coverage?asOf=2026-10-18')).json();
    const psl = r.us.paidSickLeave as Array<{ jurisdiction: string; answeredBy: string; modelled: boolean }>;
    expect(psl.find((p) => p.jurisdiction === 'US-CA')).toMatchObject({
      answeredBy: 'US-CA',
      modelled: true,
    });
    expect(psl.find((p) => p.jurisdiction === 'US-NY-NYC')).toMatchObject({
      answeredBy: 'US-NY-NYC',
      modelled: true,
    });
    expect(r.us.fmla).toMatchObject({ coveredEmployer: false, minEmployees: 50 });
    const de = (
      r.eu as Array<{
        country: string;
        rules: Array<{ key: string; modelled: boolean; answeredBy: string }>;
        publicHolidays: number;
      }>
    ).find((x) => x.country === 'DE')!;
    expect(de.rules.find((x) => x.key === 'employment.notice_period')).toMatchObject({
      modelled: true,
      answeredBy: 'DE',
    });
    expect(de.rules.find((x) => x.key === 'working_time.max_weekly_hours')).toMatchObject({
      modelled: true,
      answeredBy: 'EU',
    });
    expect(de.publicHolidays).toBeGreaterThan(0);
  });
});

describe('5.4 compliance matrix', () => {
  let forklift: string;
  const people: Record<string, string> = {};
  it('requirements per job title and location; records with expiry; status dashboard with filters', async () => {
    const r = await api('POST', '/v1/compliance/requirements', {
      kind: 'licence',
      name: 'Fictional forklift licence',
      appliesTo: { jobTitles: ['Forklift Operator'] },
      validityMonths: 12,
      reminderDays: [30, 7, 0],
    });
    expect(r.statusCode, r.body).toBe(201);
    forklift = r.json().id;
    expect(
      (
        await api('POST', '/v1/compliance/requirements', {
          kind: 'training',
          name: 'Fictional fire safety',
          appliesTo: { entityIds: [ent.gb2] },
          validityMonths: 24,
        })
      ).statusCode,
    ).toBe(201);
    people.expiring = await hire(ent.gb!, { jobTitle: 'Forklift Operator' });
    people.missing = await hire(ent.gb!, { jobTitle: 'Forklift Operator' });
    people.expired = await hire(ent.gb!, { jobTitle: 'Forklift Operator' });
    expect(
      (
        await api('POST', '/v1/compliance/records', {
          requirementId: forklift,
          employeeId: people.expiring,
          issuedOn: '2025-11-01',
          reference: 'FICT-FL-1',
        })
      ).json().expiresOn,
    ).toBe('2026-10-31');
    expect(
      (
        await api('POST', '/v1/compliance/records', {
          requirementId: forklift,
          employeeId: people.expired,
          issuedOn: '2025-01-01',
        })
      ).statusCode,
    ).toBe(201);
    const m = (await api('GET', `/v1/compliance/matrix?asOf=2026-10-18&requirementId=${forklift}`)).json();
    expect(m.summary).toEqual({ compliant: 0, expiring: 1, expired: 1, missing: 1 });
    const missing = (
      await api('GET', `/v1/compliance/matrix?asOf=2026-10-18&requirementId=${forklift}&status=missing`)
    ).json();
    expect(missing.rows.map((x: { employeeId: string }) => x.employeeId)).toEqual([people.missing]);
    expect(
      (
        await api('GET', `/v1/compliance/matrix?asOf=2026-10-18&jobTitle=Analyst&requirementId=${forklift}`)
      ).json().total,
    ).toBe(0);
    expect(
      (await api('GET', `/v1/compliance/matrix?asOf=2026-10-18&kind=training&entityId=${ent.gb2}`)).json()
        .summary.missing,
    ).toBeGreaterThan(0);
  });

  it('rejects evidence documents of another employee and is scoped by role', async () => {
    const doc = await tx((t) =>
      t.one<{ id: string }>(
        `INSERT INTO app.documents (tenant_id, employee_id, title, file_key, file_name, content_type, status) VALUES (app.current_tenant(), $1, 'Fictional licence', 'k', 'l.pdf', 'application/pdf', 'ready') RETURNING id`,
        [people.expiring],
      ),
    );
    expect(
      (
        await api('POST', '/v1/compliance/records', {
          requirementId: forklift,
          employeeId: people.missing,
          issuedOn: '2026-10-01',
          evidenceDocumentId: doc.id,
        })
      ).statusCode,
    ).toBe(400);
    const deHr = await login(await hire(ent.de!), 'entity_hr_admin', { type: 'entity', values: [ent.de!] });
    expect(
      (
        await api('GET', `/v1/compliance/matrix?asOf=2026-10-18&requirementId=${forklift}`, undefined, deHr)
      ).json().total,
    ).toBe(0);
    expect(
      (
        await api(
          'POST',
          '/v1/compliance/records',
          { requirementId: forklift, employeeId: people.missing, issuedOn: '2026-10-01' },
          deHr,
        )
      ).statusCode,
    ).toBe(403);
    const emp = await login(people.missing!, 'employee');
    expect(
      (await api('POST', '/v1/compliance/requirements', { kind: 'other', name: 'Nope' }, emp)).statusCode,
    ).toBe(403);
  });

  it('daily job: expiry reminders to HR and the employee at each offset, once; missing items become HR tasks once', async () => {
    const own = await login(people.expiring!, 'employee');
    void own;
    const first = await daily('2026-10-01'); // 30 days before 2026-10-31
    expect(first.matrix).toBeGreaterThan(0);
    const rec = await tx((t) =>
      t.one<{ id: string }>(`SELECT id FROM app.compliance_records WHERE employee_id = $1`, [
        people.expiring,
      ]),
    );
    const sent = await notifications(`matrix:${rec.id}:30`);
    const user = await tx((t) =>
      t.one<{ id: string }>('SELECT id FROM app.users WHERE employee_id = $1', [people.expiring]),
    );
    expect(sent.some((s) => s.user_id === user.id)).toBe(true);
    expect((await daily('2026-10-01')).matrix).toBe(0);
    const missingTasks = await tx((t) =>
      t.query(`SELECT 1 FROM app.tasks WHERE dedupe_key = $1`, [
        `matrix-missing:${forklift}:${people.missing}`,
      ]),
    );
    expect(missingTasks).toHaveLength(1);
    // renewing closes the task and the status becomes compliant
    expect(
      (
        await api('POST', '/v1/compliance/records', {
          requirementId: forklift,
          employeeId: people.expiring,
          issuedOn: '2026-10-20',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await tx((t) =>
          t.one<{ status: string }>(`SELECT status FROM app.tasks WHERE dedupe_key = $1`, [
            `matrix:${rec.id}:task`,
          ]),
        )
      ).status,
    ).toBe('done');
    const after = (
      await api(
        'GET',
        `/v1/compliance/matrix?asOf=2026-10-21&requirementId=${forklift}&employeeId=${people.expiring}`,
      )
    ).json();
    expect(after.rows[0]).toMatchObject({ status: 'compliant', expiresOn: '2027-10-19' });
  });
});

describe('dashboard and settings', () => {
  it('summarises every area on an explicit date and keeps settings audited', async () => {
    const d = await api('GET', '/v1/compliance/dashboard?asOf=2026-10-18');
    expect(d.statusCode, d.body).toBe(200);
    const b = d.json();
    expect(b.rightToWork.total).toBeGreaterThan(0);
    expect(b.i9.total).toBeGreaterThan(0);
    expect(b.reporting.genderPayGap).toMatchObject({
      threshold: 250,
      required: false,
      snapshotDate: '2026-04-05',
    });
    expect(b.reporting.eeo1).toMatchObject({ threshold: 100, required: false });
    expect(b.reporting.payTransparency[0]).toMatchObject({ country: 'DE', status: 'not_transposed' });
    const s = await api('PUT', '/v1/settings/compliance', { smallCellThreshold: 10 });
    expect(s.json().smallCellThreshold).toBe(10);
    expect(await auditCount('settings.compliance_updated')).toBe(1);
    await api('PUT', '/v1/settings/compliance', { smallCellThreshold: 5 });
  });
});

describe('5.5 law-changes feed', () => {
  let staff: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const editor = await staffSession(ctx, 'rules_editor');
    staff = editor.cookie;
    const entry = (jurisdiction: string, title: string, refs: unknown[] = []) => ({
      jurisdiction,
      effectiveDate: '2027-01-01',
      title: { 'en-GB': title },
      summary: { 'en-GB': `Fictional summary for ${title}` },
      whatToDo: { 'en-GB': 'Review your policies.' },
      packRuleRefs: refs,
    });
    // publishing needs an approved, time-boxed elevation (plan 2.2.3); a draft does not
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/v1/backoffice/law-changes',
      headers: { cookie: staff },
      payload: entry('GB', 'blocked'),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ reason: 'elevationRequired', scope: 'rules_publish' });
    await elevate(ctx, editor, 'rules_publish');
    const post = async (key: string, body: unknown) => {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/v1/backoffice/law-changes',
        headers: { cookie: staff },
        payload: body as object,
      });
      expect(r.statusCode, r.body).toBe(201);
      ids[key] = r.json().id;
    };
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/backoffice/law-changes',
          headers: { cookie: staff },
          payload: entry('GB', 'bad ref', [
            {
              jurisdiction: 'GB',
              key: 'employment.unfair_dismissal_qualifying_period',
              effectiveFrom: '2030-01-01',
            },
          ]),
        })
      ).statusCode,
    ).toBe(400);
    await post(
      'gb',
      entry('GB', 'Unfair dismissal qualifying period becomes six months', [
        {
          jurisdiction: 'GB',
          key: 'employment.unfair_dismissal_qualifying_period',
          effectiveFrom: '2027-01-01',
        },
      ]),
    );
    await post('eu', entry('EU', 'Pay transparency reporting starts'));
    await post('usca', entry('US-CA', 'California exempt salary update'));
    await post('fr', entry('FR', 'Not relevant to this tenant'));
    await post('nir', entry('GB-NIR', 'Northern Ireland only'));
  });

  it('customers see only entries for jurisdictions where they have entities, locations or employees (and parents such as EU)', async () => {
    const r = await api('GET', '/v1/compliance/law-changes');
    expect(r.statusCode, r.body).toBe(200);
    const got = (r.json().items as Array<{ id: string }>).map((i) => i.id);
    expect(got).toEqual(expect.arrayContaining([ids.gb, ids.eu, ids.usca]));
    expect(got).not.toContain(ids.fr);
    expect(got).not.toContain(ids.nir);
    const gb = (
      r.json().items as Array<{ id: string; ruleVersions: Array<{ key: string; source: { url: string } }> }>
    ).find((i) => i.id === ids.gb)!;
    expect(gb.ruleVersions[0]).toMatchObject({ key: 'employment.unfair_dismissal_qualifying_period' });
    expect(gb.ruleVersions[0]!.source.url).toMatch(/legislation\.gov\.uk/);
  });

  it('read and acknowledged state per admin, audited; other tenants and managers see nothing', async () => {
    expect((await api('POST', `/v1/compliance/law-changes/${ids.fr}/acknowledge`)).statusCode).toBe(404);
    const read = await api('POST', `/v1/compliance/law-changes/${ids.gb}/read`);
    expect(read.json()).toMatchObject({ acknowledgedAt: null });
    const ack = await api('POST', `/v1/compliance/law-changes/${ids.gb}/acknowledge`);
    expect(ack.statusCode).toBe(200);
    expect(ack.json().acknowledgedAt).not.toBeNull();
    expect(await auditCount('law_change.acknowledged')).toBe(1);
    const item = (
      (await api('GET', '/v1/compliance/law-changes')).json().items as Array<{
        id: string;
        acknowledgedAt: string | null;
        acknowledgements: unknown[];
      }>
    ).find((i) => i.id === ids.gb)!;
    expect(item.acknowledgedAt).not.toBeNull();
    expect(item.acknowledgements).toHaveLength(1);
    expect(
      (
        (await api('GET', '/v1/compliance/law-changes?unacknowledgedOnly=true')).json().items as Array<{
          id: string;
        }>
      ).map((i) => i.id),
    ).not.toContain(ids.gb);
    const other = await ownerSession(ctx);
    const theirs = await ctx.app.inject({
      method: 'GET',
      url: '/v1/compliance/law-changes',
      headers: { cookie: other.cookie },
    });
    expect(theirs.json().items).toEqual([]); // no entities yet: nothing relevant
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/compliance/law-changes/${ids.gb}/acknowledge`,
          headers: { cookie: other.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const mgr = await login(await hire(ent.gb!), 'manager', { type: 'own_team' });
    expect((await api('GET', '/v1/compliance/law-changes', undefined, mgr)).statusCode).toBe(403);
  });

  it('withdrawn entries disappear; new relevant entries notify HR once from the daily job', async () => {
    const before = (await daily('2026-10-18')).lawChanges;
    expect(before).toBeGreaterThan(0);
    expect((await daily('2026-10-19')).lawChanges).toBe(0);
    expect(
      (
        await ctx.app.inject({
          method: 'PATCH',
          url: `/v1/backoffice/law-changes/${ids.usca}`,
          headers: { cookie: staff },
          payload: { status: 'withdrawn' },
        })
      ).json().status,
    ).toBe('withdrawn');
    expect(
      ((await api('GET', '/v1/compliance/law-changes')).json().items as Array<{ id: string }>).map(
        (i) => i.id,
      ),
    ).not.toContain(ids.usca);
  });
});
