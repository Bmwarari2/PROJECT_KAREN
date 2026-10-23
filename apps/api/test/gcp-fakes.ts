import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyManagementServiceClient } from '@google-cloud/kms';
import type { Storage } from '@google-cloud/storage';

/**
 * In-memory stand-ins for the parts of @google-cloud/storage and @google-cloud/kms the adapters use (ADR-0156).
 * Tests never reach Google Cloud. Behaviour mirrors the real services where the adapters depend on it:
 * versioned buckets keep noncurrent generations, listings page, KMS binds ciphertext to its AAD.
 */
export interface FakeObject {
  name: string;
  generation: number;
  body: Buffer;
  contentType?: string;
  live: boolean;
}

export class FakeFile {
  readonly generation?: number;
  constructor(
    readonly bucket: FakeBucket,
    readonly name: string,
    opts: { generation?: number } = {},
  ) {
    this.generation = opts.generation;
  }
  async getSignedUrl(cfg: Record<string, unknown>): Promise<[string]> {
    this.bucket.signed.push({ name: this.name, ...cfg });
    return [
      `https://storage.googleapis.com/${this.bucket.name}/${encodeURIComponent(this.name)}?X-Goog-Signature=fake`,
    ];
  }
  async save(body: Buffer, opts: { contentType?: string; resumable?: boolean } = {}) {
    for (const o of this.bucket.objects) if (o.name === this.name) o.live = false;
    this.bucket.objects.push({
      name: this.name,
      generation: ++this.bucket.nextGeneration,
      body: Buffer.from(body),
      contentType: opts.contentType,
      live: true,
    });
    this.bucket.saves.push({ name: this.name, opts });
  }
  async download(): Promise<[Buffer]> {
    const o = this.bucket.objects.find((x) => x.name === this.name && x.live);
    if (!o) throw Object.assign(new Error('No such object'), { code: 404 });
    return [Buffer.from(o.body)];
  }
  async delete(opts: { ignoreNotFound?: boolean } = {}) {
    const list = this.bucket.objects;
    const i =
      this.generation === undefined
        ? list.findIndex((x) => x.name === this.name && x.live)
        : list.findIndex((x) => x.name === this.name && x.generation === this.generation);
    if (i < 0) {
      if (opts.ignoreNotFound) return [{}];
      throw Object.assign(new Error('No such object'), { code: 404 });
    }
    // A versioned bucket keeps the live object as a noncurrent generation; deleting a generation removes it.
    if (this.generation === undefined) list[i]!.live = false;
    else list.splice(i, 1);
    this.bucket.deletes.push({ name: this.name, generation: this.generation });
    return [{}];
  }
}

export class FakeBucket {
  objects: FakeObject[] = [];
  nextGeneration = 1_700_000_000_000_000;
  metadataCalls = 0;
  signed: Array<Record<string, unknown>> = [];
  saves: Array<{ name: string; opts: unknown }> = [];
  deletes: Array<{ name: string; generation?: number }> = [];
  pageSize = 1000;
  constructor(
    readonly name: string,
    public location = 'EUROPE-WEST2',
    public locationType = 'region',
  ) {}
  async getMetadata() {
    this.metadataCalls++;
    return [{ name: this.name, location: this.location, locationType: this.locationType }, {}];
  }
  file(name: string, opts: { generation?: number } = {}) {
    return new FakeFile(this, name, opts);
  }
  async getFiles(q: {
    prefix?: string;
    versions?: boolean;
    maxResults?: number;
    pageToken?: string;
    autoPaginate?: boolean;
  }) {
    const all = this.objects
      .filter((o) => o.name.startsWith(q.prefix ?? '') && (q.versions || o.live))
      .sort((a, b) => a.name.localeCompare(b.name) || a.generation - b.generation);
    // The page token is a cursor (the last name and generation returned), as in the real API, so deleting
    // objects that were already listed never makes a later page skip any.
    const size = Math.min(q.maxResults ?? 1000, this.pageSize);
    const key = (o: FakeObject) => `${o.name}\u0000${String(o.generation).padStart(20, '0')}`;
    const rest = q.pageToken ? all.filter((o) => key(o) > q.pageToken!) : all;
    const page = rest.slice(0, size);
    const files = page.map((o) => this.file(o.name, q.versions ? { generation: o.generation } : {}));
    const next = rest.length > size ? { ...q, pageToken: key(page[page.length - 1]!) } : null;
    return [files, next, {}];
  }
}

export class FakeStorage {
  readonly buckets = new Map<string, FakeBucket>();
  add(bucket: FakeBucket) {
    this.buckets.set(bucket.name, bucket);
    return this;
  }
  bucket(name: string) {
    const b = this.buckets.get(name);
    if (!b) throw new Error(`fake bucket ${name} not set up`);
    return b;
  }
  /** The fake typed as the real client, for constructor injection. */
  get asStorage(): Storage {
    return this as unknown as Storage;
  }
}

/** Cloud KMS encrypt/decrypt with authenticated additional data, like the real service. */
export class FakeKms {
  private readonly key = randomBytes(32);
  readonly calls: Array<{
    op: 'encrypt' | 'decrypt';
    name: string;
    plaintext?: Buffer;
    aad: Buffer;
  }> = [];
  async encrypt(req: { name: string; plaintext: Buffer; additionalAuthenticatedData: Buffer }) {
    this.calls.push({
      op: 'encrypt',
      name: req.name,
      plaintext: Buffer.from(req.plaintext),
      aad: Buffer.from(req.additionalAuthenticatedData),
    });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(req.additionalAuthenticatedData));
    const ct = Buffer.concat([c.update(req.plaintext), c.final()]);
    return [{ name: `${req.name}/cryptoKeyVersions/1`, ciphertext: Buffer.concat([iv, c.getAuthTag(), ct]) }];
  }
  async decrypt(req: { name: string; ciphertext: Buffer; additionalAuthenticatedData: Buffer }) {
    this.calls.push({ op: 'decrypt', name: req.name, aad: Buffer.from(req.additionalAuthenticatedData) });
    const blob = Buffer.from(req.ciphertext);
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
      d.setAAD(Buffer.from(req.additionalAuthenticatedData));
      d.setAuthTag(blob.subarray(12, 28));
      return [{ plaintext: Buffer.concat([d.update(blob.subarray(28)), d.final()]) }];
    } catch {
      throw Object.assign(new Error('3 INVALID_ARGUMENT: Decryption failed'), { code: 3 });
    }
  }
  get asClient(): KeyManagementServiceClient {
    return this as unknown as KeyManagementServiceClient;
  }
}
