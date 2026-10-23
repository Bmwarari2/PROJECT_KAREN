import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '@thapsus/core/time';
import { rules } from '@thapsus/rules';
import { passwordProblems } from '../src/modules/auth/password-policy';
import {
  FULL_SIZE,
  LOGIN_ROLES,
  MIN_SIZE,
  StagingConfigError,
  assertSeedAllowed,
  defaultEmail,
  stagingConfigFromEnv,
} from '../src/cli/staging/config';
import {
  buildPlan,
  currentJob,
  employedOn,
  minimumWageMinor,
  ruleAtOrFirst,
  type PlanPerson,
} from '../src/cli/staging/plan';

/** Unit tests for the staging seed: the STAGING_LOGINS contract and the invariants of the company plan. */
const ANCHOR = '2026-10-23';
const logins = (over: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({
    workspace: 'kestrel',
    logins: LOGIN_ROLES.map((role, i) => ({
      role,
      email: `${role.replace('_', '.')}@staging.example.test`,
      password: `Quill-Harbour-Lantern-${i}-qz7`,
    })),
    ...over,
  });

describe('STAGING_LOGINS contract', () => {
  it('refuses to run in production whatever else is set', () => {
    expect(() => assertSeedAllowed({ APP_ENV: 'prod' })).toThrow(StagingConfigError);
    expect(() => stagingConfigFromEnv({ APP_ENV: 'prod', STAGING_LOGINS: logins() })).toThrow(/APP_ENV=prod/);
  });

  it('refuses a cell other than the UK (the workspace is homed in the UK)', () => {
    expect(() =>
      stagingConfigFromEnv({ APP_ENV: 'staging', CELL_REGION: 'eu', STAGING_LOGINS: logins() }),
    ).toThrow(/UK cell/);
  });

  it('requires STAGING_LOGINS outside local development and never generates passwords there', () => {
    for (const APP_ENV of ['staging', 'loadtest'])
      expect(() => stagingConfigFromEnv({ APP_ENV })).toThrow(/STAGING_LOGINS is required/);
  });

  it('uses the given emails and passwords exactly (emails case-folded), one per role, in role order', () => {
    const raw = JSON.parse(logins()) as { logins: Array<{ role: string; email: string }> };
    raw.logins.reverse();
    raw.logins[0]!.email = raw.logins[0]!.email.toUpperCase();
    const cfg = stagingConfigFromEnv({ APP_ENV: 'staging', STAGING_LOGINS: JSON.stringify(raw) });
    expect(cfg.generated).toBe(false);
    expect(cfg.workspace).toBe('kestrel');
    expect(cfg.size).toBe(FULL_SIZE);
    expect(cfg.logins.map((l) => l.role)).toEqual([...LOGIN_ROLES]);
    expect(cfg.logins.find((l) => l.role === 'employee')!.email).toBe('employee@staging.example.test');
    expect(cfg.logins.find((l) => l.role === 'owner')!.password).toBe('Quill-Harbour-Lantern-0-qz7');
  });

  it('rejects malformed, incomplete or duplicate logins without echoing any password', () => {
    const bad = [
      'not json',
      JSON.stringify({ logins: {} }),
      JSON.stringify({ workspace: 'Not A Slug!', logins: [] }),
      JSON.stringify({ logins: JSON.parse(logins()).logins.slice(1) }),
      JSON.stringify({ logins: [...JSON.parse(logins()).logins, JSON.parse(logins()).logins[0]] }),
      JSON.stringify({
        logins: JSON.parse(logins()).logins.map((l: { role: string }) => ({
          ...l,
          email: 'same@staging.example.test',
        })),
      }),
      JSON.stringify({
        logins: JSON.parse(logins()).logins.map((l: { role: string }) => ({
          ...l,
          role: l.role === 'manager' ? 'super_admin' : l.role,
        })),
      }),
      JSON.stringify({
        logins: JSON.parse(logins()).logins.map((l: object) => ({ ...l, password: 'short' })),
      }),
      JSON.stringify({
        logins: JSON.parse(logins()).logins.map((l: object) => ({
          ...l,
          password: 'kestrel-is-my-password',
        })),
      }),
    ];
    for (const STAGING_LOGINS of bad) {
      let err: unknown;
      try {
        stagingConfigFromEnv({ APP_ENV: 'staging', STAGING_LOGINS });
      } catch (e) {
        err = e;
      }
      expect(err, STAGING_LOGINS).toBeInstanceOf(StagingConfigError);
      expect((err as Error).message).not.toMatch(/Quill-Harbour-Lantern|short|kestrel-is-my-password/);
    }
  });

  it('defaults to fictional emails and fresh policy-compliant passwords for local development only', () => {
    const a = stagingConfigFromEnv({ APP_ENV: 'dev' });
    const b = stagingConfigFromEnv({});
    expect(a.generated).toBe(true);
    expect(a.logins.map((l) => l.email)).toEqual([
      'owner@kestrel.example.test',
      'hr.admin@kestrel.example.test',
      'payroll@kestrel.example.test',
      'manager@kestrel.example.test',
      'employee@kestrel.example.test',
    ]);
    expect(a.logins.map((l) => l.email)).toEqual(LOGIN_ROLES.map((r) => defaultEmail(r)));
    for (const l of a.logins)
      expect(passwordProblems(l.password, { workspaceSlug: 'kestrel', email: l.email })).toEqual([]);
    expect(new Set([...a.logins, ...b.logins].map((l) => l.password)).size).toBe(10);
  });

  it('bounds the roster size', () => {
    expect(stagingConfigFromEnv({ APP_ENV: 'test', STAGING_SEED_EMPLOYEES: String(MIN_SIZE) }).size).toBe(
      MIN_SIZE,
    );
    expect(() => stagingConfigFromEnv({ APP_ENV: 'test', STAGING_SEED_EMPLOYEES: '10' })).toThrow(
      StagingConfigError,
    );
    expect(() => stagingConfigFromEnv({ APP_ENV: 'test', STAGING_SEED_EMPLOYEES: '1.5' })).toThrow(
      StagingConfigError,
    );
  });
});

describe('staging company plan', () => {
  const book = rules();
  const plan = buildPlan({ book, anchor: ANCHOR });
  const roster = plan.people.filter((p) => p.kind === 'roster');
  const at = (p: PlanPerson) => currentJob(p, ANCHOR);

  it('is deterministic for a seed, size and anchor; who is who never depends on the anchor', () => {
    expect(buildPlan({ book, anchor: ANCHOR })).toEqual(plan);
    // a later run (re-seeding the logins) finds each login's person by the same employee number
    const later = buildPlan({ book, anchor: '2027-02-15' });
    const who = (p: PlanPerson) => [p.number, p.first, p.last, p.team, p.level, p.login, p.kind];
    expect(later.people.map(who)).toEqual(plan.people.map(who));
    expect(later.logins).toEqual(plan.logins);
  });

  it('has about 300 current staff with a UK entity above the gender pay gap threshold, plus leavers and joiners', () => {
    const threshold = book.resolve<{ employeeThreshold: number }>('GB', 'reporting.gender_pay_gap', ANCHOR)
      .value.employeeThreshold;
    expect(roster).toHaveLength(FULL_SIZE);
    const byEntity = (e: string) => roster.filter((p) => p.entity === e).length;
    expect(byEntity('uk')).toBeGreaterThanOrEqual(threshold);
    // and the UK entity was above it on the last snapshot date, so the report is required
    for (const anchor of [ANCHOR, '2027-02-15', '2027-06-30']) {
      const p = buildPlan({ book, anchor });
      const snapshot =
        compareDates(anchor, `${anchor.slice(0, 4)}-04-05`) >= 0
          ? `${anchor.slice(0, 4)}-04-05`
          : `${Number(anchor.slice(0, 4)) - 1}-04-05`;
      expect(
        p.people.filter((x) => x.entity === 'uk' && employedOn(x, snapshot)).length,
        anchor,
      ).toBeGreaterThanOrEqual(threshold + 5);
    }
    expect([byEntity('uk'), byEntity('ie'), byEntity('us')]).toEqual([262, 22, 16]);
    expect(new Set(roster.map((p) => at(p).location))).toEqual(new Set(['LON', 'MAN', 'EDI', 'DUB', 'NYC']));
    const past = plan.people.filter((p) => p.kind === 'past_leaver');
    const upcoming = plan.people.filter((p) => p.kind === 'upcoming_starter');
    expect(past.length).toBeGreaterThanOrEqual(5);
    expect(past.every((p) => compareDates(p.endDate!, ANCHOR) < 0 && p.leaverType)).toBe(true);
    expect(upcoming.length).toBeGreaterThanOrEqual(3);
    expect(upcoming.every((p) => compareDates(p.startDate, ANCHOR) > 0)).toBe(true);
    expect(roster.filter((p) => p.endDate).every((p) => compareDates(p.endDate!, ANCHOR) > 0)).toBe(true);
  });

  it('links each login to the right person: the manager has a team of 6 to 10 and the employee reports to them', () => {
    expect(Object.keys(plan.logins).sort()).toEqual([...LOGIN_ROLES].sort());
    const team = roster.filter((p) => p.managerIdx === plan.logins.manager);
    expect(team.length).toBeGreaterThanOrEqual(6);
    expect(team.length).toBeLessThanOrEqual(10);
    expect(plan.people[plan.logins.employee]!.managerIdx).toBe(plan.logins.manager);
    expect(at(plan.people[plan.logins.owner]!).title).toBe('Chief executive officer');
    expect(at(plan.people[plan.logins.hr_admin]!).title).toBe('Head of people operations');
    expect(at(plan.people[plan.logins.payroll_admin]!).title).toBe('Payroll manager');
    // a smaller roster (CI) keeps the manager's whole team
    const small = buildPlan({ book, anchor: ANCHOR, size: MIN_SIZE });
    expect(small.people.filter((p) => p.kind === 'roster')).toHaveLength(MIN_SIZE);
    expect(
      small.people.filter((p) => p.kind === 'roster' && p.managerIdx === small.logins.manager),
    ).toHaveLength(team.length);
  });

  it('has a single-rooted manager tree whose managers were in post before their reports started', () => {
    const roots = plan.people.filter((p) => p.managerIdx === null);
    expect(roots.map((p) => p.number)).toEqual(['KS0001']);
    for (const p of plan.people) {
      const seen = new Set<number>();
      for (let m = p.managerIdx; m !== null; m = plan.people[m]!.managerIdx) {
        expect(seen.has(m)).toBe(false);
        seen.add(m);
      }
      if (p.managerIdx !== null)
        expect(compareDates(plan.people[p.managerIdx]!.startDate, p.startDate)).toBeLessThanOrEqual(0);
    }
  });

  it('keeps effective-dated job and pay history in order, starting on the first day and ending by the last', () => {
    for (const p of plan.people) {
      expect(p.jobs[0]!.from).toBe(p.startDate);
      expect(p.pay[0]!.from).toBe(p.startDate);
      for (const list of [p.jobs, p.pay])
        for (let i = 1; i < list.length; i++)
          expect(compareDates(list[i - 1]!.from, list[i]!.from)).toBeLessThan(0);
      if (p.endDate) expect(p.pay.every((x) => compareDates(x.from, p.endDate!) <= 0)).toBe(true);
    }
    expect(plan.futureChanges.length).toBe(3);
    expect(plan.futureChanges.every((c) => compareDates(c.effectiveDate, ANCHOR) > 0)).toBe(true);
    expect(roster.filter((p) => p.pay.length > 1 || p.jobs.length > 1).length).toBeGreaterThan(200);
  });

  it('pays everyone in integer minor units of the entity currency, at or above the minimum wage in the packs', () => {
    const exempt = book.resolve<{ standardAnnualEquivalent: { amountMinor: number } }>(
      'US',
      'overtime.exempt_salary_threshold',
      ANCHOR,
    ).value;
    let hourlyChecked = 0;
    for (const p of plan.people) {
      expect(p.currency).toBe({ uk: 'GBP', ie: 'EUR', us: 'USD' }[p.entity]);
      for (const pay of p.pay) {
        expect(Number.isInteger(pay.amountMinor)).toBe(true);
        const j = currentJob(p, pay.from);
        if (p.entity === 'ie') continue; // no statutory minimum wage in the Ireland pack
        const min = minimumWageMinor(book, j.location, pay.from);
        if (pay.frequency === 'hourly') {
          hourlyChecked++;
          expect(pay.amountMinor, `${p.number} ${pay.from}`).toBeGreaterThanOrEqual(min);
        } else {
          const hours = (j.weeklyHours ?? 37.5) * 52;
          expect(pay.amountMinor / hours, `${p.number} ${pay.from}`).toBeGreaterThanOrEqual(min);
        }
      }
      if (p.flsa === 'exempt')
        expect(p.pay.at(-1)!.amountMinor).toBeGreaterThanOrEqual(exempt.standardAnnualEquivalent.amountMinor);
    }
    expect(hourlyChecked).toBeGreaterThan(60);
  });

  it('takes rule values for dates before a pack starts from the first version, never from memory', () => {
    const first = ruleAtOrFirst<{ hourly: { age21Plus: { amountMinor: number } } }>(
      book,
      'GB',
      'minimum_wage.rates',
      '2019-05-13',
    );
    const earliest = book
      .versions('GB', 'minimum_wage.rates')
      .map((v) => v.effectiveFrom)
      .sort()[0];
    expect(first.effectiveFrom).toBe(earliest);
    expect(ruleAtOrFirst(book, 'GB', 'minimum_wage.rates', ANCHOR).effectiveFrom <= ANCHOR).toBe(true);
  });

  it('uses only fictional contact details (reserved phone ranges, .example.test email, non-existent postcodes)', () => {
    const phone =
      /^(\+44 7700 900\d{3}|\+44 20 7946 0\d{3}|\+44 161 496 0\d{3}|\+44 131 496 0\d{3}|\+1 212 555 01\d{2})$/;
    for (const p of plan.people) {
      expect(p.workEmail).toMatch(/@kestrel\.example\.test$/);
      expect(p.personalEmail).toMatch(/@personal\.example\.test$/);
      expect(p.personalPhone).toMatch(phone);
      if (p.workPhone) expect(p.workPhone).toMatch(phone);
      for (const c of p.emergency) expect(c.phone).toMatch(phone);
      expect(p.address.postcode).toMatch(/^(ZZ\d|X\d\d|000)/);
    }
    expect(new Set(plan.people.map((p) => `${p.first} ${p.last}`)).size).toBe(plan.people.length);
  });

  it('places recent joiners and the future-dated changes relative to the anchor', () => {
    const recent = roster.filter((p) => p.recentStarter);
    expect(recent.length).toBeGreaterThanOrEqual(3);
    expect(
      recent.every(
        (p) => compareDates(p.startDate, addDays(ANCHOR, -40)) >= 0 && compareDates(p.startDate, ANCHOR) < 0,
      ),
    ).toBe(true);
    expect(plan.nextMonth).toBe('2026-11-01');
  });
});
