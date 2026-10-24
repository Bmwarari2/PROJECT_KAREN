import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { drain, Drainer, WorkerCycle, type WorkerEngine } from '../src/drain';
import { createWorkerServer } from '../src/http';

/**
 * WORKER_MODE=http (Cloud Run, ADR-0156): Cloud Scheduler calls POST /drain every minute, and a drain runs the loop's
 * own step until there is no work or the time budget is spent. A fake engine and clock; no database.
 */
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeEngine implements WorkerEngine {
  ticks = 0;
  sweeps = 0;
  constructor(
    private readonly work: number[],
    private readonly clock?: { t: number; perTick: number },
  ) {}
  async tick() {
    this.ticks++;
    if (this.clock) this.clock.t += this.clock.perTick;
    return this.work.shift() ?? 0;
  }
  async signalAll() {
    this.sweeps++;
  }
}

const cycleFor = (engine: WorkerEngine, clock: { t: number }, beats: { n: number; fail?: boolean }) =>
  new WorkerCycle({
    engine,
    heartbeat: async () => {
      beats.n++;
      if (beats.fail) throw new Error('heartbeat down');
    },
    log: silent,
    now: () => clock.t,
    sweepMs: 5 * 60_000,
    beatMs: 30_000,
  });

describe('drain', () => {
  it('sweeps and beats when due, then ticks until a tick finds no work', async () => {
    const clock = { t: 1_000_000, perTick: 10 };
    const engine = new FakeEngine([3, 2, 0], clock);
    const beats = { n: 0 };
    const r = await drain(cycleFor(engine, clock, beats), {
      budgetMs: 50_000,
      now: () => clock.t,
      log: silent,
    });
    expect(r).toEqual({
      rounds: 3,
      tenants: 5,
      swept: true,
      heartbeat: true,
      budgetExhausted: false,
      errors: 0,
      durationMs: 30,
    });
    expect(engine.sweeps).toBe(1);
    expect(beats.n).toBe(1);
  });

  it('stops when the time budget is spent, even while there is still work', async () => {
    const clock = { t: 1_000_000, perTick: 20_000 };
    const engine = new FakeEngine(Array(100).fill(1), clock);
    const r = await drain(cycleFor(engine, clock, { n: 0 }), {
      budgetMs: 50_000,
      now: () => clock.t,
      log: silent,
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.rounds).toBe(3);
    expect(engine.ticks).toBe(3);
  });

  it('sweeps again only once the sweep interval has passed, like the loop', async () => {
    const clock = { t: 1_000_000, perTick: 0 };
    const engine = new FakeEngine([], clock);
    const beats = { n: 0 };
    const cycle = cycleFor(engine, clock, beats);
    const run = () => drain(cycle, { budgetMs: 50_000, now: () => clock.t, log: silent });
    expect((await run()).swept).toBe(true);
    clock.t += 60_000;
    expect(await run()).toMatchObject({ swept: false, heartbeat: true });
    clock.t += 10_000;
    expect(await run()).toMatchObject({ swept: false, heartbeat: false });
    clock.t += 5 * 60_000;
    expect((await run()).swept).toBe(true);
    expect(engine.sweeps).toBe(2);
    expect(beats.n).toBe(3);
  });

  it('a failed heartbeat is logged and does not stop the drain; a failed tick ends it with an error count', async () => {
    const clock = { t: 1_000_000, perTick: 0 };
    const ok = await drain(cycleFor(new FakeEngine([1, 0], clock), clock, { n: 0, fail: true }), {
      budgetMs: 50_000,
      now: () => clock.t,
      log: silent,
    });
    expect(ok).toMatchObject({ rounds: 2, tenants: 1, errors: 0 });
    const broken = new FakeEngine([], clock);
    broken.tick = async () => {
      throw new Error('database unavailable');
    };
    const r = await drain(cycleFor(broken, clock, { n: 0 }), {
      budgetMs: 50_000,
      now: () => clock.t,
      log: silent,
    });
    expect(r).toMatchObject({ rounds: 0, errors: 1 });
  });
});

describe('Drainer', () => {
  it('serialises drains in the process: a call during a running drain joins it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ticks = 0;
    const engine: WorkerEngine = {
      tick: async () => {
        ticks++;
        await gate;
        return 0;
      },
      signalAll: async () => undefined,
    };
    const drainer = new Drainer(cycleFor(engine, { t: 0 }, { n: 0 }), { budgetMs: 50_000, log: silent });
    const a = drainer.run();
    const b = drainer.run();
    expect(drainer.running).toBe(true);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(ticks).toBe(1);
    expect(drainer.running).toBe(false);
    await drainer.run();
    expect(ticks).toBe(2);
  });

  it('on shutdown the running drain ends after its current step', async () => {
    const clock = { t: 0, perTick: 0 };
    const engine = new FakeEngine(Array(100).fill(1), clock);
    const drainer = new Drainer(cycleFor(engine, clock, { n: 0 }), { budgetMs: 50_000, log: silent });
    const running = drainer.run();
    await drainer.stop();
    expect((await running).rounds).toBe(1);
    expect(drainer.running).toBe(false);
  });
});

describe('worker HTTP server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  const start = async (engine: WorkerEngine) => {
    const drainer = new Drainer(cycleFor(engine, { t: Date.now() }, { n: 0 }), {
      budgetMs: 50_000,
      log: silent,
    });
    const server = createWorkerServer({ drainer, log: silent });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    close = () => new Promise((r) => server.close(() => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('GET /health answers 200; POST /drain answers 200 with counts only', async () => {
    const base = await start(new FakeEngine([2, 0]));
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    const res = await fetch(`${base}/drain`, { method: 'POST', body: '{"from":"scheduler"}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['budgetExhausted', 'durationMs', 'errors', 'heartbeat', 'rounds', 'swept', 'tenants'].sort(),
    );
    expect(body).toMatchObject({ rounds: 2, tenants: 2, errors: 0 });
    for (const v of Object.values(body)) expect(['number', 'boolean']).toContain(typeof v);
  });

  it('a failed drain answers 500 so Cloud Scheduler records the failure', async () => {
    const base = await start({
      tick: async () => {
        throw new Error('database unavailable');
      },
      signalAll: async () => undefined,
    });
    const res = await fetch(`${base}/drain`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ errors: 1 });
  });

  it('refuses other methods and paths', async () => {
    const base = await start(new FakeEngine([]));
    expect((await fetch(`${base}/drain`)).status).toBe(405);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/v1/anything`)).status).toBe(404);
  });
});

describe('cell tasks', () => {
  it('run on every step, and a failing task never stops the tick', async () => {
    const clock = { t: 1_000_000, perTick: 10 };
    const engine = new FakeEngine([1, 0], clock);
    let calls = 0;
    const cycle = new WorkerCycle({
      engine,
      heartbeat: async () => undefined,
      cellTasks: async () => {
        calls++;
        if (calls === 1) throw new Error('detections down');
      },
      log: silent,
      now: () => clock.t,
      sweepMs: 5 * 60_000,
      beatMs: 30_000,
    });
    const r = await drain(cycle, { budgetMs: 50_000, now: () => clock.t, log: silent });
    expect(calls).toBe(2);
    expect(r.rounds).toBe(2);
    expect(r.errors).toBe(0);
  });
});
