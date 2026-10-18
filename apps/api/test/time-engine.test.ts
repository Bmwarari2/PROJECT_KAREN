import { describe, expect, it } from 'vitest';
import { rules } from '@thapsus/rules';
import { calculateOvertime, checkWorkingTime, splitByLocalDay, workedMinutes, type WorkingTimeRules } from '../src/modules/time/engine';

/** Golden tests: rule values come from the jurisdiction packs (sources recorded in the pack JSON). */
const book = rules();
const at = '2026-06-01';
const US = book.resolve('US', 'overtime.weekly', at).value as { thresholdHours: number; multiplier: number };
const CA = book.resolve('US-CA', 'overtime.daily', at).value as { tiers: Array<{ afterHours: number; multiplier: number }> };
const CA7 = book.resolve('US-CA', 'overtime.seventh_day', at).value as { tiers: Array<{ afterHours: number; multiplier: number }> };
const CO = book.resolve('US-CO', 'overtime.daily', at).value as { tiers: Array<{ afterHours: number; multiplier: number }> };


describe('worked time across zones and DST', () => {
  it('a night shift is split by local calendar day', () => {
    const parts = splitByLocalDay({ start: '2026-06-05T22:00', end: '2026-06-06T06:00', breakMinutes: 30, zone: 'Europe/London' });
    expect(parts).toEqual([
      { date: '2026-06-05', minutes: 120 },
      { date: '2026-06-06', minutes: 330 }, // break deducted from the longer part
    ]);
  });
  it('a shift over the autumn clock change is an hour longer', () => {
    expect(workedMinutes({ start: '2026-10-24T22:00', end: '2026-10-25T06:00', breakMinutes: 0, zone: 'Europe/London' })).toBe(9 * 60);
    expect(workedMinutes({ start: '2026-03-28T22:00', end: '2026-03-29T06:00', breakMinutes: 0, zone: 'Europe/London' })).toBe(7 * 60);
  });
});

