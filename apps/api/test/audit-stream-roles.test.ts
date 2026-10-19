import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AUDIT_STREAM_ROLE_PREFIX, AwsCrossAccountS3, isAuditStreamRoleArn } from '../src/modules/platform/siem-s3';

/**
 * Phase 9.3 (ADR-0069): the cell worker's task role may assume only customer roles named
 * thapsus-hr-audit-* (infra/lib/cell-stack.ts, pinned in infra/test). The API refuses any other role
 * when a stream is saved, and the S3 writer refuses it again before calling STS, so a stream can never
 * depend on a broader IAM grant.
 */
describe('S3 audit stream roles', () => {
  it('accept only roles named thapsus-hr-audit-* in the aws partition, without a path', () => {
    expect(AUDIT_STREAM_ROLE_PREFIX).toBe('thapsus-hr-audit-');
    for (const ok of ['arn:aws:iam::123456789012:role/thapsus-hr-audit-siem', `arn:aws:iam::123456789012:role/thapsus-hr-audit-${'a'.repeat(47)}`, 'arn:aws:iam::123456789012:role/thapsus-hr-audit-Splunk_EU.1']) {
      expect(isAuditStreamRoleArn(ok), ok).toBe(true);
    }
    for (const bad of [
      'arn:aws:iam::123456789012:role/ThapsusAudit',
      'arn:aws:iam::123456789012:role/thapsus-hr-export-warehouse',
      'arn:aws:iam::123456789012:role/thapsus-hr-audit-',
      'arn:aws:iam::123456789012:role/siem/thapsus-hr-audit-siem',
      'arn:aws:iam::123456789012:role/thapsus-hr-audit-siem/x',
      'arn:aws-us-gov:iam::123456789012:role/thapsus-hr-audit-siem',
      'arn:aws:iam::12345:role/thapsus-hr-audit-siem',
      'arn:aws:iam::123456789012:user/thapsus-hr-audit-siem',
      `arn:aws:iam::123456789012:role/thapsus-hr-audit-${'a'.repeat(48)}`,
    ]) {
      expect(isAuditStreamRoleArn(bad), bad).toBe(false);
    }
  });

  it('the cross-account S3 writer refuses a role outside thapsus-hr-audit-* without sending anything', async () => {
    let requests = 0;
    const mock = createServer((_req, res) => {
      requests++;
      res.end();
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    try {
      const writer = new AwsCrossAccountS3('uk', { s3: url, sts: url });
      const put = { region: 'eu-west-2', externalId: 'thapsus-fictional', bucket: 'fictional-audit', key: 'k', body: '{}', contentType: 'application/x-ndjson', sessionName: 's' };
      await expect(writer.put({ ...put, roleArn: 'arn:aws:iam::123456789012:role/ThapsusAudit' })).rejects.toThrow('role_not_allowed');
      await expect(writer.put({ ...put, roleArn: 'arn:aws:iam::123456789012:role/audit/thapsus-hr-audit-siem' })).rejects.toThrow('role_not_allowed');
      expect(requests).toBe(0);
    } finally {
      mock.close();
    }
  });
});
