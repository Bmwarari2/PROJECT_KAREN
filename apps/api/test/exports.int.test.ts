import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { readerUrl, testRouter, TEST_DBS } from '@thapsus/db/testing';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { widgets, type Widgets } from './reports-fixtures';
import { enqueueDueExports, transports } from '../src/modules/data-export/routes';
import { hostKeyFingerprint } from '../src/modules/payroll/sftp';
import type { AwsClients } from '../src/modules/data-export/destination';

/**
 * PROGRESS 7.3: scheduled data export to the customer's own S3 bucket (home region only, cross-account role
 * with ExternalId; AWS clients faked at the client seam) or SFTP server (a real SSH session against an
 * in-process ssh2 server with a pinned host key). Datasets come from the builder catalogue with the same
 * permission rules; the delivery log holds counts only.
 */
let ctx: TestContext;
let w: Widgets;

// ---- fake AWS (records every command; HeadBucket answers with a configurable region) ----------------------
const sent: Array<{ client: string; region: string; name: string; input: Record<string, unknown> }> = [];
let bucketRegion = 'eu-west-2';
const fakeAws: AwsClients = {
  sts: (region) => ({
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ client: 'sts', region, name: c.constructor.name, input: c.input });
      return {
        Credentials: {
          AccessKeyId: 'ASIAFICTIONAL',
          SecretAccessKey: 'fictional-secret',
          SessionToken: 'fictional-token',
        },
      };
    },
  }),
  s3: (region) => ({
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ client: 's3', region, name: c.constructor.name, input: c.input });
      return c.constructor.name === 'HeadBucketCommand' ? { BucketRegion: bucketRegion } : {};
    },
  }),
};

