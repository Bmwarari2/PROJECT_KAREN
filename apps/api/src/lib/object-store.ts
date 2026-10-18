import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';

/**
 * Files live in the home-region bucket (private, versioned, SSE-KMS). Clients upload and download
 * directly via short-lived presigned URLs. Object keys always start with the tenant id.
 */
export interface ObjectStore {
  presignPut(key: string, contentType: string, maxBytes: number): Promise<string>;
  presignGet(key: string, filename?: string): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const objectKey = (tenantId: string, area: string, ext = '') => `${tenantId}/${area}/${randomUUID()}${ext}`;

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  /**
   * Dev/test only: when `serve` is set, download links point at the API's `/v1/dev/objects` route with a
   * short-lived HMAC signature (like a presigned URL), so files can be downloaded without an S3 emulator.
   */
  constructor(readonly serve?: { baseUrl: string; secret: Buffer }) {}
  async presignPut(key: string) {
    return `memory://put/${encodeURIComponent(key)}`;
  }
  async presignGet(key: string, filename?: string) {
    if (!this.serve) return `memory://get/${encodeURIComponent(key)}`;
    const exp = String(Math.floor(Date.now() / 1000) + 300);
    const name = filename ?? key.split('/').pop() ?? 'file';
    const q = new URLSearchParams({ key, exp, name, sig: this.sign(key, exp, name) });
    return `${this.serve.baseUrl}/v1/dev/objects?${q.toString()}`;
  }
  private sign(key: string, exp: string, name: string) {
    return createHmac('sha256', this.serve!.secret).update(`${key}\n${exp}\n${name}`).digest('base64url');
  }
  /** Checks a dev download link; returns the object when the signature is valid and unexpired. */
  verify(q: { key: string; exp: string; name: string; sig: string }) {
    if (!this.serve || Number(q.exp) < Date.now() / 1000) return undefined;
    const want = Buffer.from(this.sign(q.key, q.exp, q.name));
    const got = Buffer.from(q.sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    return this.objects.get(q.key);
  }
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return o.body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  constructor(
    cell: HomeRegion,
    private readonly bucket: string,
    endpoint?: string,
    private readonly kmsKeyId?: string,
  ) {
    this.client = createAwsClientFactory({ cell, endpoints: endpoint ? { s3: endpoint } : {} })(S3Client, 's3');
  }
  async presignPut(key: string, contentType: string, maxBytes: number) {
    void maxBytes; // size is validated again server-side when the upload is confirmed
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ...(this.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
      { expiresIn: 300 },
    );
  }
  async presignGet(key: string, filename?: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/"/g, '')}"` : undefined,
      }),
      { expiresIn: 300 },
    );
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
    );
  }
  async get(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function objectStoreFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): ObjectStore {
  if (env.FILES_BUCKET) return new S3ObjectStore(cell, env.FILES_BUCKET, env.S3_ENDPOINT, env.FILES_KMS_KEY_ARN);
  const local = env.APP_ENV === 'dev' || env.APP_ENV === 'test' || env.APP_ENV === undefined;
  return new MemoryObjectStore(local ? { baseUrl: env.API_BASE_URL ?? 'http://localhost:4000', secret: randomBytes(32) } : undefined);
}
