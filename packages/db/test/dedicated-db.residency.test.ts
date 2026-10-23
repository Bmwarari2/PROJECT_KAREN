import { describe, expect, it } from 'vitest';
import { REGIONS, regionPairs, type HomeRegion } from '@thapsus/core/regions';
import { assertCellResidency } from '@thapsus/core/residency';
import { TenantRouter } from '../src/router';

/**
 * Phase 9.5 residency, for every region pair (UK↔EU, UK↔US, EU↔US, both directions): a dedicated database
 * (or its reader) configured for a cell must be in that cell's home region. Both the tenant router and the
 * services' startup check (assertCellResidency in depsFromEnv) refuse a host in another region, so a
 * tenant moved to a dedicated database can never be routed out of its home region by configuration.
 */
const secret = (username: string) =>
  JSON.stringify({ username, password: 'fictional-pw', port: 5432, dbname: 'thapsus' });
const host = (kind: 'proxy' | 'cluster-ro', region: string) =>
  `thapsus-hr-staging-big.${kind}-abc123.${region}.rds.amazonaws.com`;
const cellEnv = (cell: HomeRegion) => ({
  CELL_REGION: cell,
  DATABASE_SECRET: secret('thapsus_app'),
  DATABASE_HOST: host('proxy', REGIONS[cell].awsRegion).replace('-big', ''),
  REPORTING_DATABASE_SECRET: secret('thapsus_reporting'),
});

describe.each(regionPairs())('dedicated databases stay in the home region (%s → %s)', (home, other) => {
  const otherRegion = REGIONS[other].awsRegion;

  it(`a ${home} cell refuses a dedicated database in ${otherRegion} (router and startup check)`, () => {
    const env = {
      ...cellEnv(home),
      DEDICATED_DATABASE_HOSTS: JSON.stringify({ big: host('proxy', otherRegion) }),
    };
    expect(() => TenantRouter.fromEnv(env)).toThrow(
      new RegExp(`Residency violation for ${home} cell.*${otherRegion}`),
    );
    expect(() => assertCellResidency(home, env)).toThrow(/Residency violation/);
  });

  it(`a ${home} cell refuses a dedicated reader in ${otherRegion}, and its backup region is not a home for databases either`, () => {
    const env = {
      ...cellEnv(home),
      DEDICATED_DATABASE_HOSTS: JSON.stringify({ big: host('proxy', REGIONS[home].awsRegion) }),
      DEDICATED_READER_HOSTS: JSON.stringify({ big: host('cluster-ro', otherRegion) }),
    };
    expect(() => TenantRouter.fromEnv(env)).toThrow(/Residency violation/);
    expect(() => assertCellResidency(home, env)).toThrow(/Residency violation/);
    const backup = REGIONS[home].backupRegion;
    if (backup)
      expect(() =>
        TenantRouter.fromEnv({
          ...cellEnv(home),
          DEDICATED_DATABASE_HOSTS: JSON.stringify({ big: host('proxy', backup) }),
        }),
      ).toThrow(/Residency violation/);
  });

  it(`a ${home} cell accepts a dedicated database and reader in its own region`, () => {
    const env = {
      ...cellEnv(home),
      DEDICATED_DATABASE_HOSTS: JSON.stringify({ big: host('proxy', REGIONS[home].awsRegion) }),
      DEDICATED_READER_HOSTS: JSON.stringify({ big: host('cluster-ro', REGIONS[home].awsRegion) }),
    };
    expect(() => assertCellResidency(home, env)).not.toThrow();
    const router = TenantRouter.fromEnv(env);
    expect(router.config.databases.big).toContain(`.${REGIONS[home].awsRegion}.rds.amazonaws.com`);
    expect(router.config.readers?.big).toContain(`.${REGIONS[home].awsRegion}.rds.amazonaws.com`);
  });
});
