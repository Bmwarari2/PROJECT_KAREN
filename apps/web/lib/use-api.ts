'use client';
import * as React from 'react';
import { api, ApiProblem } from './api';

/**
 * Minimal data hook: fetch on mount / key change, expose reload. No caching of personal data.
 * `initial` is data the server already fetched for this path (serverApi): it is shown at once and
 * the first fetch is skipped.
 */
export function useApi<T>(path: string | null, initial?: T) {
  const [data, setData] = React.useState<T | undefined>(path ? initial : undefined);
  const [error, setError] = React.useState<ApiProblem | null>(null);
  const [loading, setLoading] = React.useState(!!path && initial === undefined);
  const [tick, setTick] = React.useState(0);
  const served = React.useRef(path && initial !== undefined ? path : null);
  React.useEffect(() => {
    if (!path) return;
    if (served.current === path && tick === 0) return;
    served.current = null;
    let cancelled = false;
    setLoading(true);
    // Results render as a transition: React can split the work and stay responsive on slow phones.
    api<T>(path)
      .then((d) => {
        if (!cancelled)
          React.startTransition(() => {
            setData(d);
            setError(null);
            setLoading(false);
          });
      })
      .catch((e) => {
        if (!cancelled)
          React.startTransition(() => {
            setError(e instanceof ApiProblem ? e : new ApiProblem(0, 'error', String(e), {}));
            setLoading(false);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
