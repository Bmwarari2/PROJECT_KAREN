import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound HTTP for customer-configured destinations (webhooks, SIEM streams) with SSRF protection:
 *  - https only; no credentials in the URL; no redirects followed;
 *  - every address the hostname resolves to is checked AT CONNECT TIME (custom DNS lookup), so DNS
 *    rebinding cannot swap in a private address after validation;
 *  - loopback, private (RFC 1918 / ULA), link-local, carrier-grade NAT, cloud metadata
 *    (169.254.169.254, fd00:ec2::254), multicast, documentation and reserved ranges are refused,
 *    including their IPv4-mapped / NAT64 IPv6 forms;
 *  - bounded time and response size; the response body is read and discarded, never stored.
 * The dev/test-only policy flags allow http:// and private targets (a local test receiver). They are
 * refused in production by depsFromEnv.
 */
export interface OutboundPolicy {
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
}
export const STRICT_OUTBOUND: OutboundPolicy = { allowHttp: false, allowPrivateNetworks: false };

export class OutboundBlockedError extends Error {
  constructor(readonly reason: 'scheme' | 'credentials' | 'blockedAddress' | 'invalidUrl' | 'port') {
    super(`outbound request blocked: ${reason}`);
    this.name = 'OutboundBlockedError';
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

/** IPv4 embedded in IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible or NAT64 (64:ff9b::/96) addresses. */
function embeddedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return undefined;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(ip, 'ipv6');
  }
  return true; // not an IP at all
}

/** Synchronous checks on a destination URL (used when a destination is saved and before each call). */
export function assertSafeUrl(raw: string, policy: OutboundPolicy = STRICT_OUTBOUND): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError('invalidUrl');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:'))
    throw new OutboundBlockedError('scheme');
  if (url.username || url.password) throw new OutboundBlockedError('credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivateNetworks) {
    if (isIP(host) && isBlockedAddress(host)) throw new OutboundBlockedError('blockedAddress');
    if (
      /^(localhost|localhost\.localdomain|metadata\.google\.internal)$/i.test(host) ||
      /\.(localhost|internal|local)$/i.test(host)
    ) {
      throw new OutboundBlockedError('blockedAddress');
    }
  }
  return url;
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** DNS lookup that fails when any resolved address is blocked (connect-time SSRF check). */
export function guardedLookup(policy: OutboundPolicy, resolve: LookupFn = dnsLookup as unknown as LookupFn) {
  return (
    hostname: string,
    options: unknown,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, wantAll ? [] : '', 0);
      if (
        !policy.allowPrivateNetworks &&
        (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address)))
      ) {
        return cb(
          Object.assign(new OutboundBlockedError('blockedAddress'), { code: 'EBLOCKED' }),
          wantAll ? [] : '',
          0,
        );
      }
      if (wantAll) return cb(null, addresses);
      return cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface OutboundResponse {
  status: number;
  durationMs: number;
}

/**
 * POSTs a body and resolves with the status code and duration. Network failures reject with an error
 * whose message is a short, non-sensitive class (timeout, connection refused, blocked address…).
 */
export async function postOutbound(
  rawUrl: string,
  body: string | Buffer,
  headers: Record<string, string>,
  opts: { policy?: OutboundPolicy; timeoutMs?: number; maxResponseBytes?: number; resolve?: LookupFn } = {},
): Promise<OutboundResponse> {
  const policy = opts.policy ?? STRICT_OUTBOUND;
  const url = assertSafeUrl(rawUrl, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<OutboundResponse>((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
        timeout: timeoutMs,
        lookup: isIP(host) ? undefined : (guardedLookup(policy, opts.resolve) as never),
        agent: false,
      },
      (res) => {
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > maxBytes) res.destroy();
        });
        const done = () =>
          resolve({ status: res.statusCode ?? 0, durationMs: Math.round(performance.now() - started) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err: NodeJS.ErrnoException) => reject(new Error(errorClass(err))));
    req.end(body);
  });
}

export function errorClass(err: NodeJS.ErrnoException): string {
  if (err instanceof OutboundBlockedError || err.code === 'EBLOCKED') return 'blocked_address';
  switch (err.code) {
    case 'ETIMEDOUT':
      return 'timeout';
    case 'ECONNREFUSED':
      return 'connection_refused';
    case 'ECONNRESET':
      return 'connection_reset';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns_failure';
    default:
      return err.code?.startsWith('ERR_TLS') || err.code?.includes('CERT') ? 'tls_error' : 'network_error';
  }
}
