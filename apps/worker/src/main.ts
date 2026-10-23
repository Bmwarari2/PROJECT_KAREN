import { startTracing } from '@thapsus/core/tracing';
import { createLogger } from '@thapsus/core/logger';
import { depsFromEnv, jobHandlers, eventSubscribers, periodic, recordHeartbeat } from '@thapsus/api/worker';
import { Engine } from './engine';
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
let stopping = false;
let lastSweep = 0;
let lastBeat = 0;
const BEAT_MS = 30_000;

async function loop() {
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > SWEEP_MS) {
        await engine.signalAll('jobs');
        lastSweep = Date.now();
      }
      // Heartbeat for the public status page (no tenant data).
      if (Date.now() - lastBeat > BEAT_MS) {
        lastBeat = Date.now();
        await recordHeartbeat(deps.router, 'worker').catch((err) => log.warn({ err }, 'heartbeat failed'));
      }
      const n = await engine.tick();
      if (n === 0) await new Promise((r) => setTimeout(r, TICK_MS));
    } catch (err) {
      log.error({ err }, 'worker tick failed');
      await new Promise((r) => setTimeout(r, TICK_MS * 5));
    }
  }
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    stopping = true;
    await tracing?.shutdown();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
log.info({ region: deps.config.cell }, 'worker started');
await loop();
