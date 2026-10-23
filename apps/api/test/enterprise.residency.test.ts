import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { REGIONS, regionPairs, ResidencyViolationError } from '@thapsus/core';
import { closeDb, enrolTotp, signup, startTestApp } from './helpers';
import { AwsCrossAccountS3 } from '../src/modules/platform/siem-s3';
import { jobHandlers } from '../src/worker';

/**
 * Phase 9 residency, for every region pair: audit streams can only write to an S3 bucket in the
 * tenant's home region (the API refuses other regions and the guarded STS/S3 factory refuses to create
 * a client for them, before any request leaves the cell), and a sandbox is created in the same cell and
 * home region as its source.
 */
afterAll(closeDb);

describe.each(regionPairs())('enterprise platform stays home (%s → %s)', (home, other) => {
  it(`the ${home} cross-account S3 writer refuses a bucket in ${other} without sending anything`, async () => {
    let requests = 0;
    const mock = createServer((_req, res) => {
      requests++;
      res.end();
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    const writer = new AwsCrossAccountS3(home, { s3: url, sts: url });
    await expect(
      writer.put({
        region: REGIONS[other].awsRegion,
        roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-audit-siem',
        externalId: 'x',
        bucket: 'fictional',
        key: 'k',
        body: '{}',
        contentType: 'application/json',
        sessionName: 's',
      }),
    ).rejects.toBeInstanceOf(ResidencyViolationError);
    if (REGIONS[home].backupRegion) {
      await expect(
        writer.put({
          region: REGIONS[home].backupRegion!,
          roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-audit-siem',
          externalId: 'x',
          bucket: 'fictional',
          key: 'k',
          body: '{}',
          contentType: 'application/json',
          sessionName: 's',
        }),
      ).rejects.toBeInstanceOf(ResidencyViolationError);
    }
    expect(requests).toBe(0);
    mock.close();
  });

  it(`a ${home} tenant cannot stream audit data to a bucket in ${other}, and its sandbox stays in ${home}`, async () => {
    const cell = await startTestApp({ cell: home, listen: false });
    try {
      const s = await signup(cell);
      await enrolTotp(cell, s.cookie);
      const res = await cell.app.inject({
        method: 'POST',
        url: '/v1/settings/audit-streams',
        headers: { cookie: s.cookie },
        payload: {
          name: 'Elsewhere',
          kind: 's3',
          bucket: 'fictional-audit',
          region: REGIONS[other].awsRegion,
          roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-audit-siem',
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ detail: 'regionNotAllowed', allowed: [REGIONS[home].awsRegion] });
      const ok = await cell.app.inject({
        method: 'POST',
        url: '/v1/settings/audit-streams',
        headers: { cookie: s.cookie },
        payload: {
          name: 'Home',
          kind: 's3',
          bucket: 'fictional-audit',
          roleArn: 'arn:aws:iam::123456789012:role/thapsus-hr-audit-siem',
        },
      });
      expect(ok.json().s3.region).toBe(REGIONS[home].awsRegion);

      const sb = await cell.app.inject({
        method: 'POST',
        url: '/v1/sandboxes',
        headers: { cookie: s.cookie },
        payload: { syntheticPeople: 2 },
      });
      expect(sb.statusCode, sb.body).toBe(202);
      const reg = await cell.deps.router.lookup(sb.json().sandboxTenantId);
      expect(reg.home_region).toBe(home);
      expect((await cell.directory.bySlug(sb.json().slug))?.homeRegion).toBe(home);
      const { withTenant } = await import('@thapsus/db');
      const job = await withTenant(cell.deps.router, s.tenantId, (tx) =>
        tx.one<{
          id: string;
          tenant_id: string;
          kind: string;
          idempotency_key: string;
          input: Record<string, unknown>;
          attempts: number;
          created_by: string | null;
        }>(
          `SELECT id, tenant_id, kind, idempotency_key, input, attempts, created_by FROM app.jobs WHERE kind = 'sandbox.create'`,
        ),
      );
      await jobHandlers['sandbox.create']!({
        tenantId: s.tenantId,
        job,
        deps: cell.deps,
        tx: (fn) => withTenant(cell.deps.router, s.tenantId, fn),
        progress: async () => undefined,
      });
      await withTenant(cell.deps.router, sb.json().sandboxTenantId, async (tx) => {
        expect(
          await tx.one<{ home_region: string; kind: string }>('SELECT home_region, kind FROM app.tenants'),
        ).toEqual({ home_region: home, kind: 'sandbox' });
      });
    } finally {
      await cell.close();
    }
  });
});
