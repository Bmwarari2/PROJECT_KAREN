import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  REGIONS,
  HOME_REGIONS,
  allowedAwsRegions,
  regionPairs,
  createAwsClientFactory,
  ResidencyViolationError,
  assertResourceInRegion,
} from '../src/index';
import { scrub, scrubString, REDACTED } from '../src/scrub';
import { createLogger } from '../src/logger';
import { scrubSpanAttributes } from '../src/tracing';
import * as time from '../src/time';
import { money, add, multiplyRatio, allocate, parseDecimal, toDecimalString } from '../src/money';
import { CATALOGUES, flatten, formatMoney, formatDate, formatDateTime, formatNumber, resolveLocale, t } from '../src/i18n';

describe('residency map', () => {
  it('pins each home region to the brief', () => {
    expect(REGIONS.uk.awsRegion).toBe('eu-west-2');
    expect(REGIONS.eu.awsRegion).toBe('eu-central-1');
    expect(REGIONS.us.awsRegion).toBe('us-east-2');
  });
  it('allows backup copies only within the same jurisdiction', () => {
    expect(REGIONS.uk.backupRegion).toBeNull();
    expect(REGIONS.eu.backupRegion).toBe('eu-west-1');
    expect(REGIONS.us.backupRegion).toBe('us-west-1');
    expect(allowedAwsRegions('uk', 'backup')).toEqual(['eu-west-2']);
  });
  it('enumerates all six ordered region pairs', () => {
    expect(regionPairs()).toHaveLength(6);
  });
});

class FakeClient {
  constructor(readonly config: Record<string, unknown>) {}
}

describe('residency-guarded AWS client factory', () => {
  for (const cell of HOME_REGIONS) {
    const create = createAwsClientFactory({ cell });
    it(`${cell}: defaults to the home region`, () => {
      expect(create(FakeClient, 's3').config.region).toBe(REGIONS[cell].awsRegion);
    });
    for (const other of HOME_REGIONS.filter((o) => o !== cell)) {
      it(`${cell}: refuses ${other}'s region for runtime and backup`, () => {
        expect(() => create(FakeClient, 's3', { region: REGIONS[other].awsRegion })).toThrow(ResidencyViolationError);
        expect(() => create(FakeClient, 'backup', { region: REGIONS[other].awsRegion }, 'backup')).toThrow(
          ResidencyViolationError,
        );
      });
    }
  }
  it('lets backup tooling reach only the permitted backup region', () => {
    const eu = createAwsClientFactory({ cell: 'eu' });
    expect(eu(FakeClient, 'backup', { region: 'eu-west-1' }, 'backup').config.region).toBe('eu-west-1');
    expect(() => eu(FakeClient, 's3', { region: 'eu-west-1' })).toThrow(ResidencyViolationError);
    const uk = createAwsClientFactory({ cell: 'uk' });
    expect(() => uk(FakeClient, 'backup', { region: 'eu-west-1' }, 'backup')).toThrow(ResidencyViolationError);
  });
  it('checks ARNs and endpoint URLs', () => {
    expect(() => assertResourceInRegion('uk', 'arn:aws:kms:eu-central-1:123456789012:key/abc')).toThrow();
    expect(() => assertResourceInRegion('us', 'https://sqs.eu-west-2.amazonaws.com/1/q')).toThrow();
    expect(() => assertResourceInRegion('uk', 'arn:aws:kms:eu-west-2:123456789012:key/abc')).not.toThrow();
  });
});

