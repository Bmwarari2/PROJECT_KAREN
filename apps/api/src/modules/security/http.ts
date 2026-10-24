import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Deps } from '../../deps';
import { ApiError, problem } from '../../http/errors';
import type { ObjectStore } from '../../lib/object-store';
import { isInternalAddress, pseudonym, truncatedNetwork } from './pseudonym';
import { SignalBuffer, type Signal } from './signals';
import { checkDeadman } from './alerts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The security signal buffer of this process (ADR-0177). */
    securitySignals?: SignalBuffer;
    securityCaches?: SecurityCaches;
  }
  interface FastifyRequest {
    securityIpKey?: string;
    securitySignalled?: boolean;
  }
}

/**
 * Honey endpoints (ADR-0179): addresses no client of Thapsus-HR ever calls. A request raises a detection,
 * waits (a tarpit that slows scanners down) and gets an ordinary 404. The web host forwards its copies of
 * the first three to `/v1/honey/<name>` (apps/web/proxy.ts).
 */
export const HONEY_PATHS = [
  '/.env',
  '/wp-login.php',
  '/.git/config',
  '/v1/admin/export-all',
  '/v1/internal/debug',
];
export const WEB_HONEY_NAMES: Record<string, string> = {
  env: '/.env',
  'wp-login': '/wp-login.php',
  'git-config': '/.git/config',
};
const SIGN_IN = ['/v1/auth/', '/v1/backoffice/auth/', '/v1/oauth/token'];
export const sha256Hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * What the request path checks without a database round trip: addresses under a block, and the honeytoken
 * fingerprints. Both refresh from the database in the background (30 and 60 seconds) and on demand.
 */
