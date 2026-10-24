import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Deps } from '../deps';
import { RequestMetrics } from '../lib/request-metrics';

declare module 'fastify' {
  interface FastifyInstance {
    /** In-memory request counters, flushed once a minute to platform.request_metrics (ADR-0176). */
    requestMetrics?: RequestMetrics;
  }
}

/** Counts every response by route group, status class and latency; no database work per request. */
export const requestMetricsPlugin = fp(
  async (app: FastifyInstance, opts: { deps: Deps; flushMs?: number }) => {
    const metrics = new RequestMetrics(() => opts.deps.router.registryPool(), opts.deps.now);
    app.decorate('requestMetrics', metrics);
    app.addHook('onResponse', async (req, reply) => {
      metrics.record(req.routeOptions?.url, reply.statusCode, reply.elapsedTime);
    });
    // tests flush explicitly; deployed processes flush once a minute and on shutdown
    if (opts.deps.config.env !== 'test') metrics.start(opts.flushMs);
    app.addHook('onClose', async () => {
      await metrics.stop();
    });
  },
);
