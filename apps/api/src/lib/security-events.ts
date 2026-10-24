import { createHash, createHmac } from 'node:crypto';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { HomeRegion } from '@thapsus/core';
import type { Deps } from '../deps';

/**
 * Security events for authentication, sessions and the back office (docs/SECURITY_HARDENING.md §3.1).
 * They are the hook the detection pipeline consumes: every event is written to the structured log as
 * `securityEvent` (routed with the cell's logs, in the home region) and handed to every subscriber
 * registered with onSecurityEvent().
 *
 * Events carry pseudonymous ids only: tenant, user and staff ids (UUIDs), and keyed hashes of the
 * client address and of a submitted account name, so detections can correlate "many accounts from one
 * address" without storing the address or the email. Never names, emails, addresses, tokens or values.
 */
export type SecurityEventType =
  // customer sign-in and recovery
  | 'auth.login_failed'
  | 'auth.lockout'
  | 'auth.throttled'
  | 'auth.mfa_failed'
  | 'auth.mfa_reset'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_completed'
  | 'auth.password_set_after_email_link'
  | 'auth.sso_identity_bound'
  | 'auth.sso_subject_mismatch'
  | 'auth.sso_identity_unlinked'
  | 'auth.session_network_changed'
  // Thapsus staff
  | 'staff.login'
  | 'staff.login_failed'
  | 'staff.enrolment_issued'
  | 'staff.enrolled'
  | 'staff.reauth_failed'
  | 'staff.elevation_requested'
  | 'staff.elevation_approved'
  | 'staff.elevation_denied'
  | 'staff.elevation_revoked'
  | 'staff.elevation_missing';

export type SecuritySeverity = 'info' | 'low' | 'medium' | 'high';

export interface SecurityEvent {
  type: SecurityEventType;
  severity: SecuritySeverity;
  at: string;
  cell: HomeRegion;
  tenantId?: string;
  userId?: string;
  staffId?: string;
  /** Keyed hash of the client address (the same address gives the same key within a cell). */
  ipKey?: string;
  /** Keyed hash of a submitted account name (tenant + email), for attempts on unknown accounts. */
  accountKey?: string;
  route?: string;
  requestId?: string;
  /** Codes and counts only (reason, scope, method…). */
  detail?: Record<string, string | number | boolean | null>;
}

export type SecurityEventSink = (event: SecurityEvent) => void | Promise<void>;

const sinks = new Set<SecurityEventSink>();

/** Subscribes to every security event of this process; returns the unsubscribe function. */
export function onSecurityEvent(sink: SecurityEventSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

const keys = new Map<string, Buffer>();
function pseudonymKey(deps: Pick<Deps, 'config'>): Buffer {
  const id = `${deps.config.cell}:${deps.config.internalToken}`;
  let k = keys.get(id);
  if (!k) {
    k = createHash('sha256').update(`thapsus-hr:security-events:${id}`).digest();
    keys.set(id, k);
  }
  return k;
}

/** A stable, non-reversible key for a value within this cell (HMAC-SHA-256, 128 bits, base64url). */
export function pseudonym(deps: Pick<Deps, 'config'>, kind: 'ip' | 'account', value: string): string {
  return createHmac('sha256', pseudonymKey(deps))
    .update(`${kind}:${value.toLowerCase()}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

const LEVEL: Record<SecuritySeverity, 'info' | 'warn'> = {
  info: 'info',
  low: 'info',
  medium: 'warn',
  high: 'warn',
};

export interface SecurityEventInput {
  type: SecurityEventType;
  severity?: SecuritySeverity;
  tenantId?: string;
  userId?: string;
  staffId?: string;
  /** The submitted account name (hashed before it leaves this function). */
  account?: { tenant: string; email: string };
  detail?: SecurityEvent['detail'];
}

/** Emits one event: a structured log line plus every subscriber. Never throws. */
export function emitSecurityEvent(
  deps: Pick<Deps, 'config' | 'now'>,
  req: Pick<FastifyRequest, 'id' | 'ctx' | 'routeOptions'> & { log: FastifyBaseLogger },
  input: SecurityEventInput,
): SecurityEvent {
  const event: SecurityEvent = {
    type: input.type,
    severity: input.severity ?? 'low',
    at: deps.now().toISOString(),
    cell: deps.config.cell,
    tenantId: input.tenantId,
    userId: input.userId,
    staffId: input.staffId,
    ipKey: req.ctx?.ip ? pseudonym(deps, 'ip', req.ctx.ip) : undefined,
    accountKey: input.account
      ? pseudonym(deps, 'account', `${input.account.tenant}:${input.account.email}`)
      : undefined,
    route: req.routeOptions?.url,
    requestId: req.id,
    detail: input.detail,
  };
  req.log[LEVEL[event.severity]]({ securityEvent: event.type, ...event, type: undefined }, 'security event');
  for (const sink of sinks) {
    try {
      void Promise.resolve(sink(event)).catch(() => undefined);
    } catch {
      // a failing subscriber never breaks the request
    }
  }
  return event;
}
