import { TenantRouter } from '@thapsus/db';
import { buildApp } from './app';
import type { Deps } from './deps';
import { InMemoryDirectory } from './lib/directory';
import { LocalKeyProvider } from './lib/kms';
import { MemoryMailer } from './lib/mailer';
import { MemoryRateLimiter } from './lib/rate-limit';
import { MemoryObjectStore } from './lib/object-store';

export const PUBLIC_SERVER = 'https://api.{region}.{domain}';

/** Builds the public OpenAPI document from the route schemas (no database connection needed). */
export async function buildSpec(): Promise<Record<string, unknown>> {
  const deps: Deps = {
    config: { env: 'test', cell: 'uk', domain: 'example.test', appBaseUrl: 'http://localhost', apiBaseUrl: PUBLIC_SERVER, globalBaseUrl: 'http://localhost' },
    router: new TenantRouter({ databases: { shared: 'postgres://unused@127.0.0.1:1/none' } }),
    directory: new InMemoryDirectory(),
    mailer: new MemoryMailer('uk'),
    keys: new LocalKeyProvider('00'.repeat(32)),
    limiter: new MemoryRateLimiter(),
    dns: { resolveTxt: async () => [] },
    objects: new MemoryObjectStore(),
    now: () => new Date(),
    regionalAppUrls: { uk: '', eu: '', us: '' },
    regionalApiUrls: { uk: '', eu: '', us: '' },
    fetch: globalThis.fetch,
    serviceRole: 'cell',
    mockIdp: false,
  };
  const app = await buildApp(deps, { logger: false });
  await app.ready();
  const spec = app.swagger() as Record<string, unknown>;
  await app.close();
  spec.servers = [
    {
      url: PUBLIC_SERVER,
      description: 'Your workspace home region (uk, eu or us). Responses are never cached at the edge.',
      variables: { region: { default: 'uk', enum: ['uk', 'eu', 'us'] }, domain: { default: 'thapsus-hr.example' } },
    },
  ];
  return spec;
}
