import type { NextConfig } from 'next';
import { STATIC_ASSET_CSP } from './lib/csp';

// Pages get a per-request nonce-based Content-Security-Policy from proxy.ts (ADR-0130); the static
// assets below, which the proxy skips, get a fixed policy under which nothing can run or be framed.

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
];

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@thapsus/ui', '@thapsus/core'],
  images: { formats: ['image/avif', 'image/webp'] },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      ...['/_next/static/:path*', '/fonts/:path*', '/icons/:path*'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: STATIC_ASSET_CSP }] })),
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Service-Worker-Allowed', value: '/' },
          // a worker script's own policy governs what it may fetch and import
          { key: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
        ],
      },
    ];
  },
};

export default config;
