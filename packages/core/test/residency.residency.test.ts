import { describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS, regionPairs, type HomeRegion } from '../src/regions';
import { createAwsClientFactory, ResidencyViolationError } from '../src/aws';
import { assertCellResidency, endpointViolations, regionOf, type ResourceKind } from '../src/residency';
import { assertGcpLocationAllowed, gcpLocationOf, GcpResidencyViolationError } from '../src/gcp';

/**
 * Residency matrix: for every ordered pair of home regions (UK↔EU, UK↔US, EU↔US) and every resource
 * kind, a cell must refuse resources in the other region. Infrastructure-level equivalents are asserted
 * in infra/test (CDK) and the database router check in apps/api/test/residency.residency.test.ts.
 */
const sample = (kind: ResourceKind, region: string): string => {
  const short = {
    'eu-west-2': 'euw2',
    'eu-central-1': 'euc1',
    'us-east-2': 'use2',
    'eu-west-1': 'euw1',
    'us-west-1': 'usw1',
  }[region]!;
  switch (kind) {
    case 'database':
      return `postgres://thapsus_app:x@thapsus-staging.proxy-abc123.${region}.rds.amazonaws.com:5432/thapsus`;
    case 'objectStorage':
      return `thapsus-hr-staging-${region}-files`;
    case 'cache':
      return `rediss://master.thapsus-staging.abc123.${short}.cache.amazonaws.com:6379`;
    case 'queue':
      return `https://sqs.${region}.amazonaws.com/123456789012/thapsus-staging-jobs`;
    case 'email':
      return `arn:aws:ses:${region}:123456789012:identity/example.test`;
    case 'logs':
      return `arn:aws:logs:${region}:123456789012:log-group:/thapsus/staging/api`;
    case 'kms':
      return `arn:aws:kms:${region}:123456789012:key/11111111-2222-3333-4444-555555555555`;
    case 'backup':
      return `arn:aws:backup:${region}:123456789012:backup-vault:thapsus-staging`;
    case 'search':
      return `postgres://thapsus_reporting:x@thapsus-staging.cluster-ro-abc123.${region}.rds.amazonaws.com:5432/thapsus`;
  }
};

const KINDS: ResourceKind[] = [
  'database',
  'objectStorage',
  'cache',
  'queue',
  'email',
  'logs',
  'kms',
  'backup',
  'search',
];

describe('region extraction', () => {
  it.each(KINDS)('finds the region in a %s identifier', (kind) => {
    for (const r of HOME_REGIONS)
      expect(regionOf(sample(kind, REGIONS[r].awsRegion))).toBe(REGIONS[r].awsRegion);
  });
});

describe.each(regionPairs())('residency %s → %s', (home: HomeRegion, other: HomeRegion) => {
  it.each(KINDS)(`a ${home} cell refuses ${other} %s resources`, (kind) => {
    const v = endpointViolations(home, [{ kind, resource: sample(kind, REGIONS[other].awsRegion) }]);
    expect(v).toHaveLength(1);
    expect(v[0]!.region).toBe(REGIONS[other].awsRegion);
  });
  it(`a ${home} cell refuses AWS SDK clients for ${other} for every service`, () => {
    const create = createAwsClientFactory({ cell: home });
    class C {
      constructor(readonly c: unknown) {}
    }
    for (const svc of [
      's3',
      'sqs',
      'ses',
      'kms',
      'logs',
      'events',
      'scheduler',
      'backup',
      'secretsmanager',
      'elasticache',
      'rds',
    ]) {
      expect(() => create(C, svc, { region: REGIONS[other].awsRegion })).toThrow(ResidencyViolationError);
      expect(() => create(C, svc, { region: REGIONS[other].awsRegion }, 'backup')).toThrow(
        ResidencyViolationError,
      );
    }
  });
  it(`a ${home} cell refuses to start when any endpoint points at ${other}`, () => {
    const env = {
      DATABASES: JSON.stringify({
        shared: sample('database', REGIONS[home].awsRegion),
        big: sample('database', REGIONS[other].awsRegion),
      }),
    };
    expect(() => assertCellResidency(home, env)).toThrow(/Residency violation/);
  });
});

describe.each(HOME_REGIONS)('home-region resources are accepted (%s)', (home) => {
  it('accepts every kind in the home region', () => {
    expect(
      endpointViolations(
        home,
        KINDS.map((kind) => ({ kind, resource: sample(kind, REGIONS[home].awsRegion) })),
      ),
    ).toEqual([]);
  });
  it('backups may go only to the permitted backup region', () => {
    const backupRegion = REGIONS[home].backupRegion;
    const all = ['eu-west-1', 'us-west-1', 'eu-west-2', 'eu-central-1', 'us-east-2'];
    for (const r of all) {
      const ok = r === REGIONS[home].awsRegion || r === backupRegion;
      expect(endpointViolations(home, [{ kind: 'backup', resource: sample('backup', r) }]).length === 0).toBe(
        ok,
      );
      // non-backup resources never use the backup region
      if (r !== REGIONS[home].awsRegion)
        expect(
          endpointViolations(home, [{ kind: 'database', resource: sample('database', r) }]),
        ).toHaveLength(1);
    }
  });
  it('local emulator endpoints carry no region and are allowed', () => {
    expect(() =>
      assertCellResidency(home, {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        VALKEY_URL: 'redis://localhost:6379',
        S3_ENDPOINT: 'http://localhost:9090',
      }),
    ).not.toThrow();
  });
});

/**
 * Google Cloud (ADR-0156): the same matrix for the Google Cloud forms a cell is configured with. Every
 * ordered pair, every form, runtime and backup.
 */
