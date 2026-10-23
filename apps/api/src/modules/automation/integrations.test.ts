import { describe, expect, it } from 'vitest';
import { isPublicHttpsUrl, signBody } from './integrations';

describe('outbound URL guard', () => {
  it('allows public https hosts only', () => {
    for (const ok of [
      'https://hooks.example.test/x',
      'https://203.0.113.10/hook',
      'https://[2001:db8::1]/x',
      'https://api.example.com:8443/path?q=1',
    ])
      expect(isPublicHttpsUrl(ok), ok).toBe(true);
    for (const bad of [
      'http://hooks.example.test/x',
      'ftp://example.com',
      'not a url',
      'https://localhost/x',
      'https://app.localhost/x',
      'https://printer.local/x',
      'https://db.internal/x',
      'https://metadata/x',
      'https://127.0.0.1/x',
      'https://10.0.0.8/x',
      'https://172.16.5.4/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://user:pw@example.com/x',
    ])
      expect(isPublicHttpsUrl(bad), bad).toBe(false);
  });

  it('signs with a key unique to each tenant', () => {
    const a = signBody('k', '00000000-0000-4000-8000-00000000000a', '{"x":1}');
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signBody('k', '00000000-0000-4000-8000-00000000000b', '{"x":1}')).not.toBe(a);
    expect(signBody('k', '00000000-0000-4000-8000-00000000000a', '{"x":1}')).toBe(a);
  });
});
