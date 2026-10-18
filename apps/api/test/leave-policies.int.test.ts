import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rules } from '@thapsus/rules';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { leaveFixtures } from './leave-fixtures';

/**
 * Leave policies through the API (phase 3.1): per entity / country, mid-year changes, per-hour-worked
 * accrual from recorded hours, carry-over, waiting periods, TOIL, unpaid and family leave, cover
 * warnings and request audit rows. Dates are fixed past/future civil dates passed as `asOf`.
 */
let ctx: TestContext;
let f: Awaited<ReturnType<typeof leaveFixtures>>;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  f = await leaveFixtures(ctx);
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('policies per entity and country', () => {
  it('an entity-scoped and a country-scoped policy apply only to their own employees', async () => {
    const entityA = await f.entity({ name: 'Fictional Entity A Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });
    const entityB = await f.entity({ name: 'Fictional Entity B Ltd', country: 'GB', regionCode: 'GB-ENG', currency: 'GBP', timeZone: 'Europe/London' });
    const ireland = await f.entity({ name: 'Fictional Teoranta', country: 'IE', currency: 'EUR', timeZone: 'Europe/Dublin' });
    const config = { accrual: { method: 'annual_upfront', days: 30 }, unit: 'days', yearStart: '01-01', proRata: true, includesPublicHolidays: false, waitingDays: 0, allowNegativeDays: 0, rounding: 'none' };
    await f.created('POST', '/v1/leave/policies', { name: 'Entity A annual leave', leaveTypeId: f.types.annual, entityId: entityA, config });
    await f.created('POST', '/v1/leave/policies', { name: 'Ireland annual leave', leaveTypeId: f.types.annual, country: 'IE', config: { ...config, accrual: { method: 'annual_upfront', days: 21 } } });
    const a = await f.hire({ entityId: entityA });
    const b = await f.hire({ entityId: entityB });
    const ie = await f.hire({ entityId: ireland, payCurrency: 'EUR' });
    expect(await f.balance(a, '2026-06-01')).toMatchObject({ policy: 'Entity A annual leave', entitlement: 30 });
    expect((await f.balance(b, '2026-06-01')).policy).toMatch(/^Standard annual leave/);
    expect(await f.balance(ie, '2026-06-01')).toMatchObject({ policy: 'Ireland annual leave', entitlement: 21 });
  });
});

describe('mid-year changes', () => {
  it('a policy change mid-year is pro-rated across the assignment periods (and future-dated changes count)', async () => {
    const p20 = await f.policy('Fictional 20-day policy', { accrual: { method: 'annual_upfront', days: 20 } });
    const p30 = await f.policy('Fictional 30-day policy', { accrual: { method: 'annual_upfront', days: 30 } });
    const emp = await f.hire();
    await f.assign(p20, [emp], '2026-01-01');
    await f.assign(p30, [emp], '2026-07-01');
    // 20 × 181/365 + 30 × 184/365 = 25.0411
    expect(await f.balance(emp, '2026-08-01')).toMatchObject({ policy: 'Fictional 30-day policy', entitlement: 25.0411 });
    expect(await f.balance(emp, '2026-03-01')).toMatchObject({ policy: 'Fictional 20-day policy', entitlement: 25.0411 });
  });

  it('a mid-year FTE change is pro-rated per period', async () => {
    const emp = await f.hire();
    expect((await f.api('POST', `/v1/employees/${emp}/changes`, { effectiveDate: '2026-07-01', fte: 0.5, weeklyHours: 18.75 })).statusCode).toBe(200);
    // default UK policy, 28 days: 28 × 181/365 + 14 × 184/365 = 20.94 → rounded up to the half day
    expect((await f.balance(emp, '2026-08-01')).entitlement).toBe(21);
  });
});

describe('per-hour-worked accrual', () => {
  it('accrues from recorded hours worked, in hours, and checks requests in hours', async () => {
    const percent = rules().resolve<{ accrualPercentOfHoursWorked: number }>('GB', 'leave.irregular_hours_accrual', '2026-01-01').value.accrualPercentOfHoursWorked;
    const p = await f.policy('Fictional irregular hours', { unit: 'hours', accrual: { method: 'per_hour_worked', percent } });
    const emp = await f.hire();
    await f.assign(p, [emp], '2026-01-01');
    expect((await f.balance(emp, '2026-03-01')).accrued).toBe(0); // nothing recorded yet
    expect((await f.api('POST', '/v1/leave/worked-hours', { employeeId: emp, startDate: '2026-01-05', endDate: '2026-01-30', hours: 100 })).statusCode).toBe(201);
    expect((await f.api('POST', '/v1/leave/worked-hours', { employeeId: emp, startDate: '2026-01-26', endDate: '2026-02-06', hours: 10 })).statusCode).toBe(409);
    expect((await f.api('GET', `/v1/leave/worked-hours/${emp}?from=2026-01-05&to=2026-01-17`)).json()).toEqual({ hours: 50, source: 'recorded' }); // 13 of 26 days
    expect(await f.balance(emp, '2026-03-01')).toMatchObject({ unit: 'hours', accrued: 12.07, available: 12.07 });
    // Two 7.5-hour days are 15 hours: more than the 12.07 hours available (a days check would wrongly allow it).
    const tooMuch = await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-03-02', endDate: '2026-03-03' });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json()).toMatchObject({ requested: 15, unit: 'hours' });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-03-02', endDate: '2026-03-02' })).json()).toMatchObject({ amountDays: 1, amountHours: 7.5 });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-03-04', endDate: '2026-03-04', hours: 3 })).json()).toMatchObject({ amountDays: 0.4, amountHours: 3 });
    expect(await f.balance(emp, '2026-03-01')).toMatchObject({ pending: 10.5, available: 1.57 });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-03-05', endDate: '2026-03-06', hours: 2 })).statusCode).toBe(400);
  });
});

