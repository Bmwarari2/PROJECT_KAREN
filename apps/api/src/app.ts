import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import { createLogger } from '@thapsus/core/logger';
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
import { MemoryObjectStore } from './lib/object-store';

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
          bearer: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ session: [] }, { bearer: [] }],
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
    // Dev/test only: signed download links for the in-memory object store (production uses S3 presigned URLs).
    const store = deps.objects;
    if (store instanceof MemoryObjectStore && store.serve && (deps.config.env === 'dev' || deps.config.env === 'test')) {
      app.get('/v1/dev/objects', { config: { auth: 'public' }, schema: { hide: true } }, async (req, reply) => {
        const q = req.query as { key?: string; exp?: string; name?: string; sig?: string };
        const o = q.key && q.exp && q.name && q.sig ? store.verify({ key: q.key, exp: q.exp, name: q.name, sig: q.sig }) : undefined;
        if (!o) return reply.status(404).send({ type: 'about:blank#notFound', title: 'Not found', status: 404, code: 'notFound' });
        return reply.header('content-type', o.contentType).header('content-disposition', `attachment; filename="${q.name!.replace(/["\\\r\n]/g, '')}"`).send(o.body);
      });
    }
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
