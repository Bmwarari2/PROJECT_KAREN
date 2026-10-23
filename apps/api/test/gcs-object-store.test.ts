import { describe, expect, it } from 'vitest';
import { GcpResidencyViolationError, HOME_REGIONS, REGIONS, regionPairs } from '@thapsus/core';
import { GcsObjectStore, objectStoreFromEnv, S3ObjectStore } from '../src/lib/object-store';
import { contentDisposition } from '../src/http/security';
import { FakeBucket, FakeStorage } from './gcp-fakes';

/** Files in a Cloud Storage bucket (Google Cloud staging, ADR-0156). Fake Storage client; fictional data only. */
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const setup = (location = 'EUROPE-WEST2', locationType = 'region', cell: 'uk' | 'eu' | 'us' = 'uk') => {
  const bucket = new FakeBucket('thapsus-hr-staging-uk-files', location, locationType);
  const storage = new FakeStorage().add(bucket);
  return { bucket, store: new GcsObjectStore(cell, bucket.name, { storage: storage.asStorage }) };
};

describe('GcsObjectStore: bucket location', () => {
  it.each(regionPairs())(
    'a %s cell refuses a bucket in the %s region for every operation',
    async (home, other) => {
      const { store } = setup(REGIONS[other].gcpRegion.toUpperCase(), 'region', home);
      for (const op of [
        () => store.presignGet(`${TENANT}/docs/a.pdf`, 'a.pdf'),
        () => store.presignPut(`${TENANT}/docs/a.pdf`, 'application/pdf', 1024),
        () => store.put(`${TENANT}/docs/a.pdf`, Buffer.from('x'), 'application/pdf'),
        () => store.get(`${TENANT}/docs/a.pdf`),
        () => store.delete(`${TENANT}/docs/a.pdf`),
        () => store.list(`${TENANT}/`),
        () => store.deletePrefix(`${TENANT}/`),
      ])
        await expect(op()).rejects.toThrow(GcpResidencyViolationError);
    },
  );

  it.each([
    ['EU', 'multi-region'],
    ['US', 'multi-region'],
    ['EUR4', 'dual-region'],
    ['NAM4', 'dual-region'],
    ['EUROPE-WEST2', 'dual-region'],
  ])('refuses a %s %s bucket', async (location, type) => {
    const { store, bucket } = setup(location, type);
    await expect(store.put(`${TENANT}/x`, Buffer.from('x'), 'text/plain')).rejects.toThrow(
      GcpResidencyViolationError,
    );
    expect(bucket.objects).toEqual([]);
  });

  it.each(HOME_REGIONS)(
    'accepts a %s cell bucket in its own region and checks it only once',
    async (cell) => {
      const { store, bucket } = setup(REGIONS[cell].gcpRegion.toUpperCase(), 'region', cell);
      await store.put(`${TENANT}/a`, Buffer.from('a'), 'text/plain');
      await store.get(`${TENANT}/a`);
      await store.list(`${TENANT}/`);
      expect(bucket.metadataCalls).toBe(1);
    },
  );
});

