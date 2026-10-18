import { describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS, regionPairs, type HomeRegion } from '../src/regions';
import { createAwsClientFactory, ResidencyViolationError } from '../src/aws';
import { assertCellResidency, endpointViolations, regionOf, type ResourceKind } from '../src/residency';

/**
 * Residency matrix: for every ordered pair of home regions (UK↔EU, UK↔US, EU↔US) and every resource
 * kind, a cell must refuse resources in the other region. Infrastructure-level equivalents are asserted
 * in infra/test (CDK) and the database router check in apps/api/test/residency.residency.test.ts.
 */
const sample = (kind: ResourceKind, region: string): string => {
  const short = { 'eu-west-2': 'euw2', 'eu-central-1': 'euc1', 'us-east-2': 'use2', 'eu-west-1': 'euw1', 'us-west-1': 'usw1' }[region]!;
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

const KINDS: ResourceKind[] = ['database', 'objectStorage', 'cache', 'queue', 'email', 'logs', 'kms', 'backup', 'search'];

describe('region extraction', () => {
  it.each(KINDS)('finds the region in a %s identifier', (kind) => {
    for (const r of HOME_REGIONS) expect(regionOf(sample(kind, REGIONS[r].awsRegion))).toBe(REGIONS[r].awsRegion);
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
    for (const svc of ['s3', 'sqs', 'ses', 'kms', 'logs', 'events', 'scheduler', 'backup', 'secretsmanager', 'elasticache', 'rds']) {
      expect(() => create(C, svc, { region: REGIONS[other].awsRegion })).toThrow(ResidencyViolationError);
      expect(() => create(C, svc, { region: REGIONS[other].awsRegion }, 'backup')).toThrow(ResidencyViolationError);
    }
  });
  it(`a ${home} cell refuses to start when any endpoint points at ${other}`, () => {
    const env = {
      DATABASES: JSON.stringify({ shared: sample('database', REGIONS[home].awsRegion), big: sample('database', REGIONS[other].awsRegion) }),
    };
    expect(() => assertCellResidency(home, env)).toThrow(/Residency violation/);
  });
});

describe.each(HOME_REGIONS)('home-region resources are accepted (%s)', (home) => {
  it('accepts every kind in the home region', () => {
    expect(endpointViolations(home, KINDS.map((kind) => ({ kind, resource: sample(kind, REGIONS[home].awsRegion) })))).toEqual([]);
  });
  it('backups may go only to the permitted backup region', () => {
    const backupRegion = REGIONS[home].backupRegion;
    const all = ['eu-west-1', 'us-west-1', 'eu-west-2', 'eu-central-1', 'us-east-2'];
    for (const r of all) {
      const ok = r === REGIONS[home].awsRegion || r === backupRegion;
      expect(endpointViolations(home, [{ kind: 'backup', resource: sample('backup', r) }]).length === 0).toBe(ok);
      // non-backup resources never use the backup region
      if (r !== REGIONS[home].awsRegion) expect(endpointViolations(home, [{ kind: 'database', resource: sample('database', r) }])).toHaveLength(1);
    }
  });
  it('local emulator endpoints carry no region and are allowed', () => {
    expect(() => assertCellResidency(home, { DATABASE_URL: 'postgres://u:p@localhost:5432/x', VALKEY_URL: 'redis://localhost:6379', S3_ENDPOINT: 'http://localhost:9090' })).not.toThrow();
  });
});
