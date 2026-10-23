import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { privacyCompany, type PrivacyCompany } from './privacy-fixtures';

/** The retention tests run on a fixed date so that they never depend on today's date. */
const TODAY = '2027-06-01';
let ctx: TestContext;
let c: PrivacyCompany;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  ctx.clock.now = new Date(`${TODAY}T08:00:00Z`); // before sign-up, so sessions are valid on this date
  c = await privacyCompany(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const clockIn = (emp: string, at: string, id: string, co = c) =>
  co.tx((t) =>
    t.exec(
      `INSERT INTO app.clock_events (tenant_id, employee_id, kind, occurred_at, zone, source, client_event_id) VALUES (app.current_tenant(), $1, 'in', $2, 'Europe/London', 'pwa', $3)`,
      [emp, at, id],
    ),
  );
const clockCount = (emp: string, co = c) =>
  co.tx((t) =>
    t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.clock_events WHERE employee_id = $1`, [emp]),
  );

describe('retention rules', () => {
  it('lists pack rules per category and jurisdiction with sources, marked for legal review', async () => {
    await c.hire('sf');
    const r = (await c.api('GET', '/v1/privacy/retention')).json();
    expect(r.jurisdictions).toEqual(expect.arrayContaining(['GB', 'US-CA']));
    const time = r.categories.find((x: { category: string }) => x.category === 'time_records');
    const gb = time.rules.find((x: { jurisdiction: string }) => x.jurisdiction === 'GB');
    expect(gb).toMatchObject({
      key: 'retention.time_records',
      period: 'P2Y',
      statutoryMinimum: true,
      legalReview: 'pending',
    });
    expect(gb.rule.source.url).toBe('https://www.legislation.gov.uk/uksi/1998/1833/regulation/9');
    const personnel = r.categories.find((x: { category: string }) => x.category === 'personnel_records');
    expect(personnel.rules.find((x: { jurisdiction: string }) => x.jurisdiction === 'GB')).toMatchObject({
      statutoryMinimum: false,
      period: 'P6Y',
    });
    expect(
      personnel.rules.find((x: { jurisdiction: string }) => x.jurisdiction === 'US-CA').rule.source.url,
    ).toMatch(/ecfr\.gov/);
  });

  it('rejects tenant periods below a statutory minimum but accepts longer ones and periods for suggested defaults', async () => {
    const short = await c.api('PUT', '/v1/privacy/retention/policies', {
      category: 'time_records',
      jurisdiction: 'GB',
      period: 'P1Y',
      enabled: true,
    });
    expect(short.statusCode).toBe(422);
    expect(short.json().minimums).toEqual(['GB:retention.time_records:P2Y']);
    const allSites = await c.api('PUT', '/v1/privacy/retention/policies', {
      category: 'time_records',
      period: 'P18M',
      enabled: true,
    });
    expect(allSites.statusCode).toBe(422); // '*' is checked against every jurisdiction in use
    expect(
      (
        await c.api('PUT', '/v1/privacy/retention/policies', {
          category: 'personnel_records',
          jurisdiction: 'GB',
          period: 'P2Y',
          anchor: 'employment_end',
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    const ok = await c.api('PUT', '/v1/privacy/retention/policies', {
      category: 'time_records',
      jurisdiction: 'GB',
      period: 'P2Y',
      enabled: false,
    });
    expect(ok.json()).toMatchObject({
      category: 'time_records',
      jurisdiction: 'GB',
      period: 'P2Y',
      anchor: 'record_date',
      enabled: false,
    });
  });
});

describe('retention runs', () => {
  it('dry run counts what would go, deletes nothing and is logged', async () => {
    const emp = await c.hire('london');
    await clockIn(emp, '2024-01-15T09:00:00Z', 'old-1');
    await clockIn(emp, '2026-05-01T09:00:00Z', 'new-1');
    const lines = (
      await c.api('POST', '/v1/privacy/retention/dry-run', { categories: ['time_records'] })
    ).json();
    const gb = lines.find(
      (l: { jurisdiction: string; category: string }) =>
        l.jurisdiction === 'GB' && l.category === 'time_records',
    );
    expect(gb).toMatchObject({ rows: 1, cutoff: '2024-01-15', action: 'delete' });
    expect((await clockCount(emp)).n).toBe(2);
    const log = (await c.api('GET', '/v1/privacy/retention/runs')).json();
    expect(
      log.some((l: { dryRun: boolean; category: string }) => l.dryRun && l.category === 'time_records'),
    ).toBe(true);
  });

  it('deletes only for enabled categories, honours legal holds and logs the rule version without personal data', async () => {
    const emp = await c.hire('london', { legalFirstName: 'Wilhelmina', legalLastName: 'Retentionova' });
    const held = await c.hire('london');
    await clockIn(emp, '2024-02-01T09:00:00Z', 'old-2');
    await clockIn(emp, '2026-06-01T09:00:00Z', 'new-2');
    await clockIn(held, '2024-02-01T09:00:00Z', 'held-1');
    await c.runJob('privacy.retention', { date: TODAY, trigger: 'manual' });
    expect((await clockCount(emp)).n).toBe(2); // policy not enabled yet

    await c.api('PUT', '/v1/privacy/retention/policies', {
      category: 'time_records',
      jurisdiction: 'GB',
      period: 'P2Y',
      enabled: true,
    });
    await c.api('POST', '/v1/privacy/legal-holds', {
      employeeId: held,
      category: 'time_records',
      reason: 'Fictional working-time dispute',
    });
    expect((await c.api('POST', '/v1/privacy/retention/run')).statusCode).toBe(202);
    const [res] = await c.runQueued('privacy.retention');
    expect(res!.rows).toBeGreaterThanOrEqual(1);
    expect((await clockCount(emp)).n).toBe(1); // the 2026 record stays until 2028
    expect((await clockCount(held)).n).toBe(1); // legal hold
    const runs = await c.tx((t) =>
      t.query<Record<string, unknown>>(
        `SELECT * FROM app.retention_runs WHERE NOT dry_run AND category = 'time_records' AND jurisdiction = 'GB' AND action = 'delete' AND rows_affected > 0`,
      ),
    );
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.rule_versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'retention.time_records',
          sourceUrl: 'https://www.legislation.gov.uk/uksi/1998/1833/regulation/9',
          packVersion: expect.any(Number),
        }),
      ]),
    );
    const text = JSON.stringify(runs);
    for (const pii of ['Wilhelmina', 'Retentionova', emp, held]) expect(text).not.toContain(pii);
  });

  it('anonymises leavers once the personnel-records period has passed (tenant period over a suggested default)', async () => {
    const leaver = await c.hire('london', { startDate: '2015-01-05', legalLastName: 'Longgone' });
    const recent = await c.hire('london', { startDate: '2019-01-07', legalLastName: 'Recentleaver' });
    await c.tx(async (t) => {
      await t.exec(`UPDATE app.employees SET end_date = '2020-01-31' WHERE id = $1`, [leaver]);
      await t.exec(`UPDATE app.employees SET end_date = '2026-01-30' WHERE id = $1`, [recent]);
      await t.query('SELECT app.refresh_employee_current(NULL, $1)', [TODAY]);
    });
    await c.api('PUT', '/v1/privacy/retention/policies', {
      category: 'personnel_records',
      jurisdiction: 'GB',
      period: 'P6Y',
      anchor: 'employment_end',
      enabled: true,
    });
    const dry = (
      await c.api('POST', '/v1/privacy/retention/dry-run', { categories: ['personnel_records'] })
    ).json();
    expect(dry.find((l: { jurisdiction: string }) => l.jurisdiction === 'GB')).toMatchObject({
      action: 'anonymise',
      rows: 1,
    });
    await c.runJob('privacy.retention', { date: TODAY, trigger: 'schedule' }, null);
    const rows = await c.tx((t) =>
      t.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM app.employees WHERE id = ANY($1::uuid[])`,
        [[leaver, recent]],
      ),
    );
    expect(rows.find((r) => r.id === leaver)!.display_name).toBe('Erased person');
    expect(rows.find((r) => r.id === recent)!.display_name).toMatch(/Recentleaver/);
  });
});

