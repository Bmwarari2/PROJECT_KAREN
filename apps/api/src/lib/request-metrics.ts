import type pg from 'pg';
import { bucketIndex, HISTOGRAM_SIZE, routeGroup } from '@thapsus/core/metrics';

/**
 * Per-process request metrics for the back office's performance screen (ADR-0176). Each request adds to an
 * in-memory counter for its minute and route group (the first segment of the route PATTERN, never the URL,
 * so no ids, slugs or emails); once a minute the finished minutes are written in one INSERT. The request
 * path itself never waits on the database. Nothing about the caller is kept: no tenant, user, address or
 * path.
 */
interface Bucket {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  latencySumMs: number;
  latency: number[];
}

export class RequestMetrics {
  readonly instanceId = crypto.randomUUID();
  private buckets = new Map<string, Bucket>();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(
    private readonly pool: () => pg.Pool,
    private readonly now: () => Date,
  ) {}

  /** Counts one finished request. Synchronous and allocation-light: it runs on every response. */
  record(routePattern: string | undefined, status: number, ms: number) {
    const minute = Math.floor(this.now().getTime() / 60_000);
    const key = `${minute}|${routeGroup(routePattern)}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        requests: 0,
        errors4xx: 0,
        errors5xx: 0,
        latencySumMs: 0,
        latency: new Array(HISTOGRAM_SIZE).fill(0),
      };
      this.buckets.set(key, b);
    }
    b.requests++;
    if (status >= 500) b.errors5xx++;
    else if (status >= 400) b.errors4xx++;
    const d = Math.max(0, Math.round(ms));
    b.latencySumMs += d;
    b.latency[bucketIndex(d)]!++;
  }

  /** Starts the once-a-minute flush (unref'd: it never keeps the process alive). */
  start(everyMs = 60_000) {
    this.timer ??= setInterval(() => void this.flush().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush(true).catch(() => undefined);
  }

  /**
   * Writes the finished minutes (every minute when `all`, e.g. on shutdown). A row that already exists for
   * this process (a second flush of the same minute) is added to, never replaced.
   */
  async flush(all = false) {
    if (this.flushing) await this.flushing;
    const current = Math.floor(this.now().getTime() / 60_000);
    const due: Array<[string, Bucket]> = [];
    for (const [k, b] of this.buckets) if (all || Number(k.split('|')[0]) < current) due.push([k, b]);
    if (!due.length) return;
    for (const [k] of due) this.buckets.delete(k);
    const rows = due.map(([k, b]) => {
      const [minute, group] = k.split('|');
      return { at: new Date(Number(minute) * 60_000).toISOString(), group: group!, ...b };
    });
    this.flushing = this.pool()
      .query(
        `INSERT INTO platform.request_metrics (bucket_start, instance_id, route_group, requests, errors_4xx, errors_5xx, latency_sum_ms, latency_buckets)
         SELECT r.at, $1, r.grp, r.requests, r.e4, r.e5, r.lat, ARRAY(SELECT jsonb_array_elements_text(r.hist)::int)
           FROM jsonb_to_recordset($2::jsonb) AS r(at timestamptz, grp text, requests int, e4 int, e5 int, lat bigint, hist jsonb)
         ON CONFLICT (bucket_start, instance_id, route_group) DO UPDATE SET
           requests = platform.request_metrics.requests + EXCLUDED.requests,
           errors_4xx = platform.request_metrics.errors_4xx + EXCLUDED.errors_4xx,
           errors_5xx = platform.request_metrics.errors_5xx + EXCLUDED.errors_5xx,
           latency_sum_ms = platform.request_metrics.latency_sum_ms + EXCLUDED.latency_sum_ms,
           latency_buckets = ARRAY(SELECT coalesce(a, 0) + coalesce(b, 0) FROM unnest(platform.request_metrics.latency_buckets, EXCLUDED.latency_buckets) AS u(a, b))`,
        [
          this.instanceId,
          JSON.stringify(
            rows.map((r) => ({
              at: r.at,
              grp: r.group,
              requests: r.requests,
              e4: r.errors4xx,
              e5: r.errors5xx,
              lat: r.latencySumMs,
              hist: r.latency,
            })),
          ),
        ],
      )
      .then(() => undefined)
      .catch((err: unknown) => {
        // put the counts back so the next flush retries them
        for (const [k, b] of due) {
          const cur = this.buckets.get(k);
          if (!cur) this.buckets.set(k, b);
          else {
            cur.requests += b.requests;
            cur.errors4xx += b.errors4xx;
            cur.errors5xx += b.errors5xx;
            cur.latencySumMs += b.latencySumMs;
            cur.latency = cur.latency.map((v, i) => v + (b.latency[i] ?? 0));
          }
        }
        throw err;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }
}