type GcpForm = 'socketHost' | 'socketFile' | 'socketUrl' | 'connectionName' | 'kmsKey' | 'bucketLocation';
const GCP_FORMS: GcpForm[] = [
  'socketHost',
  'socketFile',
  'socketUrl',
  'connectionName',
  'kmsKey',
  'bucketLocation',
];
const gcpSample = (form: GcpForm, location: string): { kind: ResourceKind; resource: string } => {
  const conn = `thapsus-hr-staging:${location}:thapsus-pg`;
  switch (form) {
    case 'socketHost':
      return { kind: 'database', resource: `/cloudsql/${conn}` };
    case 'socketFile':
      return { kind: 'database', resource: `/cloudsql/${conn}/.s.PGSQL.5432` };
    case 'socketUrl':
      return {
        kind: 'database',
        resource: `postgres://thapsus_app:x@localhost:5432/thapsus?host=${encodeURIComponent(`/cloudsql/${conn}`)}`,
      };
    case 'connectionName':
      return { kind: 'database', resource: conn };
    case 'kmsKey':
      return {
        kind: 'kms',
        resource: `projects/thapsus-hr-staging/locations/${location}/keyRings/cell/cryptoKeys/fields`,
      };
    case 'bucketLocation':
      return { kind: 'objectStorage', resource: location.toUpperCase() };
  }
};

describe('Google Cloud location extraction', () => {
  it.each(GCP_FORMS)('finds the location in a %s', (form) => {
    for (const r of HOME_REGIONS)
      expect(gcpLocationOf(gcpSample(form, REGIONS[r].gcpRegion).resource)).toBe(REGIONS[r].gcpRegion);
  });
});

describe.each(regionPairs())('Google Cloud residency %s → %s', (home: HomeRegion, other: HomeRegion) => {
  const there = REGIONS[other].gcpRegion;
  it.each(GCP_FORMS)(`a ${home} cell refuses ${other} %s resources`, (form) => {
    const v = endpointViolations(home, [gcpSample(form, there)]);
    expect(v).toHaveLength(1);
    expect(v[0]!.region).toBe(there);
    expect(() => assertGcpLocationAllowed(home, gcpLocationOf(gcpSample(form, there).resource))).toThrow(
      GcpResidencyViolationError,
    );
  });
  it(`a ${home} cell refuses ${other}'s Google Cloud regions for backups too`, () => {
    for (const loc of [there, REGIONS[other].gcpBackupRegion].filter((x): x is string => !!x)) {
      expect(() => assertGcpLocationAllowed(home, loc, 'backup')).toThrow(GcpResidencyViolationError);
      expect(() => assertGcpLocationAllowed(home, loc, 'runtime')).toThrow(GcpResidencyViolationError);
      expect(
        endpointViolations(home, [
          { kind: 'backup', resource: `projects/p/locations/${loc}/backupVaults/thapsus` },
        ]),
      ).toHaveLength(1);
    }
  });
  it(`a ${home} cell refuses to start when GCP_KMS_KEY or a Cloud SQL socket points at ${other}`, () => {
    const conn = `thapsus-hr-staging:${there}:thapsus-pg`;
    for (const env of [
      { GCP_KMS_KEY: gcpSample('kmsKey', there).resource },
      { DATABASE_HOST: `/cloudsql/${conn}` },
      { REPORTING_DATABASE_HOST: `/cloudsql/${conn}` },
      { DATABASE_URL: gcpSample('socketUrl', there).resource },
      { DATABASES: JSON.stringify({ shared: gcpSample('socketUrl', there).resource }) },
    ])
      expect(() => assertCellResidency(home, env), JSON.stringify(env)).toThrow(/Residency violation/);
  });
});

describe.each(HOME_REGIONS)('Google Cloud home locations are accepted (%s)', (home) => {
  const here = REGIONS[home].gcpRegion;
  it('accepts every form in the home region and lets the cell start', () => {
    expect(
      endpointViolations(
        home,
        GCP_FORMS.map((f) => gcpSample(f, here)),
      ),
    ).toEqual([]);
    expect(() =>
      assertCellResidency(home, {
        GCP_KMS_KEY: gcpSample('kmsKey', here).resource,
        DATABASE_HOST: `/cloudsql/thapsus-hr-staging:${here}:thapsus-pg`,
        REPORTING_DATABASE_HOST: `/cloudsql/thapsus-hr-staging:${here}:thapsus-pg`,
      }),
    ).not.toThrow();
  });
  it('backups may use only the permitted Google Cloud backup region; nothing else may', () => {
    const backup = REGIONS[home].gcpBackupRegion;
    for (const r of HOME_REGIONS.flatMap((c) => [REGIONS[c].gcpRegion, REGIONS[c].gcpBackupRegion])) {
      if (!r) continue;
      const ok = r === here || r === backup;
      expect(
        endpointViolations(home, [{ kind: 'backup', resource: `projects/p/locations/${r}/backupVaults/v` }])
          .length === 0,
        r,
      ).toBe(ok);
      if (r !== here) expect(endpointViolations(home, [gcpSample('socketHost', r)]), r).toHaveLength(1);
    }
  });
  it('multi-region and dual-region buckets and global keys are refused', () => {
    for (const loc of ['EU', 'US', 'ASIA', 'EUR4', 'NAM4'])
      expect(endpointViolations(home, [{ kind: 'objectStorage', resource: loc }]), loc).toHaveLength(1);
    expect(
      endpointViolations(home, [{ kind: 'kms', resource: gcpSample('kmsKey', 'global').resource }]),
    ).toHaveLength(1);
  });
});
