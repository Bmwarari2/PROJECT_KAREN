import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { DIRECTORY_FIELDS, directoryDatabaseUrl, PgDirectory } from '../src/lib/directory';

/**
 * The global tenant directory must never hold personal data. Adding a field to the directory
 * schema fails these tests until the allow-list below is changed deliberately (and reviewed).
 */
const ALLOWED = [
  'tenantId',
  'slug',
  'homeRegion',
  'status',
  'planRef',
  'verifiedDomains',
  'createdAt',
  'updatedAt',
];
const PERSONAL = /email|name$|phone|address|birth|ssn|nino|national|salary|ip$|user/i;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('tenant directory schema', () => {
  it('is exactly the reviewed allow-list and names nothing personal', () => {
    expect([...DIRECTORY_FIELDS].sort()).toEqual([...ALLOWED].sort());
    for (const f of DIRECTORY_FIELDS) expect(f).not.toMatch(PERSONAL);
  });

  it('the local/regional Postgres directory table has only those columns', () => {
    const columns = PgDirectory.DDL.replace(/^[^(]*\(/, '')
      .split(/,(?![^(]*\))/)
      .map((c) => c.trim().split(/\s+/)[0]!)
      .map(camel);
    expect(columns).toHaveLength(DIRECTORY_FIELDS.length);
    for (const c of columns) expect(DIRECTORY_FIELDS as readonly string[]).toContain(c);
  });

  it('every directory field is an allow-listed attribute of the global DynamoDB table', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'infra', 'lib', 'global-stack.ts'),
      'utf8',
    );
    const block = /export const DIRECTORY_ATTRIBUTES = \[([^\]]*)\]/.exec(src)?.[1];
    expect(block).toBeDefined();
    const attrs = [...block!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    for (const f of DIRECTORY_FIELDS) expect(attrs).toContain(f);
    for (const a of attrs) expect(a).not.toMatch(PERSONAL);
  });
});

describe('Postgres directory connection (ADR-0156)', () => {
  const SOCKET = '/cloudsql/thapsus-hr-staging:europe-west2:thapsus-pg';
  const params = (url: string) =>
    (new pg.Client({ connectionString: url }) as unknown as { connectionParameters: Record<string, unknown> })
      .connectionParameters;

  it('DIRECTORY_DATABASE_SECRET + DATABASE_HOST reach thapsus_global on the same Cloud SQL instance', () => {
    const url = directoryDatabaseUrl({
      DIRECTORY_DATABASE_SECRET: JSON.stringify({ username: 'thapsus_directory', password: 'fictional-pw' }),
      DATABASE_HOST: SOCKET,
    });
    expect(params(url!)).toMatchObject({
      host: SOCKET,
      port: 5432,
      database: 'thapsus_global',
      user: 'thapsus_directory',
      password: 'fictional-pw',
    });
    expect(url).not.toMatch(/sslmode/);
  });

  it('the secret dbname wins, DIRECTORY_DATABASE_URL wins over the secret, and nothing set means in-memory', () => {
    const withDb = JSON.stringify({ username: 'u', password: 'p', dbname: 'thapsus_directory', port: 5432 });
    expect(
      params(directoryDatabaseUrl({ DIRECTORY_DATABASE_SECRET: withDb, DATABASE_HOST: SOCKET })!),
    ).toMatchObject({ database: 'thapsus_directory' });
    expect(
      directoryDatabaseUrl({
        DIRECTORY_DATABASE_URL: 'postgres://u:p@localhost:5432/thapsus_global',
        DIRECTORY_DATABASE_SECRET: withDb,
        DATABASE_HOST: SOCKET,
      }),
    ).toBe('postgres://u:p@localhost:5432/thapsus_global');
    expect(directoryDatabaseUrl({})).toBeUndefined();
  });
});
