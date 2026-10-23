import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Bucket, File, GetFilesOptions, Storage } from '@google-cloud/storage';
import type { HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';
import { contentDisposition } from '../http/security';
import { GuardedBucket } from './gcs';

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
  /** Keys under a prefix (current objects). */
  list(prefix: string): Promise<string[]>;
  /** Permanently deletes every object AND every stored version under a prefix; returns how many keys were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

export const objectKey = (tenantId: string, area: string, ext = '') =>
  `${tenantId}/${area}/${randomUUID()}${ext}`;

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
  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (const k of keys) this.objects.delete(k);
    return keys.length;
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
    this.client = createAwsClientFactory({ cell, endpoints: endpoint ? { s3: endpoint } : {} })(
      S3Client,
      's3',
    );
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
        // RFC 6266: a sanitised ASCII name plus the exact UTF-8 name (ASVS V5.4.2)
        ResponseContentDisposition: filename ? contentDisposition(filename) : 'attachment',
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
  async list(prefix: string) {
    const out = new Set<string>();
    for await (const v of this.versions(prefix)) if (v.latest && !v.deleteMarker) out.add(v.key);
    return [...out].sort();
  }
  /** The bucket is versioned, so verified deletion removes every version and delete marker. */
  async deletePrefix(prefix: string) {
    if (!prefix.includes('/')) throw new Error('refusing to delete a prefix without a tenant path segment');
    const keys = new Set<string>();
    let batch: Array<{ Key: string; VersionId?: string }> = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch, Quiet: true } }),
      );
      batch = [];
    };
    for await (const v of this.versions(prefix)) {
      keys.add(v.key);
      batch.push({ Key: v.key, VersionId: v.versionId });
      if (batch.length === 1000) await flush();
    }
    await flush();
    return keys.size;
  }
  private async *versions(prefix: string) {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: prefix, KeyMarker, VersionIdMarker }),
      );
      for (const v of page.Versions ?? [])
        yield { key: v.Key!, versionId: v.VersionId, latest: !!v.IsLatest, deleteMarker: false };
      for (const d of page.DeleteMarkers ?? [])
        yield { key: d.Key!, versionId: d.VersionId, latest: !!d.IsLatest, deleteMarker: true };
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  }
}

/** Signed URL lifetime, the same as the S3 presigned URLs (5 minutes). */
const SIGNED_URL_TTL_MS = 300_000;

/**
 * Files in a Cloud Storage bucket (Google Cloud staging, ADR-0156): private, versioned, encrypted with the bucket's
 * default key (set by the infrastructure). The bucket's location is checked on first use. Signed URLs are V4; on
 * Cloud Run the library signs them through the IAM signBlob API with the service's own identity.
 */
export class GcsObjectStore implements ObjectStore {
  private readonly guarded: GuardedBucket;
  constructor(cell: HomeRegion, bucket: string, opts: { storage?: Storage } = {}) {
    this.guarded = new GuardedBucket(cell, bucket, opts.storage);
  }
  private async file(key: string): Promise<File> {
    return (await this.guarded.bucket()).file(key);
  }
  async presignPut(key: string, contentType: string, maxBytes: number) {
    void maxBytes; // size is validated again server-side when the upload is confirmed (as with S3)
    const [url] = await (
      await this.file(key)
    ).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + SIGNED_URL_TTL_MS, contentType });
    return url;
  }
  async presignGet(key: string, filename?: string) {
    const [url] = await (
      await this.file(key)
    ).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
      // RFC 6266: a sanitised ASCII name plus the exact UTF-8 name (ASVS V5.4.2)
      responseDisposition: filename ? contentDisposition(filename) : 'attachment',
    });
    return url;
  }
  async put(key: string, body: Buffer, contentType: string) {
    await (await this.file(key)).save(body, { contentType, resumable: false });
  }
  async get(key: string) {
    const [body] = await (await this.file(key)).download();
    return body;
  }
  async delete(key: string) {
    // In a versioned bucket the object becomes a noncurrent generation, like an S3 delete marker.
    await (await this.file(key)).delete({ ignoreNotFound: true });
  }
  async list(prefix: string) {
    const out: string[] = [];
    for await (const f of this.files(prefix, false)) out.push(f.name);
    return out.sort();
  }
  /** The bucket is versioned, so verified deletion removes every generation, current and noncurrent. */
  async deletePrefix(prefix: string) {
    if (!prefix.includes('/')) throw new Error('refusing to delete a prefix without a tenant path segment');
    const keys = new Set<string>();
    let batch: File[] = [];
    const flush = async () => {
      // Listed with versions: true, each File is scoped to its generation, so delete() removes exactly that one.
      await Promise.all(batch.map((f) => f.delete({ ignoreNotFound: true })));
      batch = [];
    };
    for await (const f of this.files(prefix, true)) {
      keys.add(f.name);
      batch.push(f);
      if (batch.length === 100) await flush();
    }
    await flush();
    return keys.size;
  }
  private async *files(prefix: string, versions: boolean) {
    const bucket: Bucket = await this.guarded.bucket();
    let query: GetFilesOptions | null = { prefix, versions, autoPaginate: false, maxResults: 1000 };
    while (query) {
      const [files, next]: [File[], unknown, unknown] = await bucket.getFiles(query);
      yield* files;
      query = (next as GetFilesOptions | null) ?? null;
    }
  }
}

export function objectStoreFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): ObjectStore {
  if (env.GCS_FILES_BUCKET && env.FILES_BUCKET)
    throw new Error('Set only one of GCS_FILES_BUCKET (Cloud Storage) and FILES_BUCKET (S3)');
  if (env.GCS_FILES_BUCKET) return new GcsObjectStore(cell, env.GCS_FILES_BUCKET);
  if (env.FILES_BUCKET)
    return new S3ObjectStore(cell, env.FILES_BUCKET, env.S3_ENDPOINT, env.FILES_KMS_KEY_ARN);
  const local = env.APP_ENV === 'dev' || env.APP_ENV === 'test' || env.APP_ENV === undefined;
  return new MemoryObjectStore(
    local ? { baseUrl: env.API_BASE_URL ?? 'http://localhost:4000', secret: randomBytes(32) } : undefined,
  );
}
