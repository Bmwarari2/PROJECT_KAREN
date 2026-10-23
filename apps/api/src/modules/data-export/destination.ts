import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { REGIONS, type HomeRegion } from '@thapsus/core';
import { createAwsClientFactory, ResidencyViolationError } from '@thapsus/core/aws';
import { SftpError, uploadSftp } from '../payroll/sftp';

/**
 * Delivery destinations for scheduled data exports (PROGRESS 7.3), behind one small interface so the payroll
 * SFTP transport (phase 6) and audit streaming to S3 (phase 9) can share it later. Destinations are the
 * customer's own systems (docs/SUBPROCESSORS.md): an S3 bucket in the tenant's HOME REGION reached by assuming
 * a role in the customer's account (name prefix `thapsus-hr-export-`, ExternalId), or an SFTP server with a
 * pinned host key. Every AWS client comes from the residency-guarded factory.
 */
export interface DeliveryFile {
  /** Relative path below the destination's prefix / directory, e.g. "employees/employees-2026-10-18.csv". */
  name: string;
  body: Buffer;
  contentType: string;
}

export interface Destination {
  readonly kind: 's3' | 'sftp';
  /** Target without secrets, for the UI and the delivery log. */
  describe(): string;
  /** Proves the destination is reachable and writable (writes a small marker file; S3 removes it again). */
  test(): Promise<void>;
  put(file: DeliveryFile): Promise<{ path: string; bytes: number }>;
}

export type DestinationErrorCode =
  | 'invalidConfig'
  | 'regionNotAllowed'
  | 'bucketRegionMismatch'
  | 'assumeRoleFailed'
  | 'accessDenied'
  | 'hostNotAllowed'
  | 'hostKeyMismatch'
  | 'authFailed'
  | 'timeout'
  | 'connect'
  | 'transfer';
/** Errors worth retrying (the job backs off); every other code needs the customer to fix the configuration. */
export const TRANSIENT: DestinationErrorCode[] = ['timeout', 'connect', 'transfer'];

export class DestinationError extends Error {
  constructor(
    readonly code: DestinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationError';
  }
}

// ---- S3 (customer bucket, home region only) ---------------------------------------------------------------
export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  roleArn: string;
  externalId: string;
}

/** Customer roles the cell's task role may assume (the CDK policy grants sts:AssumeRole on this prefix only). */
export const EXPORT_ROLE_PREFIX = 'thapsus-hr-export-';
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/thapsus-hr-export-[A-Za-z0-9+=,.@_-]{1,40}$/;
const BUCKET = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const newExternalId = () => `thr-${randomBytes(16).toString('hex')}`;

