import { Redis } from 'iovalkey';

/** Fixed-window counters used for sign-in throttling and per-tenant API rate limits. */
export interface RateLimiter {
  /** Increments the counter for key and returns the count within the window. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number }>;
  reset(key: string): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async hit(key: string, windowSeconds: number) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || b.expires <= t) {
      b = { count: 0, expires: t + windowSeconds * 1000 };
      this.buckets.set(key, b);
    }
    b.count++;
    return { count: b.count, resetSeconds: Math.ceil((b.expires - t) / 1000) };
  }
  async reset(key: string) {
    this.buckets.delete(key);
  }
}

/** Valkey (ElastiCache in AWS) backed limiter: shared across all API tasks in the cell. */
export class ValkeyRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, windowSeconds: number) {
    const k = `rl:${key}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSeconds, 'NX').ttl(k).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSeconds);
    return { count, resetSeconds: ttl > 0 ? ttl : windowSeconds };
  }
  async reset(key: string) {
    await this.redis.del(`rl:${key}`);
  }
}

export function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  if (env.VALKEY_URL) {
    return new ValkeyRateLimiter(new Redis(env.VALKEY_URL, { lazyConnect: false, maxRetriesPerRequest: 2, tls: env.VALKEY_URL.startsWith('rediss') ? {} : undefined }));
  }
  return new MemoryRateLimiter();
}
