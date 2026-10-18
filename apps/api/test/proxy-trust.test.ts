import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustOneProxyHop } from '../src/app';

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