/** Refuses a bucket outside the tenant's home region and roles outside the allowed name prefix. */
export function validateS3Config(
  cell: HomeRegion,
  c: Omit<S3Config, 'externalId'> & { externalId?: string },
) {
  const home = REGIONS[cell].awsRegion;
  if (c.region !== home)
    throw new DestinationError(
      'regionNotAllowed',
      `The bucket must be in ${home}, this workspace's home region`,
    );
  if (!BUCKET.test(c.bucket)) throw new DestinationError('invalidConfig', 'Invalid bucket name');
  if (!ROLE_ARN.test(c.roleArn))
    throw new DestinationError('invalidConfig', `The role name must start with ${EXPORT_ROLE_PREFIX}`);
  if (
    c.prefix &&
    (c.prefix.startsWith('/') ||
      c.prefix.split('/').includes('..') ||
      !/^[A-Za-z0-9!_.*'()/-]{0,200}$/.test(c.prefix))
  )
    throw new DestinationError('invalidConfig', 'Invalid key prefix');
  if (c.externalId !== undefined && !/^thr-[0-9a-f]{32}$/.test(c.externalId))
    throw new DestinationError('invalidConfig', 'Invalid external id');
}

type Sender = { send(cmd: unknown): Promise<unknown> };
/** Client creation seam: production uses the residency-guarded factory; tests pass recording fakes. */
export interface AwsClients {
  sts(region: string): Sender;
  s3(
    region: string,
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  ): Sender;
}

export function guardedAwsClients(
  cell: HomeRegion,
  endpoints: Partial<Record<string, string>> = {},
): AwsClients {
  const create = createAwsClientFactory({ cell, endpoints });
  return {
    sts: (region) => create(STSClient, 'sts', { region }),
    s3: (region, credentials) => create(S3Client, 's3', { region, credentials }),
  };
}

export class S3Destination implements Destination {
  readonly kind = 's3' as const;
  constructor(
    private readonly cell: HomeRegion,
    private readonly tenantId: string,
    private readonly c: S3Config,
    private readonly clients: AwsClients = guardedAwsClients(cell),
  ) {
    validateS3Config(cell, c);
  }

  describe() {
    return `s3://${this.c.bucket}/${this.c.prefix}`;
  }

  private async client(): Promise<Sender> {
    const home = REGIONS[this.cell].awsRegion;
    let creds: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string } | undefined;
    try {
      const out = (await this.clients.sts(home).send(
        new AssumeRoleCommand({
          RoleArn: this.c.roleArn,
          RoleSessionName: `thapsus-hr-export-${this.tenantId.slice(0, 8)}`,
          ExternalId: this.c.externalId,
          DurationSeconds: 900,
        }),
      )) as { Credentials?: typeof creds };
      creds = out.Credentials;
    } catch (err) {
      if (err instanceof ResidencyViolationError) throw err;
      throw new DestinationError(
        'assumeRoleFailed',
        'Could not assume the export role (check its trust policy and external id)',
      );
    }
    if (!creds?.AccessKeyId || !creds.SecretAccessKey)
      throw new DestinationError('assumeRoleFailed', 'The export role returned no credentials');
    const s3 = this.clients.s3(this.c.region, {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    });
    // The bucket must really be in the home region: S3 reports its region on HeadBucket (or redirects).
    let bucketRegion: string | undefined;
    try {
      bucketRegion = (
        (await s3.send(new HeadBucketCommand({ Bucket: this.c.bucket }))) as { BucketRegion?: string }
      ).BucketRegion;
    } catch (err) {
      const e = err as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
        $response?: { headers?: Record<string, string> };
      };
      const redirected = e.$response?.headers?.['x-amz-bucket-region'];
      if (redirected || e.name === 'PermanentRedirect' || e.$metadata?.httpStatusCode === 301)
        throw new DestinationError('bucketRegionMismatch', `The bucket is not in ${home}`);
      throw new DestinationError(
        e.$metadata?.httpStatusCode === 403 ? 'accessDenied' : 'connect',
        'The bucket could not be reached with the export role',
      );
    }
    if (bucketRegion && bucketRegion !== home)
      throw new DestinationError('bucketRegionMismatch', `The bucket is in ${bucketRegion}, not ${home}`);
    return s3;
  }

  private key(name: string) {
    return `${this.c.prefix ? this.c.prefix.replace(/\/?$/, '/') : ''}${name.replace(/^\/+/, '')}`;
  }

  async test() {
    const s3 = await this.client();
    const key = this.key(`.thapsus-hr-connection-test-${randomBytes(4).toString('hex')}`);
    await s3
      .send(
        new PutObjectCommand({
          Bucket: this.c.bucket,
          Key: key,
          Body: Buffer.from('ok\n'),
          ContentType: 'text/plain',
        }),
      )
      .catch(() => {
        throw new DestinationError('accessDenied', 'The export role cannot write to the bucket');
      });
    await s3.send(new DeleteObjectCommand({ Bucket: this.c.bucket, Key: key })).catch(() => undefined);
  }

  async put(file: DeliveryFile) {
    const s3 = await this.client();
    const key = this.key(file.name);
    await s3
      .send(
        new PutObjectCommand({
          Bucket: this.c.bucket,
          Key: key,
          Body: file.body,
          ContentType: file.contentType,
        }),
      )
      .catch((err: { $metadata?: { httpStatusCode?: number } }) => {
        throw new DestinationError(
          err.$metadata?.httpStatusCode === 403 ? 'accessDenied' : 'transfer',
          'Upload to the bucket failed',
        );
      });
    return { path: `s3://${this.c.bucket}/${key}`, bytes: file.body.length };
  }
}

// ---- SFTP (reuses the phase 6 pinned-host-key transport) -------------------------------------------------
export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  directory: string;
  hostKeySha256: string;
  auth: 'password' | 'key';
}
export interface SftpSecrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
export const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function validateSftpConfig(c: SftpConfig) {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(c.host))
    throw new DestinationError('invalidConfig', 'Invalid host name');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new DestinationError('invalidConfig', 'Invalid port');
  if (!HOST_KEY.test(c.hostKeySha256))
    throw new DestinationError('invalidConfig', 'Pin the server host key (OpenSSH SHA256 fingerprint)');
  if (c.directory && (c.directory.split('/').includes('..') || !/^[A-Za-z0-9._/-]{0,200}$/.test(c.directory)))
    throw new DestinationError('invalidConfig', 'Invalid directory');
}

const SFTP_CODES: Record<SftpError['code'], DestinationErrorCode> = {
  hostNotAllowed: 'hostNotAllowed',
  hostKeyMismatch: 'hostKeyMismatch',
  authFailed: 'authFailed',
  timeout: 'timeout',
  transfer: 'transfer',
  connect: 'connect',
};

export class SftpDestination implements Destination {
  readonly kind = 'sftp' as const;
  constructor(
    private readonly c: SftpConfig,
    private readonly secrets: SftpSecrets,
    private readonly opts: { allowPrivateHosts: boolean; timeoutMs?: number },
  ) {
    validateSftpConfig(c);
  }

  describe() {
    return `sftp://${this.c.host}:${this.c.port}/${this.c.directory.replace(/^\/+/, '')}`;
  }

  private async upload(name: string, body: Buffer) {
    const dir = posix.join(this.c.directory || '.', posix.dirname(name));
    try {
      return await uploadSftp(
        {
          host: this.c.host,
          port: this.c.port,
          username: this.c.username,
          directory: dir,
          hostKeySha256: this.c.hostKeySha256,
        },
        this.secrets,
        posix.basename(name),
        body,
        this.opts,
      );
    } catch (err) {
      if (err instanceof SftpError) throw new DestinationError(SFTP_CODES[err.code], err.message);
      throw new DestinationError('transfer', 'SFTP upload failed');
    }
  }

  async test() {
    await this.upload(`.thapsus-hr-connection-test-${randomBytes(4).toString('hex')}`, Buffer.from('ok\n'));
  }

  async put(file: DeliveryFile) {
    // flat file names in the configured directory (many SFTP servers refuse to create directories)
    return this.upload(posix.basename(file.name), file.body);
  }
}
