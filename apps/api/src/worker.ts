import type { EventSubscriber, JobHandler } from '@thapsus/db';
import type { Deps } from './deps';

/** Domain job handlers and outbox subscribers, run by apps/worker. Modules add entries per phase. */
export const jobHandlers: Record<string, JobHandler<Deps>> = {};
export const eventSubscribers: Record<string, EventSubscriber[]> = {};

export function registerJob(kind: string, handler: JobHandler<Deps>) {
  jobHandlers[kind] = handler;
}
export function subscribe(topic: string, subscriber: EventSubscriber) {
  (eventSubscribers[topic] ??= []).push(subscriber);
}

export { depsFromEnv } from './deps';
