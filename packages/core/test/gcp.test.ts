import { describe, expect, it } from 'vitest';
import {
  assertGcpLocationAllowed,
  assertGcpResourceAllowed,
  gcpLocationOf,
  GcpResidencyViolationError,
  isGcpRegion,
} from '../src/gcp';
import { ResidencyViolationError } from '../src/aws';

/** Google Cloud residency guard (ADR-0156). Fictional project and resource names only. */
describe('gcpLocationOf', () => {
  it.each([
    ['projects/thapsus-hr-staging/locations/europe-west2/keyRings/cell/cryptoKeys/fields', 'europe-west2'],
    [
      '//cloudkms.googleapis.com/projects/thapsus-hr-staging/locations/us-east5/keyRings/cell/cryptoKeys/fields/cryptoKeyVersions/3',
      'us-east5',
    ],
    ['projects/thapsus-hr-staging/locations/global/keyRings/cell/cryptoKeys/fields', 'global'],
    ['thapsus-hr-staging:europe-west2:thapsus-pg', 'europe-west2'],
    ['example.test:thapsus-hr-staging:europe-west3:thapsus-pg', 'europe-west3'],
    ['/cloudsql/thapsus-hr-staging:europe-west2:thapsus-pg', 'europe-west2'],
    ['/cloudsql/thapsus-hr-staging:europe-west2:thapsus-pg/.s.PGSQL.5432', 'europe-west2'],
    [
      'postgres://thapsus_app:x@localhost:5432/thapsus?host=%2Fcloudsql%2Fthapsus-hr-staging%3Aus-east5%3Athapsus-pg',
      'us-east5',
    ],
    ['postgres://thapsus_app:x@localhost:5432/thapsus?host=/cloudsql/p-1:europe-west3:db', 'europe-west3'],
    ['EUROPE-WEST2', 'europe-west2'],
    ['us-west1', 'us-west1'],
    ['EU', 'eu'],
    ['US', 'us'],
    ['ASIA', 'asia'],
    ['EUR4', 'eur4'],
    ['NAM4', 'nam4'],
  ])('reads the location of %s', (resource, location) => {
    expect(gcpLocationOf(resource)).toBe(location);
  });

  it.each([
    'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555',
    'postgres://thapsus_app:x@thapsus-staging.proxy-abc123.eu-west-2.rds.amazonaws.com:5432/thapsus',
    'postgres://thapsus_app:x@localhost:5432/thapsus',
    'https://sqs.eu-west-2.amazonaws.com/123456789012/thapsus-staging-jobs',
    'thapsus-hr-staging-uk-files',
    'eu-west-2',
    'localhost',
    '',
  ])('finds no Google Cloud location in %s', (resource) => {
    expect(gcpLocationOf(resource)).toBeUndefined();
  });

  it('tells single regions apart from multi-regions and dual-regions', () => {
    for (const r of ['europe-west2', 'europe-west3', 'us-east5', 'us-west1', 'EUROPE-WEST2'])
      expect(isGcpRegion(r), r).toBe(true);
    for (const r of ['eu', 'US', 'asia', 'eur4', 'NAM4', 'global', '']) expect(isGcpRegion(r), r).toBe(false);
  });
});

describe('assertGcpLocationAllowed', () => {
  it('accepts the home location in either case (the Storage API reports upper case)', () => {
    expect(() => assertGcpLocationAllowed('uk', 'europe-west2')).not.toThrow();
    expect(() => assertGcpLocationAllowed('uk', 'EUROPE-WEST2')).not.toThrow();
  });

  it('refuses multi-regions, dual-regions, global and unknown locations for every cell and purpose', () => {
    for (const cell of ['uk', 'eu', 'us'] as const)
      for (const purpose of ['runtime', 'backup'] as const)
        for (const loc of ['EU', 'US', 'ASIA', 'EUR4', 'NAM4', 'global', '', undefined])
          expect(() => assertGcpLocationAllowed(cell, loc, purpose), `${cell} ${purpose} ${loc}`).toThrow(
            GcpResidencyViolationError,
          );
  });

  it('throws a residency violation that names the cell, purpose and location', () => {
    let err: unknown;
    try {
      assertGcpLocationAllowed('uk', 'EU', 'backup');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResidencyViolationError);
    expect(err).toBeInstanceOf(GcpResidencyViolationError);
    const v = err as GcpResidencyViolationError;
    expect(v.cell).toBe('uk');
    expect(v.purpose).toBe('backup');
    expect(v.requestedRegion).toBe('eu');
    expect(v.message).toMatch(/uk.*backup.*Google Cloud.*eu.*multi-region or dual-region/);
  });
});

describe('assertGcpResourceAllowed', () => {
  it('checks the location a resource name carries and refuses names that carry none', () => {
    expect(() =>
      assertGcpResourceAllowed('uk', 'projects/p/locations/europe-west2/keyRings/r/cryptoKeys/k'),
    ).not.toThrow();
    expect(() =>
      assertGcpResourceAllowed('uk', 'projects/p/locations/europe-west3/keyRings/r/cryptoKeys/k'),
    ).toThrow(GcpResidencyViolationError);
    expect(() =>
      assertGcpResourceAllowed('uk', 'projects/p/locations/global/keyRings/r/cryptoKeys/k'),
    ).toThrow(GcpResidencyViolationError);
    expect(() => assertGcpResourceAllowed('uk', 'fields-key')).toThrow(/unknown/);
  });
});
