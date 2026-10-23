import type { Bucket, Storage } from '@google-cloud/storage';
import {
  assertGcpLocationAllowed,
  gcpLocationOf,
  GcpResidencyViolationError,
  type HomeRegion,
} from '@thapsus/core';

/**
 * Cloud Storage access for a cell on Google Cloud (staging, ADR-0156). A bucket name carries no location, so a
 * bucket is used only after its metadata shows a single region equal to the cell's Google Cloud region:
 * multi-regions and dual-regions keep copies elsewhere and are refused like any other region.
 */

/**
 * The Storage client from Application Default Credentials. On Cloud Run that is the service's identity; there is no
 * key file, so the library signs URLs through the IAM signBlob API. Loaded on first use only, so AWS cells, tests
 * and local development never load the library.
 */
export async function defaultStorage(): Promise<Storage> {
  const { Storage } = await import('@google-cloud/storage');
  return new Storage();
}

export class GuardedBucket {
  private opened?: Promise<Bucket>;
  constructor(
    readonly cell: HomeRegion,
    readonly name: string,
    private readonly storage?: Storage,
  ) {}

  /** The bucket, once its location has been checked. A residency refusal is final; other errors are retried. */
  bucket(): Promise<Bucket> {
    this.opened ??= this.open().catch((err: unknown) => {
      if (!(err instanceof GcpResidencyViolationError)) this.opened = undefined;
      throw err;
    });
    return this.opened;
  }

  private async open(): Promise<Bucket> {
    const bucket = (this.storage ?? (await defaultStorage())).bucket(this.name);
    const [meta] = await bucket.getMetadata();
    const location = gcpLocationOf(String(meta.location ?? '')) ?? '';
    if (meta.locationType && String(meta.locationType).toLowerCase() !== 'region')
      throw new GcpResidencyViolationError(
        `${location} (${String(meta.locationType)})`,
        this.cell,
        'runtime',
      );
    assertGcpLocationAllowed(this.cell, location);
    return bucket;
  }
}
