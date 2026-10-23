'use client';
import { compareInstants } from '@thapsus/core/time';
import { api, ApiProblem } from './api';

/**
 * Offline clock queue for the PWA. Punches are written to this device first (localStorage, per user)
 * and sent in a batch with a client-generated id, so a retry after a dropped connection can never
 * create a duplicate: the API answers "duplicate" for ids it has already stored.
 */
export type ClockKind = 'in' | 'out' | 'break_start' | 'break_end';
export interface QueuedPunch {
  clientEventId: string;
  kind: ClockKind;
  occurredAt: string;
  zone?: string;
  location?: { lat: number; lng: number };
}
export interface ClockState {
  state: 'out' | 'in' | 'break';
  since: string | null;
}
export interface SyncResult {
  results: Array<{ clientEventId: string; status: 'created' | 'duplicate' | 'rejected'; reason?: string }>;
  state: ClockState;
  geofence: { enabled: boolean; notice: string | null };
}

const key = (userId: string) => `thr.clock.queue.v1.${userId}`;

export function readQueue(userId: string): QueuedPunch[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeQueue(userId: string, q: QueuedPunch[]) {
  if (q.length) localStorage.setItem(key(userId), JSON.stringify(q));
  else localStorage.removeItem(key(userId));
}

export function newClientEventId(): string {
  return `pwa-${crypto.randomUUID()}`;
}

export function enqueue(userId: string, p: QueuedPunch): QueuedPunch[] {
  const q = [...readQueue(userId), p];
  writeQueue(userId, q);
  return q;
}

let inFlight: Promise<SyncResult | null> | null = null;

/** Sends everything queued; entries the server answered (created, duplicate or rejected) leave the queue. */
export function syncQueue(userId: string): Promise<SyncResult | null> {
  if (inFlight) return inFlight;
  const run = async (): Promise<SyncResult | null> => {
    try {
      const q = readQueue(userId);
      if (!q.length) return null;
      const batch = q.slice(0, 200);
      const r = await api<SyncResult>('/v1/clock/events', { method: 'POST', json: { events: batch } });
      const answered = new Set(r.results.map((x) => x.clientEventId));
      writeQueue(
        userId,
        readQueue(userId).filter((x) => !answered.has(x.clientEventId)),
      );
      return r;
    } catch (err) {
      // offline or server unreachable: keep everything queued; an auth error also keeps it for the next sign-in
      if (err instanceof ApiProblem && err.status === 400) writeQueue(userId, []);
      return null;
    }
  };
  // cleared in a later microtask, after the assignment (the body may finish synchronously)
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The state after applying queued punches on top of the last state the server confirmed. */
export function projectState(server: ClockState, queue: QueuedPunch[]): ClockState {
  let s = server;
  for (const p of [...queue].sort((a, b) => compareInstants(a.occurredAt, b.occurredAt))) {
    if (p.kind === 'in') s = { state: 'in', since: p.occurredAt };
    else if (p.kind === 'out') s = { state: 'out', since: p.occurredAt };
    else if (p.kind === 'break_start' && s.state === 'in') s = { state: 'break', since: p.occurredAt };
    else if (p.kind === 'break_end' && s.state === 'break') s = { state: 'in', since: p.occurredAt };
  }
  return s;
}
