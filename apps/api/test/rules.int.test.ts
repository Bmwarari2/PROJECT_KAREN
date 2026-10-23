import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';
import { createStaff, STAFF_COOKIE } from '../src/modules/backoffice/auth';
import { invalidateRuleBook } from '../src/modules/rules/routes';

let ctx: TestContext;
let cookie: string;
beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  cookie = (await ownerSession(ctx)).cookie;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const get = (url: string, c = cookie) => ctx.app.inject({ method: 'GET', url, headers: { cookie: c } });

async function staffSession(role: 'rules_editor' | 'support') {
  const email = `${role}.${Math.random().toString(36).slice(2, 6)}@thapsus.example.test`;
  const s = await createStaff(ctx.app, email, 'Fictional Staff', role);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/backoffice/auth/login',
    payload: { email, password: s.password },
  });
  const c = `${STAFF_COOKIE}=${String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]}`;
  return { cookie: c, secret: s.totpSecret };
}

describe('rule lookups for tenants', () => {
  it('resolves layered, effective-dated rules with their official source', async () => {
    const r = (await get('/v1/rules/US-TX/overtime.weekly?date=2026-06-01')).json();
    expect(r).toMatchObject({ jurisdiction: 'US', key: 'overtime.weekly' });
    expect(r.source.url).toMatch(/dol\.gov/);
    expect(
      (await get('/v1/rules/GB/employment.unfair_dismissal_qualifying_period?date=2027-01-01')).json()
        .effectiveFrom,
    ).toBe('2027-01-01');
    expect((await get('/v1/rules/US-TX/overtime.daily')).statusCode).toBe(404);
    expect((await get('/v1/rules/DE')).json().map((x: { key: string }) => x.key)).toEqual(
      expect.arrayContaining(['leave.statutory_annual_minimum', 'working_time.max_weekly_hours']),
    );
  });

  it('accepts locality codes and walks locality -> state -> federal', async () => {
    const nyc = (await get('/v1/rules/US-NY-NYC/sick_pay.paid_sick_leave_accrual?date=2026-06-01')).json();
    expect(nyc).toMatchObject({ jurisdiction: 'US-NY-NYC', effectiveFrom: '2026-02-22' });
    expect(nyc.source.url).toMatch(/^https:\/\/www\.nyc\.gov\//);
    expect((await get('/v1/rules/US-NY-NYC/minimum_wage.rates?date=2026-06-01')).json().jurisdiction).toBe(
      'US-NY',
    );
    expect((await get('/v1/rules/US-NY-BUF/minimum_wage.rates?date=2026-06-01')).json().jurisdiction).toBe(
      'US-NY',
    );
    expect(
      (await get('/v1/rules/US-NY-NYC?date=2026-06-01'))
        .json()
        .map((x: { jurisdiction: string }) => x.jurisdiction),
    ).toEqual(expect.arrayContaining(['US-NY-NYC', 'US-NY', 'US']));
    expect((await get('/v1/rules/US-NY-NYCX/minimum_wage.rates')).statusCode).toBe(400);
    expect((await get('/v1/rules/US-NY-NYC-X/minimum_wage.rates')).statusCode).toBe(400);
  });

  it('keeps UK nations apart: Northern Ireland never silently inherits Great Britain law', async () => {
    expect(
      (await get('/v1/rules/GB-SCT/leave.statutory_annual_minimum?date=2026-06-01')).json(),
    ).toMatchObject({ jurisdiction: 'GB', regions: ['GB-ENG', 'GB-WLS', 'GB-SCT'] });
    expect(
      (await get('/v1/rules/GB-WLS/employment.unfair_dismissal_qualifying_period?date=2027-01-01')).json()
        .value.qualifyingPeriod,
    ).toBe('P6M');
    const ni = (
      await get('/v1/rules/GB-NIR/employment.unfair_dismissal_qualifying_period?date=2027-01-01')
    ).json();
    expect(ni).toMatchObject({ jurisdiction: 'GB-NIR', value: { qualifyingPeriod: 'P1Y' } });
    expect((await get('/v1/rules/GB-NIR/minimum_wage.rates?date=2026-06-01')).json().regions).toContain(
      'GB-NIR',
    );
    expect((await get('/v1/rules/GB-NIR/reporting.gender_pay_gap?date=2026-06-01')).statusCode).toBe(404);
    const all = (await get('/v1/rules/GB-NIR?date=2026-06-01')).json() as Array<{
      key: string;
      jurisdiction: string;
    }>;
    expect(all.map((x) => x.key)).not.toContain('reporting.gender_pay_gap');
    expect(all.find((x) => x.key === 'leave.statutory_annual_minimum')?.jurisdiction).toBe('GB-NIR');
  });

  it('returns public holidays for country and region with observed days', async () => {
    const wls = (await get('/v1/holidays?country=GB&region=GB-WLS&year=2026')).json();
    expect(wls.map((h: { observed: string | null; date: string }) => h.observed ?? h.date)).toContain(
      '2026-12-28',
    );
    const sct = (await get('/v1/holidays?country=GB&region=GB-SCT&year=2026')).json();
    expect(sct.map((h: { id: string }) => h.id)).toEqual(expect.arrayContaining(['st-andrews-day']));
    const us2027 = (await get('/v1/holidays?country=US&year=2027')).json();
    const july4 = us2027.find((h: { date: string }) => h.date === '2027-07-04');
    expect(july4.observed).toBe('2027-07-05');
  });
});

describe('back-office rule editing', () => {
  it('requires staff MFA, appends versions (never overwrites) and takes effect for lookups', async () => {
    const editor = await staffSession('rules_editor');
    const add = (c: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/backoffice/rules/GB/minimum_wage.rates/versions',
        headers: { cookie: c },
        payload: {
          effectiveFrom: '2027-04-01',
          value: { ageBands: [{ minAge: 21, hourly: { amountMinor: 1300, currency: 'GBP' } }] },
          source: {
            url: 'https://www.gov.uk/national-minimum-wage-rates',
            title: 'National Minimum Wage rates (fictional future test value)',
          },
          verifiedOn: '2026-10-18',
        },
      });
    expect((await add(editor.cookie)).statusCode).toBe(403); // MFA not yet verified
    const code = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(editor.secret),
      digits: 6,
      period: 30,
    }).generate();
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/backoffice/auth/totp',
          headers: { cookie: editor.cookie },
          payload: { code },
        })
      ).statusCode,
    ).toBe(204);
    expect((await add(editor.cookie)).statusCode).toBe(201);
    invalidateRuleBook();
    const after = (await get('/v1/rules/GB/minimum_wage.rates?date=2027-05-01')).json();
    expect(after.value.ageBands[0].hourly.amountMinor).toBe(1300);
    const before = (await get('/v1/rules/GB/minimum_wage.rates?date=2026-05-01')).json();
    expect(before.value).not.toEqual(after.value);
    const versions = (
      await ctx.app.inject({
        method: 'GET',
        url: '/v1/backoffice/rules/GB/minimum_wage.rates/versions',
        headers: { cookie: editor.cookie },
      })
    ).json();
    expect(versions.filter((v: { origin: string }) => v.origin === 'backoffice')).toHaveLength(1);
    expect(versions.filter((v: { origin: string }) => v.origin === 'pack').length).toBeGreaterThanOrEqual(2);
    // append-only even for the owner role
    const owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await owner.connect();
    try {
      await expect(owner.query(`UPDATE backoffice.rule_versions SET value = '{}'`)).rejects.toThrow(
        /append-only/,
      );
      const audit = await owner.query(
        `SELECT action FROM backoffice.staff_audit WHERE action = 'rules.version_added'`,
      );
      expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }
  });

  it('support staff cannot edit rules and tenants cannot reach back-office routes', async () => {
    const support = await staffSession('support');
    const code = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(support.secret),
      digits: 6,
      period: 30,
    }).generate();
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/backoffice/auth/totp',
      headers: { cookie: support.cookie },
      payload: { code },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/backoffice/rules/GB/minimum_wage.rates/versions',
      headers: { cookie: support.cookie },
      payload: {
        effectiveFrom: '2027-04-01',
        value: {},
        source: { url: 'https://www.gov.uk/x', title: 'x x x' },
        verifiedOn: '2026-10-18',
      },
    });
    expect(res.statusCode).toBe(403);
    expect((await get('/v1/backoffice/rules/GB/minimum_wage.rates/versions')).statusCode).toBe(401);
  });
});