describe('GcsObjectStore: signed URLs', () => {
  it('download links are V4, short-lived and carry the RFC 6266 content disposition', async () => {
    const { store, bucket } = setup();
    const before = Date.now();
    const url = await store.presignGet(`${TENANT}/payslips/p.pdf`, 'Fictional payslip – März.pdf');
    expect(url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    await store.presignGet(`${TENANT}/payslips/q.pdf`);
    const [named, unnamed] = bucket.signed as Array<{
      name: string;
      version: string;
      action: string;
      expires: number;
      responseDisposition: string;
    }>;
    expect(named).toMatchObject({
      name: `${TENANT}/payslips/p.pdf`,
      version: 'v4',
      action: 'read',
      responseDisposition: contentDisposition('Fictional payslip – März.pdf'),
    });
    expect(named!.expires - before).toBeGreaterThanOrEqual(299_000);
    expect(named!.expires - before).toBeLessThanOrEqual(305_000);
    expect(unnamed!.responseDisposition).toBe('attachment');
  });

  it('upload links are V4 writes bound to the content type, with the same short expiry', async () => {
    const { store, bucket } = setup();
    const before = Date.now();
    await store.presignPut(`${TENANT}/docs/c.pdf`, 'application/pdf', 5_000_000);
    expect(bucket.signed[0]).toMatchObject({
      name: `${TENANT}/docs/c.pdf`,
      version: 'v4',
      action: 'write',
      contentType: 'application/pdf',
    });
    const expires = bucket.signed[0]!.expires as number;
    expect(expires - before).toBeGreaterThanOrEqual(299_000);
    expect(expires - before).toBeLessThanOrEqual(305_000);
  });
});

describe('GcsObjectStore: objects', () => {
  it('puts, gets, lists current objects under a prefix and deletes', async () => {
    const { store, bucket } = setup();
    await store.put(`${TENANT}/docs/b`, Buffer.from('bee'), 'text/plain');
    await store.put(`${TENANT}/docs/a`, Buffer.from('ay'), 'text/plain');
    await store.put('00000000-0000-4000-8000-0000000000bb/docs/z', Buffer.from('other'), 'text/plain');
    expect(bucket.saves[0]).toEqual({
      name: `${TENANT}/docs/b`,
      opts: { contentType: 'text/plain', resumable: false },
    });
    expect((await store.get(`${TENANT}/docs/a`)).toString()).toBe('ay');
    expect(await store.list(`${TENANT}/`)).toEqual([`${TENANT}/docs/a`, `${TENANT}/docs/b`]);
    await store.delete(`${TENANT}/docs/a`);
    await store.delete(`${TENANT}/docs/never-existed`);
    expect(await store.list(`${TENANT}/`)).toEqual([`${TENANT}/docs/b`]);
    await expect(store.get(`${TENANT}/docs/a`)).rejects.toThrow();
  });

  it('lists across pages', async () => {
    const { store, bucket } = setup();
    bucket.pageSize = 2;
    for (const k of ['e', 'd', 'c', 'b', 'a'])
      await store.put(`${TENANT}/p/${k}`, Buffer.from(k), 'text/plain');
    expect(await store.list(`${TENANT}/p/`)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((k) => `${TENANT}/p/${k}`),
    );
  });

  it('deletePrefix removes every object and every noncurrent generation, across pages, and nothing else', async () => {
    const { store, bucket } = setup();
    bucket.pageSize = 2;
    const other = '00000000-0000-4000-8000-0000000000bb/docs/keep';
    await store.put(`${TENANT}/docs/a`, Buffer.from('v1'), 'text/plain');
    await store.put(`${TENANT}/docs/a`, Buffer.from('v2'), 'text/plain'); // v1 becomes noncurrent
    await store.put(`${TENANT}/docs/b`, Buffer.from('b'), 'text/plain');
    await store.delete(`${TENANT}/docs/b`); // only a noncurrent generation is left
    await store.put(`${TENANT}/exports/c`, Buffer.from('c'), 'text/plain');
    await store.put(other, Buffer.from('keep'), 'text/plain');
    expect(bucket.objects.filter((o) => o.name.startsWith(TENANT))).toHaveLength(4);

    const deletesBefore = bucket.deletes.length;
    expect(await store.deletePrefix(`${TENANT}/`)).toBe(3);
    expect(bucket.objects.map((o) => o.name)).toEqual([other]);
    // every deletion named its generation (a plain delete would only leave another noncurrent version)
    const purged = bucket.deletes.slice(deletesBefore);
    expect(purged).toHaveLength(4);
    expect(purged.every((d) => d.generation !== undefined)).toBe(true);
    await expect(store.deletePrefix('no-tenant-segment')).rejects.toThrow(/tenant path segment/);
  });

  it('deletePrefix keeps going while it deletes (more objects than one page and one batch)', async () => {
    const { store, bucket } = setup();
    bucket.pageSize = 7;
    for (let i = 0; i < 250; i++)
      await store.put(`${TENANT}/bulk/${String(i).padStart(3, '0')}`, Buffer.from('x'), 'text/plain');
    expect(await store.deletePrefix(`${TENANT}/bulk/`)).toBe(250);
    expect(bucket.objects).toEqual([]);
  });
});

describe('objectStoreFromEnv', () => {
  it('GCS_FILES_BUCKET selects Cloud Storage without contacting Google Cloud; FILES_BUCKET still selects S3', () => {
    expect(objectStoreFromEnv('uk', { GCS_FILES_BUCKET: 'thapsus-hr-staging-uk-files' })).toBeInstanceOf(
      GcsObjectStore,
    );
    expect(objectStoreFromEnv('uk', { FILES_BUCKET: 'thapsus-hr-staging-eu-west-2-files' })).toBeInstanceOf(
      S3ObjectStore,
    );
    expect(() =>
      objectStoreFromEnv('uk', { GCS_FILES_BUCKET: 'a', FILES_BUCKET: 'thapsus-hr-staging-eu-west-2-files' }),
    ).toThrow(/only one/);
  });
});
