import { describe, expect, it } from 'vitest';
import { CATALOGUES, flatten } from '@thapsus/core/i18n';
import { readersFromEnv, TenantRouter } from '@thapsus/db';
import { latestOccurrence, resolveRelative } from '../src/modules/reports/schedule';
import { displayCell, fileNameFor, renderCsv, renderJsonl } from '../src/modules/reports/render';
import { DATASETS } from '../src/modules/reports/builder/datasets';
import { READY_REPORTS } from '../src/modules/reports/ready/registry';
import type { ReportResult } from '../src/modules/reports/types';

/** PROGRESS 7.2 units: schedule periods (IANA zones, DST), relative periods, exports, reader configuration. */
describe('scheduled delivery periods', () => {
  it('daily at 07:00 Europe/London across the October clock change', () => {
    // 25 Oct 2026: BST ends; 07:00 local is 06:00Z before and 07:00Z after
    expect(latestOccurrence('2026-10-24T06:30:00Z', { frequency: 'daily', timeOfDay: '07:00', timeZone: 'Europe/London' })).toEqual({ periodKey: '2026-10-24', at: '2026-10-24T06:00:00Z' });
    expect(latestOccurrence('2026-10-25T06:30:00Z', { frequency: 'daily', timeOfDay: '07:00', timeZone: 'Europe/London' })).toEqual({ periodKey: '2026-10-24', at: '2026-10-24T06:00:00Z' });
    expect(latestOccurrence('2026-10-25T07:00:00Z', { frequency: 'daily', timeOfDay: '07:00', timeZone: 'Europe/London' })).toEqual({ periodKey: '2026-10-25', at: '2026-10-25T07:00:00Z' });
  });
  it('a local time inside the spring-forward gap resolves to the next valid instant', () => {
    // 29 Mar 2026 01:30 does not exist in London (clocks go 01:00 → 02:00)
    const occ = latestOccurrence('2026-03-29T03:00:00Z', { frequency: 'daily', timeOfDay: '01:30', timeZone: 'Europe/London' });
    expect(occ?.periodKey).toBe('2026-03-29');
  });
  it('weekly on Monday and monthly on the 1st, in the schedule zone', () => {
    expect(latestOccurrence('2026-10-18T12:00:00Z', { frequency: 'weekly', weekday: 1, timeOfDay: '08:00', timeZone: 'America/New_York' })?.periodKey).toBe('2026-10-12');
    expect(latestOccurrence('2026-10-19T11:59:00Z', { frequency: 'weekly', weekday: 1, timeOfDay: '08:00', timeZone: 'America/New_York' })?.periodKey).toBe('2026-10-12');
    expect(latestOccurrence('2026-10-19T12:00:00Z', { frequency: 'weekly', weekday: 1, timeOfDay: '08:00', timeZone: 'America/New_York' })?.periodKey).toBe('2026-10-19');
    expect(latestOccurrence('2026-11-01T05:59:00Z', { frequency: 'monthly', dayOfMonth: 1, timeOfDay: '07:00', timeZone: 'Europe/Berlin' })?.periodKey).toBe('2026-10-01');
    expect(latestOccurrence('2026-11-01T06:00:00Z', { frequency: 'monthly', dayOfMonth: 1, timeOfDay: '07:00', timeZone: 'Europe/Berlin' })?.periodKey).toBe('2026-11-01');
  });
  it('relative periods resolve against the run date', () => {
    expect(resolveRelative('previousMonth', '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28', asOf: '2026-02-28' });
    expect(resolveRelative('previousWeek', '2026-10-18')).toEqual({ from: '2026-10-05', to: '2026-10-11', asOf: '2026-10-11' });
    expect(resolveRelative('yearToDate', '2026-10-18')).toEqual({ from: '2026-01-01', to: '2026-10-18', asOf: '2026-10-18' });
    expect(resolveRelative('previousYear', '2026-10-18')).toEqual({ from: '2025-01-01', to: '2025-12-31', asOf: '2025-12-31' });
  });
});

