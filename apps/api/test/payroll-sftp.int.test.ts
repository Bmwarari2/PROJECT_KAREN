import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import {
  hostKeyFingerprint,
  isPrivateAddress,
  resolveSftpHost,
  SftpError,
} from '../src/modules/payroll/sftp';

/**
 * PROGRESS 6.1/6.2 SFTP delivery: a real SSH/SFTP session against an in-process ssh2 server on loopback
 * (dev/test only — private addresses are refused elsewhere). The host key is pinned, the upload is
 * atomic (temporary name, then rename), the bytes match the export's SHA-256, and every attempt is in
 * the delivery log and the audit trail.
 */
let ctx: TestContext;
let c: Phase6Company;
let server: InstanceType<typeof ssh2.Server>;
let port: number;
let fingerprint: string;
const files = new Map<string, Buffer>();
const opsSeen: string[] = [];
const USER = 'payroll-drop';
const PASS = 'fictional-sftp-password';

function startServer(): Promise<void> {
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
  const parsed = ssh2.utils.parseKey(hostKey.private) as { getPublicSSH(): Buffer };
  fingerprint = hostKeyFingerprint(parsed.getPublicSSH());
  const { STATUS_CODE } = ssh2.utils.sftp;
  server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client: any) => {
    client.on('authentication', (a: any) =>
      a.method === 'password' && a.username === USER && a.password === PASS
        ? a.accept()
        : a.reject(['password']),
    );
    client.on('ready', () => {
      client.on('session', (accept: any) => {
        const session = accept();
        session.on('sftp', (acceptSftp: any) => {
          const sftp = acceptSftp();
          const open = new Map<number, { path: string; chunks: Array<{ offset: number; data: Buffer }> }>();
          let next = 1;
          sftp.on('OPEN', (reqid: number, filename: string) => {
            opsSeen.push(`OPEN ${filename}`);
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
            const size = f.chunks.reduce((n, ch) => Math.max(n, ch.offset + ch.data.length), 0);
            const buf = Buffer.alloc(size);
            for (const ch of f.chunks) ch.data.copy(buf, ch.offset);
            files.set(f.path, buf);
            open.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('REMOVE', (reqid: number, path: string) => {
            opsSeen.push(`REMOVE ${path}`);
            sftp.status(reqid, files.delete(path) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE);
          });
          sftp.on('RENAME', (reqid: number, from: string, to: string) => {
            opsSeen.push(`RENAME ${from} ${to}`);
            if (!files.has(from) || files.has(to)) return sftp.status(reqid, STATUS_CODE.FAILURE);
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

let periodId: string;
let employeeNumber: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  await startServer();
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  const emp = await c.hire({ legalFirstName: 'Sefa', legalLastName: 'Sftp', startDate: '2026-07-06' });
  employeeNumber = (
    await c.tx((t) =>
      t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [emp]),
    )
  ).employee_number;
  periodId = (
    await c.api('POST', '/v1/payroll/periods', {
      name: 'July 2026',
      frequency: 'monthly',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    })
  ).json().id;
  expect((await c.api('POST', `/v1/payroll/periods/${periodId}/close`)).statusCode).toBe(200);
});
afterAll(async () => {
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

async function sftpConnector(hostKeySha256: string, password = PASS) {
  const r = await c.api('POST', '/v1/payroll/connectors', {
    name: 'Fictional bureau drop',
    kind: 'csv',
    delivery: {
      method: 'sftp',
      sftp: { host: '127.0.0.1', port, username: USER, directory: '/inbound', hostKeySha256 },
    },
    mapping: {
      dateFormat: 'yyyy-MM-dd',
      decimalSeparator: '.',
      delimiter: ',',
      includeHeader: true,
      sections: {
        starters: {
          enabled: true,
          columns: [
            { header: 'id', field: 'employeeNumber' },
            { header: 'start', field: 'startDate' },
          ],
        },
      },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  const creds = await c.api('PUT', `/v1/payroll/connectors/${r.json().id}/credentials`, { password });
  expect(creds.json()).toEqual({ configured: ['password'] });
  return r.json().id as string;
}

describe('SFTP delivery to a customer host', () => {
  it('uploads the exact export bytes atomically to the pinned host and logs the delivery', async () => {
    const id = await sftpConnector(fingerprint);
    const e = (await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: id })).json();
    const d = await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, {
      idempotencyKey: 'sftp-july-2026',
    });
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json()).toMatchObject({
      method: 'sftp',
      status: 'queued',
      destination: `sftp://127.0.0.1:${port}/inbound`,
    });
    await c.drain();
    const remote = files.get(`/inbound/${e.fileName}`);
    expect(remote, [...files.keys()].join(',')).toBeDefined();
    expect(sha(remote!)).toBe(e.sha256);
    expect(remote!.toString('utf8')).toBe(`id,start\r\n${employeeNumber},2026-07-06\r\n`);
    // written under a temporary name, then renamed into place
    expect(opsSeen).toContain(`OPEN /inbound/.${e.fileName}.part`);
    expect(opsSeen).toContain(`RENAME /inbound/.${e.fileName}.part /inbound/${e.fileName}`);
    expect(files.has(`/inbound/.${e.fileName}.part`)).toBe(false);
    const log = (await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`)).json();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      status: 'succeeded',
      destination: `sftp://127.0.0.1:${port}/inbound/${e.fileName}`,
      detail: { bytes: remote!.length, sha256: e.sha256 },
    });
    // re-delivering replaces the file (idempotent)
    await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, { idempotencyKey: 'sftp-july-2026-again' });
    await c.drain();
    expect(files.get(`/inbound/${e.fileName}`)!.equals(remote!)).toBe(true);
    const audits = await c.tx((t) =>
      t.query<{ diff: { status: string; method: string } }>(
        `SELECT diff FROM audit.events WHERE action = 'payroll.delivered'`,
      ),
    );
    expect(audits.filter((a) => a.diff.method === 'sftp' && a.diff.status === 'succeeded')).toHaveLength(2);
  });

  it('refuses a host whose key does not match the pinned fingerprint (nothing is written)', async () => {
    const before = files.size;
    const id = await sftpConnector(`SHA256:${'A'.repeat(43)}`);
    const e = (await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: id })).json();
    const d = (await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, {})).json();
    await c.drain();
    const log = (await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`))
      .json()
      .find((x: { id: string }) => x.id === d.id);
    expect(log).toMatchObject({
      status: 'failed',
      detail: { code: 'hostKeyMismatch' },
      error: 'SFTP host key does not match the pinned fingerprint',
    });
    expect(files.size).toBe(before);
  });

  it('reports wrong credentials without retrying forever, and never stores or logs the password in clear', async () => {
    const id = await sftpConnector(fingerprint, 'not-the-password');
    const e = (await c.api('POST', `/v1/payroll/periods/${periodId}/exports`, { connectorId: id })).json();
    const d = (await c.api('POST', `/v1/payroll/exports/${e.id}/deliver`, {})).json();
    const ran = await c.drain();
    expect(ran.filter((j) => j.kind === 'payroll.deliver')).toHaveLength(1);
    const log = (await c.api('GET', `/v1/payroll/deliveries?exportId=${e.id}`))
      .json()
      .find((x: { id: string }) => x.id === d.id);
    expect(log).toMatchObject({ status: 'failed', detail: { code: 'authFailed' } });
    const job = await c.tx((t) =>
      t.one<{ status: string }>(
        `SELECT status FROM app.jobs WHERE kind = 'payroll.deliver' AND idempotency_key = $1`,
        [d.id],
      ),
    );
    expect(job.status).toBe('succeeded'); // a permanent failure is recorded, not retried
    const leaks = await c.tx((t) =>
      t.query(
        `SELECT 1 FROM app.integration_credentials WHERE envelope::text LIKE '%not-the-password%' UNION ALL SELECT 1 FROM audit.events WHERE diff::text LIKE '%not-the-password%' UNION ALL SELECT 1 FROM app.payroll_deliveries WHERE detail::text LIKE '%not-the-password%' OR coalesce(error, '') LIKE '%not-the-password%'`,
      ),
    );
    expect(leaks).toHaveLength(0);
  });

  it('private, loopback and link-local destinations are refused outside dev and test (SSRF guard)', async () => {
    for (const ip of [
      '10.0.0.5',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.1.1',
      '192.168.1.10',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.1.2.3',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['81.2.69.142', '2a00:1450:4009:81f::200e'])
      expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(resolveSftpHost('169.254.169.254', false)).rejects.toBeInstanceOf(SftpError);
    await expect(resolveSftpHost('localhost', false)).rejects.toThrow(/not allowed/);
    await expect(resolveSftpHost('127.0.0.1', true)).resolves.toBe('127.0.0.1');
    // a directory may not climb out of the configured root
    const r = await c.api('POST', '/v1/payroll/connectors', {
      name: 'x',
      kind: 'csv',
      delivery: {
        method: 'sftp',
        sftp: {
          host: 'sftp.fictional.example.test',
          port: 22,
          username: 'u',
          directory: '/in/../etc',
          hostKeySha256: fingerprint,
        },
      },
    });
    expect(r.statusCode).toBe(400);
  });
});
