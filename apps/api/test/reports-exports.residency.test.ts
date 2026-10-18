import { afterAll, describe, expect, it } from 'vitest';
import { REGIONS, regionPairs } from '@thapsus/core';
import { assertCellResidency } from '@thapsus/core/residency';
import { ResidencyViolationError } from '@thapsus/core/aws';
import { DestinationError, guardedAwsClients, S3Destination, validateS3Config, type AwsClients } from '../src/modules/data-export/destination';
import { closeDb, ownerSession, randomIp, startTestApp } from './helpers';

/**
 * Residency for phase 7, for every region pair (UK↔EU, UK↔US, EU↔US, both directions):
 *  - a data-export bucket must be in the tenant's home region (configuration, AWS client factory and the
 *    bucket's real region are all checked);
 *  - report readers (read replicas) configured outside the home region stop the cell from starting.
 */
afterAll(closeDb);

const ROLE = 'arn:aws:iam::123456789012:role/thapsus-hr-export-warehouse';
const EXTERNAL = `thr-${'a'.repeat(32)}`;

describe.each(regionPairs())('data export and reporting residency (%s → %s)', (home, other) => {
  const homeRegion = REGIONS[home].awsRegion;
  const otherRegion = REGIONS[other].awsRegion;

  it(`a ${home} tenant cannot configure a bucket in ${otherRegion}`, () => {
    expect(() => validateS3Config(home, { bucket: 'fictional-bucket', region: otherRegion, prefix: '', roleArn: ROLE })).toThrow(DestinationError);
    expect(() => validateS3Config(home, { bucket: 'fictional-bucket', region: homeRegion, prefix: '', roleArn: ROLE })).not.toThrow();
  });

  it(`the ${home} cell's guarded factory refuses STS and S3 clients in ${otherRegion}`, () => {
    const clients = guardedAwsClients(home);
    expect(() => clients.sts(otherRegion)).toThrow(ResidencyViolationError);
    expect(() => clients.s3(otherRegion, { accessKeyId: 'x', secretAccessKey: 'y' })).toThrow(ResidencyViolationError);
    expect(() => clients.s3(homeRegion, { accessKeyId: 'x', secretAccessKey: 'y' })).not.toThrow();
  });

  it(`a bucket that reports ${otherRegion} is refused before any write`, async () => {
    const calls: string[] = [];
    const fake: AwsClients = {
      sts: () => ({ send: async (c: unknown) => (calls.push((c as object).constructor.name), { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' } }) }),
      s3: () => ({ send: async (c: unknown) => (calls.push((c as object).constructor.name), (c as object).constructor.name === 'HeadBucketCommand' ? { BucketRegion: otherRegion } : {}) }),
    };
    const dest = new S3Destination(home, crypto.randomUUID(), { bucket: 'fictional-bucket', region: homeRegion, prefix: '', roleArn: ROLE, externalId: EXTERNAL }, fake);
    await expect(dest.put({ name: 'x.csv', body: Buffer.from('a'), contentType: 'text/csv' })).rejects.toMatchObject({ code: 'bucketRegionMismatch' });
    expect(calls).not.toContain('PutObjectCommand');
  });

  it(`the ${home} API refuses a ${otherRegion} destination`, async () => {
    const ctx = await startTestApp({ cell: home, listen: false });
    try {
      const o = await ownerSession(ctx);
      const r = await ctx.app.inject({ method: 'POST', url: '/v1/data-exports/destinations', headers: { cookie: o.cookie }, remoteAddress: randomIp(), payload: { name: 'Elsewhere', kind: 's3', s3: { bucket: 'fictional-bucket', region: otherRegion, roleArn: ROLE } } });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: 'regionNotAllowed' });
    } finally {
      await ctx.close();
    }
  });

  it(`a ${home} cell refuses to start with a report reader in ${otherRegion}`, () => {
    const reader = `postgres://thapsus_reporting:x@thapsus.cluster-ro-abc.${otherRegion}.rds.amazonaws.com:5432/thapsus`;
    expect(() => assertCellResidency(home, { READER_DATABASES: JSON.stringify({ shared: reader }) })).toThrow(/Residency violation/);
    expect(() => assertCellResidency(home, { DEDICATED_READER_HOSTS: JSON.stringify({ acme: `acme.cluster-ro-x.${otherRegion}.rds.amazonaws.com` }) })).toThrow(/Residency violation/);
    expect(() => assertCellResidency(home, { READER_DATABASES: JSON.stringify({ shared: reader.replace(otherRegion, homeRegion) }) })).not.toThrow();
  });
});
