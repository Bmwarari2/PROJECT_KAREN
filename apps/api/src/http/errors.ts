import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { t, type Locale } from '@thapsus/core/i18n';
import { TenantNotFoundError, TenantUnavailableError } from '@thapsus/db';
import { ResidencyViolationError } from '@thapsus/core';

/** Error codes map to message catalogue keys errors.<code> where one exists. */
export type ErrorCode =
  | 'validation'
  | 'unauthorised'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'rateLimited'
  | 'lockedOut'
  | 'mfaRequired'
  | 'mfaEnrollmentRequired'
  | 'reauthenticationRequired'
  | 'ssoRequired'
  | 'wrongRegion'
  | 'invalidCredentials'
  | 'tenantUnavailable'
  | 'gone'
  | 'unprocessable'
  | 'notImplemented'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorised: 401,
  invalidCredentials: 401,
  forbidden: 403,
  mfaRequired: 403,
  mfaEnrollmentRequired: 403,
  reauthenticationRequired: 403,
  ssoRequired: 403,
  notFound: 404,
  conflict: 409,
  wrongRegion: 421,
  gone: 410,
  lockedOut: 423,
  unprocessable: 422,
  rateLimited: 429,
  notImplemented: 501,
  tenantUnavailable: 503,
  internal: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.status = STATUS[code];
  }
}

export const notFound = () => new ApiError('notFound');
export const forbidden = (detail?: string) => new ApiError('forbidden', detail);

function title(locale: Locale, code: ErrorCode) {
  const key = `errors.${code}`;
  const msg = t(locale, key);
  return msg === key ? t(locale, 'common.error') : msg;
}

/**
 * Security events for refused requests (ASVS V16.3.2, V16.3.3; docs/SECURITY.md "Security logging"):
 * failed authorisation, anti-automation limits and rejected input are logged as structured events
 * with pseudonymous ids only (tenant, user, request), never values, names, emails, IPs or tokens.
 */
const SECURITY_EVENTS: Partial<Record<ErrorCode, { event: string; level: 'warn' | 'info' }>> = {
  forbidden: { event: 'authz.denied', level: 'warn' },
  mfaRequired: { event: 'authz.denied', level: 'info' },
  mfaEnrollmentRequired: { event: 'authz.denied', level: 'info' },
  reauthenticationRequired: { event: 'authz.denied', level: 'info' },
  ssoRequired: { event: 'authz.denied', level: 'info' },
  unauthorised: { event: 'authn.missing', level: 'info' },
  invalidCredentials: { event: 'authn.failed', level: 'warn' },
  rateLimited: { event: 'antiautomation.limited', level: 'warn' },
  lockedOut: { event: 'antiautomation.locked', level: 'warn' },
  validation: { event: 'input.rejected', level: 'info' },
};

export function securityEvent(
  req: FastifyRequest,
  code: ErrorCode,
  extra: Record<string, unknown>,
  detail?: string,
) {
  const def = SECURITY_EVENTS[code];
  if (!def) return;
  const fields = Array.isArray(extra.errors)
    ? (extra.errors as Array<{ path?: unknown }>).map((e) => String(e.path ?? '')).slice(0, 20)
    : undefined;
  req.log[def.level](
    {
      securityEvent: def.event,
      code,
      reason: typeof detail === 'string' && /^[A-Za-z]{1,40}$/.test(detail) ? detail : undefined,
      method: req.method,
      route: req.routeOptions?.url,
      tenantId: req.auth?.tenantId,
      actorId: req.auth?.userId,
      actorType: req.auth ? (req.auth.apiClient ? 'api_client' : 'user') : undefined,
      fields,
      requestId: req.id,
    },
    'security event',
  );
}

export function problem(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCode,
  extra: Record<string, unknown> = {},
  detail?: string,
) {
  const status = STATUS[code];
  securityEvent(req, code, extra, detail);
  return reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `about:blank#${code}`,
      title: title(req.ctx?.locale ?? 'en-GB', code),
      status,
      code,
      detail,
      requestId: req.id,
      ...extra,
    });
}

export function errorHandler(
  err: FastifyError & { code?: string },
  req: FastifyRequest,
  reply: FastifyReply,
) {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.extra.retryAfter) reply.header('Retry-After', String(err.extra.retryAfter));
    return problem(req, reply, err.code, err.extra, err.message !== err.code ? err.message : undefined);
  }
  if (err.validation) {
    return problem(req, reply, 'validation', {
      errors: err.validation.map((v) => ({
        path: v.instancePath || (v.params as { missingProperty?: string })?.missingProperty,
        message: v.message,
      })),
    });
  }
  if (err instanceof TenantNotFoundError) return problem(req, reply, 'notFound');
  if (err instanceof TenantUnavailableError) return problem(req, reply, 'tenantUnavailable');
  if (err instanceof ResidencyViolationError) {
    req.log.error({ err }, 'residency violation');
    return problem(req, reply, 'internal');
  }
  switch (err.code) {
    case '23505':
    case '23P01':
      return problem(req, reply, 'conflict');
    case '23503':
    case '23514':
    case '22007':
    case '22008':
      return problem(req, reply, 'unprocessable');
    case '42501':
      return problem(req, reply, 'forbidden');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return problem(req, reply, 'validation');
  }
  if (err.statusCode && err.statusCode < 500)
    return problem(req, reply, err.statusCode === 404 ? 'notFound' : 'validation');
  req.log.error({ err }, 'unhandled error');
  return problem(req, reply, 'internal');
}
