import { startTracing } from '@thapsus/core/tracing';
import { createLogger } from '@thapsus/core/logger';
import {
  CellTaskRunner,
  depsFromEnv,
  jobHandlers,
  eventSubscribers,
  periodic,
  recordHeartbeat,
} from '@thapsus/api/worker';
import { Drainer, WorkerCycle } from './drain';
import { Engine } from './engine';
import { createWorkerServer } from './http';
import { publisherFromEnv } from './publisher';

const tracing = startTracing('thapsus-worker');
const log = createLogger({ name: 'worker' });
const deps = await depsFromEnv();
const engine = new Engine({
  router: deps.router,
  deps,
  handlers: jobHandlers,
  subscribers: eventSubscribers,
  periodic,
  publisher: publisherFromEnv(deps.config.cell),
  log,
});

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 1000);
const SWEEP_MS = Number(process.env.WORKER_SWEEP_MS ?? 5 * 60_000);
const BEAT_MS = 30_000;
/** loop (default): run forever. http: serve /health and /drain for Cloud Run and Cloud Scheduler (ADR-0156). */
const MODE = process.env.WORKER_MODE ?? 'loop';
if (MODE !== 'loop' && MODE !== 'http') throw new Error('WORKER_MODE must be loop or http');

// Sweep if due, heartbeat for the public status page if due (no tenant data), the cell-wide tasks that are
// due (queue sample, detections, alerts), then one engine tick.
const cellTasks = new CellTaskRunner(deps, log);
const cycle = new WorkerCycle({
  engine,
  heartbeat: () => recordHeartbeat(deps.router, 'worker'),
  cellTasks: () => cellTasks.runDue(),
  log,
  sweepMs: SWEEP_MS,
  beatMs: BEAT_MS,
});

if (MODE === 'http') {
  const budgetMs = Number(process.env.WORKER_DRAIN_BUDGET_MS ?? 50_000);
  if (!Number.isInteger(budgetMs) || budgetMs <= 0)
    throw new Error('WORKER_DRAIN_BUDGET_MS must be a positive whole number of milliseconds');
  const drainer = new Drainer(cycle, { budgetMs, log });
  const server = createWorkerServer({ drainer, log });
  const port = Number(process.env.PORT ?? 8080);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, async () => {
      server.close();
      // Cloud Run gives a short grace period: a running drain stops after its current step.
      setTimeout(() => process.exit(0), 8000).unref();
      await Promise.all([drainer.stop(), tracing?.shutdown()]);
      process.exit(0);
    });
  }
  server.listen(port, () => log.info({ region: deps.config.cell, port }, 'worker started (http)'));
} else {
  let stopping = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, async () => {
      stopping = true;
      await tracing?.shutdown();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
  log.info({ region: deps.config.cell }, 'worker started');
  while (!stopping) {
    try {
      const { tenants } = await cycle.step();
      if (tenants === 0) await sleep(TICK_MS);
    } catch (err) {
      log.error({ err }, 'worker tick failed');
      await sleep(TICK_MS * 5);
    }
  }
}