// ---- in-process SFTP server -------------------------------------------------------------------------------
let server: InstanceType<typeof ssh2.Server>;
let port: number;
let fingerprint: string;
const files = new Map<string, Buffer>();
const USER = 'warehouse-drop';
const PASS = 'fictional-sftp-password';
function startServer(): Promise<void> {
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
  fingerprint = hostKeyFingerprint(
    (ssh2.utils.parseKey(hostKey.private) as { getPublicSSH(): Buffer }).getPublicSSH(),
  );
  const { STATUS_CODE } = ssh2.utils.sftp;
  server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client: any) => {
    client.on('authentication', (a: any) =>
      a.method === 'password' && a.username === USER && a.password === PASS
        ? a.accept()
        : a.reject(['password']),
    );
    client.on('ready', () => {
      client.on('session', (accept: any) => {
        accept().on('sftp', (acceptSftp: any) => {
          const sftp = acceptSftp();
          const open = new Map<number, { path: string; chunks: Array<{ offset: number; data: Buffer }> }>();
          let next = 1;
          sftp.on('OPEN', (reqid: number, filename: string) => {
            const h = Buffer.alloc(4);
            h.writeUInt32BE(next);
            open.set(next++, { path: filename, chunks: [] });
            sftp.handle(reqid, h);
          });
          sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            open.get(handle.readUInt32BE(0))!.chunks.push({ offset, data: Buffer.from(data) });
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
            const f = open.get(handle.readUInt32BE(0))!;
            const buf = Buffer.alloc(f.chunks.reduce((n, ch) => Math.max(n, ch.offset + ch.data.length), 0));
            for (const ch of f.chunks) ch.data.copy(buf, ch.offset);
            files.set(f.path, buf);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('REMOVE', (reqid: number, path: string) =>
            sftp.status(reqid, files.delete(path) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE),
          );
          sftp.on('RENAME', (reqid: number, from: string, to: string) => {
            if (!files.has(from)) return sftp.status(reqid, STATUS_CODE.FAILURE);
            files.set(to, files.get(from)!);
            files.delete(from);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
    client.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => ((port = server.address().port), resolve())),
  );
}

const original = transports.awsClients;
beforeAll(async () => {
  await startServer();
  transports.awsClients = () => fakeAws;
  ctx = await startTestApp({
    listen: false,
    overrides: { router: testRouter('uk', { readers: { shared: readerUrl(TEST_DBS.shared) } }) },
  });
  w = await widgets(ctx);
});
afterAll(async () => {
  transports.awsClients = original;
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

const ROLE = 'arn:aws:iam::123456789012:role/thapsus-hr-export-warehouse';
const s3Destination = async (cookie = w.owner.cookie) => {
  const r = await w.api(
    'POST',
    '/v1/data-exports/destinations',
    {
      name: 'Fictional warehouse',
      kind: 's3',
      s3: { bucket: 'fictional-widgets-warehouse', region: 'eu-west-2', prefix: 'thapsus/', roleArn: ROLE },
    },
    cookie,
  );
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; s3: { externalId: string } };
};
const deliveries = async (exportId: string) =>
  (await w.api('GET', `/v1/data-exports/${exportId}/deliveries`)).json() as Array<{
    status: string;
    rows: number;
    files: number;
    bytes: number;
    errorCode: string | null;
    durationMs: number;
  }>;

describe('S3 destinations: the customer bucket must be in the home region', () => {
  it('generates the ExternalId, refuses other regions and roles outside the allowed prefix', async () => {
    const d = await s3Destination();
    expect(d.s3.externalId).toMatch(/^thr-[0-9a-f]{32}$/);
    for (const region of ['eu-central-1', 'us-east-2', 'us-east-1']) {
      const r = await w.api('POST', '/v1/data-exports/destinations', {
        name: 'Elsewhere',
        kind: 's3',
        s3: { bucket: 'fictional-elsewhere', region, roleArn: ROLE },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: 'regionNotAllowed' });
      expect(r.json().detail).toContain('eu-west-2');
    }
    const badRole = await w.api('POST', '/v1/data-exports/destinations', {
      name: 'Admin role',
      kind: 's3',
      s3: {
        bucket: 'fictional-widgets-warehouse',
        region: 'eu-west-2',
        roleArn: 'arn:aws:iam::123456789012:role/Admin',
      },
    });
    expect(badRole.json()).toMatchObject({ code: 'invalidConfig' });
  });

  it('delivers the selected datasets once per period, assuming the role with the ExternalId', async () => {
    const d = await s3Destination();
    const e = await w.api('POST', '/v1/data-exports', {
      name: 'Nightly people',
      destinationId: d.id,
      datasets: [
        { dataset: 'employees', fields: ['employeeNumber', 'displayName', 'department', 'payAmount'] },
      ],
      format: 'csv',
      frequency: 'daily',
      timeOfDay: '02:00',
      timeZone: 'Europe/London',
    });
    expect(e.statusCode, e.body).toBe(201);
    sent.length = 0;
    const due = new Date(Date.now() + 26 * 3600_000); // the next 02:00 London after creation has passed
    expect(await w.tx((t) => enqueueDueExports(t, due))).toBe(1);
    expect(await w.tx((t) => enqueueDueExports(t, due))).toBe(0); // idempotent per export + period
    await w.drain();
    const [log] = await deliveries(e.json().id);
    expect(log).toMatchObject({ status: 'succeeded', files: 1, errorCode: null });
    expect(log!.rows).toBeGreaterThan(0);
    expect(log!.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(await deliveries(e.json().id))).not.toMatch(/Fictional|Ada|Mona/); // counts and timings only
    const assume = sent.find((c) => c.name === 'AssumeRoleCommand')!;
    expect(assume).toMatchObject({
      client: 'sts',
      region: 'eu-west-2',
      input: { RoleArn: ROLE, ExternalId: d.s3.externalId, DurationSeconds: 900 },
    });
    expect(sent.find((c) => c.name === 'HeadBucketCommand')).toMatchObject({
      region: 'eu-west-2',
      input: { Bucket: 'fictional-widgets-warehouse' },
    });
    const put = sent.find((c) => c.name === 'PutObjectCommand')!;
    expect(put.input.Key).toMatch(/^thapsus\/employees\/employees-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = (put.input.Body as Buffer).toString('utf8').replace(/^\ufeff/, '');
    expect(csv.split('\r\n')[0]).toBe('employeeNumber,displayName,department,payAmount,payAmount_currency');
  });

  it('refuses a bucket that turns out to be in another region, before writing anything', async () => {
    const d = await s3Destination();
    const e = (
      await w.api('POST', '/v1/data-exports', {
        name: 'Leave feed',
        destinationId: d.id,
        datasets: [{ dataset: 'leave', fields: ['employeeNumber', 'startDate', 'days'] }],
        format: 'jsonl',
        frequency: 'weekly',
        weekday: 1,
        timeOfDay: '03:00',
        timeZone: 'Europe/London',
      })
    ).json();
    bucketRegion = 'us-east-2';
    sent.length = 0;
    try {
      expect((await w.api('POST', `/v1/data-exports/${e.id}/run`)).statusCode).toBe(202);
      await w.drain();
    } finally {
      bucketRegion = 'eu-west-2';
    }
    expect((await deliveries(e.id))[0]).toMatchObject({
      status: 'failed',
      errorCode: 'bucketRegionMismatch',
    });
    expect(sent.some((c) => c.name === 'PutObjectCommand')).toBe(false);
  });

  it("applies the run-as user's permissions and never exports vault-backed fields", async () => {
    const hr = await w.login(null, 'entity_hr_admin', { type: 'entity', values: [w.gb] });
    const d = await s3Destination(hr.cookie);
    expect(
      (
        await w.api(
          'POST',
          '/v1/data-exports',
          {
            name: 'Reasons',
            destinationId: d.id,
            datasets: [{ dataset: 'absence', fields: ['employeeNumber', 'sicknessReason'] }],
            format: 'csv',
            frequency: 'daily',
            timeOfDay: '02:00',
            timeZone: 'Europe/London',
          },
          hr.cookie,
        )
      ).statusCode,
    ).toBe(400);
    const e = (
      await w.api(
        'POST',
        '/v1/data-exports',
        {
          name: 'GB people',
          destinationId: d.id,
          datasets: [{ dataset: 'employees', fields: ['displayName', 'entity'] }],
          format: 'jsonl',
          frequency: 'daily',
          timeOfDay: '02:00',
          timeZone: 'Europe/London',
        },
        hr.cookie,
      )
    ).json();
    sent.length = 0;
    await w.api('POST', `/v1/data-exports/${e.id}/run`, undefined, hr.cookie);
    await w.drain();
    const body = (sent.find((c) => c.name === 'PutObjectCommand')!.input.Body as Buffer).toString('utf8');
    const rows = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { entity: string | null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entity === 'Fictional Widgets Ltd')).toBe(true); // entity-scoped rows only
    const employee = await w.login(w.people.ada, 'employee', { type: 'self' });
    expect((await w.api('GET', '/v1/data-exports', undefined, employee.cookie)).statusCode).toBe(403);
  });
});

describe('SFTP destinations: pinned host key, sealed credentials', () => {
  const sftpDestination = (hostKeySha256: string) =>
    w.api('POST', '/v1/data-exports/destinations', {
      name: 'Fictional SFTP',
      kind: 'sftp',
      sftp: { host: '127.0.0.1', port, username: USER, directory: '/drop', hostKeySha256, password: PASS },
    });

  it('tests the connection and delivers files to the pinned host; the password is stored sealed', async () => {
    const r = await sftpDestination(fingerprint);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      credentialFields: ['password'],
      sftp: { auth: 'password', hostKeySha256: fingerprint },
    });
    expect(JSON.stringify(r.json())).not.toContain(PASS);
    const stored = await w.tx((t) =>
      t.one<{ config: unknown; credentials: unknown }>(
        'SELECT config, credentials FROM app.export_destinations WHERE id = $1',
        [r.json().id],
      ),
    );
    expect(JSON.stringify(stored)).not.toContain(PASS);
    const test = await w.api('POST', `/v1/data-exports/destinations/${r.json().id}/test`);
    expect(test.statusCode, test.body).toBe(200);
    const e = (
      await w.api('POST', '/v1/data-exports', {
        name: 'Timesheets',
        destinationId: r.json().id,
        datasets: [{ dataset: 'timesheets', fields: ['employeeNumber', 'weekStart', 'workedMinutes'] }],
        format: 'csv',
        frequency: 'monthly',
        dayOfMonth: 1,
        timeOfDay: '04:00',
        timeZone: 'Europe/London',
      })
    ).json();
    await w.api('POST', `/v1/data-exports/${e.id}/run`);
    await w.drain();
    expect((await deliveries(e.id))[0]).toMatchObject({ status: 'succeeded', files: 1 });
    const delivered = [...files.keys()].filter((k) => k.startsWith('/drop/timesheets-'));
    expect(delivered).toHaveLength(1);
    expect(files.get(delivered[0]!)!.toString('utf8')).toContain(
      'employeeNumber,weekStart,workedMinutes_hours',
    );
  });

  it('refuses a host whose key does not match the pin, and logs the failure without personal data', async () => {
    const wrong = `SHA256:${'A'.repeat(43)}`;
    const r = await sftpDestination(wrong);
    expect(r.statusCode).toBe(201);
    const test = await w.api('POST', `/v1/data-exports/destinations/${r.json().id}/test`);
    expect(test.statusCode).toBe(422);
    expect(test.json()).toMatchObject({ code: 'hostKeyMismatch' });
    expect(
      (
        await w.api('POST', '/v1/data-exports/destinations', {
          name: 'Unpinned',
          kind: 'sftp',
          sftp: { host: '127.0.0.1', port, username: USER, hostKeySha256: 'none', password: PASS },
        })
      ).json(),
    ).toMatchObject({ code: 'invalidConfig' });
    const e = (
      await w.api('POST', '/v1/data-exports', {
        name: 'Leave to wrong host',
        destinationId: r.json().id,
        datasets: [{ dataset: 'leave', fields: ['employeeNumber'] }],
        format: 'csv',
        frequency: 'daily',
        timeOfDay: '02:00',
        timeZone: 'Europe/London',
      })
    ).json();
    await w.api('POST', `/v1/data-exports/${e.id}/run`);
    await w.drain();
    expect((await deliveries(e.id))[0]).toMatchObject({ status: 'failed', errorCode: 'hostKeyMismatch' });
  });
});
