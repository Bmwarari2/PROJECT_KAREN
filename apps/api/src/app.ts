import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import { createLogger } from '@thapsus/core/logger';
import { API_SCOPE_KEYS, API_SCOPES } from '@thapsus/core/api-scopes';
import type { Deps } from './deps';
import { contextPlugin } from './http/context';
import { errorHandler } from './http/errors';
import { Problem } from './http/schemas';
import { authRoutes } from './modules/auth/routes';
import { passkeyRoutes } from './modules/auth/passkeys';
import { ssoRoutes } from './modules/auth/sso';
import { tenancyRoutes, globalRoutes } from './modules/tenancy/routes';
import { scimRoutes } from './modules/scim/routes';
import { auditRoutes } from './modules/audit/routes';
import { supportGrantRoutes } from './modules/support/routes';
import { meRoutes } from './modules/me/routes';
import { mockIdpKeys, mockIdpPlugin } from './dev/mock-idp';
import { registerModules } from './modules';
import { platformHttpPlugin } from './modules/platform/http';

export const API_VERSION = '1.0.0';

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger === false ? undefined : (createLogger({ name: `api-${deps.serviceRole}` }) as never),
    logger: opts.logger === false ? false : undefined,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).type('application/problem+json').send({ type: 'about:blank#notFound', title: 'Not found', status: 404, code: 'notFound', requestId: req.id }),
  );

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Thapsus-HR API',
        version: API_VERSION,
        description: 'Versioned public REST API. All responses are served from the tenant\'s home region and are never cached at the edge.',
      },
      servers: [{ url: deps.config.apiBaseUrl }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'thr_sid' },
          bearer: { type: 'http', scheme: 'bearer', description: 'Scoped API key (thr_sk_…) or OAuth 2.0 access token (thr_at_…). See docs/api.md.' },
          oauth2: {
            type: 'oauth2',
            description: 'OAuth 2.0 client credentials (RFC 6749 §4.4). Effective permissions = the client role ∩ the granted scopes.',
            flows: { clientCredentials: { tokenUrl: '/v1/oauth/token', scopes: Object.fromEntries(API_SCOPE_KEYS.map((s) => [s, `Allows: ${API_SCOPES[s].join(', ')}`])) } },
          },
        },
      },
      security: [{ session: [] }, { bearer: [] }, { oauth2: [] }],
    },
  });
  app.addSchema(Problem);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: [deps.config.appBaseUrl, deps.config.globalBaseUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(contextPlugin, { deps });
  // Public API: per-tenant rate limits, Idempotency-Key replay and deprecation headers (Phase 9).
  await app.register(platformHttpPlugin, { deps });

  for (const path of ['/health', '/health/api']) {
    app.get(path, { config: { auth: 'public' }, schema: { hide: true } }, async () => ({ ok: true, region: deps.config.cell, role: deps.serviceRole }));
  }

  if (deps.serviceRole === 'global') {
    await app.register(globalRoutes);
  } else {
    await app.register(authRoutes);
    await app.register(passkeyRoutes);
    await app.register(ssoRoutes);
    await app.register(tenancyRoutes);
    await app.register(scimRoutes);
    await app.register(auditRoutes);
    await app.register(supportGrantRoutes);
    await app.register(meRoutes);
    await registerModules(app);
    if (deps.config.env !== 'prod') await app.register(globalRoutes); // single-process local dev
  }
  if (deps.mockIdp) {
    const keys = await mockIdpKeys();
    let info: Awaited<ReturnType<typeof mockIdpPlugin>> | undefined;
    await app.register(async (sub) => {
      info = await mockIdpPlugin(sub, { baseUrl: deps.config.apiBaseUrl, keys });
    });
    app.decorate('mockIdpInfo', () => info);
  }

  app.get('/openapi.json', { config: { auth: 'public' }, schema: { hide: true } }, async () => app.swagger());
  return app;
}
