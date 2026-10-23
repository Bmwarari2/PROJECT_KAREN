import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GcpResidencyViolationError, HOME_REGIONS, REGIONS, regionPairs } from '@thapsus/core';
import {
  AwsKmsKeyProvider,
  GcpKmsKeyProvider,
  keyProviderFromEnv,
  LocalKeyProvider,
  open,
  seal,
} from '../src/lib/kms';
import { FakeKms } from './gcp-fakes';

/** Envelope encryption with Cloud KMS (Google Cloud staging, ADR-0156). Fake KMS client; fictional data only. */
const keyName = (location: string) =>
  `projects/thapsus-hr-staging/locations/${location}/keyRings/thapsus-cell/cryptoKeys/sensitive-fields`;
const UK_KEY = keyName(REGIONS.uk.gcpRegion);
const ctx = { tenant: '00000000-0000-4000-8000-0000000000aa', category: 'health', field: 'fit_note' };
/** The local provider's derivation, written out independently: SHA-256 of the sorted context entries. */
const expectedAad = (c: Record<string, string>) =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(c).sort()))
    .digest();

describe('GcpKmsKeyProvider', () => {
  it('wraps a fresh 256-bit data key with Cloud KMS encrypt, bound to the context like the local provider', async () => {
    const kms = new FakeKms();
    const kp = new GcpKmsKeyProvider(UK_KEY, 'uk', { client: kms.asClient });
    expect(kp.keyId).toBe(UK_KEY);
    const { plaintext, wrapped } = await kp.generateDataKey(ctx);
    expect(plaintext).toHaveLength(32);
    expect(wrapped.equals(plaintext)).toBe(false);
    const call = kms.calls[0]!;
    expect(call.op).toBe('encrypt');
    expect(call.name).toBe(UK_KEY);
    expect(call.plaintext!.equals(plaintext)).toBe(true);
    expect(call.aad.equals(expectedAad(ctx))).toBe(true);
    // two keys are never the same
    expect((await kp.generateDataKey(ctx)).plaintext.equals(plaintext)).toBe(false);
  });

  it('unwraps with decrypt and the same AAD, whatever the order of the context keys', async () => {
    const kms = new FakeKms();
    const kp = new GcpKmsKeyProvider(UK_KEY, 'uk', { client: kms.asClient });
    const { plaintext, wrapped } = await kp.generateDataKey(ctx);
    const reordered = { field: ctx.field, category: ctx.category, tenant: ctx.tenant };
    expect((await kp.decryptDataKey(wrapped, reordered)).equals(plaintext)).toBe(true);
    const call = kms.calls.find((c) => c.op === 'decrypt')!;
    expect(call.name).toBe(UK_KEY);
    expect(call.aad.equals(expectedAad(ctx))).toBe(true);
  });

  it('refuses to unwrap under another tenant, category or field (wrong AAD)', async () => {
    const kp = new GcpKmsKeyProvider(UK_KEY, 'uk', { client: new FakeKms().asClient });
    const { wrapped } = await kp.generateDataKey(ctx);
    for (const other of [
      { ...ctx, tenant: '00000000-0000-4000-8000-0000000000bb' },
      { ...ctx, category: 'diversity' },
      { ...ctx, field: 'other' },
      { tenant: ctx.tenant, category: ctx.category },
    ])
      await expect(kp.decryptDataKey(wrapped, other)).rejects.toThrow(/Decryption failed/);
  });

  it('seals and opens a sensitive value end to end, and the envelope does not open under another context', async () => {
    const kp = new GcpKmsKeyProvider(UK_KEY, 'uk', { client: new FakeKms().asClient });
    const env = await seal(kp, 'Fictional fit note: back in two weeks', ctx);
    expect(env.kid).toBe(UK_KEY);
    expect(JSON.stringify(env)).not.toContain('Fictional');
    expect(await open(kp, env, ctx)).toBe('Fictional fit note: back in two weeks');
    await expect(open(kp, env, { ...ctx, tenant: '00000000-0000-4000-8000-0000000000bb' })).rejects.toThrow();
  });

  it.each(regionPairs())('a %s cell refuses a Cloud KMS key in the %s region', (home, other) => {
    expect(
      () =>
        new GcpKmsKeyProvider(keyName(REGIONS[other].gcpRegion), home, { client: new FakeKms().asClient }),
    ).toThrow(GcpResidencyViolationError);
  });

  it.each(HOME_REGIONS)(
    'a %s cell accepts its own key and refuses global, multi-region and malformed key names',
    (cell) => {
      const client = new FakeKms().asClient;
      expect(() => new GcpKmsKeyProvider(keyName(REGIONS[cell].gcpRegion), cell, { client })).not.toThrow();
      for (const bad of [keyName('global'), keyName('europe'), keyName('us')])
        expect(() => new GcpKmsKeyProvider(bad, cell, { client }), bad).toThrow(GcpResidencyViolationError);
      for (const bad of [
        'sensitive-fields',
        `projects/p/locations/${REGIONS[cell].gcpRegion}/keyRings/thapsus-cell`,
        `${keyName(REGIONS[cell].gcpRegion)}/cryptoKeyVersions/1`,
      ])
        expect(() => new GcpKmsKeyProvider(bad, cell, { client }), bad).toThrow(/crypto key resource name/);
    },
  );
});

describe('keyProviderFromEnv', () => {
  it('GCP_KMS_KEY selects Cloud KMS without contacting Google Cloud', () => {
    expect(keyProviderFromEnv('uk', { APP_ENV: 'staging', GCP_KMS_KEY: UK_KEY })).toBeInstanceOf(
      GcpKmsKeyProvider,
    );
    expect(
      keyProviderFromEnv('uk', {
        APP_ENV: 'staging',
        KMS_KEY_ARN: 'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555',
      }),
    ).toBeInstanceOf(AwsKmsKeyProvider);
    expect(() =>
      keyProviderFromEnv('uk', { APP_ENV: 'staging', GCP_KMS_KEY: keyName('europe-west3') }),
    ).toThrow(GcpResidencyViolationError);
  });

  it('staging and production still refuse to start without a real KMS key, and both keys at once are refused', () => {
    for (const APP_ENV of ['staging', 'prod'])
      expect(() => keyProviderFromEnv('uk', { APP_ENV })).toThrow(/KMS_KEY_ARN or GCP_KMS_KEY is required/);
    expect(() =>
      keyProviderFromEnv('uk', {
        APP_ENV: 'staging',
        GCP_KMS_KEY: UK_KEY,
        KMS_KEY_ARN: 'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555',
      }),
    ).toThrow(/only one/);
    expect(keyProviderFromEnv('uk', { APP_ENV: 'test' })).toBeInstanceOf(LocalKeyProvider);
  });
});
