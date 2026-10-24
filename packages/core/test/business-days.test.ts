import { describe, expect, it } from 'vitest';
import { addBusinessDays, businessDayTest } from '../src/time';

/**
 * Business-day arithmetic for task due dates (ADR-0193). Written before the implementation. The calendar
 * (which weekdays are worked, which dates are closed) is always passed in: the weekdays are a workspace
 * setting and the closed dates come from a jurisdiction pack's public holidays, never from this module.
 */
const MON_TO_FRI = [1, 2, 3, 4, 5];

describe('addBusinessDays', () => {
  const weekdays = businessDayTest(MON_TO_FRI);

  it('counts forward over a weekend (Monday + 3 is Thursday, Thursday + 3 is Tuesday)', () => {
    // 2026-10-19 is a Monday
    expect(addBusinessDays('2026-10-19', 3, weekdays)).toBe('2026-10-22');
    expect(addBusinessDays('2026-10-22', 3, weekdays)).toBe('2026-10-27');
    // starting on a Saturday: the first business day after it is Monday
    expect(addBusinessDays('2026-10-24', 1, weekdays)).toBe('2026-10-26');
  });

  it('counts backward the same way', () => {
    expect(addBusinessDays('2026-10-22', -3, weekdays)).toBe('2026-10-19');
    expect(addBusinessDays('2026-10-26', -1, weekdays)).toBe('2026-10-23');
  });

  it('returns the date itself for zero days, whatever day it is', () => {
    expect(addBusinessDays('2026-10-24', 0, weekdays)).toBe('2026-10-24');
  });

  it('skips closed dates such as public holidays', () => {
    const closed = businessDayTest(MON_TO_FRI, ['2026-12-25', '2026-12-28']);
    // Thursday 24 December + 1: Friday 25 and Monday 28 are closed, so Tuesday 29
    expect(addBusinessDays('2026-12-24', 1, closed)).toBe('2026-12-29');
    expect(addBusinessDays('2026-12-29', -1, closed)).toBe('2026-12-24');
  });

  it('follows a workspace whose business week is not Monday to Friday', () => {
    const sunToThu = businessDayTest([7, 1, 2, 3, 4]);
    // Thursday 22 October + 1 is Sunday 25 October
    expect(addBusinessDays('2026-10-22', 1, sunToThu)).toBe('2026-10-25');
  });

  it('refuses a calendar with no business days and non-integer counts', () => {
    expect(() => businessDayTest([])).toThrow(RangeError);
    expect(() => addBusinessDays('2026-10-19', 1.5, weekdays)).toThrow(RangeError);
  });
});
