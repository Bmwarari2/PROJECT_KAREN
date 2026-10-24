import { BlockList, isIP } from 'node:net';

/**
 * Keyed, non-reversible ids for client addresses and submitted account names (ADR-0177): the identity work's
 * own derivation (apps/api/src/lib/security-events.ts), so an address has the same key in request signals
 * and in authentication events.
 */
export { pseudonym } from '../../lib/security-events';

/** The /24 (IPv4) or /48 (IPv6) network of an address, for display; undefined for anything else. */
export function truncatedNetwork(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) === 6) {
    const full = expandV6(ip);
    return `${full.slice(0, 3).join(':')}::/48`;
  }
  return undefined;
}

function expandV6(ip: string): string[] {
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = new Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...(tail !== undefined ? fill : []), ...t].map((x) =>
    x.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/**
 * Loopback, private, link-local, shared (carrier-grade NAT) and unique-local addresses: the cell's own
 * infrastructure (load balancers, the web proxy, health checks), never blocked. A request that arrives from one
 * of these with no forwarded client address must not lock everyone out.
 */
const INTERNAL = new BlockList();
for (const [net, bits] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
] as const)
  INTERNAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  INTERNAL.addSubnet(net, bits, 'ipv6');

export function isInternalAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const bare = ip.replace(/\/\d+$/, '');
  const v4 = bare.startsWith('::ffff:') ? bare.slice(7) : bare;
  if (isIP(v4) === 4) return INTERNAL.check(v4, 'ipv4');
  return isIP(bare) === 6 && INTERNAL.check(bare, 'ipv6');
}
