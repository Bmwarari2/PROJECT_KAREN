import type pg from 'pg';
import { compareInstants, minutesBetween } from '@thapsus/core/time';
import type { HomeRegion } from '@thapsus/core';
import type { TenantRouter } from '@thapsus/db';
import type { Mail, Mailer } from '../../lib/mailer';

/**
 * Public status per cell (ADR-0105). Component health comes from this cell only: the API answering,
 * a database round trip, the worker heartbeat and email delivery outcomes, plus incidents and
 * maintenance posted by staff for this region. Contains no personal data.
 */
export const COMPONENTS = ['api', 'database', 'worker', 'email'] as const;
export type Component = (typeof COMPONENTS)[number];
export type ComponentState = 'operational' | 'degraded' | 'outage' | 'maintenance';
const SEVERITY: ComponentState[] = ['operational', 'maintenance', 'degraded', 'outage'];

export const WORKER_DEGRADED_AFTER_MINUTES = 3;
export const WORKER_OUTAGE_AFTER_MINUTES = 15;
export const EMAIL_OUTAGE_AFTER_FAILURES = 5;

export interface IncidentInput {
  id: string;
  kind: 'incident' | 'maintenance';
  impact: 'minor' | 'major' | 'critical' | 'maintenance';
  title: string;
  components: Component[];
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string;
  resolvedAt: string | null;
  updates: Array<{ status: string; body: string; createdAt: string }>;
}

export interface StatusInput {
  region: HomeRegion;
  now: string;
  database: { ok: boolean; latencyMs: number };
  worker: { beatAt: string | null };
  email: { lastSuccessAt: string | null; lastFailureAt: string | null; recentFailures: number } | null;
  incidents: IncidentInput[];
}

const worst = (a: ComponentState, b: ComponentState) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

function isActive(i: IncidentInput, now: string): boolean {
  if (i.resolvedAt) return false;
  if (i.kind === 'incident') return true;
  return (
    !!i.scheduledStart &&
    !!i.scheduledEnd &&
    compareInstants(i.scheduledStart, now) <= 0 &&
    compareInstants(now, i.scheduledEnd) < 0
  );
}

function isUpcoming(i: IncidentInput, now: string): boolean {
  return (
    i.kind === 'maintenance' &&
    !i.resolvedAt &&
    !!i.scheduledStart &&
    compareInstants(i.scheduledStart, now) > 0
  );
}

/** Pure status computation (tested): measured health, then overridden upwards by posted incidents. */
export function computeStatus(s: StatusInput) {
  const measured: Record<Component, ComponentState> = {
    api: 'operational',
    database: !s.database.ok ? 'outage' : s.database.latencyMs > 1000 ? 'degraded' : 'operational',
    worker: !s.worker.beatAt
      ? 'outage'
      : minutesBetween(s.worker.beatAt, s.now) >= WORKER_OUTAGE_AFTER_MINUTES
        ? 'outage'
        : minutesBetween(s.worker.beatAt, s.now) >= WORKER_DEGRADED_AFTER_MINUTES
          ? 'degraded'
          : 'operational',
    email:
      !s.email ||
      !s.email.lastFailureAt ||
      (s.email.lastSuccessAt && compareInstants(s.email.lastSuccessAt, s.email.lastFailureAt) > 0)
        ? 'operational'
        : s.email.recentFailures >= EMAIL_OUTAGE_AFTER_FAILURES
          ? 'outage'
          : 'degraded',
  };
  const active = s.incidents.filter((i) => isActive(i, s.now));
  const states = { ...measured };
  for (const i of active) {
    const st: ComponentState =
      i.kind === 'maintenance' ? 'maintenance' : i.impact === 'minor' ? 'degraded' : 'outage';
    for (const c of i.components) states[c] = worst(states[c], st);
  }
  const overall = COMPONENTS.reduce<ComponentState>((acc, c) => worst(acc, states[c]), 'operational');
  const view = (i: IncidentInput) => ({
    id: i.id,
    kind: i.kind,
    impact: i.impact,
    title: i.title,
    components: i.components,
    status: i.status,
    scheduledStart: i.scheduledStart,
    scheduledEnd: i.scheduledEnd,
    startedAt: i.startedAt,
    resolvedAt: i.resolvedAt,
    updates: i.updates,
  });
  return {
    region: s.region,
    generatedAt: s.now,
    overall,
    components: COMPONENTS.map((id) => ({ id, state: states[id] })),
    active: active.map(view),
    upcoming: s.incidents.filter((i) => isUpcoming(i, s.now)).map(view),
    history: s.incidents.filter((i) => !!i.resolvedAt).map(view),
  };
}

/** Worker loop heartbeat (written at most every 30 s by apps/worker). */
export async function recordHeartbeat(router: TenantRouter, service: 'worker', at = new Date()) {
  await router
    .registryPool()
    .query(
      `INSERT INTO backoffice.service_heartbeats (service, beat_at) VALUES ($1, $2) ON CONFLICT (service) DO UPDATE SET beat_at = EXCLUDED.beat_at`,
      [service, at.toISOString()],
    );
}

/**
 * Wraps the cell mailer to record delivery outcomes for the status page (timestamps and a failure
 * count only — never recipients or content). Successes are written at most once a minute.
 */
export function withDeliveryHealth(inner: Mailer, pool: () => pg.Pool): Mailer {
  let lastSuccessWrite = 0;
  const write = (sql: string, params: unknown[]) =>
    pool()
      .query(sql, params)
      .catch(() => undefined);
  return {
    region: inner.region,
    async send(mail: Mail) {
      try {
        await inner.send(mail);
      } catch (err) {
        await write(
          `INSERT INTO backoffice.service_heartbeats (service, beat_at, last_failure_at, recent_failures) VALUES ('email', now(), now(), 1)
           ON CONFLICT (service) DO UPDATE SET beat_at = now(), last_failure_at = now(), recent_failures = backoffice.service_heartbeats.recent_failures + 1`,
          [],
        );
        throw err;
      }
      if (Date.now() - lastSuccessWrite > 60_000) {
        lastSuccessWrite = Date.now();
        await write(
          `INSERT INTO backoffice.service_heartbeats (service, beat_at, last_success_at, recent_failures) VALUES ('email', now(), now(), 0)
           ON CONFLICT (service) DO UPDATE SET beat_at = now(), last_success_at = now(), recent_failures = 0`,
          [],
        );
      }
    },
  };
}
