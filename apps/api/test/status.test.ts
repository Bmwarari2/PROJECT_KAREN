import { describe, expect, it } from 'vitest';
import { computeStatus, EMAIL_OUTAGE_AFTER_FAILURES, WORKER_DEGRADED_AFTER_MINUTES, WORKER_OUTAGE_AFTER_MINUTES, type IncidentInput, type StatusInput } from '../src/modules/status/service';

/** Status computation for the public per-region status page (PROGRESS 10.3). */
const now = '2027-04-01T12:00:00Z';
const minus = (m: number) => new Date(new Date(now).getTime() - m * 60_000).toISOString();
const base: StatusInput = { region: 'eu', now, database: { ok: true, latencyMs: 4 }, worker: { beatAt: minus(0.5) }, email: null, incidents: [] };
const state = (s: ReturnType<typeof computeStatus>, id: string) => s.components.find((c) => c.id === id)!.state;
const incident = (over: Partial<IncidentInput>): IncidentInput => ({ id: 'i', kind: 'incident', impact: 'major', title: 'Fictional problem', components: ['api'], status: 'investigating', scheduledStart: null, scheduledEnd: null, startedAt: minus(10), resolvedAt: null, updates: [], ...over });

describe('component health', () => {
  it('all operational when every check passes', () => {
    const s = computeStatus(base);
    expect(s.overall).toBe('operational');
    expect(s.components.map((c) => c.id)).toEqual(['api', 'database', 'worker', 'email']);
    expect(s.region).toBe('eu');
  });

  it('database outage and slowness', () => {
    expect(state(computeStatus({ ...base, database: { ok: false, latencyMs: 0 } }), 'database')).toBe('outage');
    expect(state(computeStatus({ ...base, database: { ok: true, latencyMs: 1500 } }), 'database')).toBe('degraded');
  });

  it('worker heartbeat age', () => {
    expect(state(computeStatus({ ...base, worker: { beatAt: minus(WORKER_DEGRADED_AFTER_MINUTES) } }), 'worker')).toBe('degraded');
    expect(state(computeStatus({ ...base, worker: { beatAt: minus(WORKER_OUTAGE_AFTER_MINUTES) } }), 'worker')).toBe('outage');
    expect(state(computeStatus({ ...base, worker: { beatAt: null } }), 'worker')).toBe('outage');
  });

  it('email delivery outcomes', () => {
    expect(state(computeStatus({ ...base, email: { lastSuccessAt: minus(1), lastFailureAt: minus(5), recentFailures: 0 } }), 'email')).toBe('operational');
    expect(state(computeStatus({ ...base, email: { lastSuccessAt: minus(10), lastFailureAt: minus(1), recentFailures: 2 } }), 'email')).toBe('degraded');
    expect(state(computeStatus({ ...base, email: { lastSuccessAt: null, lastFailureAt: minus(1), recentFailures: EMAIL_OUTAGE_AFTER_FAILURES } }), 'email')).toBe('outage');
  });
});

describe('posted incidents and maintenance', () => {
  it('an active incident raises its components (minor → degraded, major/critical → outage) and the overall status', () => {
    const s = computeStatus({ ...base, incidents: [incident({ impact: 'minor', components: ['email'] }), incident({ id: 'j', impact: 'critical', components: ['api', 'database'] })] });
    expect(state(s, 'email')).toBe('degraded');
    expect(state(s, 'api')).toBe('outage');
    expect(state(s, 'database')).toBe('outage');
    expect(s.overall).toBe('outage');
    expect(s.active).toHaveLength(2);
  });

  it('maintenance shows only inside its window; upcoming windows are listed; resolved posts go to history', () => {
    const upcoming = incident({ id: 'm1', kind: 'maintenance', impact: 'maintenance', components: ['database'], status: 'scheduled', scheduledStart: '2027-04-02T01:00:00Z', scheduledEnd: '2027-04-02T02:00:00Z', startedAt: '2027-04-02T01:00:00Z' });
    const during = incident({ id: 'm2', kind: 'maintenance', impact: 'maintenance', components: ['worker'], status: 'in_progress', scheduledStart: minus(10), scheduledEnd: '2027-04-01T13:00:00Z', startedAt: minus(10) });
    const resolved = incident({ id: 'r', resolvedAt: minus(1), status: 'resolved' });
    const s = computeStatus({ ...base, incidents: [upcoming, during, resolved] });
    expect(state(s, 'database')).toBe('operational');
    expect(state(s, 'worker')).toBe('maintenance');
    expect(state(s, 'api')).toBe('operational');
    expect(s.overall).toBe('maintenance');
    expect(s.upcoming.map((i) => i.id)).toEqual(['m1']);
    expect(s.history.map((i) => i.id)).toEqual(['r']);
  });

  it('measured outages are never hidden by a lighter posted state', () => {
    const s = computeStatus({ ...base, database: { ok: false, latencyMs: 0 }, incidents: [incident({ impact: 'minor', components: ['database'] })] });
    expect(state(s, 'database')).toBe('outage');
  });
});
