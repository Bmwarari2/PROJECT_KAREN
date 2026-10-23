import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustOneProxyHop } from '../src/app';
import { proxyToApi } from '../../web/lib/proxy';

const ipFor = async (remoteAddress: string, xff?: string, cidrs?: string) => {
  const app = Fastify({ trustProxy: trustOneProxyHop(cidrs) });
  app.get('/', async (req) => ({ ip: req.ip }));
  const r = await app.inject({ url: '/', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} });
  return r.json().ip as string;
};

describe('client IP behind the load balancer', () => {
  it('uses the address the trusted proxy appended, never one the client supplied', async () => {
    expect(await ipFor('10.0.12.34', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipFor('10.0.12.34', '203.0.113.9')).toBe('203.0.113.9');
    expect(await ipFor('::ffff:10.0.12.34', '198.51.100.7')).toBe('198.51.100.7');
  });
  it('ignores forwarding headers from a peer that is not a trusted proxy', async () => {
    expect(await ipFor('198.51.100.20', '6.6.6.6')).toBe('198.51.100.20');
    expect(await ipFor('10.0.12.34', '6.6.6.6', '172.16.0.0/12')).toBe('10.0.12.34');
  });
  it('without forwarding headers the peer is the client', async () => {
    expect(await ipFor('10.80.1.3')).toBe('10.80.1.3');
  });
});

/**
 * Google Cloud staging (ADR-0156): the API is a sidecar of the web container in one Cloud Run service, and the web
 * proxy forwards API paths to it over 127.0.0.1. With CLIENT_IP_SOURCE=cloud-run on the web and
 * TRUSTED_PROXY_CIDRS=127.0.0.1/32 on the API, req.ip (which keys the per-IP sign-in and magic-link throttles and the
 * audit IPs through req.ctx.ip) is the address Cloud Run's front end appended, never one the client wrote.
 */
describe('client IP behind Cloud Run (web proxy → API sidecar)', () => {
  it('only the local sidecar peer may set the client address', async () => {
    expect(await ipFor('127.0.0.1', '203.0.113.9', '127.0.0.1/32')).toBe('203.0.113.9');
    expect(await ipFor('::ffff:127.0.0.1', '203.0.113.9', '127.0.0.1/32')).toBe('203.0.113.9');
    expect(await ipFor('10.0.12.34', '6.6.6.6', '127.0.0.1/32')).toBe('10.0.12.34');
    expect(await ipFor('169.254.8.1', '6.6.6.6', '127.0.0.1/32')).toBe('169.254.8.1');
  });

  it('end to end through the web proxy, the API sees the rightmost X-Forwarded-For entry only', async () => {
    const api = Fastify({ trustProxy: trustOneProxyHop('127.0.0.1/32') });
    api.get('/v1/whoami', async (req) => ({ ip: req.ip }));
    await api.listen({ host: '127.0.0.1', port: 0 });
    const { port } = api.server.address() as AddressInfo;
    const saved = { url: process.env.API_PROXY_URL, source: process.env.CLIENT_IP_SOURCE };
    process.env.API_PROXY_URL = `http://127.0.0.1:${port}`;
    process.env.CLIENT_IP_SOURCE = 'cloud-run';
    const viaWeb = async (xff?: string) => {
      const res = await proxyToApi(
        new Request('https://app.example.test/v1/whoami', { headers: xff ? { 'x-forwarded-for': xff } : {} }),
      );
      return ((await res.json()) as { ip: string }).ip;
    };
    try {
      expect(await viaWeb('203.0.113.9')).toBe('203.0.113.9');
      // spoofed entries to the left of what Cloud Run appended are ignored
      expect(await viaWeb('6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
      expect(await viaWeb('203.0.113.9, 6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
      // a client pretending to be 203.0.113.9 is still seen at the address it connected from
      expect(await viaWeb('203.0.113.9, 198.51.100.20')).toBe('198.51.100.20');
      // nothing usable forwarded: the API sees the proxy itself
      expect(await viaWeb('6.6.6.6, not-an-ip')).toBe('127.0.0.1');
      expect(await viaWeb()).toBe('127.0.0.1');
      // without CLIENT_IP_SOURCE the proxy forwards no client address at all (local development, e2e)
      delete process.env.CLIENT_IP_SOURCE;
      expect(await viaWeb('6.6.6.6, 203.0.113.9')).toBe('127.0.0.1');
    } finally {
      if (saved.url === undefined) delete process.env.API_PROXY_URL;
      else process.env.API_PROXY_URL = saved.url;
      if (saved.source === undefined) delete process.env.CLIENT_IP_SOURCE;
      else process.env.CLIENT_IP_SOURCE = saved.source;
      await api.close();
    }
  });
});