describe('personal-data scrubbing', () => {
  it.each([
    ['email', 'contact ada.example@example.test now'],
    ['phone', 'call +44 7700 900123 today'],
    ['NI number', 'NI QQ 12 34 56 C on file'],
    ['SSN', 'ssn 078-05-1120'],
    ['bearer token', 'Authorization: Bearer abc.def.ghi-123'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['API key', 'key thr_live_ABCDEFGH12345678'],
  ])('redacts %s in free text', (_, input) => {
    expect(scrubString(input)).toContain(REDACTED);
  });
  it('redacts known personal fields by key', () => {
    const out = scrub({ firstName: 'Ada', last_name: 'Lovelace', employeeId: 'e1', nested: { email: 'x@y.zz' } });
    expect(out).toEqual({ firstName: REDACTED, last_name: REDACTED, employeeId: 'e1', nested: { email: REDACTED } });
  });
  it('logger output never contains personal data', async () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(c, _e, cb) {
        chunks.push(String(c));
        cb();
      },
    });
    const log = createLogger({ name: 'test', destination: dest as never });
    log.info({ email: 'pat@example.test', name: 'Pat Example', route: '/v1/employees' }, 'created for pat@example.test');
    await new Promise((r) => setTimeout(r, 10));
    const line = chunks.join('');
    expect(line).not.toContain('pat@example.test');
    expect(line).not.toContain('Pat Example');
    expect(line).toContain('/v1/employees');
  });
  it('tracer attributes are scrubbed', () => {
    const out = scrubSpanAttributes({ 'user.email': 'a@b.cc', 'http.route': '/v1/x', 'http.request.body': '{}' });
    expect(out['user.email']).toBe(REDACTED);
    expect(out['http.request.body']).toBe(REDACTED);
    expect(out['http.route']).toBe('/v1/x');
  });
});

