import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import ssh2, { type SFTPWrapper } from 'ssh2';
import type { SftpDestination } from './connectors/types';

/**
 * SFTP transport to a customer-designated host (a customer-controlled destination in SUBPROCESSORS.md).
 * - The server's host key is always pinned (OpenSSH "SHA256:…" fingerprint); a mismatch aborts before
 *   authentication, so files never go to an impostor.
 * - Private, loopback and link-local addresses are refused outside dev/test (SSRF guard), and the name is
 *   resolved once and the connection made to that address (no DNS rebinding between check and connect).
 * - The file is written as a hidden `.name.part` and renamed into place, so the payroll system never
 *   picks up half a file; a re-delivery replaces the earlier file (idempotent).
 */
export class SftpError extends Error {
  constructor(
    readonly code: 'hostNotAllowed' | 'hostKeyMismatch' | 'authFailed' | 'timeout' | 'transfer' | 'connect',
    message: string,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}

export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** True for addresses that must never be an export destination (RFC 1918, loopback, link-local, CGNAT, ULA). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return false;
}

export async function resolveSftpHost(host: string, allowPrivate: boolean): Promise<string> {
  if (/^localhost$/i.test(host) && !allowPrivate)
    throw new SftpError('hostNotAllowed', 'SFTP host not allowed');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new SftpError('connect', 'SFTP host could not be resolved');
      });
  if (!addresses.length) throw new SftpError('connect', 'SFTP host could not be resolved');
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))
    throw new SftpError('hostNotAllowed', 'SFTP host resolves to a private address');
  return addresses[0]!.address;
}

const promisify =
  <A extends unknown[]>(fn: (...args: [...A, (err?: Error | null) => void]) => void) =>
  (...args: A) =>
    new Promise<void>((resolve, reject) =>
      fn(...args, (err?: Error | null) => (err ? reject(err) : resolve())),
    );

export async function uploadSftp(
  dest: SftpDestination,
  creds: { password?: string; privateKey?: string; passphrase?: string },
  fileName: string,
  body: Buffer,
  opts: { allowPrivateHosts: boolean; timeoutMs?: number },
): Promise<{ path: string; bytes: number }> {
  if (!creds.password && !creds.privateKey)
    throw new SftpError('authFailed', 'No SFTP password or key is stored for this connector');
  const address = await resolveSftpHost(dest.host, opts.allowPrivateHosts);
  const safeName = posix.basename(fileName);
  const final = posix.join(dest.directory || '.', safeName);
  const tmp = posix.join(dest.directory || '.', `.${safeName}.part`);
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let hostChecked = false;
    let hostKeyOk = false;
    let settled = false;
    const done = (err?: Error, value?: { path: string; bytes: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => done(new SftpError('timeout', 'SFTP delivery timed out')),
      opts.timeoutMs ?? 30_000,
    );
    client.on('error', (err: Error & { level?: string }) => {
      if (hostChecked && !hostKeyOk)
        return done(new SftpError('hostKeyMismatch', 'SFTP host key does not match the pinned fingerprint'));
      done(
        new SftpError(
          err.level === 'client-authentication' ? 'authFailed' : 'connect',
          err.level === 'client-authentication' ? 'SFTP authentication failed' : 'SFTP connection failed',
        ),
      );
    });
    client.on('ready', () => {
      client.sftp(async (err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return done(new SftpError('transfer', 'SFTP subsystem unavailable'));
        try {
          await promisify<[string, Buffer]>(sftp.writeFile.bind(sftp))(tmp, body);
          await promisify<[string]>(sftp.unlink.bind(sftp))(final).catch(() => undefined);
          await promisify<[string, string]>(sftp.rename.bind(sftp))(tmp, final);
          sftp.end();
          done(undefined, { path: final, bytes: body.length });
        } catch {
          done(new SftpError('transfer', 'SFTP upload failed'));
        }
      });
    });
    client.connect({
      host: address,
      port: dest.port,
      username: dest.username,
      password: creds.password,
      privateKey: creds.privateKey,
      passphrase: creds.passphrase,
      readyTimeout: Math.min(opts.timeoutMs ?? 30_000, 20_000),
      hostVerifier: (key: Buffer) => {
        hostChecked = true;
        hostKeyOk = hostKeyFingerprint(key) === dest.hostKeySha256;
        return hostKeyOk;
      },
    });
  });
}
