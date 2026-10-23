/**
 * Content Security Policy for the web app (ASVS V3.4.3, V3.4.6; ADR-0130). Pages are rendered per
 * request, so every HTML response gets a fresh nonce: Next.js reads it from the request's CSP header
 * and puts it on its own scripts, and 'strict-dynamic' lets those load their chunks. No other script
 * runs: no inline handlers, no eval in production, no plugins (object-src 'none'), no <base> rewrite
 * (base-uri 'none'), and the app is never framed (frame-ancestors 'none'). Styles keep 'unsafe-inline'
 * (style attributes from React cannot carry a nonce); they cannot run script.
 */
export function contentSecurityPolicy(nonce: string, opts: { dev?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Policy for static build assets, icons and fonts (nothing on them may run or frame). */
export const STATIC_ASSET_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/** 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
