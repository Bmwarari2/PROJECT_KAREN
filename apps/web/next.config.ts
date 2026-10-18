import type { NextConfig } from 'next';

/**
 * Locally (and in e2e) the API runs separately, so API paths are proxied to it. In AWS the ALB
 * routes those paths to the API service directly and API_PROXY_URL is unset.
 */
const api = process.env.API_PROXY_URL;
const API_PATHS = ['/v1/:path*', '/scim/:path*', '/__mock-idp/:path*', '/global/:path*', '/openapi.json'];

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@thapsus/ui', '@thapsus/core'],
  images: { formats: ['image/avif', 'image/webp'] },
  async rewrites() {
    return api ? API_PATHS.map((source) => ({ source, destination: `${api}${source.replace('/:path*', '/:path*')}` })) : [];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};

export default config;