describe('US overtime (FLSA weekly + state daily rules)', () => {
  const week = (hours: number[], zone = 'America/Los_Angeles') =>
    hours.map((h, i) => {
      const d = nextDayN('2026-06-07', i); // Sunday-start workweek
      const end = `${String(8 + Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
      return { start: `${d}T08:00`, end: `${d}T${end}`, breakMinutes: 0, zone };
    }).filter((_, i) => hours[i]! > 0);
  const nextDayN = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it('federal only: hours over 40 in the workweek at 1.5×', () => {
    const r = calculateOvertime(week([0, 10, 10, 10, 10, 5, 0], 'America/Chicago'), { weekly: US, workweekStartsOn: 7 });
    expect(r).toMatchObject({ regularMinutes: 40 * 60, overtimeMinutes: 5 * 60, doubleMinutes: 0 });
  });
  it('California: daily over 8 at 1.5×, over 12 at 2×, and daily OT is not double counted in weekly OT', () => {
    const r = calculateOvertime(week([0, 13, 8, 8, 8, 8, 0]), { weekly: US, daily: CA.tiers, workweekStartsOn: 7 });
    // Mon 13h → 8 regular + 4 OT + 1 double; Tue–Fri 32 regular → weekly regular 40, no extra weekly OT
    expect(r).toMatchObject({ regularMinutes: 40 * 60, overtimeMinutes: 4 * 60, doubleMinutes: 60 });
  });
  it('California: seventh consecutive workday — first 8 hours at 1.5×, beyond 8 at 2×', () => {
    const r = calculateOvertime(week([6, 8, 8, 8, 8, 8, 10]), { weekly: US, daily: CA.tiers, seventhDay: CA7.tiers, workweekStartsOn: 7 });
    expect(r.doubleMinutes).toBe(2 * 60);
    expect(r.overtimeMinutes).toBe(8 * 60 + 6 * 60); // 8h day-7 + weekly overflow (46 regular-eligible → 6h)
  });
  it('Colorado: daily over 12 hours', () => {
    const r = calculateOvertime(week([0, 14, 8, 8, 0, 0, 0], 'America/Denver'), { weekly: US, daily: CO.tiers, workweekStartsOn: 7 });
    expect(r).toMatchObject({ regularMinutes: 28 * 60, overtimeMinutes: 2 * 60 });
  });
});

describe('UK and EU working-time limits (GB and EU packs)', () => {
  const gb: WorkingTimeRules = {
    maxWeekly: book.resolve('GB', 'working_time.max_weekly_hours', at).value as never,
    dailyRest: book.resolve('GB', 'working_time.daily_rest', at).value as never,
    weeklyRest: book.resolve('GB', 'working_time.weekly_rest', at).value as never,
    restBreak: book.resolve('GB', 'working_time.rest_break', at).value as never,
  };
  const eu: WorkingTimeRules = {
    maxWeekly: book.resolve('DE', 'working_time.max_weekly_hours', at).value as never,
    dailyRest: book.resolve('DE', 'working_time.daily_rest', at).value as never,
    weeklyRest: book.resolve('DE', 'working_time.weekly_rest', at).value as never,
    restBreak: book.resolve('DE', 'working_time.rest_break', at).value as never,
    timeRecording: book.resolve('DE', 'working_time.time_recording', at).value as never,
  };
  const days = (n: number, hours: number, from = '2026-01-05') =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      return { start: `${d}T07:00`, end: `${d}T${String(7 + hours).padStart(2, '0')}:00`, breakMinutes: 30, zone: 'Europe/London' };
    });

  it('less than 11 hours rest between shifts is flagged (GB adult and EU)', () => {
    const shifts = [
      { start: '2026-02-02T14:00', end: '2026-02-02T23:00', breakMinutes: 30, zone: 'Europe/London' },
      { start: '2026-02-03T07:00', end: '2026-02-03T15:00', breakMinutes: 30, zone: 'Europe/London' },
    ];
    expect(checkWorkingTime(shifts, gb, { asOf: '2026-02-03' }).map((v) => v.rule)).toContain('working_time.daily_rest');
    expect(checkWorkingTime(shifts, eu, { asOf: '2026-02-03' }).map((v) => v.rule)).toContain('working_time.daily_rest');
  });
  it('no 24-hour weekly rest in a 7-day period is flagged', () => {
    expect(checkWorkingTime(days(8, 8), gb, { asOf: '2026-01-12' }).map((v) => v.rule)).toContain('working_time.weekly_rest');
  });
  it('a 7-hour day without a 20-minute break is flagged (GB)', () => {
    const v = checkWorkingTime([{ start: '2026-02-02T09:00', end: '2026-02-02T16:00', breakMinutes: 10, zone: 'Europe/London' }], gb, { asOf: '2026-02-02' });
    expect(v.map((x) => x.rule)).toEqual(['working_time.rest_break']);
  });
  it('average over 48 hours across the 17-week reference period is flagged unless the worker opted out (GB)', () => {
    // 6 × 9.5h days a week = 57h − breaks for 17 weeks
    const shifts = Array.from({ length: 17 * 7 }, (_, i) => i).filter((i) => i % 7 !== 6).map((i) => {
      const d = new Date(Date.parse('2026-01-05T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      return { start: `${d}T07:00`, end: `${d}T17:00`, breakMinutes: 30, zone: 'Europe/London' };
    });
    const asOf = '2026-05-03';
    expect(checkWorkingTime(shifts, gb, { asOf }).map((v) => v.rule)).toContain('working_time.max_weekly_hours');
    expect(checkWorkingTime(shifts, gb, { asOf, optedOut: true }).map((v) => v.rule)).not.toContain('working_time.max_weekly_hours');
    // EU: no individual opt-out in the baseline, average over up to 4 months
    expect(checkWorkingTime(shifts, eu, { asOf, optedOut: true }).map((v) => v.rule)).toContain('working_time.max_weekly_hours');
  });
  it('a compliant week has no violations', () => {
    expect(checkWorkingTime(days(5, 8), gb, { asOf: '2026-01-09' })).toEqual([]);
  });
  it('daily time recording is required where the pack says so (EU/DE)', () => {
    expect(eu.timeRecording?.required).toBe(true);
    expect(gb.timeRecording).toBeUndefined();
  });
});
