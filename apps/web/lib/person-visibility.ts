'use client';
import * as React from 'react';
import { allows, hasFromGrants, type CapabilityKey } from '@thapsus/core/capabilities';
import { api, type SessionInfo } from './api';

/**
 * Which people the viewer may open (ADR-0161). A name links to a profile only where GET
 * /v1/employees/:id would answer, so a role never gets a link to a page it cannot open. The names
 * shown on a page are asked about together, in one request per tick (POST /v1/people/visibility);
 * answers are kept for the session in memory only (they name no personal data). An answer of "all"
 * (HR, owners) settles every later name without asking again.
 */
type State = { known: Map<string, boolean>; all: boolean };
const BATCH = 200;
let owner: string | null = null;
let state: State = { known: new Map(), all: false };
let pending = new Set<string>();
let scheduled = false;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  for (const l of listeners) l();
}

function resetFor(userId: string) {
  if (owner === userId) return;
  owner = userId;
  state = { known: new Map(), all: false };
  pending = new Set();
}

async function flush() {
  scheduled = false;
  const forUser = owner;
  const ids = [...pending];
  pending = new Set();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const r = await api<{ all: boolean; visible: string[] }>('/v1/people/visibility', {
        method: 'POST',
        json: { ids: chunk },
        capability: 'people.visibility',
      });
      if (forUser !== owner) return;
      if (r.all) state.all = true;
      const yes = new Set(r.visible);
      for (const id of chunk) state.known.set(id, r.all || yes.has(id));
    } catch {
      // unanswered names stay plain text; they are asked about again on the next page that shows them
      if (forUser !== owner) return;
    }
  }
  emit();
}

function ask(id: string) {
  if (state.all || state.known.has(id) || pending.has(id)) return;
  pending.add(id);
  if (!scheduled) {
    scheduled = true;
    // every name rendered in the same tick goes into the same request
    setTimeout(() => void flush(), 0);
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => version;

/** True when the session's grants can open a profile at all (any scope), or this one is their own. */
function possible(session: SessionInfo, id: string): boolean | 'ask' {
  const viewer = { has: hasFromGrants(session.permissions), employeeId: session.employeeId };
  const can = (c: CapabilityKey) => allows(viewer, c);
  if (id === session.employeeId && (can('people.visibility') || can('people.directory'))) return true;
  // asking needs the directory (to see anyone else) and the visibility check itself (the permission map)
  if (!can('people.directory') || !can('people.visibility')) return false;
  return 'ask';
}

/**
 * Whether the viewer may open this person's profile: true, false, or undefined while the answer is
 * on its way (render the name as text meanwhile).
 */
export function usePersonVisible(
  session: SessionInfo | null | undefined,
  id: string | null | undefined,
): boolean | undefined {
  React.useSyncExternalStore(subscribe, snapshot, () => 0);
  const decided = !session || !id ? false : possible(session, id);
  React.useEffect(() => {
    if (!session || !id || decided !== 'ask') return;
    resetFor(session.userId);
    ask(id);
  }, [session, id, decided]);
  if (decided !== 'ask') return decided;
  if (owner !== session!.userId) return undefined;
  if (state.all) return true;
  return state.known.get(id!);
}
