import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIpHeaders, forwardedClientIp, proxyToApi } from '../lib/proxy';

/**
 * The web proxy in front of the API sidecar (Google Cloud staging, ADR-0156). With CLIENT_IP_SOURCE=cloud-run it
 * forwards only the rightmost X-Forwarded-For entry, the address Cloud Run's front end appended; anything to its left
 * came from the client. Without it, client forwarding headers are dropped as before. Fictional addresses only.
 */
const headers = (h: Record<string, string>) => new Headers(h);

describe('forwardedClientIp', () => {
  it('is off unless CLIENT_IP_SOURCE=cloud-run', () => {
    expect(forwardedClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), undefined)).toBeUndefined();
    expect(forwardedClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), '')).toBeUndefined();
  });

  it('takes the rightmost entry and ignores every client-supplied entry to its left', () => {
    const ip = (xff: string) => forwardedClientIp(headers({ 'x-forwarded-for': xff }), 'cloud-run');
    expect(ip('203.0.113.9')).toBe('203.0.113.9');
    expect(ip('6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(ip('6.6.6.6,7.7.7.7 ,  198.51.100.7 ')).toBe('198.51.100.7');
    expect(ip('6.6.6.6, 2001:db8::7')).toBe('2001:db8::7');
    // the client cannot win by sending several headers either (they are joined, Cloud Run appends last)
    const multi = new Headers();
    multi.append('x-forwarded-for', '6.6.6.6');
    multi.append('x-forwarded-for', '203.0.113.9');
    expect(forwardedClientIp(multi, 'cloud-run')).toBe('203.0.113.9');
  });

  it('forwards nothing when the rightmost entry is not an IP address or there is no header', () => {
    for (const xff of ['6.6.6.6, unknown', '6.6.6.6, ', '203.0.113.9:443', '6.6.6.6, [2001:db8::7]'])
      expect(forwardedClientIp(headers({ 'x-forwarded-for': xff }), 'cloud-run'), xff).toBeUndefined();
    expect(forwardedClientIp(headers({}), 'cloud-run')).toBeUndefined();
  });

  it('refuses an unknown CLIENT_IP_SOURCE rather than guessing', () => {
    expect(() => forwardedClientIp(headers({}), 'cloudrun')).toThrow(/CLIENT_IP_SOURCE/);
  });

  it('clientIpHeaders gives the header to send to the API', () => {
    expect(clientIpHeaders(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), 'cloud-run')).toEqual({
      'x-forwarded-for': '203.0.113.9',
    });
    expect(clientIpHeaders(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), undefined)).toEqual({});
  });
});

describe('proxyToApi forwarding headers', () => {
  const sent: Headers[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    sent.length = 0;
  });
  const call = async (incoming: Record<string, string>) => {
    vi.stubEnv('API_PROXY_URL', 'http://127.0.0.1:4000');
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await proxyToApi(new Request('https://app.example.test/v1/auth/login', { headers: incoming }));
    return sent[0]!;
  };
  const spoofed = {
    'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9',
    'x-real-ip': '6.6.6.6',
    forwarded: 'for=6.6.6.6',
  };

  it('by default drops every client forwarding header', async () => {
    const h = await call(spoofed);
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('x-real-ip')).toBeNull();
    expect(h.get('forwarded')).toBeNull();
  });

  it('with CLIENT_IP_SOURCE=cloud-run sends exactly the rightmost entry and still drops the rest', async () => {
    vi.stubEnv('CLIENT_IP_SOURCE', 'cloud-run');
    const h = await call(spoofed);
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(h.get('x-real-ip')).toBeNull();
    expect(h.get('forwarded')).toBeNull();
    expect(h.get('x-forwarded-host')).toBe('app.example.test');
  });
});
