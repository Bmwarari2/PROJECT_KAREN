import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { assertResourceInRegion, type HomeRegion } from '@thapsus/core';
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
  private aad(context: Record<string, string>) {
    return createHash('sha256').update(JSON.stringify(Object.entries(context).sort())).digest();
  }
  async generateDataKey(context: Record<string, string>) {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.master, iv);
    c.setAAD(this.aad(context));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]) };
  }
  async decryptDataKey(wrapped: Buffer, context: Record<string, string>) {
    const d = createDecipheriv('aes-256-gcm', this.master, wrapped.subarray(0, 12));
    d.setAAD(this.aad(context));
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
    const out = await this.client.send(new DecryptCommand({ CiphertextBlob: wrapped, EncryptionContext: context, KeyId: this.keyId }));
    return Buffer.from(out.Plaintext!);
  }
}

export async function seal(kp: KeyProvider, plaintext: string, context: Record<string, string>): Promise<Envelope> {
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
  if (env.KMS_KEY_ARN) return new AwsKmsKeyProvider(env.KMS_KEY_ARN, cell);
  if (env.APP_ENV === 'prod' || env.APP_ENV === 'staging') throw new Error('KMS_KEY_ARN is required outside dev/test');
  return new LocalKeyProvider(env.LOCAL_KMS_KEY ?? '0'.repeat(64));
}
