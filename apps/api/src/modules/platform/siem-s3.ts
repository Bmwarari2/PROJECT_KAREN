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
    const create = createAwsClientFactory({ cell: this.cell, endpoints: this.endpoints });
    const sts = create(STSClient, 'sts', { region: o.region });
    const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: o.roleArn, ExternalId: o.externalId, RoleSessionName: o.sessionName, DurationSeconds: 900 }));
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('assume_role_failed');
    const s3 = create(S3Client, 's3', {
      region: o.region,
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    try {
      await s3.send(new PutObjectCommand({ Bucket: o.bucket, Key: o.key, Body: o.body, ContentType: o.contentType, ServerSideEncryption: 'aws:kms' }));
    } finally {
      s3.destroy();
      sts.destroy();
    }
  }
}

export function homeAwsRegion(cell: HomeRegion): string {
  return REGIONS[cell].awsRegion;
}

export function crossAccountS3FromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): CrossAccountS3 {
  return new AwsCrossAccountS3(cell, { s3: env.SIEM_S3_ENDPOINT, sts: env.STS_ENDPOINT });
}