describe('carry-over, waiting periods, TOIL', () => {
  it('carries over unused days from the previous leave year, capped, and expires them', async () => {
    const p = await f.policy('Fictional carry-over policy', { accrual: { method: 'annual_upfront', days: 10 }, proRata: false, carryOver: { maxDays: 5, expiresAfterMonths: 3 } });
    const emp = await f.hire({ startDate: '2024-06-03' });
    await f.assign(p, [emp], '2025-01-01');
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2025-03-03', endDate: '2025-03-05' })).statusCode).toBe(201);
    expect((await f.balance(emp, '2025-12-31')).available).toBe(7);
    expect(await f.balance(emp, '2026-02-01')).toMatchObject({ entitlement: 10, carriedOver: 5, available: 15 });
    expect(await f.balance(emp, '2026-04-01')).toMatchObject({ carriedOver: 0, carryOverExpired: 5, available: 10 });
  });

  it('refuses leave in the waiting period with 422', async () => {
    const p = await f.policy('Fictional 90-day waiting period', { accrual: { method: 'annual_upfront', days: 25 }, waitingDays: 90 });
    const emp = await f.hire({ startDate: '2026-09-07' });
    await f.assign(p, [emp], '2026-01-01');
    const early = await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-10-05', endDate: '2026-10-05' });
    expect(early.statusCode).toBe(422);
    expect(early.json().detail).toBe('Still in the waiting period');
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-12-14', endDate: '2026-12-14' })).statusCode).toBe(201);
  });

  it('TOIL is earned by adjustment and taken by request', async () => {
    const emp = await f.hire();
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.toil, startDate: '2026-05-11', endDate: '2026-05-11' })).statusCode).toBe(422);
    await f.created('POST', '/v1/leave/adjustments', { employeeId: emp, leaveTypeId: f.types.toil, amount: 1, effectiveDate: '2026-05-01', kind: 'toil', reason: 'Fictional weekend cover' });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.toil, startDate: '2026-05-11', endDate: '2026-05-11' })).statusCode).toBe(201);
    expect(await f.balance(emp, '2026-05-04', 'toil')).toMatchObject({ adjustments: 1, pending: 1, available: 0 });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.toil, startDate: '2026-05-12', endDate: '2026-05-12' })).statusCode).toBe(422);
  });
});

