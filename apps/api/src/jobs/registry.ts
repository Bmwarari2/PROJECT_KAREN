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

/**
 * Cell-wide tasks with no tenant context (ADR-0176, ADR-0177): the queue sample, the detection run, alert
 * digests and metric retention. The worker runs each one when it is due; every task must be safe to run in
 * several workers at once (they dedupe on a minute key or take a row lock).
 */
export interface CellTask {
  name: string;
  everyMs: number;
  run: (deps: Deps, now: Date) => Promise<unknown>;
}
export const cellTasks: CellTask[] = [];
export function registerCellTask(task: CellTask) {
  const i = cellTasks.findIndex((t) => t.name === task.name);
  if (i >= 0) cellTasks[i] = task;
  else cellTasks.push(task);
}

/** Runs the cell tasks that are due (each at most once per its interval in this process). */
export class CellTaskRunner {
  private last = new Map<string, number>();
  constructor(
    private readonly deps: Deps,
    private readonly log?: { warn: (o: object, m: string) => void },
  ) {}
  async runDue(at = this.deps.now()): Promise<string[]> {
    const ran: string[] = [];
    for (const task of cellTasks) {
      const prev = this.last.get(task.name) ?? 0;
      if (at.getTime() - prev < task.everyMs) continue;
      this.last.set(task.name, at.getTime());
      try {
        await task.run(this.deps, at);
        ran.push(task.name);
      } catch (err) {
        this.log?.warn({ err, task: task.name }, 'cell task failed');
      }
    }
    return ran;
  }
}
