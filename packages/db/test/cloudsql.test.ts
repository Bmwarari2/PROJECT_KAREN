import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { secretToUrl, tlsFor, TenantRouter } from '../src';

/**
 * Cloud SQL over the unix socket Cloud Run mounts at /cloudsql/<project>:<region>:<instance> (ADR-0156).
 * The secrets have the AWS shape without a host; DATABASE_HOST names the socket directory. Fictional only.
 */
const CONN = 'thapsus-hr-staging:europe-west2:thapsus-pg';
const SOCKET = `/cloudsql/${CONN}`;
const secret = (username: string, password: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ username, password, dbname: 'thapsus', port: 5432, ...extra });

/** What node-postgres itself makes of a connection string. */
const pgParams = (url: string) =>
  (
    new pg.Client({ connectionString: url, ssl: tlsFor(url) }) as unknown as {
      connectionParameters: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
        ssl: unknown;
      };
    }
  ).connectionParameters;

describe('database URLs for a Cloud SQL unix socket', () => {
  it('puts the socket directory in the host parameter, with no sslmode, and pg connects to that socket', () => {
    const url = secretToUrl(secret('thapsus_app', 'fictional-app-pw'), SOCKET);
    expect(url).toBe(
      'postgres://thapsus_app:fictional-app-pw@localhost:5432/thapsus?host=%2Fcloudsql%2Fthapsus-hr-staging%3Aeurope-west2%3Athapsus-pg',
    );
    expect(url).not.toMatch(/sslmode/);
    expect(tlsFor(url)).toBeUndefined();
    const p = pgParams(url);
    expect(p).toMatchObject({
      host: SOCKET,
      port: 5432,
      database: 'thapsus',
      user: 'thapsus_app',
      password: 'fictional-app-pw',
    });
    expect(p.ssl).toBeFalsy();
  });

  it('keeps passwords with URL metacharacters intact and honours the secret dbname and port', () => {
    const pw = 'p@ss:w/rd?#%&+ x';
    const url = secretToUrl(secret('thapsus_owner', pw, { dbname: 'thapsus_global', port: 6432 }), SOCKET);
    expect(pgParams(url)).toMatchObject({
      host: SOCKET,
      port: 6432,
      database: 'thapsus_global',
      user: 'thapsus_owner',
      password: pw,
    });
  });

  it('accepts the socket file itself and takes the port from it', () => {
    const url = secretToUrl(secret('thapsus_app', 'x'), `${SOCKET}/.s.PGSQL.6543`);
    expect(pgParams(url)).toMatchObject({ host: SOCKET, port: 6543 });
  });

  it('uses the given default database name only when the secret has none', () => {
    const noDb = JSON.stringify({ username: 'u', password: 'p' });
    expect(pgParams(secretToUrl(noDb, SOCKET, { dbname: 'thapsus_global' })).database).toBe('thapsus_global');
    expect(pgParams(secretToUrl(noDb, SOCKET)).database).toBe('thapsus');
    expect(pgParams(secretToUrl(secret('u', 'p'), SOCKET, { dbname: 'thapsus_global' })).database).toBe(
      'thapsus',
    );
  });

  it('tlsFor adds no TLS for a socket host (the Cloud SQL connector encrypts the connection)', () => {
    expect(
      tlsFor(`postgres://u:p@localhost:5432/thapsus?host=${encodeURIComponent(SOCKET)}`),
    ).toBeUndefined();
    expect(
      tlsFor(`postgres://u:p@localhost:5432/thapsus?host=${encodeURIComponent(SOCKET)}&sslmode=verify-full`),
    ).toBeUndefined();
    // TCP endpoints are unchanged (tls.test.ts covers them)
    expect(tlsFor('postgres://u:p@db.internal:5432/thapsus?sslmode=verify-full')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('TenantRouter.fromEnv builds the app and reporting URLs from the secrets and the socket hosts', () => {
    const env = {
      CELL_REGION: 'uk',
      DATABASE_SECRET: secret('thapsus_app', 'fictional-app-pw'),
      DATABASE_HOST: SOCKET,
      REPORTING_DATABASE_SECRET: secret('thapsus_reporting', 'fictional-reporting-pw'),
      REPORTING_DATABASE_HOST: SOCKET,
    };
    const router = TenantRouter.fromEnv(env);
    expect(pgParams(router.config.databases.shared!)).toMatchObject({ host: SOCKET, user: 'thapsus_app' });
    expect(pgParams(router.config.readers!.shared!)).toMatchObject({
      host: SOCKET,
      user: 'thapsus_reporting',
    });
  });

  it('the router refuses a Cloud SQL socket in another cell region (every pair is in the residency matrix)', () => {
    const env = {
      DATABASE_SECRET: secret('thapsus_app', 'x'),
      DATABASE_HOST: '/cloudsql/thapsus-hr-staging:europe-west3:thapsus-pg',
    };
    expect(() => TenantRouter.fromEnv({ ...env, CELL_REGION: 'uk' })).toThrow(
      /Residency violation for uk cell: database in europe-west3/,
    );
    expect(() => TenantRouter.fromEnv({ ...env, CELL_REGION: 'eu' })).not.toThrow();
  });
});
