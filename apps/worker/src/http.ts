import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@thapsus/core/logger';
import type { Drainer } from './drain';

/**
 * WORKER_MODE=http (Cloud Run, ADR-0156). Cloud Scheduler calls POST /drain every minute with an OIDC token; Cloud
 * Run IAM authenticates the call before it reaches the container, so the token is not checked here.
 *  - GET /health → 200
 *  - POST /drain → runs a drain and answers 200 with its counts (500 when a step failed). Never tenant data.
 */
export function createWorkerServer(o: { drainer: Drainer; log: Pick<Logger, 'error'> }): Server {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    req.resume(); // the scheduler's request body is not used
    const path = new URL(req.url ?? '/', 'http://worker').pathname;
    if (path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { status: 'method not allowed' });
      return json(res, 200, { status: 'ok' });
    }
    if (path === '/drain') {
      if (req.method !== 'POST') return json(res, 405, { status: 'method not allowed' });
      o.drainer.run().then(
        (r) => json(res, r.errors ? 500 : 200, r),
        (err: unknown) => {
          o.log.error({ err }, 'worker drain failed');
          json(res, 500, { status: 'error' });
        },
      );
      return;
    }
    json(res, 404, { status: 'not found' });
  });
}