describe('time utilities', () => {
  it('handles leap years', () => {
    expect(time.isLeapYear(2028)).toBe(true);
    expect(time.isLeapYear(2100)).toBe(false);
    expect(time.daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(time.addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });
  it('rejects invalid dates', () => {
    expect(time.isCivilDate('2027-02-29')).toBe(false);
    expect(time.isCivilDate('2028-02-29')).toBe(true);
  });
  it('London spring-forward day has 23 hours and autumn day 25', () => {
    expect(time.hoursInDay('2027-03-28', 'Europe/London')).toBe(23);
    expect(time.hoursInDay('2027-10-31', 'Europe/London')).toBe(25);
    expect(time.hoursInDay('2027-03-14', 'America/New_York')).toBe(23);
  });
  it('maps wall-clock times across DST gaps and overlaps', () => {
    // 01:30 does not exist in London on 2027-03-28 → moved forward to 02:30 BST = 01:30Z
    expect(time.zonedToInstant('2027-03-28', '01:30', 'Europe/London')).toBe('2027-03-28T01:30:00Z');
    // 01:30 happens twice on 2027-10-31; earlier (BST) offset → 00:30Z
    expect(time.zonedToInstant('2027-10-31', '01:30', 'Europe/London')).toBe('2027-10-31T00:30:00Z');
  });
  it('shift spanning DST end is 9 hours not 8', () => {
    const start = time.zonedToInstant('2027-10-30', '22:00', 'Europe/Berlin');
    const end = time.zonedToInstant('2027-10-31', '06:00', 'Europe/Berlin');
    expect(time.minutesBetween(start, end)).toBe(9 * 60);
  });
  it('converts instants to local dates per zone', () => {
    expect(time.instantToDate('2027-01-01T03:00:00Z', 'America/Los_Angeles')).toBe('2026-12-31');
    expect(time.instantToDate('2027-01-01T03:00:00Z', 'Europe/London')).toBe('2027-01-01');
  });
  it('computes Easter and nth weekdays', () => {
    expect(time.easterSunday(2027)).toBe('2027-03-28');
    expect(time.orthodoxEasterSunday(2027)).toBe('2027-05-02');
    expect(time.nthWeekdayOfMonth(2027, 5, 1, -1)).toBe('2027-05-31');
    expect(time.nthWeekdayOfMonth(2027, 11, 4, 4)).toBe('2027-11-25');
  });
  it('half-open ranges', () => {
    expect(time.rangesOverlap('2027-01-01', '2027-02-01', '2027-02-01', null)).toBe(false);
    expect(time.rangesOverlap('2027-01-01', null, '2030-01-01', '2030-02-01')).toBe(true);
  });
  it('validates IANA zones', () => {
    expect(time.isValidTimeZone('Europe/Dublin')).toBe(true);
    expect(time.isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('money', () => {
  it('uses integer minor units', () => {
    expect(() => money(10.5, 'GBP')).toThrow();
    expect(toDecimalString(add(money(1050, 'GBP'), money(5, 'GBP')))).toBe('10.55');
    expect(() => add(money(1, 'GBP'), money(1, 'EUR'))).toThrow();
  });
  it('rounds half-up on ratios and allocates without losing pennies', () => {
    expect(multiplyRatio(money(1000, 'GBP'), 1, 3).amountMinor).toBe(333n);
    expect(multiplyRatio(money(1001, 'GBP'), 1, 2).amountMinor).toBe(501n);
    const parts = allocate(money(1000, 'EUR'), 3);
    expect(parts.map((p) => p.amountMinor)).toEqual([334n, 333n, 333n]);
  });
  it('parses decimals exactly', () => {
    expect(parseDecimal('0.1', 'USD').amountMinor + parseDecimal('0.2', 'USD').amountMinor).toBe(30n);
    expect(parseDecimal('1500', 'HUF').amountMinor).toBe(150000n);
    expect(() => parseDecimal('1.234', 'GBP')).toThrow();
  });
});

describe('i18n', () => {
  it('en-US only overrides keys that exist in en-GB', () => {
    const gb = Object.keys(flatten(CATALOGUES['en-GB']));
    const us = Object.keys(flatten(CATALOGUES['en-US']));
    expect(us.sort()).toEqual(gb.sort());
  });
  it('translates with US spelling', () => {
    expect(t('en-GB', 'common.organisation')).toBe('Organisation');
    expect(t('en-US', 'common.organisation')).toBe('Organization');
  });
  it('resolves Accept-Language', () => {
    expect(resolveLocale('en-US,en;q=0.9')).toBe('en-US');
    expect(resolveLocale('de-DE,en-IE;q=0.8')).toBe('en-GB');
  });
  it.each([
    ['GBP', 'en-GB', 123456n, '£1,234.56'],
    ['EUR', 'en-GB', 123456n, '€1,234.56'],
    ['USD', 'en-US', 123456n, '$1,234.56'],
    ['SEK', 'en-GB', 123456n, 'SEK 1,234.56'],
    ['PLN', 'en-GB', 123456n, 'PLN 1,234.56'],
    ['DKK', 'en-GB', 123456n, 'DKK 1,234.56'],
    ['CHF', 'en-GB', 123456n, 'CHF 1,234.56'],
    ['CZK', 'en-GB', 123456n, 'CZK 1,234.56'],
    ['HUF', 'en-GB', 123456n, 'HUF 1,234.56'],
    ['RON', 'en-GB', 123456n, 'RON 1,234.56'],
  ] as const)('formats %s', (cur, locale, minor, expected) => {
    expect(formatMoney(money(minor, cur), locale).replace(/\s/g, ' ')).toBe(expected);
  });
  it('formats dates per locale without zone drift', () => {
    expect(formatDate('2027-07-04', 'en-US', 'short')).toBe('7/4/27');
    expect(formatDate('2027-07-04', 'en-GB', 'short')).toBe('04/07/2027');
  });
  it('formats numbers per locale', () => {
    expect(formatNumber(1234567.891, 'en-GB', { maximumFractionDigits: 2 })).toBe('1,234,567.89');
    expect(formatNumber(1234567.891, 'en-US', { maximumFractionDigits: 2 })).toBe('1,234,567.89');
    expect(formatNumber(0.125, 'en-GB', { style: 'percent', maximumFractionDigits: 1 })).toBe('12.5%');
  });
  it('formats instants in the viewer\'s IANA zone, across DST', () => {
    // 2026-03-29 01:30Z is 02:30 BST in London (after the spring change) and 21:30 EDT the day before in New York.
    const at = '2026-03-29T01:30:00Z';
    expect(formatDateTime(at, 'en-GB', 'Europe/London').replace(/\s/g, ' ')).toBe('29 Mar 2026, 02:30');
    expect(formatDateTime(at, 'en-US', 'America/New_York').replace(/\s/g, ' ')).toBe('Mar 28, 2026, 9:30 PM');
    expect(formatDateTime(at, 'en-GB', 'Asia/Kolkata').replace(/\s/g, ' ')).toBe('29 Mar 2026, 07:00');
  });
});