describe('unpaid and family leave', () => {
  it('lists the leave types with paid and balance flags', async () => {
    const list = (await f.api('GET', '/v1/leave/types')).json() as Array<{ key: string; category: string; paid: boolean; deductsBalance: boolean }>;
    expect(list.find((t) => t.key === 'unpaid')).toMatchObject({ category: 'unpaid', paid: false, deductsBalance: false });
    expect(list.find((t) => t.key === 'family')).toMatchObject({ category: 'family', paid: true, deductsBalance: false });
    expect(list.find((t) => t.key === 'toil')).toMatchObject({ category: 'toil', deductsBalance: true });
    expect(list.map((t) => t.key)).toEqual(expect.arrayContaining(['annual', 'sickness', 'unpaid', 'family', 'toil']));
  });

  it('unpaid leave does not touch the annual balance and has no balance of its own', async () => {
    const emp = await f.hire();
    const before = await f.balance(emp, '2026-06-01');
    const r = await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.unpaid, startDate: '2026-06-15', endDate: '2026-06-19' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().amountDays).toBe(5);
    expect(await f.balance(emp, '2026-06-01')).toEqual(before);
    expect(((await f.api('GET', `/v1/leave/balances/${emp}?asOf=2026-06-01`)).json() as Array<{ leaveType: string }>).map((b) => b.leaveType)).not.toContain('unpaid');
  });

  it('family leave requests are audited as sensitive; statutory entitlements come from the GB pack', async () => {
    const emp = await f.hire({ startDate: '2026-09-07' });
    const r = await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.family, startDate: '2026-11-02', endDate: '2026-11-13' });
    expect(r.statusCode, r.body).toBe(201);
    expect((await f.auditRows('leave.requested', r.json().id))[0]).toMatchObject({ sensitive: true });
    const info = (await f.api('GET', `/v1/leave/family-entitlements/${emp}?asOf=2026-10-18`)).json() as { jurisdiction: string; entitlements: Array<{ kind: string; leaveWeeks: number; detail: Record<string, unknown>; source: { url: string } }> };
    expect(info.jurisdiction).toBe('GB');
    const maternity = info.entitlements.find((e) => e.kind === 'maternity')!;
    const paternity = info.entitlements.find((e) => e.kind === 'paternity')!;
    expect(maternity).toMatchObject({ leaveWeeks: 52, detail: { payWeeks: 39, meetsLeaveService: true, meetsPayService: false } });
    expect(paternity).toMatchObject({ leaveWeeks: 2, detail: { leaveServiceWeeksRequired: 0, meetsLeaveService: true } });
    for (const e of info.entitlements) expect(e.source.url).toMatch(/^https:\/\/(www\.)?(gov\.uk|legislation\.gov\.uk)\//);
  });
});

describe('requests: cover warnings and audit', () => {
  it('a warn cover rule lets the request through with warnings', async () => {
    const dept = (await f.created('POST', '/v1/org/departments', { name: 'Fictional warn team' })).id as string;
    const a = await f.hire({ departmentId: dept });
    const b = await f.hire({ departmentId: dept });
    await f.created('POST', '/v1/leave/cover-rules', { name: 'Prefer two in', departmentId: dept, minPresent: 1, enforcement: 'warn' });
    expect((await f.api('POST', '/v1/leave/requests', { employeeId: a, leaveTypeId: f.types.annual, startDate: '2026-11-16', endDate: '2026-11-16' })).json().warnings).toEqual([]);
    const warned = await f.api('POST', '/v1/leave/requests', { employeeId: b, leaveTypeId: f.types.annual, startDate: '2026-11-16', endDate: '2026-11-16' });
    expect(warned.statusCode).toBe(201);
    expect(warned.json().warnings).toEqual([{ rule: 'Prefer two in', date: '2026-11-16', present: 0, min: 1, enforcement: 'warn' }]);
  });

  it('writes leave.requested and leave.cancelled audit rows', async () => {
    const emp = await f.hire();
    const r = (await f.api('POST', '/v1/leave/requests', { employeeId: emp, leaveTypeId: f.types.annual, startDate: '2026-12-07', endDate: '2026-12-08' })).json();
    const requested = await f.auditRows('leave.requested', r.id);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ sensitive: false, diff: { employeeId: emp, type: 'annual', days: 2 } });
    expect((await f.api('POST', `/v1/leave/requests/${r.id}/cancel`)).json().status).toBe('cancelled');
    expect(await f.auditRows('leave.cancelled', r.id)).toEqual([expect.objectContaining({ action: 'leave.cancelled', diff: { previousStatus: 'pending' } })]);
  });
});
