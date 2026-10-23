import { describe, expect, it } from 'vitest';
import { GcpResidencyViolationError, REGIONS, regionPairs } from '@thapsus/core';
import { BucketMailer, mailerFromEnv } from '../src/lib/mailer';
import { FakeBucket, FakeStorage } from './gcp-fakes';

/** Staging email capture in a Cloud Storage bucket (ADR-0156). Fake Storage client; fictional people only. */
const MAIL = {
  to: 'pat.fictional@example.test',
  subject: 'Your sign-in link for Fictional Ltd',
  text: 'Sign in: https://app.example.test/auth/magic?token=fictional-token',
  html: '<p>Sign in: <a href="https://app.example.test/auth/magic?token=fictional-token">link</a></p>',
};
const setup = (location = 'EUROPE-WEST2', cell: 'uk' | 'eu' | 'us' = 'uk') => {
  const bucket = new FakeBucket('thapsus-hr-staging-uk-mail', location);
  const storage = new FakeStorage().add(bucket);
  const mailer = new BucketMailer(cell, bucket.name, 'no-reply@example.test', {
    storage: storage.asStorage,
    now: () => new Date('2026-10-23T09:08:07.654Z'),
  });
  return { bucket, mailer };
};

describe('BucketMailer', () => {
  it('writes each message as an RFC 822 .eml object named only by date, time and a random id', async () => {
    const { bucket, mailer } = setup();
    await mailer.send(MAIL);
    await mailer.send({ ...MAIL, html: undefined });
    expect(bucket.objects).toHaveLength(2);
    const [first, second] = bucket.objects;
    expect(first!.name).toMatch(/^mail\/2026-10-23\/090807-[0-9a-f-]{36}\.eml$/);
    expect(first!.name).not.toBe(second!.name);
    for (const o of bucket.objects) expect(o.name).not.toMatch(/pat|fictional|example|sign/i);
    expect(first!.contentType).toBe('message/rfc822');
    expect(bucket.saves[0]!.opts).toEqual({ contentType: 'message/rfc822', resumable: false });
    const eml = first!.body.toString('utf8');
    expect(eml).toMatch(/^From: no-reply@example\.test$/m);
    expect(eml).toMatch(/^To: pat\.fictional@example\.test$/m);
    expect(eml).toMatch(/^Subject: Your sign-in link for Fictional Ltd$/m);
    expect(eml).toMatch(/^MIME-Version: 1\.0$/m);
    expect(eml).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(eml).toContain('token=fictional-token');
    expect(second!.body.toString('utf8')).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(mailer.region).toBe('uk');
  });

  it.each(regionPairs())('a %s cell refuses a mail bucket in the %s region', async (home, other) => {
    const { bucket, mailer } = setup(REGIONS[other].gcpRegion.toUpperCase(), home);
    await expect(mailer.send(MAIL)).rejects.toThrow(GcpResidencyViolationError);
    expect(bucket.objects).toEqual([]);
  });

  it('refuses multi-region and dual-region buckets', async () => {
    for (const location of ['EU', 'NAM4']) {
      const { bucket, mailer } = setup(location);
      await expect(mailer.send(MAIL)).rejects.toThrow(GcpResidencyViolationError);
      expect(bucket.objects).toEqual([]);
    }
  });
});

describe('mailerFromEnv with MAIL_TRANSPORT=bucket', () => {
  it('is allowed only in dev, test and staging, and needs MAIL_BUCKET', () => {
    for (const APP_ENV of ['dev', 'test', 'staging'])
      expect(
        mailerFromEnv('uk', { APP_ENV, MAIL_TRANSPORT: 'bucket', MAIL_BUCKET: 'thapsus-hr-staging-uk-mail' }),
      ).toBeInstanceOf(BucketMailer);
    for (const APP_ENV of ['prod', 'loadtest', undefined])
      expect(
        () =>
          mailerFromEnv('uk', {
            APP_ENV,
            MAIL_TRANSPORT: 'bucket',
            MAIL_BUCKET: 'thapsus-hr-staging-uk-mail',
          }),
        String(APP_ENV),
      ).toThrow(/only allowed in dev, test and staging/);
    expect(() => mailerFromEnv('uk', { APP_ENV: 'staging', MAIL_TRANSPORT: 'bucket' })).toThrow(
      /MAIL_BUCKET/,
    );
  });
});
