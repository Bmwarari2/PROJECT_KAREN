import { describe, expect, it } from 'vitest';
import { RuleBook } from '@thapsus/rules';
import { dueDateFor, type DuePerson } from '../src/modules/tasks/due';

/**
 * Task due dates (ADR-0193), written before the implementation. A due rule counts calendar or business
 * days from the workflow's own date or one of the person's own dates; a pack deadline (Form I-9 Section 2)
 * comes from the US pack, never from a number in the template. The business calendar is the workspace's
 * business weekdays without the pack's public holidays for the person's jurisdiction. Fictional people.
 */
const book = RuleBook.fromDirectory();
const MON_TO_FRI = [1, 2, 3, 4, 5];
const uk: DuePerson = {
  startDate: '2026-12-21',
  endDate: null,
  probationEndDate: '2027-06-21',
  country: 'GB',
  regionCode: 'GB-ENG',
};
const us: DuePerson = { ...uk, startDate: '2026-11-23', country: 'US', regionCode: 'US-NY' };
const at = (person: DuePerson | null, anchorDate: string | null = person?.startDate ?? null) => ({
  person,
  anchorDate,
  book,
  businessWeekdays: MON_TO_FRI,
});

describe('due dates from a due rule', () => {
  it('keeps the old meaning of dueOffsetDays: calendar days from the workflow date', () => {
    expect(dueDateFor({ anchor: 'anchor', offsetDays: -7 }, at(uk))).toBe('2026-12-14');
    expect(dueDateFor({ anchor: 'anchor', offsetDays: 3 }, at(uk, '2026-10-19'))).toBe('2026-10-22');
  });

  it('follows the person’s own dates: start, leaving date and probation end', () => {
    expect(dueDateFor({ anchor: 'start', offsetDays: 30 }, at(uk, '2026-01-01'))).toBe('2027-01-20');
    expect(dueDateFor({ anchor: 'probation_end', offsetDays: -14 }, at(uk))).toBe('2027-06-07');
    expect(dueDateFor({ anchor: 'end', offsetDays: 0 }, at({ ...uk, endDate: '2027-03-31' }))).toBe(
      '2027-03-31',
    );
  });

  it('gives no due date when the person has no such date, rather than a guess', () => {
    expect(
      dueDateFor({ anchor: 'probation_end', offsetDays: 0 }, at({ ...uk, probationEndDate: null })),
    ).toBe(null);
    expect(dueDateFor({ anchor: 'end', offsetDays: 0 }, at(uk))).toBe(null);
    expect(dueDateFor({ anchor: 'start', offsetDays: 0 }, at(null, '2026-10-19'))).toBe(null);
  });

  it('counts business days over the weekend and the pack’s public holidays (England and Wales)', () => {
    // Monday 21 December 2026 + 3 business days: Christmas Day (Fri 25) and Boxing Day (substitute Mon 28)
    // are bank holidays in the GB pack, so the third business day is Tuesday 29 December
    expect(dueDateFor({ anchor: 'start', offsetDays: 3, businessDays: true }, at(uk))).toBe('2026-12-24');
    expect(dueDateFor({ anchor: 'start', offsetDays: 4, businessDays: true }, at(uk))).toBe('2026-12-29');
    // five business days before the start: Mon 14 December
    expect(dueDateFor({ anchor: 'start', offsetDays: -5, businessDays: true }, at(uk))).toBe('2026-12-14');
  });

  it('takes the Form I-9 Section 2 deadline from the US pack: three business days after the first day', () => {
    // USCIS M-274 §4.0 example: employment begins on a Monday, Section 2 is due on Thursday. The pack (rule
    // i9.completion_deadlines) gives the count; the workspace's business weekdays give the calendar. USCIS
    // does not define business days, so — like the Form I-9 record (compliance engine) — public holidays
    // are not skipped: 26 November 2026 is Thanksgiving, and the deadline is never later than the record's.
    expect(
      dueDateFor({ anchor: 'start', offsetDays: 3, packDeadline: 'i9_section2' }, at(us, '2026-11-23')),
    ).toBe('2026-11-26');
    // a Thursday start runs over the weekend to Tuesday (a calendar count of 3 would say Sunday)
    const thursday = { ...us, startDate: '2026-10-22' };
    expect(dueDateFor({ anchor: 'start', offsetDays: 3, packDeadline: 'i9_section2' }, at(thursday))).toBe(
      '2026-10-27',
    );
    // the template's own offset is ignored: the deadline is the pack's
    expect(dueDateFor({ anchor: 'start', offsetDays: 30, packDeadline: 'i9_section2' }, at(thursday))).toBe(
      '2026-10-27',
    );
    // employed for fewer than three business days: due on the first day (pack rule)
    const short = { ...us, startDate: '2026-10-22', endDate: '2026-10-23' };
    expect(dueDateFor({ anchor: 'start', offsetDays: 3, packDeadline: 'i9_section2' }, at(short))).toBe(
      '2026-10-22',
    );
  });

  it('gives no I-9 deadline for someone outside the United States', () => {
    expect(dueDateFor({ anchor: 'start', offsetDays: 3, packDeadline: 'i9_section2' }, at(uk))).toBe(null);
  });
});