describe('automatic retention (worker schedule)', () => {
  it('queues no scheduled run until a policy is enabled, then exactly one per UTC date, which applies the policy', async () => {
    const s = await privacyCompany(ctx); // a fresh tenant that has never enabled a policy
    const emp = await s.hire('london');
    await clockIn(emp, '2024-01-15T09:00:00Z', 'sched-old', s);
    await clockIn(emp, '2027-05-03T09:00:00Z', 'sched-new', s);

    await s.runPeriodic(`${TODAY}T02:00:00Z`);
    expect(await s.jobsOf('privacy.retention')).toEqual([]); // no policy at all
    expect(
      (
        await s.api('PUT', '/v1/privacy/retention/policies', {
          category: 'time_records',
          jurisdiction: 'GB',
          period: 'P2Y',
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    await s.runPeriodic(`${TODAY}T03:00:00Z`);
    expect(await s.jobsOf('privacy.retention')).toEqual([]); // a saved policy that is not enabled
    expect((await clockCount(emp, s)).n).toBe(2);

    expect(
      (
        await s.api('PUT', '/v1/privacy/retention/policies', {
          category: 'time_records',
          jurisdiction: 'GB',
          period: 'P2Y',
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    await s.runPeriodic(`${TODAY}T04:00:00Z`);
    await s.runPeriodic(`${TODAY}T23:59:00Z`); // later sweeps on the same UTC date add nothing
    const queued = await s.jobsOf('privacy.retention');
    expect(queued).toEqual([
      expect.objectContaining({
        idempotency_key: `schedule:${TODAY}`,
        input: { trigger: 'schedule', date: TODAY },
        status: 'queued',
        created_by: null,
      }),
    ]);

    expect(await s.runQueued('privacy.retention')).toEqual([
      expect.objectContaining({ date: TODAY, rows: 1 }),
    ]);
    expect((await clockCount(emp, s)).n).toBe(1); // the 2024 record is past the two-year period; the 2027 one stays
    const runs = await s.tx((t) =>
      t.query<{ trigger: string; job_id: string }>(
        `SELECT trigger, job_id FROM app.retention_runs WHERE NOT dry_run AND category = 'time_records' AND jurisdiction = 'GB'`,
      ),
    );
    expect(runs).toEqual([{ trigger: 'schedule', job_id: queued[0]!.id }]);

    await s.runPeriodic(`${TODAY}T12:00:00Z`); // a finished run is not repeated on the same date
    await s.runPeriodic('2027-06-02T00:05:00Z');
    expect((await s.jobsOf('privacy.retention')).map((j) => [j.idempotency_key, j.status])).toEqual([
      [`schedule:${TODAY}`, 'succeeded'],
      ['schedule:2027-06-02', 'queued'],
    ]);
  });
});
