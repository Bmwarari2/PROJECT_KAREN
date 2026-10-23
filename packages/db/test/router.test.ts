import { describe, expect, it } from 'vitest';
import { ownerUrlsFromEnv } from '../src/move-requests';
import { TenantRouter } from '../src/router';

/**
 * Phase 9.5 (ADR-0068): the cell stack passes dedicated databases to the api and worker as
 * DEDICATED_DATABASE_HOSTS / DEDICATED_READER_HOSTS (router key → host) next to the shared role secrets,
 * and each dedicated tools task carries the owner secrets the move runner needs. Fictional secrets only.
 */
const secret = (username: string, password: string, host = 'shared-proxy.example.test') => JSON.stringify({ username, password, host, port: 5432, dbname: 'thapsus' });
const UK_PROXY = 'thapsus-hr-staging-uk-big-uk-proxy.proxy-abc123.eu-west-2.rds.amazonaws.com';
const UK_READER = 'thapsus-hr-staging-uk-big-uk.cluster-ro-abc123.eu-west-2.rds.amazonaws.com';
const cellEnv = {
  CELL_REGION: 'uk',
  DATABASE_SECRET: secret('thapsus_app', 'fictional-app-pw'),
  DATABASE_HOST: 'thapsus-hr-staging-uk-proxy.proxy-abc123.eu-west-2.rds.amazonaws.com',
  REPORTING_DATABASE_SECRET: secret('thapsus_reporting', 'fictional-reporting-pw'),
  REPORTING_DATABASE_HOST: 'thapsus-hr-staging-uk.cluster-ro-abc123.eu-west-2.rds.amazonaws.com',
};

describe('TenantRouter.fromEnv with dedicated databases', () => {
  it('routes each DEDICATED_DATABASE_HOSTS key to its host with the app role secret, and DEDICATED_READER_HOSTS with the reporting role', () => {
    const router = TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: JSON.stringify({ 'big-uk': UK_PROXY }), DEDICATED_READER_HOSTS: JSON.stringify({ 'big-uk': UK_READER }) });
    expect(router.config.databases).toEqual({
      shared: `postgres://thapsus_app:fictional-app-pw@${cellEnv.DATABASE_HOST}:5432/thapsus?sslmode=verify-full`,
      'big-uk': `postgres://thapsus_app:fictional-app-pw@${UK_PROXY}:5432/thapsus?sslmode=verify-full`,
    });
    expect(router.config.readers).toEqual({
      shared: `postgres://thapsus_reporting:fictional-reporting-pw@${cellEnv.REPORTING_DATABASE_HOST}:5432/thapsus?sslmode=verify-full`,
      'big-uk': `postgres://thapsus_reporting:fictional-reporting-pw@${UK_READER}:5432/thapsus?sslmode=verify-full`,
    });
    expect(router.config.cell).toBe('uk');
    expect(router.registryKey).toBe('shared');
    expect(router.hasReader('big-uk')).toBe(true);
    // without dedicated hosts only the shared database is configured
    expect(Object.keys(TenantRouter.fromEnv(cellEnv).config.databases)).toEqual(['shared']);
  });

  it('refuses dedicated hosts it cannot use: no DATABASE_SECRET, the shared key, invalid keys, non-string hosts or malformed JSON', () => {
    const hosts = JSON.stringify({ 'big-uk': UK_PROXY });
    expect(() => TenantRouter.fromEnv({ CELL_REGION: 'uk', DATABASE_URL: 'postgres://thapsus_app:x@localhost:5432/thapsus', DEDICATED_DATABASE_HOSTS: hosts })).toThrow(/DEDICATED_DATABASE_HOSTS needs DATABASE_SECRET/);
    expect(() => TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: JSON.stringify({ shared: UK_PROXY }) })).toThrow(/"shared"/);
    for (const key of ['Big', 'big uk', '-big', 'a'.repeat(64)]) expect(() => TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: JSON.stringify({ [key]: UK_PROXY }) }), key).toThrow(/key/);
    expect(() => TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: JSON.stringify({ 'big-uk': 5432 }) })).toThrow(/host/);
    expect(() => TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: JSON.stringify([UK_PROXY]) })).toThrow(/DEDICATED_DATABASE_HOSTS/);
    expect(() => TenantRouter.fromEnv({ ...cellEnv, DEDICATED_DATABASE_HOSTS: '{"big-uk":' })).toThrow(/DEDICATED_DATABASE_HOSTS/);
  });
});

describe('move runner owner URLs', () => {
  it('ownerUrlsFromEnv builds the shared and dedicated owner URLs from the dedicated tools task, or takes OWNER_DATABASES', () => {
    const tools = {
      DEDICATED_DB_KEY: 'big-uk',
      OWNER_DATABASE_SECRET: secret('thapsus_owner', 'fictional-dedicated-owner-pw'),
      DATABASE_HOST: 'thapsus-hr-staging-uk-big-uk.cluster-abc123.eu-west-2.rds.amazonaws.com',
      SHARED_OWNER_DATABASE_SECRET: secret('thapsus_owner', 'fictional-shared-owner-pw'),
      SHARED_DATABASE_HOST: 'thapsus-hr-staging-uk.cluster-abc123.eu-west-2.rds.amazonaws.com',
    };
    expect(ownerUrlsFromEnv(tools)).toEqual({
      shared: `postgres://thapsus_owner:fictional-shared-owner-pw@${tools.SHARED_DATABASE_HOST}:5432/thapsus?sslmode=verify-full`,
      'big-uk': `postgres://thapsus_owner:fictional-dedicated-owner-pw@${tools.DATABASE_HOST}:5432/thapsus?sslmode=verify-full`,
    });
    const explicit = { shared: 'postgres://thapsus_owner:x@localhost:5432/a', 'big-uk': 'postgres://thapsus_owner:x@localhost:5432/b' };
    expect(ownerUrlsFromEnv({ ...tools, OWNER_DATABASES: JSON.stringify(explicit) })).toEqual(explicit);
    expect(ownerUrlsFromEnv({})).toEqual({});
    expect(() => ownerUrlsFromEnv({ OWNER_DATABASE_SECRET: tools.OWNER_DATABASE_SECRET, DATABASE_HOST: tools.DATABASE_HOST })).toThrow(/DEDICATED_DB_KEY/);
  });
});
