import { startTracing } from '@thapsus/core/tracing';
import { depsFromEnv } from './deps';
import { buildApp } from './app';

const tracing = startTracing(`thapsus-api-${process.env.SERVICE_ROLE ?? 'cell'}`);
const deps = await depsFromEnv();
const app = await buildApp(deps);
// API_PORT first: as a Cloud Run sidecar the API must not take the PORT that belongs to the web container.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await tracing?.shutdown();
    process.exit(0);
  });
}
