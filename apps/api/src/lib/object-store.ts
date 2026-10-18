import { randomUUID } from 'node:crypto';
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
  async presignPut(key: string) {
    return `memory://put/${encodeURIComponent(key)}`;
  }
  async presignGet(key: string) {
    return `memory://get/${encodeURIComponent(key)}`;
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
  return new MemoryObjectStore();
}
