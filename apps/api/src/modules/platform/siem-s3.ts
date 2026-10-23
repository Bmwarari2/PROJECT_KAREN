import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { assertRegionAllowed, assertResourceInRegion, REGIONS, type HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';

/**
 * Audit streaming to a customer-owned S3 bucket through a cross-account IAM role the customer creates
 * (trust policy: our cell's task role + an ExternalId unique to the stream). Both the STS and S3 clients
 * come from the residency-guarded factory, so the bucket must be in the tenant's home region: a client
 * for any other region is refused (ResidencyViolationError) and no request leaves the cell.
 */

/**
 * Customer roles the cell worker may assume for S3 audit streams. The CDK cell stack grants
 * sts:AssumeRole on arn:aws:iam::*:role/thapsus-hr-audit-* only (ADR-0069), so the API refuses any
 * other role name when a stream is saved and the writer refuses it again before calling STS. No role
 * path: IAM matches the prefix against the whole path-and-name. Role names are at most 64 characters.
 */
export const AUDIT_STREAM_ROLE_PREFIX = 'thapsus-hr-audit-';
const AUDIT_STREAM_ROLE_ARN = new RegExp(
  `^arn:aws:iam::\\d{12}:role/${AUDIT_STREAM_ROLE_PREFIX}[A-Za-z0-9+=,.@_-]{1,${64 - AUDIT_STREAM_ROLE_PREFIX.length}}$`,
);
export const isAuditStreamRoleArn = (arn: string) => AUDIT_STREAM_ROLE_ARN.test(arn);
export interface CrossAccountPut {
  region: string;
  roleArn: string;
  externalId: string;
  bucket: string;
  key: string;
  body: string;
  contentType: string;
  sessionName: string;
}
export interface CrossAccountS3 {
  put(o: CrossAccountPut): Promise<void>;
}

export class AwsCrossAccountS3 implements CrossAccountS3 {
  constructor(
    private readonly cell: HomeRegion,
    private readonly endpoints: { s3?: string; sts?: string } = {},
  ) {}

  async put(o: CrossAccountPut): Promise<void> {
    assertRegionAllowed(this.cell, o.region);
    assertResourceInRegion(this.cell, o.roleArn);
    if (!isAuditStreamRoleArn(o.roleArn)) throw new Error('role_not_allowed');
    const create = createAwsClientFactory({ cell: this.cell, endpoints: this.endpoints });
    const sts = create(STSClient, 'sts', { region: o.region });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: o.roleArn,
        ExternalId: o.externalId,
        RoleSessionName: o.sessionName,
        DurationSeconds: 900,
      }),
    );
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('assume_role_failed');
    const s3 = create(S3Client, 's3', {
      region: o.region,
      credentials: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: o.bucket,
          Key: o.key,
          Body: o.body,
          ContentType: o.contentType,
          ServerSideEncryption: 'aws:kms',
        }),
      );
    } finally {
      s3.destroy();
      sts.destroy();
    }
  }
}

export function homeAwsRegion(cell: HomeRegion): string {
  return REGIONS[cell].awsRegion;
}

export function crossAccountS3FromEnv(
  cell: HomeRegion,
  env: NodeJS.ProcessEnv = process.env,
): CrossAccountS3 {
  return new AwsCrossAccountS3(cell, { s3: env.SIEM_S3_ENDPOINT, sts: env.STS_ENDPOINT });
}
