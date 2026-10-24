import type { Logger } from '@thapsus/core/logger';

/** The part of the engine a worker cycle drives. */
export interface WorkerEngine {
  /** Processes every tenant that signalled work; returns how many tenants were processed. */
  tick(): Promise<number>;
  /** Signals every active tenant (date-driven work). */
  signalAll(kind?: string): Promise<void>;
}

type Log = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface WorkerCycleOptions {
  engine: WorkerEngine;
  /** Status-page heartbeat (no tenant data). */
  heartbeat: () => Promise<void>;
  /** Cell-wide tasks (queue sample, detections, alerts); the runner decides which are due (ADR-0176). */
  cellTasks?: () => Promise<unknown>;
  log: Log;
  sweepMs: number;
  beatMs: number;
  now?: () => number;
}

/**
 * One step of the worker, shared by the forever loop (WORKER_MODE=loop) and the HTTP drain (WORKER_MODE=http,
 * ADR-0156): sweep every tenant if the sweep is due, record the heartbeat if due, then one engine tick.
 */
export class WorkerCycle {
  private lastSweep = 0;
  private lastBeat = 0;
  constructor(private readonly o: WorkerCycleOptions) {}

  async step(): Promise<{ tenants: number; swept: boolean; beat: boolean }> {
    const now = this.o.now ?? Date.now;
    let swept = false;
    let beat = false;
    if (now() - this.lastSweep > this.o.sweepMs) {
      await this.o.engine.signalAll('jobs');
      this.lastSweep = now();
      swept = true;
    }
    if (now() - this.lastBeat > this.o.beatMs) {
      this.lastBeat = now();
      beat = true;
      await this.o.heartbeat().catch((err: unknown) => this.o.log.warn({ err }, 'heartbeat failed'));
    }
    await this.o.cellTasks?.().catch((err: unknown) => this.o.log.warn({ err }, 'cell tasks failed'));
    return { tenants: await this.o.engine.tick(), swept, beat };
  }
}

/** What a drain did: counts and flags only, never tenant ids or data. */
export interface DrainResult {
  rounds: number;
  tenants: number;
  swept: boolean;
  heartbeat: boolean;
  budgetExhausted: boolean;
  errors: number;
  durationMs: number;
}

/** Runs worker steps until a step finds no work, a step fails, or the time budget is spent. */
export async function drain(
  cycle: WorkerCycle,
  opts: { budgetMs: number; log: Log; now?: () => number; stopRequested?: () => boolean },
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const r: Omit<DrainResult, 'durationMs'> = {
    rounds: 0,
    tenants: 0,
    swept: false,
    heartbeat: false,
    budgetExhausted: false,
    errors: 0,
  };
  for (;;) {
    let step: Awaited<ReturnType<WorkerCycle['step']>>;
    try {
      step = await cycle.step();
    } catch (err) {
      opts.log.error({ err }, 'worker drain step failed');
      r.errors++;
      break;
    }
    r.rounds++;
    r.tenants += step.tenants;
    r.swept ||= step.swept;
    r.heartbeat ||= step.beat;
    if (step.tenants === 0 || opts.stopRequested?.()) break;
    if (now() - started >= opts.budgetMs) {
      r.budgetExhausted = true;
      break;
    }
  }
  return { ...r, durationMs: now() - started };
}

/**
 * Serialises drains within the process: a call while a drain is running joins that drain and gets its result,
 * so overlapping scheduler calls (retries, a slow drain) never run two drains side by side in one instance.
 * Drains in different instances are safe anyway: every engine step is idempotent and claims work with SKIP LOCKED.
 */
export class Drainer {
  private current?: Promise<DrainResult>;
  private stopping = false;
  constructor(
    private readonly cycle: WorkerCycle,
    private readonly opts: { budgetMs: number; log: Log; now?: () => number },
  ) {}
  get running(): boolean {
    return !!this.current;
  }
  run(): Promise<DrainResult> {
    this.current ??= drain(this.cycle, { ...this.opts, stopRequested: () => this.stopping }).finally(() => {
      this.current = undefined;
    });
    return this.current;
  }
  /** On shutdown: the running drain ends after its current step; resolves once no drain is running. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.current?.catch(() => undefined);
  }
}