export class SecurityCaches {
  blockedIps = new Set<string>();
  honey = new Map<string, Set<string>>([
    ['api_key', new Set()],
    ['endpoint', new Set()],
    ['object_key', new Set()],
  ]);
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly deps: Pick<Deps, 'router' | 'now'>) {}

  async refreshBlocks() {
    const { rows } = await this.deps.router
      .registryPool()
      .query<{ ip_key: string }>(
        `SELECT DISTINCT ip_key FROM security.containment_actions WHERE kind = 'block_ip' AND reversed_at IS NULL AND (expires_at IS NULL OR expires_at > $1)`,
        [this.deps.now()],
      );
    this.blockedIps = new Set(rows.map((r) => r.ip_key));
  }

  async refreshHoneytokens() {
    const { rows } = await this.deps.router
      .registryPool()
      .query<{ kind: string; fingerprint: string }>(
        'SELECT kind, fingerprint FROM security.honeytokens WHERE retired_at IS NULL',
      );
    const next = new Map<string, Set<string>>([
      ['api_key', new Set()],
      ['endpoint', new Set()],
      ['object_key', new Set()],
    ]);
    for (const r of rows) next.get(r.kind)?.add(r.fingerprint);
    this.honey = next;
    this.honeyLoaded = true;
  }

  /** True once the registry has been read; until then a request that may carry a decoy waits for one read. */
  honeyLoaded = false;
  private lastTry = 0;
  async ensureHoneytokens() {
    if (this.honeyLoaded || Date.now() - this.lastTry < 5000) return;
    this.lastTry = Date.now();
    await this.refreshHoneytokens().catch(() => undefined);
  }

  async refresh() {
    await Promise.all([this.refreshBlocks(), this.refreshHoneytokens()]);
  }

  start() {
    const every = (ms: number, fn: () => Promise<void>) => {
      const t = setInterval(() => void fn().catch(() => undefined), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(30_000, () => this.refreshBlocks());
    every(30_000, () => this.refreshHoneytokens());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

const WATCHED = Symbol('thapsus.honeyObjects');
/**
 * Watches the object store for decoy keys: a read of one raises a detection before anything is served.
 * The store's own methods are wrapped in place (once), so it keeps its identity and type.
 */
export function watchHoneyObjects(
  store: ObjectStore,
  isDecoy: (key: string) => boolean,
  onTouch: () => void,
) {
  const s = store as ObjectStore & { [WATCHED]?: { isDecoy: typeof isDecoy; onTouch: typeof onTouch } };
  if (s[WATCHED]) {
    s[WATCHED] = { isDecoy, onTouch };
    return;
  }
  s[WATCHED] = { isDecoy, onTouch };
  const check = (key: string) => {
    if (s[WATCHED]!.isDecoy(key)) s[WATCHED]!.onTouch();
  };
  const presignGet = store.presignGet.bind(store);
  const get = store.get.bind(store);
  store.presignGet = async (key, filename) => {
    check(key);
    return presignGet(key, filename);
  };
  store.get = async (key) => {
    check(key);
    return get(key);
  };
}

function classify(req: FastifyRequest, status: number): string | undefined {
  const route = req.routeOptions?.url;
  if (status === 401) return route && SIGN_IN.some((p) => route.startsWith(p)) ? 'authn.failed' : undefined;
  if (status === 403) return 'authz.denied';
  if (status === 400 || status === 422) return 'input.rejected';
  if (status === 429) return 'antiautomation.limited';
  if (status === 423) return 'antiautomation.locked';
  if (status === 404) return route ? 'http.not_found' : 'route.not_found';
  return undefined;
}

/**
 * Security signals and app-level containment (ADR-0177, ADR-0178, ADR-0179):
 *  - every refused, rejected, throttled or not-found response becomes a signal (route pattern, keyed address
 *    hash and truncated network, the caller's tenant and user ids when signed in);
 *  - requests from a blocked address are refused before any route runs;
 *  - the decoy API key and the honey endpoints raise a detection and are slowed down.
 */
export const securityHttpPlugin = fp(async (app: FastifyInstance, opts: { deps: Deps }) => {
  const deps = opts.deps;
  const signals = new SignalBuffer(() => deps.router.registryPool());
  const caches = new SecurityCaches(deps);
  app.decorate('securitySignals', signals);
  app.decorate('securityCaches', caches);
  const tarpitMs = Number(process.env.HONEY_TARPIT_MS ?? (deps.config.env === 'test' ? 0 : 3000));
  const tarpit = () => new Promise((r) => setTimeout(r, Math.min(Math.max(tarpitMs, 0), 10_000)));

  const ipKeyOf = (req: FastifyRequest) =>
    (req.securityIpKey ??= req.ctx?.ip ? pseudonym(deps, 'ip', req.ctx.ip) : undefined);
  const base = (req: FastifyRequest, type: string, source: Signal['source']): Signal => ({
    at: deps.now().toISOString(),
    type,
    source,
    tenantId: req.auth?.tenantId,
    actorId: req.auth?.userId,
    ipKey: ipKeyOf(req),
    ipNet: truncatedNetwork(req.ctx?.ip),
    route: req.routeOptions?.url,
  });

  watchHoneyObjects(
    deps.objects,
    (key) => !!caches.honey.get('object_key')?.has(sha256Hex(key)),
    () => signals.push({ at: deps.now().toISOString(), type: 'honeytoken.object', source: 'honeytoken' }),
  );

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url.startsWith('/health')) return;
    const key = ipKeyOf(req);
    if (key && caches.blockedIps.has(key) && !isInternalAddress(req.ctx?.ip)) {
      req.securitySignalled = true;
      signals.push(base(req, 'ip.blocked', 'request'));
      throw new ApiError('forbidden', 'blocked');
    }
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer thr_sk_')) {
      await caches.ensureHoneytokens();
      const token = header.slice(7).trim();
      if (caches.honey.get('api_key')?.has(sha256Hex(token))) {
        req.securitySignalled = true;
        signals.push({
          ...base(req, 'honeytoken.api_key', 'honeytoken'),
          tenantId: undefined,
          actorId: undefined,
        });
        await tarpit();
        throw new ApiError('unauthorised');
      }
    }
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.securitySignalled) return;
    const type = classify(req, reply.statusCode);
    if (type) signals.push(base(req, type, 'request'));
  });

  const honey = async (req: FastifyRequest, reply: FastifyReply, path: string) => {
    req.securitySignalled = true;
    signals.push({ ...base(req, 'honeytoken.endpoint', 'honeytoken'), route: path });
    await tarpit();
    return problem(req, reply, 'notFound');
  };
  for (const path of HONEY_PATHS)
    app.all(path, { config: { auth: 'public', selfAudited: true }, schema: { hide: true } }, (req, reply) =>
      honey(req, reply, path),
    );
  app.all(
    '/v1/honey/:name',
    { config: { auth: 'public', selfAudited: true }, schema: { hide: true } },
    (req, reply) => {
      const path = WEB_HONEY_NAMES[(req.params as { name: string }).name];
      return path ? honey(req, reply, path) : problem(req, reply, 'notFound');
    },
  );

  // MERGE NOTE: with the identity work merged, subscribe to its events here:
  //   import { onSecurityEvent } from '../../lib/security-events';
  //   const off = onSecurityEvent((e) => signals.push(fromAuthEvent(e)));  // and off() on close
  await caches.refresh().catch((err: unknown) => app.log.warn({ err }, 'security caches not loaded yet'));
  signals.start();
  caches.start();
  // the dead-man's switch is watched from here too, so a dead worker cannot silence it
  const deadman =
    deps.config.env === 'test'
      ? undefined
      : setInterval(() => void checkDeadman(deps, deps.now()).catch(() => undefined), 60_000);
  deadman?.unref?.();
  app.addHook('onClose', async () => {
    if (deadman) clearInterval(deadman);
    caches.stop();
    await signals.stop();
  });
});
