import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { secretToUrl, tlsFor } from '../src';

/** ASVS V12.3.1 to V12.3.4: database connections in AWS use TLS with verified certificates. */
describe('database TLS', () => {
  const secret = JSON.stringify({
    username: 'thapsus_app',
    password: 'fictional-only',
    port: 5432,
    dbname: 'thapsus',
  });

  it('connection URLs for AWS endpoints ask for verify-full, never the unverified modes', () => {
    const url = secretToUrl(secret, 'thapsus-hr-staging-uk-proxy.proxy-abc123.eu-west-2.rds.amazonaws.com');
    expect(url).toMatch(/\?sslmode=verify-full$/);
    // node-postgres turns verify-full into TLS with certificate and host name checks
    const client = new pg.Client({ connectionString: url, ssl: tlsFor(url) });
    const ssl = (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl as
      { rejectUnauthorized?: boolean } | boolean;
    expect(ssl).toBeTruthy();
    expect(typeof ssl === 'object' ? ssl.rejectUnauthorized : true).not.toBe(false);
  });

  it('pools for AWS endpoints always verify the server certificate; local Docker Postgres has no TLS', () => {
    expect(
      tlsFor(
        'postgres://u:p@thapsus-hr-staging-uk.cluster-ro-abc123.eu-west-2.rds.amazonaws.com:5432/thapsus',
      ),
    ).toEqual({ rejectUnauthorized: true });
    expect(tlsFor('postgres://u:p@db.internal:5432/thapsus?sslmode=verify-full')).toEqual({
      rejectUnauthorized: true,
    });
    expect(tlsFor('postgres://u:p@127.0.0.1:5432/thapsus')).toBeUndefined();
    expect(readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')).not.toMatch(
      /rejectUnauthorized:\s*false/,
    );
  });

  it('the API and worker images trust the Amazon RDS CA bundle (pinned by checksum) for the Aurora endpoints', () => {
    for (const app of ['api', 'worker']) {
      const dockerfile = readFileSync(new URL(`../../../apps/${app}/Dockerfile`, import.meta.url), 'utf8');
      expect(dockerfile).toMatch(
        /ADD --checksum=sha256:[0-9a-f]{64} --chmod=644 https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem \/etc\/ssl\/certs\/rds-global-bundle\.pem/,
      );
      expect(dockerfile).toContain('ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem');
    }
  });
});
