import type pg from 'pg';
import type { SignalSource } from '@thapsus/core/security';

/**
 * The security signal buffer of an API process (ADR-0177). Request outcomes, the identity work's
 * authentication events and honeytoken touches are pushed here synchronously and written to
 * security.events in batches (every two seconds, or at 500 queued), so no request waits on the database.
 * Audit-trail signals do not pass through here: database triggers copy them in the same transaction.
 *
 * Only pseudonymous values are accepted: ids must be UUIDs, the address must already be a keyed hash
 * (plus its truncated network), detail values must be codes, numbers or booleans. Anything else is dropped.
 *
 * MERGE NOTE (identity work, `apps/api/src/lib/security-events.ts`): once it is merged, the security plugin
 * subscribes with `onSecurityEvent((e) => signals.push(fromAuthEvent(e)))`; see http.ts.
 */
export interface Signal {
  at: string;
  type: string;
  source: SignalSource;
  tenantId?: string;
  actorId?: string;
  staffId?: string;
  ipKey?: string;
  ipNet?: string;
  accountKey?: string;
  route?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** The shape of an identity event (SecurityEvent in security-events.ts), as far as the pipeline reads it. */
export interface AuthEventLike {
  type: string;
  at: string;
  tenantId?: string;
  userId?: string;
  staffId?: string;
  ipKey?: string;
  accountKey?: string;
  route?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export function fromAuthEvent(e: AuthEventLike): Signal {
  return {
    at: e.at,
    type: e.type,
    source: 'auth',
    tenantId: e.tenantId,
    actorId: e.userId,
    staffId: e.staffId,
    ipKey: e.ipKey,
    accountKey: e.accountKey,
    route: e.route,
    detail: e.detail,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const TYPE = /^[a-z][a-z0-9_.]{2,80}$/;
const CODE = /^[a-z0-9_.:/-]{1,60}$/i;
const NET = /^[0-9a-f.:]+\/\d{1,3}$/i;

export function cleanSignal(s: Signal): Signal | undefined {
  if (!TYPE.test(s.type) || Number.isNaN(Date.parse(s.at))) return undefined;
  const detail: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(s.detail ?? {}).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) detail[k] = v;
    else if (typeof v === 'string' && CODE.test(v)) detail[k] = v;
  }
  const id = (v?: string) => (v && UUID.test(v) ? v : undefined);
  return {
    at: new Date(s.at).toISOString(),
    type: s.type,
    source: s.source,
    tenantId: id(s.tenantId),
    actorId: id(s.actorId),
    staffId: id(s.staffId),
    ipKey: s.ipKey && KEY.test(s.ipKey) ? s.ipKey : undefined,
    ipNet: s.ipNet && NET.test(s.ipNet) ? s.ipNet : undefined,
    accountKey: s.accountKey && KEY.test(s.accountKey) ? s.accountKey : undefined,
    // route patterns only (they contain `:id`, never an id)
    route:
      s.route && s.route.length <= 200 && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(s.route) ? s.route : undefined,
    detail,
  };
}

/** Inserts signals in one statement (jsonb_to_recordset keeps it a single round trip). */
export async function insertSignals(db: Pick<pg.Pool, 'query'>, signals: Signal[]) {
  const rows = signals.map(cleanSignal).filter((s): s is Signal => !!s);
  if (!rows.length) return 0;
  await db.query(
    `INSERT INTO security.events (at, type, source, subject_tenant_id, actor_id, staff_id, ip_key, ip_net, account_key, route, detail)
     SELECT r.at, r.type, r.source, r.tenant, r.actor, r.staff, r.ip_key, r.ip_net::cidr, r.account_key, r.route, coalesce(r.detail, '{}'::jsonb)
       FROM jsonb_to_recordset($1::jsonb) AS r(at timestamptz, type text, source text, tenant uuid, actor uuid, staff uuid, ip_key text, ip_net text, account_key text, route text, detail jsonb)`,
    [
      JSON.stringify(
        rows.map((s) => ({
          at: s.at,
          type: s.type,
          source: s.source,
          tenant: s.tenantId ?? null,
          actor: s.actorId ?? null,
          staff: s.staffId ?? null,
          ip_key: s.ipKey ?? null,
          ip_net: s.ipNet ?? null,
          account_key: s.accountKey ?? null,
          route: s.route ?? null,
          detail: s.detail ?? {},
        })),
      ),
    ],
  );
  return rows.length;
}

export class SignalBuffer {
  private queue: Signal[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<number>;
  /** Signals dropped because the buffer was full (the database was unreachable for a while). */
  dropped = 0;

  constructor(
    private readonly pool: () => pg.Pool,
    private readonly opts: { max?: number; batch?: number } = {},
  ) {}

  push(s: Signal) {
    if (this.queue.length >= (this.opts.max ?? 10_000)) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(s);
    if (this.queue.length >= (this.opts.batch ?? 500)) void this.flush().catch(() => undefined);
  }

  get pending() {
    return this.queue.length;
  }

  start(everyMs = 2000) {
    this.timer ??= setInterval(() => void this.flush().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush().catch(() => undefined);
  }

  /** Writes everything queued; on failure the signals go back to the front of the queue. */
  async flush(): Promise<number> {
    if (this.flushing) await this.flushing.catch(() => undefined);
    if (!this.queue.length) return 0;
    const batch = this.queue;
    this.queue = [];
    this.flushing = insertSignals(this.pool(), batch).catch((err: unknown) => {
      this.queue = [...batch, ...this.queue].slice(-(this.opts.max ?? 10_000));
      throw err;
    });
    try {
      return await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }
}