describe('exports', () => {
  const result: ReportResult = {
    columns: [
      { key: 'name', labelKey: 'reports.field.displayName', type: 'text' },
      { key: 'pay', labelKey: 'reports.field.payAmount', type: 'money' },
      { key: 'worked', labelKey: 'reports.col.worked', type: 'minutes' },
      { key: 'start', labelKey: 'reports.field.startDate', type: 'date' },
      { key: 'rate', labelKey: 'reports.col.turnoverRate', type: 'percent', scale: 2 },
    ],
    rows: [
      { name: '=HYPERLINK("http://example.test")', pay: { amountMinor: '3640000', currency: 'GBP' }, worked: 2550, start: '2026-07-04', rate: '66.67' },
      { name: 'Ada, "Fictional"', pay: { amountMinor: '1250', currency: 'JPY' }, worked: 20, start: null, rate: null },
    ],
    notes: [],
  };
  it('CSV: localised headers, money as decimal + ISO code, minutes as hours, formula injection neutralised', () => {
    const csv = renderCsv(result, 'en-GB').toString('utf8').replace(/^\ufeff/, '').split('\r\n');
    expect(csv[0]).toBe('Name,Pay,Pay (Currency),Worked (hours),Start date,Turnover rate');
    expect(csv[1]).toBe(`"'=HYPERLINK(""http://example.test"")",36400.00,GBP,42.50,2026-07-04,66.67`);
    expect(csv[2]).toBe('"Ada, ""Fictional""",1250,JPY,0.33,,');
  });
  it('JSONL keeps typed values', () => {
    const lines = renderJsonl(result).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].pay).toEqual({ amountMinor: '3640000', currency: 'GBP' });
  });
  it('display formatting is locale-aware without floating point money', () => {
    const [, pay, worked, start, rate] = result.columns;
    expect(displayCell('en-GB', pay!, { amountMinor: '3640000', currency: 'GBP' })).toBe('£36,400.00');
    expect(displayCell('en-US', pay!, { amountMinor: '12345', currency: 'USD' })).toBe('$123.45');
    expect(displayCell('en-US', start!, '2026-07-04')).toBe('Jul 4, 2026');
    expect(displayCell('en-GB', start!, '2026-07-04')).toBe('4 Jul 2026');
    expect(displayCell('en-GB', worked!, 2550)).toBe('42.5 h');
    expect(displayCell('en-GB', rate!, '66.67')).toBe('66.67%');
    expect(fileNameFor('Holiday liability', '2026-10-18', 'pdf')).toBe('holiday-liability-2026-10-18.pdf');
  });
});

describe('tenant routing with readers (configuration only)', () => {
  it('reads reader URLs per database key from the environment', () => {
    const secret = JSON.stringify({ username: 'thapsus_reporting', password: 'p@ss', host: 'ignored', port: 5432, dbname: 'thapsus' });
    expect(readersFromEnv({ REPORTING_DATABASE_SECRET: secret, REPORTING_DATABASE_HOST: 'thapsus.cluster-ro-x.eu-west-2.rds.amazonaws.com', DEDICATED_READER_HOSTS: JSON.stringify({ acme: 'acme.cluster-ro-y.eu-west-2.rds.amazonaws.com' }) })).toEqual({
      shared: 'postgres://thapsus_reporting:p%40ss@thapsus.cluster-ro-x.eu-west-2.rds.amazonaws.com:5432/thapsus?sslmode=require',
      acme: 'postgres://thapsus_reporting:p%40ss@acme.cluster-ro-y.eu-west-2.rds.amazonaws.com:5432/thapsus?sslmode=require',
    });
    expect(readersFromEnv({ READER_DATABASES: JSON.stringify({ shared: 'postgres://r@h/db' }), REPORTING_DATABASE_URL: 'postgres://ignored@h/db' })).toEqual({ shared: 'postgres://r@h/db' });
    expect(readersFromEnv({})).toEqual({});
  });
  it('a dedicated database without its own reader falls back to its writer', () => {
    const r = new TenantRouter({ databases: { shared: 'postgres://a@h/s', acme: 'postgres://a@h/acme' }, readers: { shared: 'postgres://r@h/s' } });
    expect(r.hasReader('shared')).toBe(true);
    expect(r.readerPool('acme')).toEqual({ pool: r.pool('acme'), reader: false });
  });
});

describe('every report label is in both message catalogues', () => {
  const gb = new Set(Object.keys(flatten(CATALOGUES['en-GB'])));
  const us = new Set(Object.keys(flatten(CATALOGUES['en-US'])));
  const keys = [
    ...READY_REPORTS.flatMap((r) => [r.titleKey, r.descriptionKey]),
    ...DATASETS.flatMap((d) => [`reports.dataset.${d.key}`, ...d.fields.map((f) => `reports.field.${f.key}`), ...d.fields.flatMap((f) => (f.enumValues ?? []).map((v) => `reports.enum.${f.key}.${v}`))]),
    ...['count', 'countDistinct', 'sum', 'avg', 'min', 'max'].map((m) => `reports.measure.${m}`),
    'notify.reportReady',
  ];
  it.each(keys)('%s', (k) => {
    expect(gb.has(k)).toBe(true);
    expect(us.has(k)).toBe(true);
  });
});
