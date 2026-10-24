import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CellConfig } from '@thapsus/core';

/**
 * Browser-facing HTTP hardening shared by every route (ASVS V3.3, V3.5, V4.1, V5.4, V14.3).
 * See docs/ASVS.md and ADR-0130.
 */

// ---- session cookies (V3.3.1, V3.3.3) ----------------------------------------------------------------

/** Over HTTPS the session cookie carries the `__Host-` prefix: Secure, Path=/, no Domain (host-only). */
export const SESSION_COOKIE_SECURE = '__Host-thr_sid';
/** Plain-HTTP local development and e2e only, where a `__Host-` cookie cannot be set. */
export const SESSION_COOKIE_DEV = 'thr_sid';
export const STAFF_COOKIE_SECURE = '__Host-thr_staff';
export const STAFF_COOKIE_DEV = 'thr_staff';

export interface CookieSpec {
  name: string;
  secure: boolean;
  path: string;
}

const isHttps = (config: Pick<CellConfig, 'apiBaseUrl'>) => config.apiBaseUrl.startsWith('https://');

export function sessionCookie(config: Pick<CellConfig, 'apiBaseUrl'>): CookieSpec {
  const secure = isHttps(config);
  return { name: secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV, secure, path: '/' };
}

/**
 * Back-office staff cookie. Over HTTPS it is `__Host-` prefixed, which requires Path=/ (SameSite=Strict
 * keeps it off cross-site requests; only /v1/backoffice routes read it). Over plain HTTP it stays scoped
 * to /v1/backoffice.
 */
export function staffCookie(config: Pick<CellConfig, 'apiBaseUrl'>): CookieSpec {
  const secure = isHttps(config);
  return secure
    ? { name: STAFF_COOKIE_SECURE, secure, path: '/' }
    : { name: STAFF_COOKIE_DEV, secure, path: '/v1/backoffice' };
}

/**
 * Binds an OIDC sign-in to the browser that started it (ASVS V10.1.2): a random value in this
 * short-lived cookie must come back with the identity provider's redirect.
 */
export function ssoBindingCookie(config: Pick<CellConfig, 'apiBaseUrl'>): CookieSpec {
  const secure = isHttps(config);
  return { name: secure ? '__Host-thr_sso' : 'thr_sso', secure, path: '/' };
}

// ---- browser request forgery (V3.5.1, V3.5.2) ---------------------------------------------------------

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** Origins whose pages may send state-changing requests with the user's cookies. */
export function trustedOrigins(
  config: Pick<CellConfig, 'appBaseUrl' | 'apiBaseUrl' | 'globalBaseUrl' | 'backofficeBaseUrl'>,
): Set<string> {
  return new Set(
    [
      config.appBaseUrl,
      config.apiBaseUrl,
      config.globalBaseUrl,
      config.backofficeBaseUrl ?? config.appBaseUrl,
    ]
      .map(originOf)
      .filter((o): o is string => !!o),
  );
}

/**
 * Decides whether a state-changing request may proceed. Browsers send `Origin` on every non-GET
 * request (and `Sec-Fetch-Site`), so a request from another site's page is refused whatever its
 * content type. Requests without either header come from non-browser clients and carry no ambient
 * credentials a third-party page could abuse. Requests that authenticate only with an
 * Authorization header (API keys, OAuth tokens, SCIM, Basic) are not forgeable either.
 */
export function crossSiteRefusal(
  req: { method: string; headers: Record<string, string | string[] | undefined> },
  trusted: Set<string>,
): 'untrustedOrigin' | 'crossSite' | undefined {
  if (!UNSAFE.has(req.method)) return undefined;
  if (req.headers.authorization && !req.headers.cookie) return undefined;
  const origin = req.headers.origin;
  if (typeof origin === 'string') return trusted.has(origin) ? undefined : 'untrustedOrigin';
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return 'crossSite';
  return undefined;
}

// ---- Content-Type charset (V4.1.1) --------------------------------------------------------------------

/** Adds `charset=utf-8` to text and XML media types that lack one (JSON needs none: RFC 8259 §11). */
export function withCharset(contentType: string): string {
  const [type, ...params] = contentType.split(';').map((p) => p.trim());
  const media = (type ?? '').toLowerCase();
  const textual =
    media.startsWith('text/') ||
    media === 'application/xml' ||
    media.endsWith('+xml') ||
    media === 'application/javascript';
  if (!textual || params.some((p) => p.toLowerCase().startsWith('charset='))) return contentType;
  return [type, ...params, 'charset=utf-8'].join('; ');
}

export async function charsetOnSend(_req: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const ct = reply.getHeader('content-type');
  if (typeof ct === 'string') {
    const fixed = withCharset(ct);
    if (fixed !== ct) reply.header('content-type', fixed);
  }
  return payload;
}

// ---- download file names (V5.4.1, V5.4.2) -------------------------------------------------------------

/**
 * RFC 6266 / RFC 8187 Content-Disposition for a download. The quoted `filename` is an ASCII-only,
 * sanitised fallback (no quotes, backslashes, control characters, path separators or `;`); the
 * exact UTF-8 name goes in `filename*`. Never lets a stored name change the header's structure.
 */
export function contentDisposition(
  fileName: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const cleaned =
    fileName
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f"\\/;]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 200) || 'download';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return ascii === cleaned
    ? `${disposition}; filename="${ascii}"`
    : `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
