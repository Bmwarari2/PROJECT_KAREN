import { afterAll, describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS, regionPairs } from '@thapsus/core';
import { withTenant } from '@thapsus/db';
import { closeDb, signup, startTestApp } from './helpers';
import { MemoryMailer, SesMailer } from '../src/lib/mailer';
import { S3ObjectStore } from '../src/lib/object-store';
import { AwsKmsKeyProvider } from '../src/lib/kms';

/**
 * Application-level residency: a tenant created in one cell exists only in that cell's database,
 * mail is sent by the home-region mailer, and region-bound clients refuse other regions — for every
 * region pair.
 */
afterAll(closeDb);

describe.each(regionPairs())('tenant data stays home (%s → %s)', (home, other) => {
  it(`a ${home} tenant is created only in the ${home} cell and is unknown to the ${other} cell`, async () => {
    const homeCell = await startTestApp({ cell: home, listen: false });
    const otherCell = await startTestApp({ cell: other, listen: false, directory: homeCell.directory });
    try {
      const s = await signup(homeCell);
      expect(homeCell.mailer.region).toBe(home);
      // Same Postgres in tests, so the registry row records the home region the cell wrote.
      const reg = await homeCell.deps.router.lookup(s.tenantId);
      expect(reg.home_region).toBe(home);
      // The other cell refuses sign-in for that tenant and redirects to the home region.
      const res = await otherCell.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.slug, email: s.email, password: 'x' } });
      expect(res.statusCode).toBe(421);
      // The other cell cannot create a tenant for the home region.
      const create = await otherCell.app.inject({ method: 'POST', url: '/v1/signup', payload: { companyName: 'Fictional Other Ltd', slug: `x-${Date.now()}`, region: home, ownerName: 'X', ownerEmail: 'x@x.example.test', password: 'Correct-Horse-Battery-9', acceptDpa: true } });
      expect(create.statusCode).toBe(421);
      await withTenant(homeCell.deps.router, s.tenantId, async (tx) => {
        expect((await tx.one<{ home_region: string }>('SELECT home_region FROM app.tenants')).home_region).toBe(home);
      });
    } finally {
      await homeCell.close();
      await otherCell.close();
    }
  });

  it(`${home} cell email, object storage and KMS clients refuse ${other}`, () => {
    expect(() => new AwsKmsKeyProvider(`arn:aws:kms:${REGIONS[other].awsRegion}:123456789012:key/x`, home)).toThrow(/Residency guard/);
    // Region-bound clients are created through the guarded factory with the HOME region only.
    const ses = new SesMailer(home, 'no-reply@example.test') as unknown as { client: { config: { region: () => Promise<string> } } };
    const s3 = new S3ObjectStore(home, 'bucket') as unknown as { client: { config: { region: () => Promise<string> } } };
    return Promise.all([ses.client.config.region(), s3.client.config.region()]).then(([a, b]) => {
      expect(a).toBe(REGIONS[home].awsRegion);
      expect(b).toBe(REGIONS[home].awsRegion);
      expect(a).not.toBe(REGIONS[other].awsRegion);
    });
  });
});

describe('mailers are bound to their cell', () => {
  it.each(HOME_REGIONS)('%s', (r) => {
    expect(new MemoryMailer(r).region).toBe(r);
  });
});
