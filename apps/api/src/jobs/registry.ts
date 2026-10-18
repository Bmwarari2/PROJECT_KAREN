import type { EventSubscriber, JobHandler, Tx } from '@thapsus/db';
import type { Deps } from '../deps';

/** Domain job handlers, outbox subscribers and periodic enqueuers (populated by modules on import). */
export const jobHandlers: Record<string, JobHandler<Deps>> = {};
export const eventSubscribers: Record<string, EventSubscriber[]> = {};
/** Called for every active tenant on each scheduler sweep; must enqueue idempotently. */
export const periodic: Array<(tx: Tx, now: Date) => Promise<void>> = [];

export function registerJob(kind: string, handler: JobHandler<Deps>) {
  jobHandlers[kind] = handler;
}
export function subscribe(topic: string, subscriber: EventSubscriber) {
  (eventSubscribers[topic] ??= []).push(subscriber);
}
