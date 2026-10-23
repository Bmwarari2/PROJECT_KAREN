import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyManagementServiceClient } from '@google-cloud/kms';
import { assertGcpResourceAllowed, assertResourceInRegion, type HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';

/**
 * Envelope encryption for field-level protection of sensitive data.
 * A fresh 256-bit data key per value is wrapped by the cell's regional KMS key (or the local mock),
 * and the value is sealed with AES-256-GCM bound to its tenant/category/field via AAD.
 */
export interface KeyProvider {
  readonly keyId: string;
  generateDataKey(context: Record<string, string>): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  decryptDataKey(wrapped: Buffer, context: Record<string, string>): Promise<Buffer>;
}

export interface Envelope {
  v: 1;
  kid: string;
  wdek: string;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * The additional authenticated data a wrapped data key is bound to: SHA-256 of the context entries, sorted. The local
 * provider and Cloud KMS use it, so a wrapped key opens only under the same tenant, category and field.
 */
export function contextAad(context: Record<string, string>): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(context).sort()))
    .digest();
}

/** Local/test mock of KMS: wraps data keys with a master key from configuration. Never used in AWS. */
export class LocalKeyProvider implements KeyProvider {
  private readonly master: Buffer;
  constructor(
    masterKeyHex: string,
    readonly keyId = 'local-kms',
  ) {
    this.master = Buffer.from(masterKeyHex, 'hex');
    if (this.master.length !== 32) throw new Error('LOCAL_KMS_KEY must be 32 bytes hex');
  }
  async generateDataKey(context: Record<string, string>) {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.master, iv);
    c.setAAD(contextAad(context));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]) };
  }
  async decryptDataKey(wrapped: Buffer, context: Record<string, string>) {
    const d = createDecipheriv('aes-256-gcm', this.master, wrapped.subarray(0, 12));
    d.setAAD(contextAad(context));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

/** AWS KMS in the cell's home region (client created through the residency guard). */
export class AwsKmsKeyProvider implements KeyProvider {
  private readonly client: KMSClient;
  constructor(
    readonly keyId: string,
    cell: HomeRegion,
  ) {
    assertResourceInRegion(cell, keyId);
    this.client = createAwsClientFactory({ cell })(KMSClient, 'kms');
  }
  async generateDataKey(context: Record<string, string>) {
    const out = await this.client.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }),
    );
    return { plaintext: Buffer.from(out.Plaintext!), wrapped: Buffer.from(out.CiphertextBlob!) };
  }
  async decryptDataKey(wrapped: Buffer, context: Record<string, string>) {
    const out = await this.client.send(
      new DecryptCommand({ CiphertextBlob: wrapped, EncryptionContext: context, KeyId: this.keyId }),
    );
    return Buffer.from(out.Plaintext!);
  }
}

/** Protobuf bytes arrive as a Uint8Array over gRPC and as base64 text over the REST fallback. */
const kmsBytes = (v: Uint8Array | string) =>
  typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v);

/** Full resource name of a Cloud KMS crypto key (not a key ring, not a key version). */
const CRYPTO_KEY_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/**
 * Cloud KMS in the cell's Google Cloud region (staging, ADR-0156). Cloud KMS has no data-key API, so each 256-bit
 * data key is generated here and wrapped with `encrypt`, bound to the context through additionalAuthenticatedData
 * (contextAad, as in the local provider); `decrypt` must present the same AAD. The key's location is checked by the
 * residency guard. The client comes from Application Default Credentials unless one is injected, and the library is
 * loaded only on first use.
 */
export class GcpKmsKeyProvider implements KeyProvider {
  private client?: Promise<KeyManagementServiceClient>;
  constructor(
    readonly keyId: string,
    cell: HomeRegion,
    opts: { client?: KeyManagementServiceClient } = {},
  ) {
    if (!CRYPTO_KEY_NAME.test(keyId))
      throw new Error(
        'GCP_KMS_KEY must be a full crypto key resource name: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>',
      );
    assertGcpResourceAllowed(cell, keyId);
    if (opts.client) this.client = Promise.resolve(opts.client);
  }
  private kms(): Promise<KeyManagementServiceClient> {
    this.client ??= import('@google-cloud/kms').then((m) => new m.KeyManagementServiceClient());
    return this.client;
  }
  async generateDataKey(context: Record<string, string>) {
    const plaintext = randomBytes(32);
    const [out] = await (
      await this.kms()
    ).encrypt({ name: this.keyId, plaintext, additionalAuthenticatedData: contextAad(context) });
    if (!out.ciphertext) throw new Error('Cloud KMS returned no ciphertext');
    return { plaintext, wrapped: kmsBytes(out.ciphertext) };
  }
  async decryptDataKey(wrapped: Buffer, context: Record<string, string>) {
    const [out] = await (
      await this.kms()
    ).decrypt({ name: this.keyId, ciphertext: wrapped, additionalAuthenticatedData: contextAad(context) });
    if (!out.plaintext) throw new Error('Cloud KMS returned no plaintext');
    return kmsBytes(out.plaintext);
  }
}

export async function seal(
  kp: KeyProvider,
  plaintext: string,
  context: Record<string, string>,
): Promise<Envelope> {
  const { plaintext: dek, wrapped } = await kp.generateDataKey(context);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(Buffer.from(JSON.stringify(Object.entries(context).sort())));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  dek.fill(0);
  return {
    v: 1,
    kid: kp.keyId,
    wdek: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export async function open(kp: KeyProvider, env: Envelope, context: Record<string, string>): Promise<string> {
  const dek = await kp.decryptDataKey(Buffer.from(env.wdek, 'base64'), context);
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(Object.entries(context).sort())));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

export function keyProviderFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): KeyProvider {
  if (env.KMS_KEY_ARN && env.GCP_KMS_KEY)
    throw new Error('Set only one of KMS_KEY_ARN (AWS KMS) and GCP_KMS_KEY (Cloud KMS)');
  if (env.KMS_KEY_ARN) return new AwsKmsKeyProvider(env.KMS_KEY_ARN, cell);
  if (env.GCP_KMS_KEY) return new GcpKmsKeyProvider(env.GCP_KMS_KEY, cell);
  if (env.APP_ENV === 'prod' || env.APP_ENV === 'staging')
    throw new Error('KMS_KEY_ARN or GCP_KMS_KEY is required outside dev/test');
  return new LocalKeyProvider(env.LOCAL_KMS_KEY ?? '0'.repeat(64));
}
