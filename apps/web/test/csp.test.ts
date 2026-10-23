import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce, STATIC_ASSET_CSP } from '../lib/csp';

/** ASVS V3.4.3 and V3.4.6: a nonce-based policy with object-src and base-uri 'none', never framed. */
describe('content security policy', () => {
  const directives = (csp: string) =>
    new Map(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .map(([name, ...values]) => [name!, values]),
    );

  it('pages allow only nonce-carrying scripts (and what they load), no plugins, no base rewrite, no framing', () => {
    const d = directives(contentSecurityPolicy('bm9uY2U='));
    expect(d.get('script-src')).toEqual(["'self'", "'nonce-bm9uY2U='", "'strict-dynamic'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(contentSecurityPolicy('x')).not.toContain('unsafe-eval');
    expect(d.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('only development adds unsafe-eval (React debugging), never production', () => {
    expect(directives(contentSecurityPolicy('x', { dev: true })).get('script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('nonces are fresh 128-bit values', () => {
    const a = newNonce();
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
    expect(new Set(Array.from({ length: 50 }, newNonce)).size).toBe(50);
  });

  it('static assets get a policy under which nothing runs or frames, and pages are covered by the proxy', () => {
    const d = directives(STATIC_ASSET_CSP);
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    const proxy = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
    expect(proxy).toContain("response.headers.set('content-security-policy', csp)");
    const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
    expect(config).not.toContain("'unsafe-inline'");
  });

  it('no page opts out of per-request rendering (a prerendered page would carry no nonce and its scripts would be blocked)', () => {
    const root = new URL('../app', import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.(tsx?|jsx?)$/.test(f),
    );
    const offenders = files.filter((f) =>
      /force-static|export const revalidate|generateStaticParams/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
